import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  appendFileSync,
  renameSync,
  linkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  join,
  relative,
  resolve,
  sep,
  dirname,
  extname,
  isAbsolute,
  normalize,
} from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const A2A_ROOT = resolve(join(__dirname, ".."));

const CONFIG_FILE = join(A2A_ROOT, "config.json");
const REGISTRY_FILE = join(A2A_ROOT, "registry.json");
const GROUPS_DIR = join(A2A_ROOT, "groups");
const TEAMS_DIR = join(A2A_ROOT, "teams");
const PID_FILE = join(A2A_ROOT, "bridge.pid");
const DEFAULT_LOG_FILE = join(A2A_ROOT, "messages.log");

const DEFAULT_PORT = 7742;
const DEFAULT_HOST = "127.0.0.1";
const FILE_MODE_DEFAULT = 0o644;
const FILE_MODE_SECRET = 0o600;
const INSTALL_TOKEN_PREFIX = "ai-";
const INSTALL_TOKEN_BYTES = 8;
const SHARED_KEY_PREFIX = "a2a-";
const SHARED_KEY_BYTES = 16;

const CONFIG_DEFAULTS = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  url: null,
  key: null,
  peers: {},
  // When true, `a2a start` defaults to global mode (ngrok exposure + peer
  // fan-out tagging). Setting this with `a2a config set global true` lets
  // operators avoid typing `--global` for every start while keeping the
  // explicit `--no-global` escape hatch for one-off local starts.
  global: false,
  // Delivery transport. "tmux" pastes into tmux panes; "iterm" routes through
  // the a2a iTerm2 bridge (cmd/a2a-iterm2-bridge) so messages target iTerm2
  // sessions by GUID without any tmux dependency. An invalid persisted value
  // is coerced back to "tmux" on load with a one-time stderr warning (the
  // transport router cannot fail per-message on a value that never survives
  // loadConfig).
  protocol: "tmux",
  log: {
    mode: "on",
    path: DEFAULT_LOG_FILE,
    maxBytes: 0,
    redactRemote: false,
  },
};

const REGISTRY_DEFAULTS = {
  // agents is intentionally a list of plain ids; the bridge is the source
  // of truth for live state. This cache is a hint for token classification
  // (so a2a-tokens.mjs can resolve `--scout` even when the bridge is down)
  // and an orphan-candidate seed for `a2a kill --all`. The orphan classifier
  // additionally requires a tmux @a2a-install-token match before treating a
  // session as a2a-owned, so stale ids in this list cannot collide with
  // unrelated user sessions.
  agents: [],
  groups: [],
  // installToken: random per-install identifier. Generated lazily on first
  // spawn. Pinned onto every a2a-spawned tmux session as the
  // @a2a-install-token option so list/kill can prove ownership.
  installToken: null,
};

const USER_KEYS = [
  "port",
  "host",
  "url",
  "key",
  "global",
  "protocol",
  "log.mode",
  "log.path",
  "log.maxBytes",
  "log.redactRemote",
];

const PROTOCOLS = ["tmux", "iterm"];
const PROTOCOL_SET = new Set(PROTOCOLS);
const USER_KEY_SET = new Set(USER_KEYS);
const USER_KEY_PREFIXES = new Set();
for (const key of USER_KEYS) {
  const dotIndex = key.indexOf(".");
  if (dotIndex !== -1) USER_KEY_PREFIXES.add(key.slice(0, dotIndex));
}

// One warning per distinct invalid value per process: loadConfig runs on
// nearly every config accessor, so an unconditional warn would spam stderr.
const warnedInvalidProtocolValues = new Set();

function warnInvalidProtocolOnce(value) {
  const key = JSON.stringify(value);
  if (warnedInvalidProtocolValues.has(key)) return;
  warnedInvalidProtocolValues.add(key);
  console.warn(
    `a2a: persisted protocol ${key} is invalid (expected one of: ${PROTOCOLS.join(", ")}); using "${CONFIG_DEFAULTS.protocol}"`,
  );
}

