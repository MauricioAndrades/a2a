export function resolveReconnectTargets({
  name,
  hasAll,
  isGroup,
  listGroupMembers,
  loadResolvedTeamSpec,
  tmuxListSessions,
  loadRegistry,
  launchCwd,
}) {
  if (name && isGroup(name))
    return {
      targets: listGroupMembers(name).map((m) => m.name),
      viewSession: `${name}-view`,
    };
  if (name) {
    const teamSpec = loadResolvedTeamSpec(name, launchCwd);
    if (teamSpec)
      return {
        targets: teamSpec.agents.map((a) => a.id),
        viewSession: `${teamSpec.name}-view`,
        description: `team:${teamSpec.name}`,
      };
  }
  if (name) return { targets: [name], viewSession: null };
  const live = tmuxListSessions().filter((id) => !id.endsWith("-view"));
  if (hasAll) return { targets: live, viewSession: "a2a-view" };

  const cachedRaw = loadRegistry().agents;
  const cached = Array.isArray(cachedRaw) ? cachedRaw : [];
  const liveSet = new Set(live);
  const cachedLive = cached.filter((id) => liveSet.has(id));
  if (cachedLive.length > 0) return { targets: cachedLive, viewSession: null };
  return { targets: [], viewSession: null };
}
