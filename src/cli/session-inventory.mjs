// Pure categorization of a2a's live tmux + bridge state.
//
// Inputs are explicit (no fs / no spawn) so the function is testable without
// a running tmux server or bridge. cli.mjs adapts the I/O at the call site.
//
// Output buckets:
//   registered: agents the bridge knows about (with tmux liveness annotated)
//   views:      *-view sessions present in tmux, plus any view session names
//               derivable from a registered agent's description even if the
//               session itself is gone
//   orphans:    tmux sessions whose names look like a2a agents (cached in
//               ~/.claude/skills/a2a/registry.json) AND that prove they were
//               spawned by this install via the @a2a-install-token option.
//               Both conditions are required so `--all` cannot accidentally
//               kill an unrelated user tmux session that shares a name with
//               a stale cache entry.
//   itermOrphans: iTerm sessions stamped with this install's token that no
//               longer map to a registered agent.

import { itermSessionNameMatches } from "../transport-probes.mjs";

/**
 * Build the SYNCHRONOUS iTerm ownership checker buildSessionInventory
 * expects. The inventory consumer compares the checker's return value with
 * `=== true`, so wiring in an async function (e.g. transport-probes'
 * isA2aOwnedITermSession, which returns a Promise) silently disables iTerm
 * orphan detection — a Promise is never `=== true`. Callers fetch the
 * session list once and close over it here instead.
 *
 * @param {Array<{guid:string, installToken:string|null}>} itermSessions
 * @param {string|null|undefined} expectedToken  This install's token.
 * @returns {(guid: string) => boolean}
 */
export function makeItermOwnershipChecker(itermSessions, expectedToken) {
  const sessions = Array.isArray(itermSessions) ? itermSessions : [];
  const tokenByGuid = new Map();
  for (const session of sessions) {
    if (
      typeof session?.guid === "string" &&
      session.guid &&
      !tokenByGuid.has(session.guid)
    ) {
      tokenByGuid.set(session.guid, session.installToken || null);
    }
  }
  return (guid) => {
    if (typeof expectedToken !== "string" || !expectedToken) return false;
    return tokenByGuid.get(guid) === expectedToken;
  };
}

/**
 * Find an iTerm session whose decorated name matches `agentName` AND that is
 * provably owned by this install (installToken match). Pure name-keyed analog
 * of isA2aOwnedITermSession; used to gate probeAgentAlive's iTerm branch when
 * the active protocol is tmux, so a name collision with an unrelated user
 * iTerm window cannot hijack an agent onto the wrong surface.
 *
 * @param {Array<{guid:string, name:string|null, installToken:string|null}>} itermSessions
 * @param {string} agentName
 * @param {string|null|undefined} expectedToken
 * @returns {{guid:string, name:string|null, installToken:string|null}|null}
 */
export function findOwnedItermSessionByName(
  itermSessions,
  agentName,
  expectedToken,
) {
  if (typeof expectedToken !== "string" || !expectedToken) return null;
  const sessions = Array.isArray(itermSessions) ? itermSessions : [];
  return (
    sessions.find(
      (s) =>
        s &&
        typeof s.guid === "string" &&
        s.guid &&
        s.installToken === expectedToken &&
        itermSessionNameMatches(s.name, agentName),
    ) || null
  );
}

function parseCohortDescription(desc) {
  if (typeof desc !== "string" || desc.length === 0) return null;
  const sepIdx = desc.indexOf(":");
  if (sepIdx <= 0) return null;
  const kind = desc.slice(0, sepIdx);
  const rest = desc.slice(sepIdx + 1);
  if (kind !== "group" && kind !== "team") return null;
  if (!rest) return null;
  return rest;
}

const VIEW_SUFFIX = "-view";

function isViewName(name) {
  if (!name) return false;
  if (name === "a2a-view") return true;
  return name.endsWith(VIEW_SUFFIX) && name.length > VIEW_SUFFIX.length;
}

function baseFromView(name) {
  if (name === "a2a-view") return "a2a";
  if (!name.endsWith(VIEW_SUFFIX)) return null;
  const base = name.slice(0, -VIEW_SUFFIX.length);
  return base || null;
}

function agentIdFromItermSessionName(sessionName) {
  if (typeof sessionName !== "string") return null;
  const trimmed = sessionName.trim();
  if (!trimmed) return null;
  const [head] = trimmed.split(/\s+[-\u2013\u2014]\s+/);
  const agentId = (head || trimmed).trim();
  return /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : null;
}