function normalizeProtocolValue(value) {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "iterm2") return "iterm";
    if (PROTOCOL_SET.has(v)) return v;
  }
  // configSet throws for the same value, but a hand-edited or stale
  // config.json still has to load. Coerce to the default, loudly: silent
  // coercion contradicted the schema enum and hid misconfiguration.
  warnInvalidProtocolOnce(value);
  return CONFIG_DEFAULTS.protocol;
}

// ---------- path/io helpers ----------

export function stripTrailingSlash(s) {
  return String(s).replace(/\/+$/, "");
}

export function ensureDirs(dirPath) {
  if (!dirPath || typeof dirPath !== "string") {
    throw new Error("ensureDirs: dirPath must be a non-empty string");
  }
  mkdirSync(targetDirectoryFor(normalizeFsPath(dirPath)), { recursive: true });
}

/**
 * Resolve an input string to an absolute filesystem path. Accepts:
 *   - `file://` URLs — converted via fileURLToPath
 *   - regular path strings — resolved against cwd
 *
 * Rejects any other URL scheme (http://, https://, etc.) by throwing, so an
 * invalid input cannot silently become a bogus local path.
 */
export function normalizeFsPath(input) {
  const trimmed = input.trim();
  if (URL.canParse(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "file:") {
      throw new Error(
        `ensureDirs: unsupported URL scheme in '${input}' (expected file:// or a plain path)`,
      );
    }
    return normalize(fileURLToPath(parsed));
  }
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(trimmed);
}

/**
 * Heuristic for "does this path look like a file?" used only when statSync
 * fails (path doesn't exist yet). Treats dotfiles (`.env`, `.gitignore`) as
 * files even though they have no extension by the usual definition.
 */
export function looksLikeFilePath(p) {
  const base = basename(p);
  if (base.startsWith(".") && !base.includes(".", 1)) return true; // dotfile like .env
  return extname(base).length > 0;
}

export function targetDirectoryFor(normalizedPath) {
  try {
    const stats = statSync(normalizedPath);
    return stats.isDirectory() ? normalizedPath : dirname(normalizedPath);
  } catch {
    return looksLikeFilePath(normalizedPath)
      ? dirname(normalizedPath)
      : normalizedPath;
  }
}

function normalizeHttpBaseUrlForConfig(value, label) {
  if (value === "" || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(
      `${label} must be a valid URL (e.g. https://example.ngrok-free.dev)`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http:// or https://`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function mergeDefaults(defaults, value, opts = {}) {
  const replace = new Set(opts.replace || []);
  if (
    defaults == null ||
    typeof defaults !== "object" ||
    Array.isArray(defaults) ||
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value === undefined ? defaults : value;
  }
  const out = { ...defaults };
  for (const [key, child] of Object.entries(value)) {
    if (replace.has(key)) {
      out[key] = child;
    } else {
      out[key] = mergeDefaults(defaults[key], child, opts);
    }
  }
  return out;
}

export function readJson(path, defaults) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return mergeDefaults(defaults, {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to read JSON '${path}': ${message}. Fix or remove this file and retry.`,
      { cause: err },
    );
  }
  if (!raw) return mergeDefaults(defaults, {});
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to read JSON '${path}': ${message}. Fix or remove this file and retry.`,
      { cause: err },
    );
  }
  // A top-level array/scalar used to silently behave as all-defaults (and
  // mergeDefaults spread array indices into an object). Fail loudly instead.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `'${path}' must be a JSON object (found ${Array.isArray(parsed) ? "an array" : typeof parsed}). Fix or remove this file and retry.`,
    );
  }
  return mergeDefaults(defaults, parsed);
}

