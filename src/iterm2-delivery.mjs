// File: iterm2-delivery.mjs
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { submitKeysForBackend } from "./backend-delivery.mjs";
import { computeSettleMs } from "./key-sequence.mjs";

const DEFAULT_SOCKET =
  process.env.A2A_ITERM2_BRIDGE_SOCKET ||
  join(homedir(), ".local/state/a2a/iterm2-bridge.sock");
const DEFAULT_TIMEOUT_MS = 5000;
const RPC_PER_STEP_BUDGET_MS = 250;
const CURSOR_AGENT_BACKEND = "cursor-agent";

/**
 * Base rpc timeout. Env-tunable (A2A_ITERM2_RPC_TIMEOUT_MS) so tests can
 * shrink it without waiting out the 5s production default.
 *
 * @returns {number}
 */
function baseRpcTimeoutMs() {
  const raw = process.env.A2A_ITERM2_RPC_TIMEOUT_MS;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Computes the rpc timeout for a send_keys request. The Python bridge
 * executes every step — including sleep steps up to SLEEP(60000) and
 * per-paste settle sleeps — BEFORE replying, so a fixed timeout makes any
 * sequence with >base total sleep "time out" while the bridge delivers
 * anyway (and retries then double-deliver). Budget: base + sum of sleep-step
 * ms + a per-step allowance.
 *
 * @param {Array<{type?:string, ms?:number}>} steps
 * @returns {number}
 */
export function rpcTimeoutForSteps(steps) {
  let ms = baseRpcTimeoutMs();
  for (const step of Array.isArray(steps) ? steps : []) {
    ms += RPC_PER_STEP_BUDGET_MS;
    if (step && step.type === "sleep" && Number.isFinite(step.ms)) {
      ms += Math.max(0, step.ms);
    }
  }
  return ms;
}

/**
 * Sends one JSON request over the bridge socket and awaits one JSON response.
 *
 * @param {string} socketPath
 * @param {object} request
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function rpc(socketPath, request, timeoutMs = baseRpcTimeoutMs()) {
  return new Promise((resolve) => {
    const sock = createConnection({ path: socketPath });
    let buf = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(
      () => settle({ ok: false, error: `bridge timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    sock.on("connect", () => {
      sock.write(`${JSON.stringify(request)}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        clearTimeout(timer);
        try {
          settle(JSON.parse(line));
        } catch (e) {
          settle({ ok: false, error: `bad response json: ${e.message}` });
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: `bridge socket: ${err.code || err.message}` });
    });
    sock.on("end", () => {
      clearTimeout(timer);
      if (!settled) settle({ ok: false, error: "bridge closed without response" });
    });
  });
}

/**
 * Maps an a2a backend id to the raw byte sequence the bridge should append
 * after the pasted content when submit=true.
 *
 * @param {string} backend
 * @returns {string}
 */
function submitBytesForBackend(backend) {
  if (process.env.A2A_ITERM2_SUBMIT_BYTES) return process.env.A2A_ITERM2_SUBMIT_BYTES;
  if (backend === CURSOR_AGENT_BACKEND) return "\x1b\r";
  // submitKeysForBackend is reused so this stays in sync with the tmux path
  // when other backends are added.
  void submitKeysForBackend;
  return "\r";
}

/**
 * Delivers text to an iTerm2 session by GUID via the running bridge.
 *
 * Mirrors deliverRawTmuxInput's contract so a transport router can dispatch
 * by route without callers caring which backend is in use.
 *
 * @param {object} opts
 * @param {string} opts.target  iTerm2 session GUID.
 * @param {string} opts.content Raw text to send.
 * @param {string} [opts.backend]
 * @param {boolean} [opts.submit=true]
 * @param {boolean} [opts.verify] Reserved for future use; bridge does not yet verify.
 * @param {string} [opts.socketPath]
 * @returns {Promise<{ ok: boolean; bytes?: number; error?: string; warning?: string }>}
 */
const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #\d+/;
const VERIFY_SCREEN_LINES = 8;
const ITERM_VERIFY_MAX_RETRIES = 3;
const ITERM_VERIFY_BACKOFF_MS = 200;

export async function deliverITerm2Input({
  target,
  content,
  backend = "",
  submit = true,
  verify = process.env.A2A_ITERM_PASTE_VERIFY !== "0",
  socketPath = DEFAULT_SOCKET,
} = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    return { ok: false, error: "target must be a non-empty session guid" };
  }
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "content must be a non-empty string" };
  }
  // Route through send_keys so paste / settle-sleep / submit-key arrive as
  // discrete steps on the bridge side. The all-in-one send_text path races
  // the receiving TUI's bracketed-paste commit and ends up with the paste
  // sitting in the input buffer unsubmitted (the same race the tmux delivery
  // path solves via load-buffer + paste-buffer + sleep + send-keys).
  const settleMs = computeSettleMs(Buffer.byteLength(content, "utf8"));
  const steps = [{ type: "paste", text: content }];
  if (submit) {
    steps.push({ type: "sleep", ms: settleMs });
    // submitBytesForBackend returns the raw byte sequence (e.g. "\r" or
    // "\x1b\r" for cursor-agent). Re-encode as send_keys steps so each key
    // can be settled discretely.
    const submitBytes = submitBytesForBackend(backend);
    for (const ch of submitBytes) {
      if (ch === "\x1b") steps.push({ type: "key", key: "ESC" });
      else if (ch === "\r") steps.push({ type: "key", key: "ENTER" });
      else if (ch === "\t") steps.push({ type: "key", key: "TAB" });
      else steps.push({ type: "type", text: ch });
    }
  }
  const resp = await rpc(
    socketPath,
    {
      op: "send_keys",
      params: { guid: target, steps },
    },
    rpcTimeoutForSteps(steps),
  );
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  const bytes = typeof resp.bytes === "number" ? resp.bytes : undefined;

  // Constraint 2: verify submit. After paste+ENTER the receiving TUI either
  // committed the bracketed paste or left it sitting in the input. Two
  // failure modes:
  //   (a) Large paste → Claude Code renders `[Pasted text #N +M lines]`
  //       placeholder. Easy to detect.
  //   (b) Small paste → our pasted text still sits inline after the prompt
  //       char with no placeholder. Detected by matching the prompt line's
  //       content against what we pasted (never against arbitrary input —
  //       a stray ENTER would submit the recipient's own half-typed prompt).
  // Each check sleeps AFTER the preceding ENTER and BEFORE reading the
  // screen — reading immediately checks a stale frame and fires duplicate
  // ENTERs. Mirrors the tmux raw-delivery ordering.
  if (submit && verify) {
    for (let attempt = 0; attempt < ITERM_VERIFY_MAX_RETRIES; attempt++) {
      await delay(ITERM_VERIFY_BACKOFF_MS * (attempt + 1));
      const unsubmitted = await screenLooksUnsubmitted(
        socketPath,
        target,
        content,
      );
      if (unsubmitted === false) return { ok: true, bytes };
      if (unsubmitted === null) {
        return {
          ok: true,
          bytes,
          warning: "iterm paste verify could not read screen; submit uncertain",
        };
      }
      if (attempt === ITERM_VERIFY_MAX_RETRIES - 1) break;
      // Send one more ENTER. The bracketed-paste end marker has now had
      // more time to commit so a single submit should land.
      const resubmit = await rpc(socketPath, {
        op: "send_keys",
        params: {
          guid: target,
          steps: [{ type: "key", key: "ENTER" }],
        },
      });
      if (!resubmit.ok) {
        return {
          ok: true,
          bytes,
          warning: `iterm resubmit ENTER failed: ${
            resubmit.error || "bridge error"
          }; paste may be left in input`,
        };
      }
    }
    return {
      ok: true,
      bytes,
      warning: "iterm paste placeholder persisted after retries; left in input",
    };
  }
  return { ok: true, bytes };
}

