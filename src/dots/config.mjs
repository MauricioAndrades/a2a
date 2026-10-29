import { homedir } from "node:os";
import { join } from "node:path";

export function positiveInteger(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return number;
}

export function agentId(value, name = "agent") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value.trim())) {
    throw new Error(`${name} must be an agent id, not an option or team reference`);
  }
  return value.trim();
}

export function httpBaseUrl(value, name) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) base URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function dotsConfig(env = process.env) {
  const host = env.A2A_DOTS_HOST ?? "127.0.0.1";
  if (!host || /[\s/[\]]/.test(host) || host.includes("://")) {
    throw new Error("A2A_DOTS_HOST must be a bare hostname or IP");
  }
  const port = positiveInteger(env.A2A_DOTS_PORT, "A2A_DOTS_PORT", 7743, 65535);
  const callbackPort = positiveInteger(env.A2A_DOTS_CALLBACK_PORT, "A2A_DOTS_CALLBACK_PORT", 7744, 65535);
  if (port === callbackPort) {
    throw new Error("MCP and callback ports must differ");
  }
  const mcpPath = env.A2A_DOTS_MCP_PATH ?? "/mcp";
  if (!mcpPath.startsWith("/") || /[?#\s]/.test(mcpPath) || mcpPath === "/health") {
    throw new Error("A2A_DOTS_MCP_PATH must be an absolute path other than /health");
  }
  const callbackUrl = httpBaseUrl(env.A2A_DOTS_CALLBACK_URL ?? `http://127.0.0.1:${callbackPort}`, "A2A_DOTS_CALLBACK_URL");
  const mcpUrl = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  if (new URL(callbackUrl).origin === mcpUrl.origin) {
    throw new Error("A2A_DOTS_CALLBACK_URL must not point at the MCP listener");
  }
  return {
    host, port, callbackPort, mcpPath,
    bridgeUrl: httpBaseUrl(env.A2A_BRIDGE ?? "http://127.0.0.1:7742", "A2A_BRIDGE"),
    bridgeKey: env.A2A_KEY ?? "",
    dotId: agentId(env.A2A_DOTS_AGENT_ID ?? "dot", "A2A_DOTS_AGENT_ID"),
    bin: env.A2A_DOTS_BIN ?? "a2a",
    callbackUrl,
    maxInbox: positiveInteger(env.A2A_DOTS_MAX_INBOX, "A2A_DOTS_MAX_INBOX", 1000),
    requestTimeoutMs: positiveInteger(env.A2A_DOTS_REQUEST_TIMEOUT_MS, "A2A_DOTS_REQUEST_TIMEOUT_MS", 2000, 60000),
    reconcileMs: positiveInteger(env.A2A_DOTS_RECONCILE_MS, "A2A_DOTS_RECONCILE_MS", 2000, 60000),
    events: eventsConfig(env, mcpUrl.origin),
  };
}

// Event subscription settings. Without A2A_DOTS_EVENTS_KEY the endpoint still
// answers server/discover and advertises the capability, but accepts no
// subscription and therefore no callback destination from anyone.
export function eventsConfig(env = process.env, selfOrigin = "") {
  const eventsKey = env.A2A_DOTS_EVENTS_KEY ?? "";
  if (eventsKey && eventsKey.length < 16) {
    throw new Error("A2A_DOTS_EVENTS_KEY must be at least 16 characters");
  }
  const defaultTtlMs = positiveInteger(env.A2A_DOTS_EVENTS_TTL_MS, "A2A_DOTS_EVENTS_TTL_MS", 86400000, 2592000000);
  const minTtlMs = positiveInteger(env.A2A_DOTS_EVENTS_MIN_TTL_MS, "A2A_DOTS_EVENTS_MIN_TTL_MS", 60000, 2592000000);
  const origins = (env.A2A_DOTS_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    eventsKey,
    eventsPrincipal: env.A2A_DOTS_EVENTS_PRINCIPAL ?? "chatgpt",
    // Persisted outside the checkout by default so a running adapter never
    // writes subscription state or signing material into the repository.
    stateDir: env.A2A_DOTS_STATE_DIR ?? join(homedir(), ".a2a", "dots"),
    // An authenticated callback route is what lets an event say the bridge
    // route was verified. Unset keeps the existing unauthenticated behavior
    // and the event payload reports the sender as claimed only.
    callbackKey: env.A2A_DOTS_CALLBACK_KEY ?? "",
    defaultTtlMs,
    minTtlMs,
    maxTtlMs: positiveInteger(env.A2A_DOTS_EVENTS_MAX_TTL_MS, "A2A_DOTS_EVENTS_MAX_TTL_MS", defaultTtlMs, 2592000000),
    allowUnboundedTtl: env.A2A_DOTS_EVENTS_ALLOW_UNBOUNDED_TTL === "1",
    verificationTtlMs: positiveInteger(env.A2A_DOTS_EVENTS_VERIFICATION_TTL_MS, "A2A_DOTS_EVENTS_VERIFICATION_TTL_MS", 3600000, 86400000),
    maxAttempts: positiveInteger(env.A2A_DOTS_EVENTS_MAX_ATTEMPTS, "A2A_DOTS_EVENTS_MAX_ATTEMPTS", 5, 20),
    retryBaseMs: positiveInteger(env.A2A_DOTS_EVENTS_RETRY_BASE_MS, "A2A_DOTS_EVENTS_RETRY_BASE_MS", 1000, 60000),
    retryMaxMs: positiveInteger(env.A2A_DOTS_EVENTS_RETRY_MAX_MS, "A2A_DOTS_EVENTS_RETRY_MAX_MS", 30000, 600000),
    deliveryDeadlineMs: positiveInteger(env.A2A_DOTS_EVENTS_DEADLINE_MS, "A2A_DOTS_EVENTS_DEADLINE_MS", 5000, 60000),
    maxJournal: positiveInteger(env.A2A_DOTS_EVENTS_MAX_JOURNAL, "A2A_DOTS_EVENTS_MAX_JOURNAL", 500, 100000),
    allowedOrigins: origins.length ? origins : (selfOrigin ? [selfOrigin] : []),
  };
}
