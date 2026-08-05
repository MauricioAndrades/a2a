import yaml from "js-yaml";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function event(type, severity, target, message, data = {}) {
  return { type, severity, target, message, data };
}

export function buildRuntimeEvents(snapshot) {
  const events = [];
  if (snapshot.bridge?.error) {
    events.push(
      event("bridge.error", "error", "bridge", snapshot.bridge.error),
    );
  } else {
    events.push(event("bridge.ok", "info", "bridge", "bridge reachable"));
  }
  for (const agent of safeArray(snapshot.agents)) {
    const severity = agent.status === "live" ? "info" : "warn";
    events.push(
      event(
        "agent.status",
        severity,
        agent.id,
        `${agent.id} ${agent.status}`,
        { cohort: agent.cohort, backend: agent.backend, yolo: agent.yolo },
      ),
    );
  }
  for (const orphan of safeArray(snapshot.orphans)) {
    events.push(
      event(
        "agent.tmux-only",
        "warn",
        orphan.id,
        `${orphan.id} has tmux state but no bridge registration`,
      ),
    );
  }
  for (const view of safeArray(snapshot.views)) {
    events.push(
      event(
        "view.status",
        view.known ? "info" : "warn",
        view.session,
        `${view.session} ${view.known ? "known" : "unknown"}`,
        { baseName: view.baseName, sources: view.sources },
      ),
    );
  }
  for (const peer of safeArray(snapshot.peers)) {
    if (peer.error) {
      events.push(event("peer.error", "warn", peer.peer, peer.error));
      continue;
    }
    events.push(
      event(
        "peer.status",
        "info",
        peer.peer,
        `${peer.peer} ${safeArray(peer.agents).length} agents`,
      ),
    );
  }
  for (const item of safeArray(snapshot.attention)) {
    events.push(
      event(
        "attention",
        item.severity || "warn",
        item.id,
        item.message,
        { kind: item.kind },
      ),
    );
  }
  return events.map((entry, index) => ({
    sequence: index + 1,
    generatedAt: snapshot.generatedAt,
    ...entry,
  }));
}

export function formatRuntimeEvents(events) {
  if (events.length === 0) return "(no runtime events)\n";
  return `${events
    .map(
      (entry) =>
        `${String(entry.sequence).padStart(3, " ")} ${entry.severity.padEnd(5)} ${entry.type.padEnd(14)} ${entry.target}: ${entry.message}`,
    )
    .join("\n")}\n`;
}

export function buildAttentionStack(snapshot) {
  return safeArray(snapshot.attention).map((item, index) => ({
    index: index + 1,
    kind: item.kind,
    id: item.id,
    severity: item.severity || "warn",
    message: item.message,
  }));
}

export function formatAttentionStack(stack) {
  if (stack.length === 0) return "attention: clear\n";
  return `${stack
    .map(
      (item) =>
        `#${item.index} ${item.severity} ${item.kind} ${item.id}: ${item.message}`,
    )
    .join("\n")}\n`;
}

function agentIdsFromTeam(teamSpec) {
  return new Set(safeArray(teamSpec.agents).map((agent) => agent.id));
}

function normalizeLayoutNode(node, agentIds, path = "root") {
  const raw = safeObject(node);
  const flex = raw.flex == null ? 1 : Number(raw.flex);
  if (!Number.isFinite(flex) || flex <= 0) {
    throw new Error(`layout ${path}: flex must be a positive number`);
  }
  if (raw.agent != null) {
    const agent = String(raw.agent);
    if (!agentIds.has(agent)) throw new Error(`layout ${path}: unknown agent '${agent}'`);
    return {
      type: "agent",
      agent,
      flex,
      focus: raw.focus === true,
      zoom: raw.zoom === true,
    };
  }
  const direction = raw.direction || raw.flex_direction;
  if (direction !== "row" && direction !== "column") {
    throw new Error(`layout ${path}: direction must be row or column`);
  }
  const panes = safeArray(raw.panes);
  if (panes.length === 0) throw new Error(`layout ${path}: panes must not be empty`);
  return {
    type: "split",
    direction,
    flex,
    panes: panes.map((child, index) =>
      normalizeLayoutNode(child, agentIds, `${path}.${index}`),
    ),
  };
}

function collectLayoutLeaves(node, path = "root", out = []) {
  if (node.type === "agent") {
    out.push({
      path,
      agent: node.agent,
      flex: node.flex,
      focus: node.focus,
      zoom: node.zoom,
    });
    return out;
  }
  node.panes.forEach((child, index) =>
    collectLayoutLeaves(child, `${path}.${index}`, out),
  );
  return out;
}

export function buildLayoutPlan(teamSpec, rawLayout = null) {
  const agentIds = agentIdsFromTeam(teamSpec);
  const layout =
    rawLayout == null
      ? {
          direction: "row",
          panes: safeArray(teamSpec.agents).map((agent) => ({ agent: agent.id })),
        }
      : rawLayout.root || rawLayout;
  const tree = normalizeLayoutNode(layout, agentIds);
  const leaves = collectLayoutLeaves(tree);
  const used = new Set();
  const duplicateAgents = new Set();
  for (const leaf of leaves) {
    if (used.has(leaf.agent)) duplicateAgents.add(leaf.agent);
    else used.add(leaf.agent);
  }
  const missing = [...agentIds].filter((id) => !used.has(id));
  return {
    team: teamSpec.name,
    tree,
    leaves,
    missing,
    duplicateAgents: [...duplicateAgents],
    valid: missing.length === 0 && duplicateAgents.size === 0,
  };
}

export function formatLayoutPlan(plan) {
  const lines = [`layout ${plan.team}: ${plan.valid ? "valid" : "needs attention"}`];
  for (const leaf of plan.leaves) {
    const flags = [leaf.focus ? "focus" : "", leaf.zoom ? "zoom" : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  ${leaf.path} agent=${leaf.agent} flex=${leaf.flex}${flags ? ` ${flags}` : ""}`,
    );
  }
  for (const id of plan.missing) lines.push(`  missing from layout: ${id}`);
  for (const id of plan.duplicateAgents) lines.push(`  duplicated in layout: ${id}`);
  return `${lines.join("\n")}\n`;
}

