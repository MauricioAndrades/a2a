import { viableItermGuid } from "../transport-select.mjs";
import { itermSessionNameMatches } from "../transport-probes.mjs";

export function resolveItermRestartSession(agent, sessions) {
  const storedGuid = viableItermGuid(agent?.itermGuid)
    ? agent.itermGuid.trim()
    : null;
  let liveGuid = null;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (storedGuid && session?.guid === storedGuid) {
      return { storedGuidLive: true, liveGuid: storedGuid };
    }
    if (
      !liveGuid &&
      session?.guid &&
      itermSessionNameMatches(session.name, agent?.agentId)
    ) {
      liveGuid = session.guid;
    }
  }
  return { storedGuidLive: false, liveGuid };
}