/**
 * Promise sleep used between submit and verify so the screen read sees a
 * post-ENTER frame instead of a stale one.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * "Looks unsubmitted" = either the Claude Code placeholder is visible OR the
 * prompt line still shows the content we pasted. Matching against the pasted
 * content (instead of "any non-empty prompt line") keeps the recipient's own
 * half-typed input and `>`-quoted transcript lines from triggering a stray
 * ENTER that would submit their prompt. Reading the last 8 lines is enough —
 * the prompt area is at the bottom.
 *
 * @param {string} socketPath
 * @param {string} guid
 * @param {string} content  The pasted body being verified.
 * @returns {Promise<boolean|null>} true=unsubmitted (paste still in input),
 *   false=submitted/clear, null=unknown (screen could not be read)
 */
async function screenLooksUnsubmitted(socketPath, guid, content) {
  const resp = await rpc(socketPath, {
    op: "screen",
    params: { guid, lines: VERIFY_SCREEN_LINES },
  });
  if (!resp.ok || !Array.isArray(resp.lines)) return null;
  // (a) Large paste placeholder — easy case.
  if (resp.lines.some((line) => PASTE_PLACEHOLDER_PATTERN.test(line))) {
    return true;
  }
  // (b) Small paste inline in the prompt area. Claude Code renders the
  // active prompt as `❯ <body>` (U+276F HEAVY RIGHT-POINTING ANGLE
  // QUOTATION MARK), other TUIs may use ASCII `>`, or `›`. The most-recent
  // prompt line is near the tail. Only a prompt line whose content matches
  // the pasted body counts as unsubmitted.
  const recent = resp.lines.slice(-5);
  const PROMPT_RE = /^[>›❯]\s+(\S.*)$/;
  for (const raw of recent) {
    const line = (raw || "").trim();
    if (!line) continue;
    if (/^[─━]{3,}$/.test(line)) continue;
    const m = PROMPT_RE.exec(line);
    if (m && promptShowsPastedContent(m[1], content)) {
      return true;
    }
    // Multi-line input wraps under the prompt; if a tail line carries the
    // body's `</a2a>` envelope-tail marker, the body is still in the input
    // field too. Only meaningful when the pasted content actually has one.
    if (
      typeof content === "string" &&
      content.includes("</a2a>") &&
      /<\/a2a>/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Does a prompt line's visible text correspond to the pasted content? The
 * screen may truncate the content (or show all of it), so accept a prefix
 * overlap in either direction against the content's first line.
 *
 * @param {string} promptText  Text after the prompt char on screen.
 * @param {string} content     The pasted body.
 * @returns {boolean}
 */
function promptShowsPastedContent(promptText, content) {
  if (typeof content !== "string" || content === "") return false;
  const shown = String(promptText || "").trim();
  if (!shown) return false;
  const firstLine = content.split("\n", 1)[0].trim();
  if (!firstLine) return false;
  return firstLine.startsWith(shown) || shown.startsWith(firstLine);
}

/**
 * Delivers an ordered op list to an iTerm2 session in a single bridge
 * round-trip. The bridge's `send_keys` op walks the steps array, applying
 * paste/type/key/chord/sleep semantics server-side.
 *
 * @param {object} opts
 * @param {string} opts.target  iTerm2 session GUID.
 * @param {Array<object>} opts.steps  Bridge-shaped op array.
 * @param {string} [opts.socketPath]
 * @returns {Promise<{ ok: boolean; bytes?: number; error?: string; warning?: string }>}
 */
export async function deliverITerm2Sequence({
  target,
  steps,
  socketPath = DEFAULT_SOCKET,
} = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    return { ok: false, error: "target must be a non-empty session guid" };
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }
  // The bridge replies only after executing every step (including sleeps up
  // to SLEEP(60000)), so the timeout must scale with the step list or long
  // sequences "time out" while the bridge delivers anyway.
  const resp = await rpc(
    socketPath,
    {
      op: "send_keys",
      params: { guid: target, steps },
    },
    rpcTimeoutForSteps(steps),
  );
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true, bytes: typeof resp.bytes === "number" ? resp.bytes : undefined };
}

/**
 * Returns the list of iTerm2 sessions known to the bridge.
 *
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; sessions?: Array<object>; error?: string }>}
 */
export async function listITerm2Sessions(socketPath = DEFAULT_SOCKET) {
  const resp = await rpc(socketPath, { op: "list_sessions" });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true, sessions: resp.sessions || [] };
}

