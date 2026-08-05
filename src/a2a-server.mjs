#!/usr/bin/env node


import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  activePort,
  activeHost,
  activeUrl,
  activeKey,
  writePid,
  removePid,
  loadConfig,
  peerKeyForUrl,
  appendMessageLog,
} from "./a2a-config.mjs";
import {
  submitKeysForBackend,
} from "./backend-delivery.mjs";
import {
  deliverITerm2Input,
} from "./iterm2-delivery.mjs";
import { viableItermGuid } from "./transport-select.mjs";
import { selectTransportForAgent } from "./transport-router.mjs";
import { wrapEnvelope } from "./server/envelope.mjs";
import {
  authFromRequest,
  configuredPeerUrl,
  isTrustedBrowserLoopbackHostname,
} from "./server/auth.mjs";
import { readJsonBody } from "./server/read-json-body.mjs";
import {
  buildRuntimeSnapshotFromState,
  clearRuntimeSnapshotCache,
} from "./runtime/runtime-snapshot.mjs";
import { pasteLooksUnsubmitted } from "./tmux-paste-verifier.mjs";

// --- Cross-module registry (magic-extractors naming) ---
const HTTPS_DEFAULT_PORT = 443;
const HTTP_DEFAULT_PORT = 80;
const MIME_APPLICATION_JSON = "application/json";
const HTTP_METHOD_POST = "POST";
const HTTP_METHOD_GET = "GET";
const HTTP_METHOD_DELETE = "DELETE";
const HTTP_METHOD_OPTIONS = "OPTIONS";
const HTTP_METHOD_PUT = "PUT";
const HTTP_METHOD_PATCH = "PATCH";
const API_PATH_A2A_SEND = "/api/a2a/send";
const API_PATH_A2A_REGISTER = "/api/a2a/register";
const API_PATH_A2A_AGENTS = "/api/a2a/agents";
const API_PATH_A2A_RUNTIME_SNAPSHOT = "/api/a2a/runtime-snapshot";
const API_PATH_HEALTH = "/health";
const API_PATH_WELL_KNOWN_AGENT_CARD = "/.well-known/agent-card.json";
const API_PATH_SPEC_MESSAGE_STREAM = "/message:stream";
const API_PATH_SPEC_MESSAGE_SEND = "/message:send";
const MESSAGE_ORIGIN_SELF = "self";
const MESSAGE_ORIGIN_USER = "user";
const MESSAGE_ORIGIN_PEER = "peer";
const HTTP_AUTH_BEARER_PREFIX = "Bearer ";
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_IMPLEMENTED = 501;

const URL_PROTOCOL_HTTPS = "https:";

const SERVER_BODY_BYTES_PER_KIB = 1024;
const SERVER_BODY_KIB_PER_MIB = 1024;
const MAX_BODY = SERVER_BODY_BYTES_PER_KIB * SERVER_BODY_KIB_PER_MIB; // 1 MiB

const HTTP_HEADER_CONTENT_TYPE = "Content-Type";
const HTTP_HEADER_CONTENT_LENGTH = "Content-Length";
const HTTP_HEADER_AUTHORIZATION = "Authorization";
const HTTP_HEADER_A2A_VERSION = "a2a-version";

const SUPPORTED_A2A_MAJOR_VERSION = 1;
const SUPPORTED_A2A_DEFAULT_VERSION = "1.0";
const A2A_VERSION_RE = /^(\d+)\.(\d+)$/;
const TASK_PUSH_OR_SUBSCRIBE_ROUTE_RE =
  /^\/tasks\/[^/]+\/(subscribe|push-config|pushNotificationConfig)$/;

const CORS_ALLOW_METHODS = `${HTTP_METHOD_GET},${HTTP_METHOD_POST},${HTTP_METHOD_DELETE},${HTTP_METHOD_OPTIONS}`;
const CORS_ALLOW_HEADERS = `${HTTP_HEADER_CONTENT_TYPE},${HTTP_HEADER_AUTHORIZATION},A2A-Version`;

const API_PATH_A2A_PREFIX = "/api/a2a/";
const API_PATH_A2A_REGISTER_UNREG_RE = new RegExp(
  `^${API_PATH_A2A_REGISTER}/(.+)$`,
);

const PASTE_LOAD_BUFFER_RANDOM_MASK = 0xffff;
const PASTE_VERIFY_BACKOFF_MULTIPLIER = 1.5;

// Paste settle / verify defaults (env-parse fallbacks)
const PASTE_SETTLE_FLOOR_MS_DEFAULT = 300;
const PASTE_SETTLE_PER_KB_MS_DEFAULT = 8;
const PASTE_SETTLE_CEILING_MS_DEFAULT = 1500;
const PASTE_VERIFY_RETRY_DELAY_MS_DEFAULT = 200;
const PASTE_MAX_ENTER_RETRIES_DEFAULT = 5;
const PASTE_VERIFY_DISABLE_SENTINEL = "0";

const TMUX_EXECUTABLE = "tmux";
const TMUX_CAPTURE_PANE_HISTORY_SCROLL_LINES = -10;

const URL_PROTOCOL_HTTP = "http:";

const BRIDGE_PROCESS_TITLE = "a2a-bridge";

const AUTH_KIND_OPERATOR = "operator";
const AUTH_KIND_LOCAL_OPEN = "local-open";
const AUTH_KIND_PEER = "peer";

const REGISTRY_KIND_LOCAL = "local";
const REGISTRY_KIND_REMOTE = "remote";

const DELIVERY_TRANSPORT_REMOTE = "remote";
const DELIVERY_TRANSPORT_TMUX = "tmux";
const DELIVERY_TRANSPORT_ITERM = "iterm";

/**
 * iTerm delivery wrapper for the server envelope path. Same per-target
 * serialization as tmuxDeliver so concurrent /api/a2a/send requests to the
 * same iTerm session do not interleave bracketed pastes.
 *
 * @param {object} recipient
 * @param {string} content   Already envelope-wrapped.
 * @param {string} itermGuid Resolved session GUID.
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string}>}
 */
