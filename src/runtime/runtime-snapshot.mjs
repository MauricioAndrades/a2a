import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isGroup,
  loadRegistry,
  teamSpecsDir,
} from "../a2a-config.mjs";
import {
  loadTeamSpec,
  resolveTeamSpecPath,
} from "../a2a-team-spec.mjs";
import {
  listITermSessionsWithOwnership,
} from "../transport-probes.mjs";
import {
  buildSessionInventory,
  makeItermOwnershipChecker,
} from "../cli/session-inventory.mjs";
import { buildStatusSnapshot } from "../cli/status-snapshot.mjs";

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_TEAMS_DIR = join(RUNTIME_ROOT, "teams");
const A2A_INSTALL_TOKEN_OPTION = "@a2a-install-token";
const RUNTIME_SNAPSHOT_CACHE_TTL_MS = 750;

let runtimeSnapshotCache = null;

function storeRuntimeSnapshotCache(key, expires, value) {
  runtimeSnapshotCache = { key, expires, value };
}

function appendCacheValue(parts, value) {
  const encoded = JSON.stringify(value ?? null);
  parts.push(String(encoded.length), ":", encoded, ";");
}

function appendAgentCacheEntry(parts, agent) {
  appendCacheValue(parts, agent?.agentId);
  appendCacheValue(parts, agent?.tmuxTarget);
  appendCacheValue(parts, agent?.itermGuid);
  appendCacheValue(parts, agent?.description);
  appendCacheValue(parts, agent?.yolo);
  appendCacheValue(parts, agent?.backend);
  appendCacheValue(parts, agent?.registeredAt);
}

function buildRuntimeSnapshotCacheKey({
  registeredAgents,
  peerSnapshots,
  bridgeError,
  self,
  launchCwd,
  registry,
}) {
  const parts = [];
  parts.push("agents=", String(registeredAgents.length), ";");
  for (const agent of registeredAgents) appendAgentCacheEntry(parts, agent);
  appendCacheValue(parts, peerSnapshots.length);
  appendCacheValue(parts, bridgeError);
  appendCacheValue(parts, self);
  appendCacheValue(parts, launchCwd);
  parts.push("cached=", String(registry.cachedAgentIds.length), ";");
  for (const id of registry.cachedAgentIds) appendCacheValue(parts, id);
  appendCacheValue(parts, registry.installToken);
  appendCacheValue(parts, registry.error);
  return parts.join("");
}

function tmux(args) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function tmuxListSessions() {
  return tmuxListSessionOwnership(null).sessions;
}

function tmuxListSessionOwnership(expectedToken) {
  const r = tmux([
    "list-sessions",
    "-F",
    `#{session_name}\t#{${A2A_INSTALL_TOKEN_OPTION}}`,
  ]);
  const sessions = [];
  const ownedSessionIds = new Set();
  if (r.status !== 0) return { sessions, ownedSessionIds };
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const sepIndex = line.indexOf("\t");
    const name = (sepIndex === -1 ? line : line.slice(0, sepIndex)).trim();
    if (!name) continue;
    sessions.push(name);
    if (!expectedToken) continue;
    const token = sepIndex === -1 ? "" : line.slice(sepIndex + 1).trim();
    if (token === expectedToken) ownedSessionIds.add(name);
  }
  return { sessions, ownedSessionIds };
}

function loadResolvedTeamSpec(ref, launchCwd = process.cwd()) {
  const specPath = resolveTeamSpecPath(
    ref,
    launchCwd || process.cwd(),
    REPO_TEAMS_DIR,
    teamSpecsDir(),
  );
  if (!specPath) return null;
  return loadTeamSpec(specPath);
}

function readRegistryForRuntime() {
  try {
    const registry = loadRegistry();
    const cachedAgentIds = Array.isArray(registry.agents)
      ? registry.agents
      : [];
    return {
      agents: cachedAgentIds,
      groups: Array.isArray(registry.groups) ? registry.groups : [],
      cachedAgentIds,
      installToken:
        typeof registry.installToken === "string" && registry.installToken
          ? registry.installToken
          : null,
      error: null,
    };
  } catch (err) {
    return {
      agents: [],
      groups: [],
      cachedAgentIds: [],
      installToken: null,
      error: err.message || String(err),
    };
  }
}

function agentIdFromItermSessionName(sessionName) {
  if (typeof sessionName !== "string") return null;
  const trimmed = sessionName.trim();
  if (!trimmed) return null;
  const [head] = trimmed.split(/\s+[-\u2013\u2014]\s+/);
  const agentId = (head || trimmed).trim();
  return /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : null;
}

function collectItermLiveAgentIds(registeredAgents, sessions) {
  const sessionAgentIds = new Set();
  for (const session of sessions) {
    const id = agentIdFromItermSessionName(session?.name);
    if (id) sessionAgentIds.add(id);
  }
  const ids = [];
  for (const agent of registeredAgents) {
    if (!agent?.agentId) continue;
    if (sessionAgentIds.has(agent.agentId)) {
      ids.push(agent.agentId);
    }
  }
  return ids;
}

async function collectItermSessionsForRuntime() {
  try {
    return await listITermSessionsWithOwnership();
  } catch {
    return [];
  }
}

export async function buildRuntimeSnapshotFromState({
  registeredAgents = [],
  peerSnapshots = [],
  bridgeError = null,
  self = null,
  launchCwd = process.cwd(),
  cache = false,
} = {}) {
  const registry = readRegistryForRuntime();
  const cacheKey = cache
    ? buildRuntimeSnapshotCacheKey({
        registeredAgents,
        peerSnapshots,
        bridgeError,
        self,
        launchCwd,
        registry,
      })
    : null;
  const now = Date.now();
  if (
    cacheKey &&
    runtimeSnapshotCache &&
    runtimeSnapshotCache.key === cacheKey &&
    runtimeSnapshotCache.expires > now
  ) {
    return runtimeSnapshotCache.value;
  }

  const itermSessions = await collectItermSessionsForRuntime();
  const itermLiveAgentIds = collectItermLiveAgentIds(
    registeredAgents,
    itermSessions,
  );
  const tmuxOwnership = tmuxListSessionOwnership(registry.installToken);
  const inventory = buildSessionInventory({
    registeredAgents,
    tmuxSessions: tmuxOwnership.sessions,
    itermLiveAgentIds,
    cachedAgentIds: registry.cachedAgentIds,
    isGroup,
    loadResolvedTeamSpec,
    isA2aOwnedSession: (name) => tmuxOwnership.ownedSessionIds.has(name),
    itermSessions,
    isA2aOwnedITermSession: makeItermOwnershipChecker(
      itermSessions,
      registry.installToken,
    ),
    launchCwd,
  });
  const snapshot = buildStatusSnapshot({
    inventory,
    peerSnapshots,
    self,
    bridgeError: registry.error
      ? [bridgeError, `registry: ${registry.error}`].filter(Boolean).join("; ")
      : bridgeError,
  });
  const value = {
    snapshot,
    inventory,
    registeredAgents,
    peerSnapshots,
    registry,
    bridgeError,
  };
  if (cacheKey) {
    storeRuntimeSnapshotCache(
      cacheKey,
      Date.now() + RUNTIME_SNAPSHOT_CACHE_TTL_MS,
      value,
    );
  }
  return value;
}

export function clearRuntimeSnapshotCache() {
  runtimeSnapshotCache = null;
}