export function writeJson(path, data, mode = FILE_MODE_DEFAULT) {
  ensureDirs(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)  }\n`, { mode });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

// ---------- config ----------

function normalizeLoadedConfig(cfg) {
  const out = { ...cfg };
  if ("protocol" in out) {
    out.protocol = normalizeProtocolValue(out.protocol);
  }
  return out;
}

export function loadConfig() {
  return normalizeLoadedConfig(readJson(CONFIG_FILE, CONFIG_DEFAULTS));
}

export function patchConfig(changes) {
  const normalized = { ...changes };
  if ("protocol" in normalized) {
    normalized.protocol = normalizeProtocolValue(normalized.protocol);
  }
  const updated = mergeDefaults(loadConfig(), normalized, { replace: ["peers"] });
  writeJson(CONFIG_FILE, updated, FILE_MODE_SECRET);
  return updated;
}

export function nestedGet(obj, dotted) {
  return dotted
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function nestedSet(obj, dotted, value) {
  const parts = dotted.split(".");
  const out = { ...obj };
  let cursor = out;
  for (const part of parts.slice(0, -1)) {
    // Replace non-object intermediates instead of spreading them: spreading a
    // string ({...'broken'}) explodes into index keys ({"0":"b","1":"r",...}).
    const child = cursor[part];
    cursor[part] =
      child != null && typeof child === "object" && !Array.isArray(child)
        ? { ...child }
        : {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return out;
}

export function configGet(key) {
  const cfg = loadConfig();
  if (key !== undefined) {
    const value = nestedGet(cfg, key);
    if (USER_KEY_SET.has(key)) return value ?? null;
    if (value !== undefined) return value;
    throw new Error(`unknown setting: ${key}`);
  }
  // ls: known keys + any extra top-level keys present in the persisted config.
  // Top-level names that are the prefix of a known nested key (e.g. "log"
  // when "log.mode" is documented) are skipped so the listing stays flat.
  const extras = Object.keys(cfg).filter(
    (k) => !USER_KEY_SET.has(k) && !USER_KEY_PREFIXES.has(k),
  );
  return Object.fromEntries(
    [...USER_KEYS, ...extras].map((k) => [k, nestedGet(cfg, k) ?? null]),
  );
}

const COERCERS = {
  port: (value) => parseStrictInteger(value, "port", { min: 1, max: 65535 }),
  host: (value) => normalizeHost(value),
  url: (value) => normalizeHttpBaseUrlForConfig(value, "url"),
  key: (value) => {
    if (value === "" || value === null) return null;
    if (typeof value !== "string") throw new Error("key must be a string");
    const trimmed = value.trim();
    return trimmed || null;
  },
  global: (value) => {
    // Accept boolean inputs from programmatic callers and string inputs
    // from the CLI ("a2a config set global true"). Anything else is a hard
    // error — silently coercing arbitrary truthy values would make
    // misconfiguration invisible.
    if (value === true || value === false) return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("global must be true or false");
  },
  protocol: (value) => {
    if (typeof value !== "string") throw new Error("protocol must be a string");
    const v = value.trim().toLowerCase();
    if (v === "iterm2") return "iterm";
    if (!PROTOCOL_SET.has(v)) {
      throw new Error(`protocol must be one of ${PROTOCOLS.join(", ")}`);
    }
    return v;
  },
  "log.mode": (value) => {
    if (value !== "on" && value !== "off")
      throw new Error("log.mode must be on or off");
    return value;
  },
  "log.path": (value) => {
    if (value === "" || value === null) return null;
    if (typeof value !== "string") throw new Error("log.path must be a string");
    return value;
  },
  "log.maxBytes": (value) => parseStrictInteger(value, "log.maxBytes", { min: 0 }),
  "log.redactRemote": (value) => {
    if (value === true || value === false) return value;
    if (value !== "true" && value !== "false")
      throw new Error("log.redactRemote must be true or false");
    return value === "true";
  },
};

// Top-level config namespaces the schema declares as closed objects
// (additionalProperties: false / fixed value shapes). configSet must not
// write arbitrary values into them: `log.bogus` or a string `log` would
// persist a config the schema rejects and break logConfig()/peerKeyForUrl().
const CLOSED_CONFIG_NAMESPACES = new Set(["log", "peers"]);

export function configSet(key, value) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("config set requires a non-empty key");
  }
  // Known keys keep their strict coercion (ports must be ints, log.mode must
  // be on|off, etc.). Novel top-level keys are stored as the raw value —
  // config.schema.json allows additional top-level properties — but keys
  // inside schema-closed namespaces must be documented settings.
  // Object.hasOwn so `config set toString x` can't dredge up a prototype fn.
  const coerce = Object.hasOwn(COERCERS, key) ? COERCERS[key] : undefined;
  if (!coerce && CLOSED_CONFIG_NAMESPACES.has(key.split(".")[0])) {
    throw new Error(`unknown setting: ${key}`);
  }
  const coerced = coerce ? coerce(value) : value;
  const updated = patchConfig(nestedSet(loadConfig(), key, coerced));
  return nestedGet(updated, key);
}

function parseStrictInteger(
  value,
  label,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    if (max !== Number.MAX_SAFE_INTEGER) {
      throw new Error(`${label} must be between ${min} and ${max}`);
    }
    throw new Error(
      `${label} must be ${min > 0 ? "a positive" : "a non-negative"} integer`,
    );
  }
  return n;
}

export function activeKey() {
  const env = (process.env.A2A_KEY || "").trim();
  return env || loadConfig().key || null;
}

export function activePort() {
  const env = process.env.A2A_PORT;
  if (env) {
    try {
      return parseStrictInteger(env, "A2A_PORT", { min: 1, max: 65535 });
    } catch {
      console.warn(
        `a2a: A2A_PORT=${JSON.stringify(env)} is not a valid port number, ignoring`,
      );
    }
  }
  const n = loadConfig().port;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

function normalizeHost(value, label = "host") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("://") || trimmed.includes("/")) {
    throw new Error(`${label} must be a bare hostname or IP`);
  }
  return trimmed;
}

export function activeHost() {
  const env = process.env.A2A_HOST;
  if (env) {
    try {
      return normalizeHost(env, "A2A_HOST");
    } catch {
      console.warn(`a2a: A2A_HOST=${JSON.stringify(env)} is invalid, ignoring`);
    }
  }
  return loadConfig().host || DEFAULT_HOST;
}

/**
 * The bridge's public, ngrok-exposed URL. This is the address peers POST to
 * when calling you from another machine. Stored in config so `start-global`
 * and peer-share flows don't have to re-query the ngrok API every time.
 *
 * Returns null when no public URL has been persisted.
 */
export function activeUrl() {
  const env = (process.env.A2A_PUBLIC_URL || "").trim();
  if (env) return normalizeHttpBaseUrlForConfig(env, "A2A_PUBLIC_URL");
  const cfg = loadConfig().url;
  return cfg ? normalizeHttpBaseUrlForConfig(cfg, "url") : null;
}

export function bridgeUrl() {
  return process.env.A2A_BRIDGE || `http://${activeHost()}:${activePort()}`;
}

