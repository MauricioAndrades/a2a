// File: transport-probes.mjs
//
// Lightweight capability probes used by the per-recipient transport selector.
// Probes cache with a short TTL: long-lived processes (a2a-server) call
// selectTransportForAgent per send, so restarted agents, reopened iTerm
// windows, and dead bridges must be re-detected within seconds. Negative tmux
// has-session results are never cached — an agent that spawns right after a
// probe must be reachable on the next send.
//
// External contract:
//   bridgeReachable()                 -> Promise<boolean>
//   tmuxSessionAlive(target)          -> boolean
//   itermSessionNameMatch(agentName)  -> Promise<boolean>
//   invalidateITermSessionCache()     -> void
//   resetTransportProbeCache()        -> void  (for tests)
//
// Internally these wrap the existing transport modules (pingITerm2Bridge,
// listITerm2Sessions, tmux has-session). Wrapping centralises the caching
// and gives the router a single place to mock during tests.

import { spawnSync } from "node:child_process";
import {
  listITerm2Sessions,
  pingITerm2Bridge,
} from "./iterm2-delivery.mjs";
import { exactTmuxTarget } from "./tmux-raw-delivery.mjs";

const TMUX_EXECUTABLE = "tmux";
export const BRIDGE_REACHABLE_TTL_MS = 5000;
export const TMUX_ALIVE_TTL_MS = 2000;
export const ITERM_SESSIONS_TTL_MS = 2000;
const ITERM_NAME_DECORATION_RE = /^\s+[-\u2013\u2014]\s+/;

/** @type {{expires:number}|null} — only successful pings are cached. */
let cachedBridgeReachable = null;
/** @type {Map<string, {expires:number}>} — positive results only. */
const tmuxAliveCache = new Map();
let lastTmuxCacheSweep = 0;
let probeGeneration = 0;
let pendingBridgePing = null;
let pendingITermSessions = null;
/** @type {{sessions:Array<{guid:string,name:string|null,installToken:string|null}>,expires:number,sessionByGuid:Map<string,{guid:string,name:string|null,installToken:string|null}>,guidByAgentName:Map<string,string>}|null} */
let cachedITermSessions = null;

/**
 * Decide what to store in the bridge-reachability cache after a ping. Only
 * successful pings are cached (with a TTL) so a later-started bridge is still
 * detected and a dead bridge is re-probed on the next send.
 *
 * @param {{expires:number}|null} previous
 * @param {boolean} pingOk
 * @param {number} [now]
 * @returns {{expires:number}|null}
 */
export function bridgeReachabilityCacheAfterPing(previous, pingOk, now = Date.now()) {
  void previous;
  return pingOk ? { expires: now + BRIDGE_REACHABLE_TTL_MS } : null;
}

/**
 * Whether an iTerm name lookup should be memoized. Negative lookups are not
 * cached so sessions that appear later in the same process are still found.
 *
 * @param {boolean} matched
 * @returns {boolean}
 */
export function shouldCacheItermNameMatch(matched) {
  return matched;
}

/**
 * Has the iTerm bridge socket answered ping recently? Successful pings are
 * cached for BRIDGE_REACHABLE_TTL_MS; failures are re-probed every call.
 *
 * @returns {Promise<boolean>}
 */
export async function bridgeReachable() {
  if (cachedBridgeReachable && cachedBridgeReachable.expires > Date.now()) {
    return true;
  }
  if (pendingBridgePing) return pendingBridgePing;
  const generation = probeGeneration;
  const pending = pingITerm2Bridge().then((result) => {
    const ok = Boolean(result?.ok);
    if (generation === probeGeneration) {
      cachedBridgeReachable = bridgeReachabilityCacheAfterPing(
        cachedBridgeReachable, ok,
      );
    }
    return ok;
  }).finally(() => {
    if (pendingBridgePing === pending) pendingBridgePing = null;
  });
  pendingBridgePing = pending;
  return pending;
}

/**
 * Does a tmux session exist for this target? `target` may be a pane spec
 * ("bob:0.0") or a bare session name ("bob"); both are normalised. The
 * session name is matched exactly (`=name`) so a dead `alice` never
 * prefix-matches a live `alice-worker`. Positive results are cached for
 * TMUX_ALIVE_TTL_MS; negative results are never cached.
 *
 * @param {string|null|undefined} target
 * @returns {boolean}
 */
