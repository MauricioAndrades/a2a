export function resolveReconnectTargets({ name, hasAll, isGroup, listGroupMembers, loadResolvedTeamSpec, tmuxListSessions, loadRegistry }) {
    if (name && isGroup(name)) return { targets: listGroupMembers(name).map((m) => m.name), viewSession: `${name}-view` };
    if (name) {
        const teamSpec = loadResolvedTeamSpec(name);
        if (teamSpec) return { targets: teamSpec.agents.map((a) => a.id), viewSession: `${teamSpec.name}-view`, description: `team:${teamSpec.name}` };
    }
    if (name) return { targets: [name], viewSession: null };
    const live = tmuxListSessions().filter((id) => !id.endsWith("-view"));
    if (hasAll) return { targets: live, viewSession: "a2a-view" };

    const cached = loadRegistry().agents || [];
    const cachedLive = cached.filter((id) => live.includes(id));
    if (cachedLive.length > 0) return { targets: cachedLive, viewSession: null };
    return { targets: live, viewSession: null };
}