export function buildSessionInventory({
  registeredAgents = [],
  tmuxSessions = [],
  itermLiveAgentIds = [],
  itermSessions = [],
  cachedAgentIds = [],
  isGroup = () => false,
  loadResolvedTeamSpec = () => null,
  // isA2aOwnedSession(name): returns true iff the tmux session was spawned
  // by this install (proven via @a2a-install-token). Defaults to
  // `() => false` so callers in pure tests can leave it unset and the
  // orphan classifier will not flag anything.
  isA2aOwnedSession = () => false,
  // isA2aOwnedITermSession(guid): returns true iff the iTerm session was
  // spawned by this install (bridge ownership map / install_token).
  isA2aOwnedITermSession = () => false,
  launchCwd = null,
} = {}) {
  const tmuxSet = new Set(tmuxSessions);
  const itermLiveSet = new Set(itermLiveAgentIds);
  const registeredIds = new Set();
  const cached = new Set(Array.isArray(cachedAgentIds) ? cachedAgentIds : []);

  const registered = [];
  for (const a of registeredAgents) {
    if (!a || typeof a.agentId !== "string" || a.agentId.length === 0) {
      continue;
    }
    registeredIds.add(a.agentId);
    const cohort = parseCohortDescription(a.description);
    registered.push({
      agentId: a.agentId,
      tmuxTarget: a.tmuxTarget || `${a.agentId}:0.0`,
      cwd: a.cwd || "",
      description: a.description || "",
      cohort,
      status:
        tmuxSet.has(a.agentId) || itermLiveSet.has(a.agentId)
          ? "live"
          : "bridge-only",
      yolo: typeof a.yolo === "boolean" ? a.yolo : null,
      backend: typeof a.backend === "string" ? a.backend : "",
    });
  }

  // viewMap: session name -> { baseName, known, sources, existsInTmux }
  const viewMap = new Map();
  const recordView = (session, baseName, known, source) => {
    const prior = viewMap.get(session);
    if (prior) {
      prior.known ||= known;
      prior.sources.add(source);
      return;
    }
    viewMap.set(session, {
      session,
      baseName,
      known,
      sources: new Set([source]),
      existsInTmux: tmuxSet.has(session),
    });
  };

  // Source 1: view sessions implied by live agents' descriptions.
  for (const a of registered) {
    if (a.cohort)
      recordView(`${a.cohort}${VIEW_SUFFIX}`, a.cohort, true, "description");
  }
  // Source 2: actual *-view sessions present in tmux.
  for (const s of tmuxSessions) {
    if (!isViewName(s)) continue;
    const base = baseFromView(s);
    let known = false;
    if (base) {
      try {
        if (isGroup(base)) known = true;
      } catch {
        /* ignore */
      }
      if (!known) {
        try {
          if (loadResolvedTeamSpec(base, launchCwd)) known = true;
        } catch {
          /* ignore */
        }
      }
    }
    recordView(s, base, known, "tmux");
  }
  const views = [];
  for (const v of viewMap.values()) {
    views.push({
      session: v.session,
      baseName: v.baseName,
      known: v.known,
      sources: [...v.sources],
      existsInTmux: v.existsInTmux,
    });
  }

  // Orphans: tmux sessions that a2a owns but the bridge no longer knows
  // about. The install token is the durable ownership proof; the cache is
  // only a compatibility hint for older sessions that pre-date the token.
  const orphans = [];
  for (const s of tmuxSessions) {
    if (registeredIds.has(s)) continue;
    if (isViewName(s)) continue;
    let owned;
    try {
      owned = isA2aOwnedSession(s) === true;
    } catch {
      owned = false;
    }
    if (owned || cached.has(s)) orphans.push(s);
  }

  const itermOrphans = [];
  for (const session of itermSessions) {
    const guid = typeof session?.guid === "string" ? session.guid : "";
    if (!guid) continue;
    let owned;
    try {
      owned = isA2aOwnedITermSession(guid) === true;
    } catch {
      owned = false;
    }
    if (!owned) continue;
    const matchesRegistered = registeredIds.has(
      agentIdFromItermSessionName(session.name),
    );
    if (matchesRegistered) continue;
    itermOrphans.push({
      guid,
      name: typeof session.name === "string" ? session.name : null,
    });
  }

  return { registered, views, orphans, itermOrphans };
}

export { isViewName, baseFromView };