export function tmuxSessionAlive(target) {
  if (typeof target !== "string" || target.trim() === "") return false;
  const session = target.split(":")[0].replace(/^=/, "");
  const now = Date.now();
  if (now - lastTmuxCacheSweep >= TMUX_ALIVE_TTL_MS) {
    for (const [key, value] of tmuxAliveCache) {
      if (value.expires <= now) tmuxAliveCache.delete(key);
    }
    lastTmuxCacheSweep = now;
  }
  const cached = tmuxAliveCache.get(session);
  if (cached && cached.expires > Date.now()) return true;
  const r = spawnSync(TMUX_EXECUTABLE, [
    "has-session",
    "-t",
    exactTmuxTarget(session),
  ]);
  const alive = r.status === 0;
  if (alive) {
    tmuxAliveCache.set(session, { expires: Date.now() + TMUX_ALIVE_TTL_MS });
  } else {
    tmuxAliveCache.delete(session);
  }
  return alive;
}

/**
 * Fetch (and cache) the iTerm bridge's session list. Returns an empty array
 * when the bridge is unreachable. The list is cached for
 * ITERM_SESSIONS_TTL_MS so closed/reopened iTerm windows are re-detected in
 * long-lived processes. `installToken` is the bridge-side ownership marker
 * (tmux analog: `@a2a-install-token` session option) — present iff this
 * session was spawned by an a2a CLI that stamped it.
 *
 * @returns {Promise<Array<{guid:string, name:string|null, installToken:string|null}>>}
 */
async function getITermSessionsCacheEntry() {
  if (cachedITermSessions && cachedITermSessions.expires > Date.now()) {
    return cachedITermSessions;
  }
  if (pendingITermSessions) return pendingITermSessions;
  const generation = probeGeneration;
  const pending = listITerm2Sessions().then((r) => {
    const ok = Boolean(r?.ok && Array.isArray(r.sessions));
    if (generation === probeGeneration) {
      cachedBridgeReachable = bridgeReachabilityCacheAfterPing(
        cachedBridgeReachable, ok,
      );
    }
    if (!ok) return null;
    const mapped = r.sessions
      .filter((session) => session && typeof session.guid === "string" && session.guid)
      .map((session) => ({
        guid: session.guid,
        name: typeof session.name === "string" ? session.name : null,
        installToken:
          typeof session.install_token === "string" && session.install_token
            ? session.install_token
            : null,
      }));
    const entry = buildITermSessionCacheEntry(mapped);
    if (generation === probeGeneration) cachedITermSessions = entry;
    return entry;
  }).finally(() => {
    if (pendingITermSessions === pending) pendingITermSessions = null;
  });
  pendingITermSessions = pending;
  return pending;
}

/**
 * Fetch (and cache) the iTerm bridge's session list.
 *
 * @returns {Promise<Array<{guid:string, name:string|null, installToken:string|null}>>}
 */
async function listITermSessionsCached() {
  const entry = await getITermSessionsCacheEntry();
  return entry?.sessions || [];
}

/**
 * Build the indexed cache entry used by guid/name/ownership probes.
 * Duplicate names preserve list order to match Array.find's first-match
 * semantics from the pre-indexed implementation.
 *
 * @param {Array<{guid:string, name:string|null, installToken:string|null}>} sessions
 * @param {number} [now]
 * @returns {{sessions:Array<{guid:string,name:string|null,installToken:string|null}>,expires:number,sessionByGuid:Map<string,{guid:string,name:string|null,installToken:string|null}>,guidByAgentName:Map<string,string>}}
 */
export function buildITermSessionCacheEntry(sessions, now = Date.now()) {
  const sessionByGuid = new Map();
  const guidByAgentName = new Map();
  for (const session of sessions) {
    if (session.guid && !sessionByGuid.has(session.guid)) {
      sessionByGuid.set(session.guid, session);
    }
    if (!session.guid || typeof session.name !== "string" || !session.name) {
      continue;
    }
    if (!guidByAgentName.has(session.name)) {
      guidByAgentName.set(session.name, session.guid);
    }
    const agentName = itermAgentNameFromSessionName(session.name);
    if (agentName && !guidByAgentName.has(agentName)) {
      guidByAgentName.set(agentName, session.guid);
    }
  }
  return {
    sessions,
    expires: now + ITERM_SESSIONS_TTL_MS,
    sessionByGuid,
    guidByAgentName,
  };
}