export function buildReloadPlan(teamSpec, registeredAgents = []) {
  const teamTag = `team:${teamSpec.name}`;
  const liveById = new Map();
  for (const agent of safeArray(registeredAgents)) {
    if (agent.description === teamTag) liveById.set(agent.agentId, agent);
  }
  const specById = new Map(teamSpec.agents.map((agent) => [agent.id, agent]));
  const changes = [];
  const unsafe = [];
  const safeAdds = [];
  const pushChange = (change) => {
    changes.push(change);
    if (change.safety === "unsafe") unsafe.push(change);
    if (change.action === "add-agent") safeAdds.push(change);
  };
  for (const agent of teamSpec.agents) {
    const current = liveById.get(agent.id);
    if (!current) {
      pushChange({
        action: "add-agent",
        safety: "safe",
        agent: agent.id,
        detail: "agent exists in spec but not in bridge registry",
      });
      continue;
    }
    const backendChanged =
      current.backend && agent.backend && current.backend !== agent.backend;
    const cwdChanged = current.cwd && agent.cwd && current.cwd !== agent.cwd;
    const yoloChanged =
      typeof current.yolo === "boolean" && current.yolo !== agent.yolo;
    if (backendChanged || cwdChanged || yoloChanged) {
      pushChange({
        action: "replace-agent",
        safety: "unsafe",
        agent: agent.id,
        detail: "backend, cwd, or yolo changed; restart explicitly",
      });
    } else {
      pushChange({
        action: "keep-agent",
        safety: "noop",
        agent: agent.id,
        detail: "agent already matches reload-safe metadata",
      });
    }
  }
  for (const [id] of liveById) {
    if (specById.has(id)) continue;
    pushChange({
      action: "remove-agent",
      safety: "unsafe",
      agent: id,
      detail: "registered team agent is absent from spec",
    });
  }
  return {
    team: teamSpec.name,
    safeToApply: unsafe.length === 0,
    changes,
    unsafe,
    safeAdds,
  };
}

export function formatReloadPlan(plan) {
  const lines = [
    `reload ${plan.team}: ${plan.safeToApply ? "safe" : "unsafe"} (${plan.changes.length} changes)`,
  ];
  for (const change of plan.changes) {
    lines.push(
      `  ${change.safety.padEnd(6)} ${change.action.padEnd(13)} ${change.agent}: ${change.detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildPmWorkerSpec({
  name,
  workers,
  backend = "claude",
  workerBackend = backend,
}) {
  const workerCount = Number(workers);
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
    throw new Error("--workers must be a positive integer");
  }
  const agents = {
    pm: {
      backend,
      role: [
        `You are the project manager for ${name}.`,
        "Decompose the task, message workers through a2a, review their work, and keep the operator updated.",
      ].join("\n"),
    },
  };
  for (let index = 1; index <= workerCount; index++) {
    agents[`worker-${index}`] = {
      backend: workerBackend,
      role: [
        `You are worker-${index} on ${name}.`,
        "Work in your assigned lane, report blockers, and send results back to pm through a2a.",
      ].join("\n"),
    };
  }
  return {
    version: 2,
    name,
    dashboard: true,
    agents,
  };
}

export function dumpTeamSpec(spec) {
  return yaml.dump(spec, { lineWidth: 100, noRefs: true });
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildItermAttachScript(target) {
  const command = `a2a attach ${target} --native-scroll`;
  const escaped = escapeAppleScriptString(command);
  return [
    'tell application "iTerm2"',
    "  activate",
    "  if (count of windows) = 0 then create window with default profile",
    "  tell current session of current window",
    `    write text "${escaped}"`,
    "  end tell",
    "end tell",
    "",
  ].join("\n");
}

function maskSecret(value) {
  return typeof value === "string" && value ? "***" : value ?? null;
}

export function maskConfig(config) {
  const peers = {};
  for (const [name, peer] of Object.entries(safeObject(config.peers))) {
    peers[name] = { ...peer, key: maskSecret(peer?.key) };
  }
  return { ...config, key: maskSecret(config.key), peers };
}

export function buildDoctorSnapshot({
  status,
  events,
  config,
  registry,
  tmuxSessions,
  paths,
  versions,
}) {
  return {
    generatedAt: status.generatedAt,
    health: status.health,
    counts: status.counts,
    paths,
    versions,
    tmux: { sessions: safeArray(tmuxSessions) },
    config: maskConfig(safeObject(config)),
    registry: {
      agents: safeArray(registry.agents),
      groups: safeArray(registry.groups),
      installTokenPresent: typeof registry.installToken === "string" && registry.installToken.length > 0,
    },
    attention: status.attention,
    events,
  };
}

export function formatDoctorSnapshot(snapshot) {
  const lines = [
    `a2a doctor: ${snapshot.health}`,
    `agents: ${snapshot.counts.localAgents} local, ${snapshot.counts.remoteAgents} remote`,
    `views: ${snapshot.counts.views}`,
    `attention: ${snapshot.attention.length}`,
    `tmux sessions: ${snapshot.tmux.sessions.length}`,
  ];
  return `${lines.join("\n")}\n`;
}
