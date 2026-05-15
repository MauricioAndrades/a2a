import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { homedir } from "os";

const SKILL_DIR   = join(homedir(), ".claude", "skills", "a2a");
const CONFIG_FILE = join(SKILL_DIR, "config.json");
const REGISTRY_FILE = join(SKILL_DIR, "registry.json");
const GROUPS_DIR  = join(SKILL_DIR, "groups");
const TEAMS_DIR   = join(SKILL_DIR, "teams");
const PID_FILE    = join(homedir(), ".claude", "a2a-bridge.pid");
const DEFAULT_LOG_FILE = join(SKILL_DIR, "messages.log");

const CONFIG_DEFAULTS = {
    port: 7742,
    host: "127.0.0.1",
    url:  null,
    key:  null,
    peers: {},
    log: {
        mode: "on",
        path: null,
        maxBytes: 0,
        redactRemote: false,
    },
};

const REGISTRY_DEFAULTS = {
    agents: [],
    groups: [],
};

const USER_KEYS = ["port", "host", "url", "key", "log.mode", "log.path", "log.maxBytes", "log.redactRemote"];

function ensureDirs() {
    mkdirSync(SKILL_DIR, { recursive: true });
    mkdirSync(GROUPS_DIR, { recursive: true });
    mkdirSync(TEAMS_DIR, { recursive: true });
}

function readJson(path, defaults) {
    try {
        const raw = readFileSync(path, "utf8").trim();
        return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
    } catch {
        return { ...defaults };
    }
}

function writeJson(path, data, mode = 0o644) {
    ensureDirs();
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode });
}

export function loadConfig() {
    return readJson(CONFIG_FILE, CONFIG_DEFAULTS);
}

export function patchConfig(changes) {
    const updated = { ...loadConfig(), ...changes };
    writeJson(CONFIG_FILE, updated, 0o600);
    return updated;
}

function nestedGet(obj, dotted) {
    return dotted.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], obj);
}

function nestedSet(obj, dotted, value) {
    const parts = dotted.split(".");
    const out = { ...obj };
    let cursor = out;
    for (const part of parts.slice(0, -1)) {
        cursor[part] = { ...(cursor[part] || {}) };
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
    return out;
}

export function configGet(key) {
    if (key !== undefined && !USER_KEYS.includes(key)) {
        throw new Error(`unknown setting '${key}' (available: ${USER_KEYS.join(", ")})`);
    }
    const cfg = loadConfig();
    if (key) return nestedGet(cfg, key) ?? null;
    return Object.fromEntries(USER_KEYS.map((k) => [k, nestedGet(cfg, k) ?? null]));
}

export function configSet(key, value) {
    if (!USER_KEYS.includes(key)) {
        throw new Error(`unknown setting '${key}' (available: ${USER_KEYS.join(", ")})`);
    }
    let coerced = value;
    if (key === "port") {
        coerced = parseInt(value, 10);
        if (!Number.isFinite(coerced) || coerced <= 0) throw new Error("port must be a positive integer");
    }
    if (key === "host") {
        if (typeof value !== "string" || value.trim() === "") throw new Error("host must be a non-empty string");
        const trimmed = value.trim();
        if (trimmed.includes("://") || trimmed.includes("/")) {
            throw new Error("host must be a bare hostname or IP (no scheme, no path). did you mean `a2a config set url`?");
        }
        coerced = trimmed;
    }
    if (key === "url") {
        if (value === "" || value === null) { coerced = null; }
        else {
            if (typeof value !== "string") throw new Error("url must be a string");
            let parsed;
            try { parsed = new URL(value.trim()); }
            catch { throw new Error("url must be a valid URL (e.g. https://example.ngrok-free.dev)"); }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("url must use http:// or https://");
            }
            coerced = value.trim().replace(/\/$/, "");
        }
    }
    if (key === "key" && (value === "" || value === null)) coerced = null;
    if (key === "log.mode") {
        if (value !== "on" && value !== "off") throw new Error("log.mode must be on or off");
    }
    if (key === "log.path" && value === "") coerced = null;
    if (key === "log.maxBytes") {
        coerced = parseInt(value, 10);
        if (!Number.isFinite(coerced) || coerced < 0) throw new Error("log.maxBytes must be a non-negative integer");
    }
    if (key === "log.redactRemote") {
        if (value !== "true" && value !== "false") throw new Error("log.redactRemote must be true or false");
        coerced = value === "true";
    }
    const updated = patchConfig(nestedSet(loadConfig(), key, coerced));
    return nestedGet(updated, key);
}