function itermDeliver(recipient, content, itermGuid) {
  const guid = itermGuid || recipient.itermGuid;
  const lockKey = `iterm:${guid}`;
  return withTargetLock(lockKey, () =>
    deliverITerm2Input({
      target: guid,
      content,
      backend: recipient.backend,
      submit: true,
    }),
  );
}

const MESSAGE_LOG_MISSING_FIELD_PLACEHOLDER = "?";
const REMOTE_DELIVERY_TIMEOUT_MS = 5000;
const VALID_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const VALID_ACTIONS = new Set(["message", "reply", "ask"]);
const VALID_MESSAGE_ORIGINS = new Set([
  MESSAGE_ORIGIN_USER,
  MESSAGE_ORIGIN_PEER,
  MESSAGE_ORIGIN_SELF,
]);
const SPEC_ROLE_USER = "ROLE_USER";
const SPEC_ROLE_AGENT = "ROLE_AGENT";
const SPEC_TASK_STATE_SUBMITTED = "TASK_STATE_SUBMITTED";
const SPEC_PART_CONTENT_KEYS = ["text", "raw", "url", "data"];

process.title = BRIDGE_PROCESS_TITLE;

const PORT = activePort();
const HOST = activeHost();

const registry = new Map();

/**
 * Sends a successful JSON response with the given data.
 *
 * @param {http.ServerResponse} res - HTTP response object.
 * @param {*} data - Response payload (serialized to JSON).
 * @param {number=} [status=200] - HTTP status code.
 * @returns {void}
 */