export function readPid() {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writePid(pid) {
  try {
    const tmp = `${PID_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, String(pid));
    renameSync(tmp, PID_FILE);
  } catch {
    /* best effort */
  }
}

export function removePid(expectedPid = null) {
  try {
    if (expectedPid != null) {
      const current = readPid();
      if (current !== expectedPid) return;
    }
    unlinkSync(PID_FILE);
  } catch {
    /* best effort */
  }
}

// ---------- groups ----------

/** Single segment only: no slashes, no ".." escapes; aligns with ~/.claude/skills/a2a/groups/<name>/ */
const SAFE_GROUP_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Rejects traversal before any path joins / statSync — use in tests + internal guard. */
export function isTrustedGroupPathSegment(name) {
  if (name == null || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return false;
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\"))
    return false;
  return SAFE_GROUP_SEGMENT.test(trimmed);
}

export function resolvedTrustedGroupDirectory(name) {
  if (!isTrustedGroupPathSegment(name)) return null;
  const trimmed = name.trim();

  const abs = resolve(join(GROUPS_DIR, trimmed));
  const root = resolve(GROUPS_DIR);
  const rel = relative(root, abs);
  if (rel === "" || rel.split(sep).includes("..")) return null;
  return abs;
}

export function isExistingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function sanitizeAgentName(filename) {
  const base = filename
    .replace(/\.md$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "agent";
}

export function isGroup(name) {
  const dir = resolvedTrustedGroupDirectory(name);
  if (dir == null) return false;
  return isExistingDirectory(dir);
}

export function listGroupNames() {
  try {
    return readdirSync(GROUPS_DIR).filter(
      (n) =>
        isTrustedGroupPathSegment(n) &&
        isExistingDirectory(join(GROUPS_DIR, n)),
    );
  } catch {
    return [];
  }
}

export function listGroupMembers(groupName) {
  const dir = resolvedTrustedGroupDirectory(groupName);
  if (dir == null) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({
        name: sanitizeAgentName(f),
        fullPath: join(dir, f),
      }));
  } catch {
    return [];
  }
}

export function teamSpecsDir() {
  ensureDirs(TEAMS_DIR);
  return TEAMS_DIR;
}

export function listTeamSpecNames() {
  try {
    return readdirSync(TEAMS_DIR)
      .filter((f) => /\.(json|ya?ml)$/i.test(f))
      .map((f) => f.replace(/\.(json|ya?ml)$/i, ""));
  } catch {
    return [];
  }
}

// ---------- registry ----------

export function loadRegistry() {
  return readJson(REGISTRY_FILE, REGISTRY_DEFAULTS);
}

/**
 * registry.schema.json declares additionalProperties: false, so writes must
 * only ever persist the documented keys. Callers habitually spread the loaded
 * registry back in ({ ...cached, agents }), which used to re-persist any
 * unknown keys a hand-edited file carried.
 */
function normalizeRegistryShape(data) {
  const src =
    data != null && typeof data === "object" && !Array.isArray(data)
      ? data
      : {};
  return {
    agents: Array.isArray(src.agents) ? src.agents : [],
    groups: Array.isArray(src.groups) ? src.groups : [],
    installToken:
      typeof src.installToken === "string" && src.installToken
        ? src.installToken
        : null,
  };
}

export function saveRegistry(data) {
  writeJson(REGISTRY_FILE, normalizeRegistryShape(data));
}

/**
 * Stable per-install identity used to prove a tmux session was spawned by
 * this a2a install. Lazily generated on first call; persisted to
 * registry.json so subsequent spawns reuse the same value. Side-effect free
 * if a token is already present.
 *
 * The token must never be reused across installs, which is why generation
 * is gated on absence in the persisted file (not on env state).
 *
 * First-call semantics are write-if-absent: two concurrent first spawns used
 * to mint different tokens with last-writer-wins, leaving every session
 * tagged with the losing token invisible to `kill --all`. When registry.json
 * does not exist yet the claim is atomic (link(2) fails with EEXIST for the
 * loser, who then adopts the winner's token); when it exists without a token
 * we re-read after writing and return whatever actually persisted.
 */
export function installToken() {
  const cached = loadRegistry();
  if (cached.installToken && typeof cached.installToken === "string") {
    return cached.installToken;
  }
  const token =
    INSTALL_TOKEN_PREFIX + randomBytes(INSTALL_TOKEN_BYTES).toString("hex");
  if (claimRegistryFileWithToken(cached, token)) return token;

  // registry.json exists (possibly created by a concurrent first spawn
  // between our load and our claim). Adopt an already-claimed token.
  const current = loadRegistry();
  if (current.installToken && typeof current.installToken === "string") {
    return current.installToken;
  }
  saveRegistry({ ...current, installToken: token });
  const persisted = loadRegistry().installToken;
  return typeof persisted === "string" && persisted ? persisted : token;
}

/**
 * Atomically create registry.json with the freshly minted token. Writes the
 * full content to a temp file first, then link(2)s it into place — link fails
 * with EEXIST when the registry already exists, so exactly one concurrent
 * caller can win and no reader can observe a partially written file.
 *
 * Returns true when this process won the claim.
 */
function claimRegistryFileWithToken(cached, token) {
  ensureDirs(REGISTRY_FILE);
  const tmp = `${REGISTRY_FILE}.${process.pid}.${Date.now()}.claim.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify(normalizeRegistryShape({ ...cached, installToken: token }), null, 2)}\n`,
      { mode: FILE_MODE_DEFAULT },
    );
    linkSync(tmp, REGISTRY_FILE);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

export function generateKey() {
  return SHARED_KEY_PREFIX + randomBytes(SHARED_KEY_BYTES).toString("hex");
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return stripTrailingSlash(value || "");
  }
}

export function peerKeyForUrl(url) {
  const normalized = canonicalHttpUrl(url || "");
  const peers = loadConfig().peers || {};
  for (const [, peer] of Object.entries(peers)) {
    if (canonicalHttpUrl(peer?.url || "") === normalized) {
      return peer?.key || null;
    }
  }
  return null;
}

// ---------- logging ----------

export function logConfig() {
  const cfg = loadConfig();
  return { ...CONFIG_DEFAULTS.log, ...(cfg.log || {}) };
}

/**
 * Resolve a configured log path to an absolute path: a leading `~/` expands
 * to the user's home directory, and relative paths resolve against A2A_ROOT
 * (matching DEFAULT_LOG_FILE) — never against the per-process cwd, which
 * used to create literal `./~/` directories and scatter logs across whatever
 * directory each agent happened to run from.
 */
function resolveConfiguredLogPath(p) {
  const trimmed = p.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(A2A_ROOT, trimmed);
}

export function messageLogPath() {
  const env = (process.env.A2A_LOG_FILE || "").trim();
  const configured = env || logConfig().path || DEFAULT_LOG_FILE;
  if (typeof configured !== "string" || configured.trim() === "") {
    return DEFAULT_LOG_FILE;
  }
  return resolveConfiguredLogPath(configured);
}

export function messageLogEnabled() {
  if (process.env.A2A_LOG === "0") return false;
  if (process.env.A2A_LOG === "1") return true;
  return logConfig().mode !== "off";
}

export function messageLogMaxBytes() {
  const n = Number(logConfig().maxBytes || 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function messageLogRedactRemote() {
  return logConfig().redactRemote === true;
}

// ---------- log header / tail truncation ----------

const BYTE_LF = 0x0a;
const BYTE_OPEN_BRACKET = 0x5b;
const BYTE_DIGIT_0 = 0x30;
const BYTE_DIGIT_9 = 0x39;
const BYTE_DASH = 0x2d;
const BYTE_T = 0x54;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_MARKER = 0x80;
const ISO_HEADER_TAIL_LEN = 11; // bytes after `[`: 4 digit year, dash, 2 digit month, dash, 2 digit day, T

export function isAsciiDigit(b) {
  return b >= BYTE_DIGIT_0 && b <= BYTE_DIGIT_9;
}

export function isUtf8Continuation(b) {
  return (b & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_MARKER;
}

/**
 * Last maxBytes bytes of the log chunk, stripping any leading orphaned UTF-8
 * continuation bytes and skipping any partial leading row so retention starts
 * at a header line `[YYYY-MM-DDThh:mm:ss...]`.
 *
 * Exported for tests.
 */
export function truncateRotatedMessageLogTail(buf, maxBytes) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length <= maxBytes) return Buffer.from(b);

  let chunk = b.subarray(b.length - maxBytes);
  chunk = stripLeadingUtf8Continuations(chunk);

  const atZero = isoLogHeaderStartsAt(chunk, 0, true);
  if (atZero !== null) return chunk.subarray(atZero);

  const nextHeader = findNextLineStartedHeader(chunk);
  if (nextHeader !== null) return chunk.subarray(nextHeader);

  return chunk;
}

export function stripLeadingUtf8Continuations(chunk) {
  let strip = 0;
  while (strip < chunk.length && isUtf8Continuation(chunk[strip])) strip++;
  return chunk.subarray(strip);
}

export function findNextLineStartedHeader(chunk) {
  for (let i = 1; i + ISO_HEADER_TAIL_LEN + 1 <= chunk.length; i++) {
    if (chunk[i - 1] !== BYTE_LF || chunk[i] !== BYTE_OPEN_BRACKET) continue;
    const h = isoLogHeaderStartsAt(chunk, i, false);
    if (h !== null) return h;
  }
  return null;
}

export function isoLogHeaderStartsAt(buf, bracketIdx, atChunkStart) {
  if (bracketIdx + ISO_HEADER_TAIL_LEN >= buf.length) return null;
  if (!atChunkStart && bracketIdx !== 0 && buf[bracketIdx - 1] !== BYTE_LF)
    return null;
  if (buf[bracketIdx] !== BYTE_OPEN_BRACKET) return null;

  const i = bracketIdx + 1;
  if (!isAsciiDigit(buf[i])) return null; // Y
  if (!isAsciiDigit(buf[i + 1])) return null; // Y
  if (!isAsciiDigit(buf[i + 2])) return null; // Y
  if (!isAsciiDigit(buf[i + 3])) return null; // Y
  if (buf[i + 4] !== BYTE_DASH) return null;
  if (!isAsciiDigit(buf[i + 5])) return null; // M
  if (!isAsciiDigit(buf[i + 6])) return null; // M
  if (buf[i + 7] !== BYTE_DASH) return null;
  if (!isAsciiDigit(buf[i + 8])) return null; // D
  if (!isAsciiDigit(buf[i + 9])) return null; // D
  if (buf[i + 10] !== BYTE_T) return null;
  return bracketIdx;
}

// ---------- ANSI stripping ----------

const ESC = 0x1b;
const BEL = 0x07;
const CSI_INTRODUCER = 0x5b; // [
const OSC_INTRODUCER = 0x5d; // ]
const STRING_TERMINATOR_TAIL = 0x5c; // \  (paired with ESC for ST)

export function isCsiParamByte(b) {
  return b >= 0x30 && b <= 0x3f;
}
export function isCsiIntermediateByte(b) {
  return b >= 0x20 && b <= 0x2f;
}
export function isCsiFinalByte(b) {
  return b >= 0x40 && b <= 0x7e;
}
export function isEscFinalByte(b) {
  return b >= 0x30 && b <= 0x7e;
}

/**
 * Remove ANSI escape sequences from a string.
 *
 * State-machine scan (no regex) implementing the ECMA-48 / ECMA-35 escape
 * grammar so that:
 *   - CSI: `\x1b[ <param 0x30-0x3f>* <intermediate 0x20-0x2f>* <final 0x40-0x7e>`.
 *     Covers `m` (SGR color), `K` (erase line), `H` (cursor home),
 *     `?25l` (hide cursor), `2J` (erase screen), etc.
 *   - OSC: `\x1b] ... <terminator>` where `<terminator>` is BEL (0x07) or
 *     ESC \\ (string terminator). Used by modern TUIs for terminal titles
 *     and OSC 8 hyperlinks.
 *   - All other ESC sequences: `\x1b <intermediate 0x20-0x2f>* <final 0x30-0x7e>`.
 *     This single rule covers Fp (`\x1b 7` save-cursor, `\x1b 8` restore),
 *     Fe (`\x1b D` index, `\x1b M` reverse index), Fs (`\x1b c` reset RIS),
 *     and nF (`\x1b ( B` charset designation, etc.).
 *
 * Persisted log lines and grep targets MUST go through this function; the
 * earlier SGR-only and Fe-only implementations left OSC sequences,
 * cursor-move CSIs, and nF charset switches in place, breaking downstream
 * pure-text matching.
 */
export function stripAnsiCodes(s) {
  const input = String(s);
  const out = [];
  let i = 0;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (c !== ESC) {
      out.push(input[i]);
      i++;
      continue;
    }

    if (i + 1 >= input.length) {
      i++;
      continue;
    } // lone ESC at EOF

    const introducer = input.charCodeAt(i + 1);
    if (introducer === CSI_INTRODUCER) {
      i = scanCsi(input, i);
      continue;
    }
    if (introducer === OSC_INTRODUCER) {
      i = scanOsc(input, i);
      continue;
    }
    i = scanGenericEsc(input, i);
  }
  return out.join("");
}

// Each scan* returns the next index to resume from. They never push output —
// every byte consumed by an ANSI sequence is dropped by definition.

export function scanCsi(input, start) {
  let j = start + 2;
  while (j < input.length && isCsiParamByte(input.charCodeAt(j))) j++;
  while (j < input.length && isCsiIntermediateByte(input.charCodeAt(j))) j++;
  if (j < input.length && isCsiFinalByte(input.charCodeAt(j))) return j + 1;
  return start + 2; // malformed — drop ESC [ only
}

export function scanOsc(input, start) {
  let j = start + 2;
  while (j < input.length) {
    const k = input.charCodeAt(j);
    if (k === BEL) return j + 1;
    if (
      k === ESC &&
      j + 1 < input.length &&
      input.charCodeAt(j + 1) === STRING_TERMINATOR_TAIL
    ) {
      return j + 2;
    }
    j++;
  }
  return input.length; // unterminated OSC — consume rest
}

export function scanGenericEsc(input, start) {
  let j = start + 1;
  while (j < input.length && isCsiIntermediateByte(input.charCodeAt(j))) j++;
  if (j < input.length && isEscFinalByte(input.charCodeAt(j))) return j + 1;
  return start + 1; // unknown — drop only the ESC byte
}

// ---------- message log ----------

function cleanLogHeaderField(value, fallback = "?") {
  const cleaned = stripAnsiCodes(value == null ? "" : String(value))
    .replace(/[\r\n]+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function formatLogStatus(entry) {
  const transport = entry.transport
    ? ` via ${cleanLogHeaderField(entry.transport, "unknown")}`
    : "";
  return entry.ok
    ? `ok${transport}`
    : `FAIL${transport}: ${cleanLogHeaderField(entry.error || "unknown", "unknown")}`;
}

export function formatLogBytes(entry) {
  return Number.isFinite(entry.bytes) ? `${entry.bytes}B` : "-";
}

export function formatLogHeader(entry, stamp) {
  const from = cleanLogHeaderField(entry.from);
  const to = cleanLogHeaderField(entry.to);
  const action = cleanLogHeaderField(entry.action || "message", "message");
  const origin = cleanLogHeaderField(entry.origin);
  return `[${stamp}] ${from} -> ${to}  ${action}/${origin}  ${formatLogBytes(entry)}  ${formatLogStatus(entry)}`;
}

export function formatLogBody(entry) {
  const raw =
    messageLogRedactRemote() && entry.transport === "remote"
      ? "[redacted remote body]"
      : entry.body == null
        ? ""
        : String(entry.body);
  return stripAnsiCodes(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => `    ${  l}`)
    .join("\n");
}

export function rotateLogIfNeeded(logPath) {
  const maxBytes = messageLogMaxBytes();
  if (maxBytes <= 0) return;
  // Same resolution as messageLogPath so rotation always hits the file the
  // appender wrote, even when a caller passes the raw configured value.
  const resolved = resolveConfiguredLogPath(String(logPath));
  const {size} = statSync(resolved);
  if (size <= maxBytes) return;
  const raw = readFileSync(resolved);
  writeFileSync(resolved, truncateRotatedMessageLogTail(raw, maxBytes), {
    mode: FILE_MODE_DEFAULT,
  });
}

/**
 * Append a single message event to the chatter log. Best effort: never throws,
 * never blocks delivery. Format is human-readable multi-line:
 *
 *   [2026-04-27T19:23:45.123Z] bob -> mike  reply/peer  147B  ok via tmux
 *       yep, line 47 -- returns {}
 *
 * Multi-line bodies preserve newlines; each line is indented 4 spaces so
 * the entry can be visually scanned in `tail -f` without fighting wrapping.
 */
export function appendMessageLog(entry) {
  if (!messageLogEnabled()) return;
  try {
    const logPath = messageLogPath();
    ensureDirs(logPath);
    const stamp = cleanLogHeaderField(entry.ts || new Date().toISOString());
    const head = formatLogHeader(entry, stamp);
    const body = formatLogBody(entry);
    appendFileSync(logPath, `${head  }\n${  body  }\n`, {
      mode: FILE_MODE_DEFAULT,
    });
    rotateLogIfNeeded(logPath);
  } catch {
    /* best effort -- never fail a delivery because of logging */
  }
}