export function activeKey() {
    const env = (process.env.A2A_KEY || "").trim();
    return env || loadConfig().key || null;
}

export function activePort() {
    const env = process.env.A2A_PORT;
    if (env) {
        const n = parseInt(env, 10);
        if (Number.isFinite(n) && n > 0) return n;
        console.warn(`a2a: A2A_PORT=${JSON.stringify(env)} is not a valid port number, ignoring`);
    }
    const n = loadConfig().port;
    return Number.isFinite(n) && n > 0 ? n : 7742;
}

export function activeHost() {
    return process.env.A2A_HOST || loadConfig().host || "127.0.0.1";
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
    if (env) return env.replace(/\/$/, "");
    const cfg = loadConfig().url;
    return cfg ? String(cfg).replace(/\/$/, "") : null;
}

export function bridgeUrl() {
    return process.env.A2A_BRIDGE || `http://${activeHost()}:${activePort()}`;
}

export function readPid() {
    try {
        const n = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
}

export function writePid(pid) {
    try { writeFileSync(PID_FILE, String(pid)); } catch { /* best effort */ }
}

export function removePid() {
    try { unlinkSync(PID_FILE); } catch { /* best effort */ }
}

/** Single segment only: no slashes, no ".." escapes; aligns with ~/.claude/skills/a2a/groups/<name>/ */
const SAFE_GROUP_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Rejects traversal before any path joins / statSync — use in tests + internal guard. */
export function isTrustedGroupPathSegment(name) {
    if (name == null || typeof name !== "string") return false;
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === "." || trimmed === "..") return false;
    if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) return false;
    return SAFE_GROUP_SEGMENT.test(trimmed);
}

function resolvedTrustedGroupDirectory(name) {
    if (!isTrustedGroupPathSegment(name)) return null;
    const trimmed = name.trim();

    const abs = resolve(join(GROUPS_DIR, trimmed));
    const root = resolve(GROUPS_DIR);
    const rel = relative(root, abs);
    if (rel === "" || rel.split(sep).includes("..")) return null;
    return abs;
}

export function isGroup(name) {
    const dir = resolvedTrustedGroupDirectory(name);
    if (dir == null) return false;
    try { return statSync(dir).isDirectory(); } catch { return false; }
}

export function listGroupNames() {
    try {
        return readdirSync(GROUPS_DIR).filter((n) => {
            try { return statSync(join(GROUPS_DIR, n)).isDirectory(); } catch { return false; }
        });
    } catch { return []; }
}

export function listGroupMembers(groupName) {
    const dir = resolvedTrustedGroupDirectory(groupName);
    if (dir == null) return [];
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => ({
                name: f.replace(/\.md$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent",
                fullPath: join(dir, f),
            }));
    } catch { return []; }
}

export function teamSpecsDir() {
    ensureDirs();
    return TEAMS_DIR;
}

export function listTeamSpecNames() {
    try {
        return readdirSync(TEAMS_DIR)
            .filter((f) => /\.(json|ya?ml)$/i.test(f))
            .map((f) => f.replace(/\.(json|ya?ml)$/i, ""));
    } catch { return []; }
}

export function loadRegistry() {
    return readJson(REGISTRY_FILE, REGISTRY_DEFAULTS);
}

export function saveRegistry(data) {
    writeJson(REGISTRY_FILE, data);
}

export function generateKey() {
    return "a2a-" + randomBytes(16).toString("hex");
}

export function peerKeyForUrl(url) {
    const normalized = (url || "").replace(/\/$/, "");
    const peers = loadConfig().peers || {};
    const match = Object.values(peers).find((p) => (p.url || "").replace(/\/$/, "") === normalized);
    return match?.key || null;
}

