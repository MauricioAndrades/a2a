const SNAPSHOT_VERSION = 1;

function asIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return new Date().toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function healthFor({ bridgeError, attentionCount }) {
  if (bridgeError) return "error";
  if (attentionCount > 0) return "warn";
  return "ok";
}

function attention(kind, id, message, extra = {}) {
  return { kind, id, message, ...extra };
}

export function buildStatusSnapshot({
  inventory = {},
  peerSnapshots = [],
  self = null,
  bridgeError = null,
  generatedAt = new Date(),
} = {}) {
  const attentionItems = [];
  if (bridgeError) {
    attentionItems.push(
      attention("bridge-error", "bridge", bridgeError, { severity: "error" }),
    );
  }

  let liveAgentCount = 0;
  let bridgeOnlyAgentCount = 0;
  const registered = [];
  for (const rawAgent of safeArray(inventory.registered)) {
    const agent = {
      id: rawAgent.agentId,
      status: rawAgent.status || "unknown",
      cohort: rawAgent.cohort || null,
      backend: rawAgent.backend || "",
      yolo: typeof rawAgent.yolo === "boolean" ? rawAgent.yolo : null,
      cwd: rawAgent.cwd || "",
      tmuxTarget: rawAgent.tmuxTarget || "",
      self: rawAgent.agentId === self,
    };
    registered.push(agent);
    if (agent.status === "live") liveAgentCount++;
    if (agent.status === "bridge-only") {
      bridgeOnlyAgentCount++;
      attentionItems.push(
        attention(
          "bridge-only",
          agent.id,
          `${agent.id} is registered but has no tmux session`,
        ),
      );
    }
  }

  const orphans = safeArray(inventory.orphans).map((id) => ({
    id,
    status: "tmux-only",
    self: id === self,
  }));
  for (const orphan of orphans) {
    attentionItems.push(
      attention(
        "tmux-only",
        orphan.id,
        `${orphan.id} has a tmux session but is not registered`,
      ),
    );
  }

  let unknownViewCount = 0;
  const existingViews = [];
  for (const rawView of safeArray(inventory.views)) {
    const view = {
      session: rawView.session,
      baseName: rawView.baseName || null,
      known: rawView.known === true,
      existsInTmux: rawView.existsInTmux === true,
      sources: safeArray(rawView.sources),
      self: rawView.session === self,
    };
    if (!view.existsInTmux) continue;
    existingViews.push(view);
    if (!view.known) {
      unknownViewCount++;
      attentionItems.push(
        attention(
          "unknown-view",
          view.session,
          `${view.session} exists but does not match a known team or group`,
        ),
      );
    }
  }

  let remoteAgentCount = 0;
  let peerErrorCount = 0;
  const peers = [];
  for (const snap of safeArray(peerSnapshots)) {
    const peer = {
      peer: snap.peer,
      url: snap.url || null,
      error: snap.error || null,
      agents: safeArray(snap.agents).map((agent) => ({
        id: agent.agentId,
        status: agent.status || "peer",
        cwd: agent.cwd || "",
        description: agent.description || "",
        yolo: typeof agent.yolo === "boolean" ? agent.yolo : null,
      })),
    };
    peers.push(peer);
    remoteAgentCount += peer.agents.length;
    if (peer.error) {
      peerErrorCount++;
      attentionItems.push(
        attention("peer-error", peer.peer, peer.error, { severity: "warn" }),
      );
    }
  }

  const counts = {
    localAgents: registered.length + orphans.length,
    registeredAgents: registered.length,
    liveAgents: liveAgentCount,
    bridgeOnlyAgents: bridgeOnlyAgentCount,
    tmuxOnlyAgents: orphans.length,
    views: existingViews.length,
    knownViews: existingViews.length - unknownViewCount,
    unknownViews: unknownViewCount,
    peers: peers.length,
    remoteAgents: remoteAgentCount,
    peerErrors: peerErrorCount,
    attention: attentionItems.length,
  };

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: asIsoString(generatedAt),
    self: self || null,
    health: healthFor({ bridgeError, attentionCount: attentionItems.length }),
    bridge: {
      ok: !bridgeError,
      error: bridgeError || null,
    },
    counts,
    agents: registered,
    orphans,
    views: existingViews,
    peers,
    attention: attentionItems,
  };
}

export function formatStatusSegment(snapshot) {
  const counts = snapshot?.counts || {};
  const localAgents = counts.localAgents || 0;
  const views = counts.views || 0;
  const attentionCount = counts.attention || 0;
  if (localAgents === 0 && views === 0 && !snapshot?.bridge?.error) return "";
  if (snapshot?.bridge?.error) return "a2a bridge down";
  const parts = [];
  if (localAgents > 0) {
    parts.push(`${counts.liveAgents || 0}/${localAgents}`);
  }
  if (views > 0) parts.push(`${views}v`);
  if (attentionCount > 0) parts.push(`!${attentionCount}`);
  return `a2a ${parts.join(" ")}`.trim();
}

export function formatHumanStatus(snapshot) {
  const { counts } = snapshot;
  const lines = [];
  lines.push(`a2a status: ${snapshot.health}`);
  if (snapshot.bridge.error) lines.push(`bridge: ${snapshot.bridge.error}`);
  else lines.push("bridge: ok");
  lines.push(
    `local agents: ${counts.liveAgents} live, ${counts.bridgeOnlyAgents} bridge-only, ${counts.tmuxOnlyAgents} tmux-only`,
  );
  lines.push(
    `views: ${counts.knownViews} known, ${counts.unknownViews} unknown`,
  );
  if (counts.peers > 0) {
    lines.push(
      `peers: ${counts.remoteAgents} agents, ${counts.peerErrors} errors`,
    );
  }
  if (snapshot.attention.length > 0) {
    lines.push("attention:");
    for (const item of snapshot.attention) {
      lines.push(`  ${item.kind} ${item.id}: ${item.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