/**
 * Captures the tail of an iTerm2 session's screen by GUID.
 *
 * @param {string} guid
 * @param {number} [lines]
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; lines?: string[]; error?: string }>}
 */
export async function screenITerm2Session(guid, lines = 40, socketPath = DEFAULT_SOCKET) {
  const resp = await rpc(socketPath, { op: "screen", params: { guid, lines } });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true, lines: resp.lines || [] };
}

/**
 * Probes the bridge for liveness.
 *
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; version?: string; error?: string }>}
 */
export async function pingITerm2Bridge(socketPath = DEFAULT_SOCKET) {
  const resp = await rpc(socketPath, { op: "ping" }, 1000);
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true, version: resp.version };
}

/**
 * Asks the iTerm bridge to spawn a new window/tab running `command` in `cwd`,
 * name the session `name`, and return its session GUID. Backbone for iTerm-
 * native agent spawning so the agent can be reached by GUID afterwards.
 *
 * @param {object} opts
 * @param {string} opts.name       Agent id used as the iTerm session name.
 * @param {string} opts.cwd        Working directory for the spawn.
 * @param {string} opts.command    Shell pipeline to exec. Wrapped by the
 *                                 bridge inside a self-deleting zsh -l script.
 * @param {"window"|"tab"} [opts.where="window"]
 * @param {string} [opts.parentGuid]   Required when `where === "tab"`.
 * @param {string} [opts.installToken] Ownership marker — the bridge keeps a
 *                                 guid → installToken map persisted next to
 *                                 the socket; `a2a kill --all` orphan sweep
 *                                 uses it to prove the session is a2a-owned.
 *                                 tmux analog: `@a2a-install-token` session
 *                                 option.
 * @param {string} [opts.socketPath]
 * @returns {Promise<{ ok: boolean; guid?: string; error?: string }>}
 */