export function messageLogPath() {
    const env = (process.env.A2A_LOG_FILE || "").trim();
    return env || logConfig().path || DEFAULT_LOG_FILE;
}

export function messageLogEnabled() {
    if (process.env.A2A_LOG === "0") return false;
    if (process.env.A2A_LOG === "1") return true;
    return logConfig().mode !== "off";
}

function logConfig() {
    const cfg = loadConfig();
    return { ...CONFIG_DEFAULTS.log, ...(cfg.log || {}) };
}

export function messageLogMaxBytes() {
    const n = Number(logConfig().maxBytes || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function messageLogRedactRemote() {
    return logConfig().redactRemote === true;
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
    let strip = 0;
    while (strip < chunk.length && (chunk[strip] & 0xc0) === 0x80) strip++;
    chunk = chunk.subarray(strip);
    const atZero = isoLogHeaderStartsAt(chunk, 0, true);
    if (atZero !== null) return chunk.subarray(atZero);
    for (let i = 1; i + 12 <= chunk.length; i++) {
        if (chunk[i - 1] !== 0x0a || chunk[i] !== 0x5b) continue;
        const h = isoLogHeaderStartsAt(chunk, i, false);
        if (h !== null) return chunk.subarray(h);
    }
    return chunk;
}

function isoLogHeaderStartsAt(buf, bracketIdx, atChunkStart) {
    const need = bracketIdx + 11;
    if (need >= buf.length) return null;
    if (!atChunkStart && bracketIdx !== 0 && buf[bracketIdx - 1] !== 0x0a) return null;
    if (buf[bracketIdx] !== 0x5b /* [ */) return null;
    const i = bracketIdx + 1;
    if (!(buf[i] >= 0x30 && buf[i] <= 0x39)) return null;
    if (!(buf[i + 1] >= 0x30 && buf[i + 1] <= 0x39)) return null;
    if (!(buf[i + 2] >= 0x30 && buf[i + 2] <= 0x39)) return null;
    if (!(buf[i + 3] >= 0x30 && buf[i + 3] <= 0x39)) return null;
    if (buf[i + 4] !== 0x2d) return null;
    if (!(buf[i + 5] >= 0x30 && buf[i + 5] <= 0x39)) return null;
    if (!(buf[i + 6] >= 0x30 && buf[i + 6] <= 0x39)) return null;
    if (buf[i + 7] !== 0x2d) return null;
    if (!(buf[i + 8] >= 0x30 && buf[i + 8] <= 0x39)) return null;
    if (!(buf[i + 9] >= 0x30 && buf[i + 9] <= 0x39)) return null;
    if (buf[i + 10] !== 0x54 /* T */) return null;
    return bracketIdx;
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
        ensureDirs();
        const stamp = entry.ts || new Date().toISOString();
        const action = entry.action || "message";
        const transport = entry.transport ? ` via ${entry.transport}` : "";
        const status = entry.ok ? `ok${transport}` : `FAIL${transport}: ${entry.error || "unknown"}`;
        const bytes = Number.isFinite(entry.bytes) ? `${entry.bytes}B` : "-";
        const head = `[${stamp}] ${entry.from} -> ${entry.to}  ${action}/${entry.origin}  ${bytes}  ${status}`;
        const logPath = messageLogPath();
        const rawBody = messageLogRedactRemote() && entry.transport === "remote"
            ? "[redacted remote body]"
            : (entry.body == null ? "" : String(entry.body));
        const body = rawBody
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((l) => "    " + l)
            .join("\n");
        appendFileSync(logPath, head + "\n" + body + "\n", { mode: 0o644 });
        const maxBytes = messageLogMaxBytes();
        if (maxBytes > 0) {
            const size = statSync(logPath).size;
            if (size > maxBytes) {
                const raw = readFileSync(logPath);
                writeFileSync(logPath, truncateRotatedMessageLogTail(raw, maxBytes), { mode: 0o644 });
            }
        }
    } catch { /* best effort -- never fail a delivery because of logging */ }
}