/**
 * Does any iTerm session's `name` variable match this agent name? Positive
 * matches are memoized for ITERM_SESSIONS_TTL_MS; negative lookups always
 * re-consult the (TTL-cached) bridge session list.
 *
 * @param {string} agentName
 * @returns {Promise<boolean>}
 */
export async function itermSessionNameMatch(agentName) {
  if (typeof agentName !== "string" || agentName === "") return false;
  // A separate name TTL would prolong stale matches beyond the
  // lifetime of the session list they came from.
  const entry = await getITermSessionsCacheEntry();
  return Boolean(entry?.guidByAgentName.has(agentName));
}

/**
 * Look up a session GUID by agent name from the cached iTerm session list.
 * Returns null when nothing matches.
 *
 * @param {string} agentName
 * @returns {Promise<string|null>}
 */
export async function itermGuidByName(agentName) {
  if (typeof agentName !== "string" || agentName === "") return null;
  const entry = await getITermSessionsCacheEntry();
  return entry?.guidByAgentName.has(agentName)
    ? entry.guidByAgentName.get(agentName)
    : null;
}

function itermAgentNameFromSessionName(sessionName) {
  if (typeof sessionName !== "string" || !sessionName) return null;
  const match = sessionName.match(/\s+[-\u2013\u2014]\s+/);
  if (!match || match.index == null || match.index <= 0) return sessionName;
  return sessionName.slice(0, match.index);
}

/**
 * iTerm decorates `session.name` with `" — <pwd>"` based on the active
 * profile's title format, so a session we named "driver" reads back as
 * `"driver — ~/Documents/dev/a2a"`. Accept either the exact match or the
 * prefix-with-separator match. The separator iTerm uses is U+2014 (em dash)
 * surrounded by single spaces; we also accept ASCII " - " to be safe.
 *
 * @param {string|null} sessionName  Raw value from the bridge's name var.
 * @param {string} agentName
 * @returns {boolean}
 */
export function itermSessionNameMatches(sessionName, agentName) {
  if (typeof sessionName !== "string") return false;
  if (typeof agentName !== "string" || agentName === "") return false;
  if (sessionName === agentName) return true;
  // iTerm decorates the name with `<sep>` where sep can be em-dash (U+2014),
  // en-dash (U+2013), or ASCII hyphen-minus, surrounded by NBSP (U+00A0)
  // or ASCII space. Treat any of those as a valid separator.
  if (!sessionName.startsWith(agentName)) return false;
  return ITERM_NAME_DECORATION_RE.test(sessionName.slice(agentName.length));
}

/**
 * Return every iTerm session the bridge knows about, with ownership info.
 * Used by orphan detection (kill --all sweep) and the iterm-side analog of
 * tmuxListSessions().
 *
 * @returns {Promise<Array<{guid:string, name:string|null, installToken:string|null}>>}
 */
export function listITermSessionsWithOwnership() {
  return listITermSessionsCached();
}

/**
 * Is this iTerm guid owned by *this* a2a install (matching install token)?
 * Mirrors isA2aOwnedSession's contract on the tmux side.
 *
 * @param {string} guid
 * @param {string} expectedToken
 * @returns {Promise<boolean>}
 */
export async function isA2aOwnedITermSession(guid, expectedToken) {
  if (typeof guid !== "string" || !guid) return false;
  if (typeof expectedToken !== "string" || !expectedToken) return false;
  const entry = await getITermSessionsCacheEntry();
  const match = entry?.sessionByGuid.get(guid);
  return Boolean(match && match.installToken === expectedToken);
}

/**
 * Drop cached iTerm session/name probes. Call after spawn, kill, or close so
 * the next lookup sees the current bridge state within this process.
 *
 * @returns {void}
 */
export function invalidateITermSessionCache() {
  probeGeneration++;
  pendingBridgePing = null;
  pendingITermSessions = null;
  cachedITermSessions = null;
}

/**
 * Is a session GUID still present on the bridge?
 *
 * @param {string} guid
 * @returns {Promise<boolean>}
 */
export async function itermGuidExists(guid) {
  if (typeof guid !== "string" || guid.trim() === "") return false;
  const entry = await getITermSessionsCacheEntry();
  return Boolean(entry?.sessionByGuid.has(guid.trim()));
}

/**
 * Forget every probe result. Tests use this; production code should not.
 *
 * @returns {void}
 */
export function resetTransportProbeCache() {
  cachedBridgeReachable = null;
  tmuxAliveCache.clear();
  lastTmuxCacheSweep = 0;
  invalidateITermSessionCache();
}