export async function spawnITerm2Window({
  name,
  cwd,
  command,
  where = "window",
  parentGuid,
  installToken,
  shell = process.env.SHELL || "/bin/sh",
  pathEnv = process.env.PATH || "",
  socketPath = DEFAULT_SOCKET,
} = {}) {
  if (typeof name !== "string" || name.trim() === "")
    return { ok: false, error: "name required" };
  if (typeof cwd !== "string" || cwd.trim() === "")
    return { ok: false, error: "cwd required" };
  if (typeof command !== "string" || command.trim() === "")
    return { ok: false, error: "command required" };
  const params = { name, cwd, command, where };
  if (where === "tab") params.parent_guid = parentGuid;
  if (typeof installToken === "string" && installToken)
    params.install_token = installToken;
  if (typeof shell === "string" && shell) params.shell = shell;
  if (typeof pathEnv === "string" && pathEnv) params.path_env = pathEnv;
  // Spawning a window takes longer than the default rpc timeout (5s) on a
  // cold iTerm. Give it 15s.
  const resp = await rpc(socketPath, { op: "spawn", params }, 15000);
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return {
    ok: true,
    guid: typeof resp.guid === "string" ? resp.guid : undefined,
  };
}

/**
 * Closes an iTerm session by GUID.
 *
 * @param {string} guid
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function closeITerm2Session(guid, socketPath = DEFAULT_SOCKET) {
  if (typeof guid !== "string" || guid.trim() === "")
    return { ok: false, error: "guid required" };
  const resp = await rpc(socketPath, { op: "close", params: { guid } });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true };
}

/**
 * Activates (brings to front) an iTerm session by GUID.
 *
 * @param {string} guid
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function focusITerm2Session(guid, socketPath = DEFAULT_SOCKET) {
  if (typeof guid !== "string" || guid.trim() === "")
    return { ok: false, error: "guid required" };
  const resp = await rpc(socketPath, { op: "focus", params: { guid } });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true };
}

/**
 * Apply post-spawn session config. Right now the only knob is
 * `nativeScroll` — when true (default), iTerm's "Allow Alternate Mouse
 * Scroll" profile property is set to NO on the session so mouse-wheel
 * scrolling moves iTerm's buffer instead of being forwarded as up/down
 * arrows to the running app.
 *
 * @param {object} opts
 * @param {string} opts.guid
 * @param {boolean} [opts.nativeScroll=true]
 * @param {string} [opts.socketPath]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function configureITerm2Session({
  guid,
  nativeScroll = true,
  socketPath = DEFAULT_SOCKET,
} = {}) {
  if (typeof guid !== "string" || guid.trim() === "")
    return { ok: false, error: "guid required" };
  const resp = await rpc(socketPath, {
    op: "configure_session",
    params: { guid, native_scroll: nativeScroll },
  });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true };
}

/**
 * Renames an iTerm session by GUID.
 *
 * @param {string} guid
 * @param {string} name
 * @param {string} [socketPath]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function setITerm2SessionName(
  guid,
  name,
  socketPath = DEFAULT_SOCKET,
) {
  if (typeof guid !== "string" || guid.trim() === "")
    return { ok: false, error: "guid required" };
  if (typeof name !== "string" || name.trim() === "")
    return { ok: false, error: "name required" };
  const resp = await rpc(socketPath, {
    op: "set_name",
    params: { guid, name },
  });
  if (!resp.ok) return { ok: false, error: resp.error || "bridge error" };
  return { ok: true };
}