function ok(res, data, status = HTTP_STATUS_OK) {
  res.writeHead(status, { [HTTP_HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON });
  res.end(JSON.stringify({ success: true, data, timestamp: Date.now() }));
}

function sendJson(res, data, status = HTTP_STATUS_OK) {
  res.writeHead(status, { [HTTP_HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON });
  res.end(JSON.stringify(data));
}

function protocolErrorPayload(name, message, extra = {}) {
  return {
    error: {
      name,
      message,
      ...extra,
    },
  };
}

function sendProtocolError(res, status, name, message, extra = {}) {
  sendJson(res, protocolErrorPayload(name, message, extra), status);
}

/**
 * Sends an error JSON response with the given status and error message.
 *
 * @param {http.ServerResponse} res - HTTP response object.
 * @param {number} status - HTTP error status code (e.g., 400, 401, 404, 500).
 * @param {string} error - Human-readable error message.
 * @returns {void}
 */
function fail(res, status, error) {
  res.writeHead(status, { [HTTP_HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON });
  res.end(JSON.stringify({ success: false, error }));
}

/**
 * Delays execution for the specified duration.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>} Resolves after the specified delay.
 *
 * @example
 * // Wait 500ms before proceeding
 * await sleep(500);
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isValidAgentId(id) {
  return typeof id === "string" && VALID_AGENT_ID_RE.test(id);
}

function isOperatorLike(auth) {
  return (
    auth.kind === AUTH_KIND_OPERATOR ||
    (auth.kind === AUTH_KIND_LOCAL_OPEN && auth.loopback)
  );
}

function peerOwnsAgentId(auth, agentId) {
  return (
    auth.kind === AUTH_KIND_PEER &&
    typeof auth.peer === "string" &&
    (agentId === auth.peer || agentId.startsWith(`${auth.peer}__`))
  );
}

function normalizeHttpBridgeUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== URL_PROTOCOL_HTTP && url.protocol !== URL_PROTOCOL_HTTPS)
    throw new Error("bridgeUrl must use http:// or https://");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function canonicalBridgeUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return String(value || "").replace(/\/+$/, "");
  }
}

function sameBridgeUrl(url) {
  const own = activeUrl();
  if (!own || !url) return false;
  return canonicalBridgeUrl(url) === canonicalBridgeUrl(own);
}

function shouldRemoteDeliver(recipient) {
  return Boolean(recipient.bridgeUrl) && !sameBridgeUrl(recipient.bridgeUrl);
}

function localBridgeBaseUrl() {
  const u = new URL(`${URL_PROTOCOL_HTTP}//127.0.0.1`);
  u.hostname = HOST;
  u.port = String(PORT);
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

function bridgeBaseUrl() {
  const configured = activeUrl();
  if (configured) return canonicalBridgeUrl(configured);
  return localBridgeBaseUrl();
}

function buildAgentCard() {
  const base = bridgeBaseUrl();
  return {
    name: "a2a-bridge",
    description:
      "Local a2a bridge exposing HTTP+JSON agent messaging and discovery endpoints.",
    supportedInterfaces: [
      {
        type: "http+json",
        protocolBinding: "HTTP+JSON",
        url: base,
        protocolVersion: "1.0",
      },
    ],
    version: "1.0",
    capabilities: {
      discovery: true,
      registration: true,
      messaging: true,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return typeof value === "string" ? value : "";
}

function negotiateA2AVersion(req) {
  const raw = firstHeaderValue(req.headers[HTTP_HEADER_A2A_VERSION]).trim();
  if (!raw) {
    return {
      ok: true,
      major: SUPPORTED_A2A_MAJOR_VERSION,
      minor: 0,
      normalized: SUPPORTED_A2A_DEFAULT_VERSION,
      source: "default",
    };
  }
  const match = A2A_VERSION_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      requestedVersion: raw,
      reason: "malformed",
    };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SUPPORTED_A2A_MAJOR_VERSION) {
    return {
      ok: false,
      requestedVersion: raw,
      reason: "unsupported-major",
      major,
      minor,
    };
  }
  return {
    ok: true,
    major,
    minor,
    normalized: `${major}.${minor}`,
    source: "header",
  };
}

function isSpecFacingRoute(method, path) {
  if (method === HTTP_METHOD_GET && path === API_PATH_WELL_KNOWN_AGENT_CARD) {
    return true;
  }
  if (method === HTTP_METHOD_POST && path === API_PATH_SPEC_MESSAGE_STREAM) {
    return true;
  }
  if (
    (method === HTTP_METHOD_POST ||
      method === HTTP_METHOD_PUT ||
      method === HTTP_METHOD_PATCH) &&
    TASK_PUSH_OR_SUBSCRIBE_ROUTE_RE.test(path)
  ) {
    return true;
  }
  return false;
}

function isSpecMessageSendRoute(method, path) {
  return method === HTTP_METHOD_POST && path === API_PATH_SPEC_MESSAGE_SEND;
}

function sendVersionNegotiationError(res, version) {
  sendProtocolError(
    res,
    HTTP_STATUS_BAD_REQUEST,
    "VersionNotSupportedError",
    "A2A-Version must be Major.Minor and use supported major version 1.",
    {
      requestedVersion: version.requestedVersion,
      supportedVersions: [SUPPORTED_A2A_DEFAULT_VERSION],
    },
  );
}

function handleSpecRoute(method, path, req, res) {
  if (!isSpecFacingRoute(method, path)) return false;
  const version = negotiateA2AVersion(req);
  if (!version.ok) {
    sendVersionNegotiationError(res, version);
    return true;
  }
  if (method === HTTP_METHOD_GET && path === API_PATH_WELL_KNOWN_AGENT_CARD) {
    sendJson(res, buildAgentCard());
    return true;
  }
  if (method === HTTP_METHOD_POST && path === API_PATH_SPEC_MESSAGE_STREAM) {
    sendProtocolError(
      res,
      HTTP_STATUS_NOT_IMPLEMENTED,
      "StreamingNotSupportedError",
      "Streaming route is not supported on this bridge.",
      { a2aVersion: version.normalized },
    );
    return true;
  }
  if (
    (method === HTTP_METHOD_POST ||
      method === HTTP_METHOD_PUT ||
      method === HTTP_METHOD_PATCH) &&
    TASK_PUSH_OR_SUBSCRIBE_ROUTE_RE.test(path)
  ) {
    sendProtocolError(
      res,
      HTTP_STATUS_NOT_IMPLEMENTED,
      "PushNotificationNotSupportedError",
      "Task subscription and push-config routes are not supported on this bridge.",
      { a2aVersion: version.normalized },
    );
    return true;
  }
  return false;
}

// Per-target serialization. Before tmuxDeliver became async the bridge implicitly serialized
// every delivery via spawnSync's event-loop-blocking behaviour. With awaited sleeps, concurrent
// /api/a2a/send requests to the SAME pane could interleave paste-buffer/Enter sequences and
// scramble each other. Per-target lock preserves "one delivery in flight per pane" while still
// allowing cross-target deliveries to run in parallel.
const targetLocks = new Map();

/**
 * Serializes async operations per target, ensuring only one invocation of fn runs at a time for each target.
 *
 * @template T
 * @param {string} target - Identifier for the serialization key (e.g., tmux pane name).
 * @param {() => Promise<T>} fn - Function that returns a Promise to be queued and executed.
 * @returns {Promise<T>} Promise that settles when fn completes, even if fn rejects.
 *
 * GOTCHA: Both success and rejection paths clean up the lock. The rejection in `next` is
 * intentionally consumed by the cleanup handler (via .then(cleanup, cleanup)) rather than
 * propagating further. The caller still receives `next` and can handle the rejection via
 * their own await. Without this pattern, two concurrent /api/a2a/send requests to the same
 * target could interleave tmux buffer operations and scramble the message.
 *
 * @example
 * // Multiple calls to the same target queue sequentially
 * const p1 = withTargetLock("pane1", () => deliverOnce("pane1", msg1));
 * const p2 = withTargetLock("pane1", () => deliverOnce("pane1", msg2));
 * // p1 completes, then p2 runs. Different targets run in parallel.
 *
 * @example
 * // Rejections are propagated but cleanup still runs
 * const p = withTargetLock("pane1", () => Promise.reject(new Error("tmux failed")));
 * try {
 *   await p;
 * } catch (err) {
 *   // err.message === "tmux failed"
 *   // Lock is still cleaned up and pane1 is available for the next operation
 * }
 */
function withTargetLock(target, fn) {
  const prev = targetLocks.get(target) || Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  targetLocks.set(target, next);
  // Use .then(cleanup, cleanup) rather than .finally(cleanup) so the rejection in `next`
  // is consumed by this branch instead of propagating into a derived unhandled promise.
  // The caller still receives `next` and handles the rejection via their own await.
  const cleanup = () => {
    if (targetLocks.get(target) === next) targetLocks.delete(target);
  };
  next.then(cleanup, cleanup);
  return next;
}

function parseNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

const PASTE_SETTLE_FLOOR_MS = parseNonNegativeIntegerEnv(
  "A2A_PASTE_SETTLE_FLOOR_MS",
  PASTE_SETTLE_FLOOR_MS_DEFAULT,
);
const PASTE_SETTLE_PER_KB_MS = parseNonNegativeIntegerEnv(
  "A2A_PASTE_SETTLE_PER_KB_MS",
  PASTE_SETTLE_PER_KB_MS_DEFAULT,
);
const PASTE_SETTLE_CEILING_MS = parseNonNegativeIntegerEnv(
  "A2A_PASTE_SETTLE_CEILING_MS",
  PASTE_SETTLE_CEILING_MS_DEFAULT,
);
const PASTE_VERIFY_RETRY_DELAY_MS = parseNonNegativeIntegerEnv(
  "A2A_PASTE_VERIFY_RETRY_DELAY_MS",
  PASTE_VERIFY_RETRY_DELAY_MS_DEFAULT,
);
const PASTE_MAX_ENTER_RETRIES = Math.max(
  1,
  parseNonNegativeIntegerEnv(
    "A2A_PASTE_MAX_ENTER_RETRIES",
    PASTE_MAX_ENTER_RETRIES_DEFAULT,
  ),
);
const PASTE_VERIFY =
  process.env.A2A_PASTE_VERIFY !== PASTE_VERIFY_DISABLE_SENTINEL;

/**
 * Calculates the delay before sending Enter, scaled by message size and bounded by configured limits.
 *
 * @param {number} byteLength - Byte length of the message being delivered.
 * @returns {number} Delay in milliseconds, guaranteed to be between PASTE_SETTLE_FLOOR_MS and PASTE_SETTLE_CEILING_MS.
 *
 * NOTE: The delay is computed as PASTE_SETTLE_FLOOR_MS + (KB of content) * PASTE_SETTLE_PER_KB_MS, then clamped
 * to ceiling. This gives the receiving TUI progressively more time to process and render the bracketed-paste
 * placeholder before Enter is sent, preventing the Enter from racing the placeholder commit and getting absorbed
 * into the paste buffer.
 *
 * @example
 * // Small message: 100 bytes (floor=300, per-KB=8, ceiling=1500)
 * computeSettleMs(100);  // 300 (floor applies)
 *
 * @example
 * // Medium message: 10 KB
 * computeSettleMs(10240);  // 380 (300 + ceil(10)*8)
 *
 * @example
 * // Large message: 150 KB
 * computeSettleMs(153600);  // 1500 (capped at ceiling)
 */
function computeSettleMs(byteLength) {
  const kib =
    byteLength <= 0
      ? 0
      : Math.ceil(byteLength / SERVER_BODY_BYTES_PER_KIB);
  const scaled =
    PASTE_SETTLE_FLOOR_MS + kib * PASTE_SETTLE_PER_KB_MS;
  return Math.max(0, Math.min(PASTE_SETTLE_CEILING_MS, scaled));
}

/**
 * Checks if the pasted envelope still looks unsubmitted in the tmux pane.
 *
 * @param {string} target - Tmux target (e.g., "session:window.pane").
 * @param {string} content - Message content that was pasted.
 * @returns {boolean} True if the placeholder or prompt text is detected in recent pane history, false if tmux command fails or pattern absent.
 *
 * NOTE: Returns false gracefully if the pane is unreachable (status !== 0), allowing retry logic to proceed.
 */
function pasteStillUnsubmitted(target, content) {
  const r = spawnSync(TMUX_EXECUTABLE, [
    "capture-pane",
    "-t",
    target,
    "-p",
    "-S",
    String(TMUX_CAPTURE_PANE_HISTORY_SCROLL_LINES),
  ]);
  if (r.status !== 0) return false;
  return pasteLooksUnsubmitted((r.stdout || "").toString(), content);
}

/**
 * Delivers a message to a tmux pane, serializing concurrent deliveries to the same target.
 *
 * @param {string} target - Tmux target (e.g., "session:window.pane").
 * @param {string} content - Message content to paste and submit.
 * @param {{ backend=}} [opts={}] - Options object.
 * @param {string=} opts.backend - Backend identifier passed to deliverOnce for submit key derivation.
 * @returns {Promise<{ ok: boolean; error?: string; bytes?: number }>} Result with ok flag and optional error or byte count.
 *
 * @see {@link withTargetLock} for serialization behavior.
 * @see {@link deliverOnce} for the actual delivery implementation.
 */
function tmuxDeliver(target, content, opts = {}) {
  return withTargetLock(target, () => deliverOnce(target, content, opts));
}

/**
 * Delivers a message to a tmux pane via load-buffer, paste-buffer, and send-keys with retry logic.
 *
 * @param {string} target - Tmux target (e.g., "session:window.pane").
 * @param {string} content - Message content to paste.
 * @param {{ backend=}} [opts={}] - Options object.
 * @param {string=} opts.backend - Backend identifier for submit key lookup.
 * @returns {Promise<{ ok: boolean; error?: string; bytes?: number }>} Success with byte count, or error with tmux command details.
 *
 * NOTE: Uses spawnSync for tmux operations, which blocks the event loop. This is intentional and pragmatic for short-lived
 * shell operations. The async nature comes from the await sleep() delays, not from non-blocking I/O.
 *
 * GOTCHA: If the Enter key lands before the tmux pane commits the bracketed-paste placeholder, the key is absorbed into
 * the paste and the message doesn't submit. The function retries with exponential backoff (200ms, 300ms, 450ms, etc.) up
 * to PASTE_MAX_ENTER_RETRIES times, checking for placeholder presence before each retry.
 */
async function deliverOnce(target, content, opts = {}) {
  const buf = `a2a-${process.pid}-${Date.now()}-${Math.floor(Math.random() * PASTE_LOAD_BUFFER_RANDOM_MASK).toString(16)}`;
  const load = spawnSync(TMUX_EXECUTABLE, ["load-buffer", "-b", buf, "-"], {
    input: content,
  });
  if (load.status !== 0)
    return {
      ok: false,
      error: `tmux load-buffer failed: ${load.stderr?.toString().trim() || "unknown"}`,
    };

  const paste = spawnSync(TMUX_EXECUTABLE, [
    "paste-buffer",
    "-p",
    "-d",
    "-b",
    buf,
    "-t",
    target,
  ]);
  if (paste.status !== 0) {
    spawnSync(TMUX_EXECUTABLE, ["delete-buffer", "-b", buf]);
    return {
      ok: false,
      error: `tmux paste-buffer failed: ${paste.stderr?.toString().trim() || "unknown"}`,
    };
  }

  // Wait for the receiving TUI to process the bracketed-paste end marker and render its
  // placeholder before we send Enter. Without this the Enter races the placeholder commit
  // and gets absorbed into the paste, leaving the message sitting unsubmitted.
  await sleep(computeSettleMs(Buffer.byteLength(content, "utf8")));

  // Send Enter and verify it took effect. If the placeholder is still visible after the
  // delay, the TUI is still holding the paste placeholder. Retry up to
  // PASTE_MAX_ENTER_RETRIES times with exponential backoff on the verify delay.
  const submitKeys = submitKeysForBackend(opts.backend);
  let submitted = false;
  for (let attempt = 0; attempt < PASTE_MAX_ENTER_RETRIES; attempt++) {
    const enter = spawnSync(TMUX_EXECUTABLE, [
      "send-keys",
      "-t",
      target,
      ...submitKeys,
    ]);
    if (enter.status !== 0)
      return {
        ok: false,
        error: `tmux send-keys failed: ${enter.stderr?.toString().trim() || "unknown"}`,
      };

    if (!PASTE_VERIFY) {
      submitted = true;
      break;
    }

    // Backoff: 200, 300, 450, 675, 1012 -- gives the TUI progressively more time
    const delay = Math.floor(
      PASTE_VERIFY_RETRY_DELAY_MS *
        PASTE_VERIFY_BACKOFF_MULTIPLIER**attempt,
    );
    await sleep(delay);

    if (!pasteStillUnsubmitted(target, content)) {
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    // Placeholder still visible after retries. Resolution is to send Enter and move on
    // rather than warn/block -- a stuck placeholder clears on the next Enter in practice.
    spawnSync(TMUX_EXECUTABLE, ["send-keys", "-t", target, ...submitKeys]);
  }
  return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * Checks HTTP request authorization against configured keys and peer credentials.
 *
 * @param {http.IncomingMessage} req - HTTP request with Authorization header.
 * @returns {*} Auth object with { ok: boolean; kind?: string; peer?: string; loopback?: boolean } on success, { ok: false } on failure.
 *
 * @see {@link authFromRequest} for full auth logic.
 */
function checkAuth(req) {
  return authFromRequest(req, { ...loadConfig(), key: activeKey() });
}

/**
 * Delivers a message to a remote a2a bridge via HTTP POST.
 *
 * @param {string} targetUrl - Target bridge URL (e.g., "https://bridge.example.com").
 * @param {*} payload - Message payload object to POST to /api/a2a/send.
 * @returns {Promise<{ ok: boolean; error?: string; bytes?: number }>} Success with byte count, or error with message.
 *
 * NOTE: Always resolves (never rejects). Network errors and non-JSON responses are converted to { ok: false, error: "..."}
 */
function remoteDeliver(targetUrl, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const url = new URL(String(targetUrl));
      if (url.protocol !== URL_PROTOCOL_HTTP && url.protocol !== URL_PROTOCOL_HTTPS) {
        done({ ok: false, error: `unsupported protocol: ${url.protocol}` });
        return;
      }
      const authKey = peerKeyForUrl(url.toString());
      const prefix = url.pathname.replace(/\/+$/, "");
      url.pathname = `${prefix}${API_PATH_A2A_SEND}`;
      url.search = "";
      url.hash = "";
      const transport =
        url.protocol === URL_PROTOCOL_HTTPS ? httpsRequest : httpRequest;
      const req = transport(
        {
          method: HTTP_METHOD_POST,
          hostname: url.hostname,
          port:
            url.port ||
            (url.protocol === URL_PROTOCOL_HTTPS
              ? HTTPS_DEFAULT_PORT
              : HTTP_DEFAULT_PORT),
          path: `${url.pathname}${url.search}`,
          timeout: REMOTE_DELIVERY_TIMEOUT_MS,
          headers: {
            [HTTP_HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON,
            [HTTP_HEADER_CONTENT_LENGTH]: body.length,
            ...(authKey
              ? {
                  [HTTP_HEADER_AUTHORIZATION]: `${HTTP_AUTH_BEARER_PREFIX}${authKey}`,
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              done(
                data.success
                  ? { ok: true, bytes: data.data?.bytes ?? body.length }
                  : { ok: false, error: `remote: ${data.error || "unknown"}` },
              );
            } catch {
              done({
                ok: false,
                error: `non-JSON response (${res.statusCode})`,
              });
            }
          });
        },
      );
      req.on("timeout", () => {
        done({
          ok: false,
          error: `unreachable: timed out after ${REMOTE_DELIVERY_TIMEOUT_MS}ms`,
        });
        req.destroy();
      });
      req.on("error", (err) =>
        done({ ok: false, error: `unreachable: ${err.message}` }),
      );
      req.write(body);
      req.end();
    } catch (err) {
      done({ ok: false, error: `remote delivery failed: ${err.message}` });
    }
  });
}

function normalizeAction(action) {
  if (action == null) return "message";
  if (typeof action !== "string") return null;
  const trimmed = action.trim();
  if (!VALID_ACTIONS.has(trimmed)) return null;
  return trimmed;
}

function isPeerSenderForAuth(sender, auth) {
  if (auth.kind !== AUTH_KIND_PEER) return true;
  return sender === auth.peer || sender.startsWith(`${auth.peer}__`);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function objectField(value) {
  return isPlainObject(value) ? value : {};
}

function firstStringField(...values) {
  for (const value of values) {
    const normalized = stringField(value);
    if (normalized) return normalized;
  }
  return null;
}

function extractSpecPartText(part) {
  if (!isPlainObject(part)) {
    throw new Error("message.parts entries must be objects");
  }
  const present = SPEC_PART_CONTENT_KEYS.filter((key) =>
    Object.hasOwn(part, key),
  );
  if (present.length !== 1) {
    throw new Error("message.parts entries must contain exactly one content field");
  }
  if (Object.hasOwn(part, "text")) {
    if (typeof part.text !== "string") {
      throw new Error("text parts must contain string text");
    }
    return part.text;
  }
  if (Object.hasOwn(part, "data")) {
    return JSON.stringify(part.data);
  }
  throw new Error("raw and url parts are not supported by the tmux bridge adapter");
}

function specMessageToBridgeText(message) {
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new Error("message.parts must be a non-empty array");
  }
  return message.parts.map((part) => extractSpecPartText(part)).join("\n");
}

function mapProtocolSendMessageRequest(requestBody) {
  if (!isPlainObject(requestBody?.message)) {
    throw new Error("message is required");
  }
  const { message } = requestBody;
  if (!stringField(message.messageId)) {
    throw new Error("message.messageId is required");
  }
  if (message.role !== SPEC_ROLE_USER) {
    throw new Error("message.role must be ROLE_USER");
  }
  const requestMeta = objectField(requestBody.metadata);
  const messageMeta = objectField(message.metadata);
  const to = firstStringField(requestMeta.to, messageMeta.to);
  if (!to) throw new Error("metadata.to is required");
  return {
    to,
    from: firstStringField(requestMeta.from, messageMeta.from) || "a2a-client",
    origin: firstStringField(requestMeta.origin, messageMeta.origin) || MESSAGE_ORIGIN_USER,
    source: firstStringField(requestMeta.source, messageMeta.source) || "api",
    body: specMessageToBridgeText(message),
    action: firstStringField(requestMeta.action, messageMeta.action) || "message",
    replyTo: firstStringField(requestMeta.replyTo, messageMeta.replyTo),
    specMessage: message,
  };
}

function mapCompatibilityMessageSendBody(body) {
  return {
    to: body?.to,
    from: body?.from,
    origin: body?.origin,
    body: body?.body,
    action: body?.action,
    replyTo: body?.replyTo,
    specMessage: null,
  };
}

function sendBridgeSendSuccess(res, { body, recipient, delivery }) {
  ok(res, {
    to: body.to,
    target: recipient.tmuxTarget,
    bytes: delivery.bytes,
  });
}

function buildSpecAckTask({ body, delivery, normalizedAction, specMessage }) {
  const message = specMessage || {
    messageId: `a2a-message-${randomUUID()}`,
    role: SPEC_ROLE_USER,
    parts: [{ text: body.body }],
    metadata: {},
  };
  const taskId = message.taskId || `a2a-task-${randomUUID()}`;
  const contextId = message.contextId || taskId;
  return {
    task: {
      id: taskId,
      contextId,
      status: {
        state: SPEC_TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `a2a-ack-${randomUUID()}`,
          contextId,
          taskId,
          role: SPEC_ROLE_AGENT,
          parts: [
            {
              text: `Message accepted for delivery to ${body.to}.`,
            },
          ],
        },
      },
      history: [message],
      metadata: {
        delivery: {
          to: body.to,
          from: body.from,
          origin: body.origin,
          action: normalizedAction,
          bytes: delivery.bytes,
        },
      },
    },
  };
}

function sendSpecMessageSendSuccess(res, context) {
  sendJson(res, buildSpecAckTask(context));
}

async function handleBridgeSendBody(body, res, auth, opts = {}) {
  const normalizedAction = normalizeAction(body?.action);
  if (
    !isValidAgentId(body?.to) ||
    !isValidAgentId(body?.from) ||
    !body?.origin ||
    !normalizedAction ||
    typeof body?.body !== "string"
  ) {
    fail(res, 400, "valid to, from, origin, action, body are required");
    appendMessageLog({
      from: body?.from || MESSAGE_LOG_MISSING_FIELD_PLACEHOLDER,
      to: body?.to || MESSAGE_LOG_MISSING_FIELD_PLACEHOLDER,
      action: normalizedAction,
      origin: body?.origin || MESSAGE_LOG_MISSING_FIELD_PLACEHOLDER,
      body: body?.body,
      ok: false,
      error: "missing required field (to/from/origin/body)",
    });
    return true;
  }
  if (!VALID_MESSAGE_ORIGINS.has(body.origin)) {
    fail(res, 400, `invalid origin '${body.origin}'`);
    appendMessageLog({
      from: body.from,
      to: body.to,
      action: normalizedAction,
      origin: body.origin,
      body: body.body,
      ok: false,
      error: `invalid origin '${body.origin}'`,
    });
    return true;
  }
  if (
    auth.kind === AUTH_KIND_PEER &&
    (body.origin !== MESSAGE_ORIGIN_PEER ||
      body.from === "cli" ||
      !isPeerSenderForAuth(body.from, auth))
  ) {
    fail(res, 403, "peer sender mismatch");
    appendMessageLog({
      from: body.from,
      to: body.to,
      action: normalizedAction,
      origin: body.origin,
      body: body.body,
      ok: false,
      error: "peer sender mismatch",
    });
    return true;
  }
  const claimedSender = registry.get(body.from);
  if (
    auth.kind === AUTH_KIND_PEER &&
    claimedSender?.kind === REGISTRY_KIND_LOCAL
  ) {
    fail(res, 403, "peer cannot claim a local sender id");
    appendMessageLog({
      from: body.from,
      to: body.to,
      action: normalizedAction,
      origin: body.origin,
      body: body.body,
      ok: false,
      error: "peer cannot claim a local sender id",
    });
    return true;
  }
  if (!claimedSender && auth.kind === AUTH_KIND_PEER) {
    let bridgeUrl;
    try {
      const peerReplyUrl =
        configuredPeerUrl(loadConfig(), auth.peer) ||
        (typeof body.replyTo === "string" ? body.replyTo : null);
      if (!peerReplyUrl) {
        fail(res, 403, "remote peer URL is not configured");
        return true;
      }
      bridgeUrl = normalizeHttpBridgeUrl(peerReplyUrl);
    } catch (err) {
      fail(res, 400, err.message);
      return true;
    }
    registry.set(body.from, {
      agentId: body.from,
      kind: REGISTRY_KIND_REMOTE,
      tmuxTarget: `${body.from}:0.0`,
      bridgeUrl,
      registeredAt: Date.now(),
    });
  }
  const recipient = registry.get(body.to);
  if (!recipient) {
    const err = `no agent '${body.to}' (registered: ${Array.from(registry.keys()).join(", ") || "none"})`;
    fail(res, 404, err);
    appendMessageLog({
      from: body.from,
      to: body.to,
      action: normalizedAction,
      origin: body.origin,
      body: body.body,
      ok: false,
      error: err,
    });
    return true;
  }
  const useRemote = shouldRemoteDeliver(recipient);
  let transport;
  let delivery;
  if (useRemote) {
    transport = DELIVERY_TRANSPORT_REMOTE;
    delivery = await remoteDeliver(recipient.bridgeUrl, {
      ...body,
      action: normalizedAction,
    });
  } else {
    const pick = await selectTransportForAgent(recipient);
    if (pick.transport === null) {
      const err = pick.reason;
      appendMessageLog({
        from: body.from,
        to: body.to,
        action: normalizedAction,
        origin: body.origin,
        body: body.body,
        ok: false,
        error: err,
        transport: DELIVERY_TRANSPORT_TMUX,
      });
      fail(res, 502, err);
      return true;
    }
    transport = pick.transport;
    const wrapped = wrapEnvelope({ ...body, action: normalizedAction });
    delivery =
      pick.transport === DELIVERY_TRANSPORT_ITERM
        ? await itermDeliver(recipient, wrapped, pick.itermGuid)
        : await tmuxDeliver(
            recipient.tmuxTarget || `${recipient.agentId}:0.0`,
            wrapped,
            {
              backend: recipient.backend,
            },
          );
  }
  appendMessageLog({
    from: body.from,
    to: body.to,
    action: normalizedAction,
    origin: body.origin,
    body: body.body,
    bytes: delivery.bytes ?? Buffer.byteLength(body.body, "utf8"),
    ok: delivery.ok,
    error: delivery.error,
    transport,
  });
  if (!delivery.ok) {
    fail(res, 502, delivery.error);
    return true;
  }
  const sendSuccess = opts.sendSuccess || sendBridgeSendSuccess;
  sendSuccess(res, {
    body,
    recipient,
    delivery,
    normalizedAction,
    specMessage: opts.specMessage || null,
  });
  return true;
}

function mapSpecMessageSendBody(body) {
  return isPlainObject(body?.message)
    ? mapProtocolSendMessageRequest(body)
    : mapCompatibilityMessageSendBody(body);
}

async function handleSpecMessageSendRoute(req, res, auth) {
  try {
    const bridgeBody = mapSpecMessageSendBody(await readJsonBody(req, MAX_BODY));
    return await handleBridgeSendBody(bridgeBody, res, auth, {
      sendSuccess: bridgeBody.specMessage
        ? sendSpecMessageSendSuccess
        : sendBridgeSendSuccess,
      specMessage: bridgeBody.specMessage,
    });
  } catch (e) {
    fail(res, e?.code ?? 400, `invalid body: ${e.message}`);
    return true;
  }
}

/**
 * Routes and handles /api/a2a/* endpoints: register, unregister, list agents, and send messages.
 *
 * @param {string} method - HTTP method (GET, POST, DELETE, OPTIONS).
 * @param {string} path - Request path.
 * @param {http.IncomingMessage} req - HTTP request (body already authenticated).
 * @param {http.ServerResponse} res - HTTP response.
 * @param {*} auth - Auth context from checkAuth().
 * @returns {Promise<boolean>} True if route was handled (response sent), false if no matching route.
 *
 * NOTE: This function sends all responses via ok() or fail(), not by returning data. The async nature derives from
 * readJsonBody() and remoteDeliver()/tmuxDeliver() awaits, not from route logic itself.
 *
 * Routes handled:
 * - POST /api/a2a/register - Register a local or infer remote agent
 * - DELETE /api/a2a/register/:agentId - Unregister an agent
 * - GET /api/a2a/agents - List all registered agents
 * - POST /api/a2a/send - Deliver a message to a registered agent
 */
async function handleA2ARoutes(method, path, req, res, auth) {
  if (!path.startsWith(API_PATH_A2A_PREFIX)) return false;

  if (method === HTTP_METHOD_POST && path === API_PATH_A2A_REGISTER) {
    try {
      const body = await readJsonBody(req, MAX_BODY);
      if (
        !isValidAgentId(body.agentId) ||
        typeof body.tmuxTarget !== "string" ||
        !body.tmuxTarget
      ) {
        fail(res, 400, "agentId and tmuxTarget are required");
        return true;
      }
      const local = isOperatorLike(auth);
      const peer = peerOwnsAgentId(auth, body.agentId);
      if (!local && !peer) {
        fail(
          res,
          403,
          auth.kind === AUTH_KIND_PEER
            ? `not allowed to register agent '${body.agentId}'; authenticated peer '${auth.peer}' may only register '${auth.peer}' or '${auth.peer}__<agent>'`
            : "not allowed to register this agent",
        );
        return true;
      }

      const existing = registry.get(body.agentId);
      if (peer && existing?.kind === REGISTRY_KIND_LOCAL) {
        fail(res, 409, "remote peer cannot overwrite local registration");
        return true;
      }

      const kind = local ? REGISTRY_KIND_LOCAL : REGISTRY_KIND_REMOTE;
      const peerOwner = peer ? auth.peer : null;
      const bridgeUrl =
        kind === REGISTRY_KIND_REMOTE
          ? configuredPeerUrl(loadConfig(), peerOwner)
          : body.bridgeUrl;
      if (kind === REGISTRY_KIND_REMOTE && !bridgeUrl) {
        fail(res, 403, "remote peer URL is not configured");
        return true;
      }
      let normalizedBridgeUrl;
      if (bridgeUrl) {
        try {
          normalizedBridgeUrl = normalizeHttpBridgeUrl(bridgeUrl);
        } catch (err) {
          fail(res, 400, err.message);
          return true;
        }
      }

      registry.set(body.agentId, {
        agentId: body.agentId,
        kind,
        tmuxTarget: body.tmuxTarget,
        // itermGuid: present for iTerm-spawned agents so the bridge can
        // pick the iTerm transport at delivery time. tmuxTarget is still
        // recorded as a fall-through so a stale guid does not strand the
        // agent.
        itermGuid: viableItermGuid(body.itermGuid)
          ? body.itermGuid.trim()
          : undefined,
        cwd: body.cwd,
        description: body.description,
        bridgeUrl: normalizedBridgeUrl,
        backend: body.backend,
        backendCommand:
          typeof body.backendCommand === "string" && body.backendCommand
            ? body.backendCommand
            : undefined,
        backendArgs: Array.isArray(body.backendArgs)
          ? body.backendArgs
          : undefined,
        backendEnv:
          body.backendEnv && typeof body.backendEnv === "object"
            ? body.backendEnv
            : undefined,
        startupPrompt:
          typeof body.startupPrompt === "string"
            ? body.startupPrompt
            : undefined,
        // yolo: authority level the agent was spawned with. Persisted so
        // `a2a list` can surface it (operators need to verify bypass
        // intent stuck) and so reconnect round-trips authority across
        // re-registrations. `null` when the registration didn't claim a
        // yolo state (e.g. manual `a2a register`, peer-driven inferred
        // registration during reply routing).
        yolo: typeof body.yolo === "boolean" ? body.yolo : null,
        // installToken: per-install marker generated by the launching
        // CLI and pinned onto the tmux session as @a2a-install-token.
        // Lets list/kill prove a tmux session is a2a-owned even when
        // the bridge has forgotten — without trusting the
        // registry.json cache alone (which could collide with an
        // unrelated user session name).
        installToken:
          typeof body.installToken === "string" && body.installToken
            ? body.installToken
            : null,
        registeredAt: Date.now(),
      });
      clearRuntimeSnapshotCache();
      ok(res, registry.get(body.agentId));
    } catch (e) {
      fail(res, e?.code ?? 400, `invalid body: ${e.message}`);
    }
    return true;
  }

  const unregMatch = path.match(API_PATH_A2A_REGISTER_UNREG_RE);
  if (method === HTTP_METHOD_DELETE && unregMatch) {
    const id = decodeURIComponent(unregMatch[1]);
    if (!isValidAgentId(id)) {
      fail(res, 400, "invalid agent id");
      return true;
    }
    const peerDeletingSelf =
      auth.kind === AUTH_KIND_PEER &&
      (auth.peer === id || id.startsWith(`${auth.peer}__`));
    if (!isOperatorLike(auth) && !peerDeletingSelf) {
      fail(res, 403, "not allowed to unregister this agent");
      return true;
    }
    const removed = registry.delete(id);
    if (removed) clearRuntimeSnapshotCache();
    ok(res, { agentId: id, removed });
    return true;
  }

  if (method === HTTP_METHOD_GET && path === API_PATH_A2A_AGENTS) {
    ok(res, { agents: Array.from(registry.values()) });
    return true;
  }

  if (method === HTTP_METHOD_GET && path === API_PATH_A2A_RUNTIME_SNAPSHOT) {
    const url = new URL(req.url, `${URL_PROTOCOL_HTTP}//${HOST}:${PORT}`);
    const self = url.searchParams.get("self") || null;
    const launchCwd = url.searchParams.get("cwd") || process.cwd();
    const fresh = url.searchParams.get("fresh") === "1";
    ok(
      res,
      await buildRuntimeSnapshotFromState({
        registeredAgents: Array.from(registry.values()),
        self,
        launchCwd,
        cache: !fresh,
      }),
    );
    return true;
  }

  if (method === HTTP_METHOD_POST && path === API_PATH_A2A_SEND) {
    let body = null;
    try {
      body = await readJsonBody(req, MAX_BODY);
      await handleBridgeSendBody(body, res, auth);
    } catch (e) {
      fail(res, e?.code ?? 400, `invalid body: ${e.message}`);
      if (body && body.from && body.to)
        appendMessageLog({
          from: body.from,
          to: body.to,
          action: body.action,
          origin: body.origin || MESSAGE_LOG_MISSING_FIELD_PLACEHOLDER,
          body: body.body,
          ok: false,
          error: `invalid body: ${e.message}`,
        });
    }
    return true;
  }

  return false;
}

/**
 * Main HTTP request handler: validates origin (for CORS), checks auth, routes to A2A endpoints or 404.
 *
 * @param {http.IncomingMessage} req - HTTP request.
 * @param {http.ServerResponse} res - HTTP response.
 * @returns {Promise<void>} Never rejects; all errors are caught and sent as 500 responses.
 *
 * NOTE: CORS origin validation only applies to browser requests (req.headers.origin present).
 * Loopback hostnames (localhost, 127.0.0.1, ::1) are trusted. Cross-origin requests from other
 * hostnames are rejected as forbidden.
 */
async function handleRequest(req, res) {
  const {origin} = req.headers;
  if (origin) {
    try {
      const u = new URL(origin);
      // Trust loopback browser origins AND chrome extensions (Claude Bridge
      // talks to this bridge from a chrome-extension:// origin, which has no
      // loopback hostname). The bridge already binds to 127.0.0.1 only.
      const trusted =
        isTrustedBrowserLoopbackHostname(u.hostname) ||
        u.protocol === "chrome-extension:";
      if (!trusted) {
        fail(res, 403, "origin not allowed");
        return;
      }
    } catch {
      fail(res, 403, "invalid origin");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  if (req.method === HTTP_METHOD_OPTIONS) {
    res.writeHead(HTTP_STATUS_OK);
    res.end();
    return;
  }

  const path = new URL(req.url, `${URL_PROTOCOL_HTTP}//${HOST}:${PORT}`)
    .pathname;

  if (req.method === HTTP_METHOD_GET && path === API_PATH_HEALTH) {
    const cfg = loadConfig();
    ok(res, {
      ok: true,
      agents: registry.size,
      auth: Boolean(cfg.key || Object.keys(cfg.peers || {}).length),
    });
    return;
  }

  if (handleSpecRoute(req.method, path, req, res)) return;

  if (isSpecMessageSendRoute(req.method, path)) {
    const version = negotiateA2AVersion(req);
    if (!version.ok) {
      sendVersionNegotiationError(res, version);
      return;
    }
    const auth = checkAuth(req);
    if (!auth.ok) {
      fail(res, 401, "unauthorized");
      return;
    }
    await handleSpecMessageSendRoute(req, res, auth);
    return;
  }

  const auth = checkAuth(req);
  if (!auth.ok) {
    fail(res, 401, "unauthorized");
    return;
  }
  if (await handleA2ARoutes(req.method, path, req, res, auth)) return;
  fail(res, 404, "not found");
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    try {
      if (res.writableEnded) return;
      if (!res.headersSent) fail(res, 500, err.message);
      else res.end();
    } catch {
      /* ignore */
    }
  });
});

process.on("SIGINT", () => {
  removePid(process.pid);
  process.exit(0);
});
process.on("SIGTERM", () => {
  removePid(process.pid);
  process.exit(0);
});
process.on("exit", () => removePid(process.pid));

server.listen(PORT, HOST, () => {
  writePid(process.pid);
  console.log(
    `a2a bridge listening on http://${HOST}:${PORT} (pid ${process.pid})`,
  );
});
