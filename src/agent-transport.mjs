// Pure helpers for deciding how a registered agent should be revived or
// routed. No IO — safe to unit test without mocks.

import { viableItermGuid } from "./transport-select.mjs";

/**
 * Should the CLI spawn a tmux session to revive a dead local agent before
 * raw/sequence delivery? iTerm-backed agents are revived via the bridge
 * instead; attempting tmux would create a stray duplicate session.
 *
 * @param {object|null|undefined} agent
 * @returns {boolean}
 */
export function shouldReviveAgentInTmux(agent) {
  if (!agent || agent.bridgeUrl) return false;
  if (viableItermGuid(agent.itermGuid)) return false;
  return true;
}

/**
 * Whether a registered local agent's session is reachable on tmux or iTerm.
 *
 * @param {object|null|undefined} agent
 * @param {{
 *   bridgeReachable: () => Promise<boolean>,
 *   listITermSessions: () => Promise<Array<{guid:string,name:string|null}>>,
 *   itermSessionNameMatches: (name: string|null, agentId: string) => boolean,
 *   tmuxSessionAlive: (target: string) => boolean,
 * }} deps
 * @returns {Promise<boolean>}
 */
export async function isAgentSessionAlive(agent, deps) {
  if (!agent?.agentId) return false;
  const {
    bridgeReachable,
    listITermSessions,
    itermSessionNameMatches,
    tmuxSessionAlive,
  } = deps;
  if (await bridgeReachable()) {
    const sessions = await listITermSessions();
    const stored =
      viableItermGuid(agent.itermGuid) ? agent.itermGuid.trim() : null;
    for (const session of sessions) {
      if (stored && session.guid === stored) return true;
      if (itermSessionNameMatches(session.name, agent.agentId)) return true;
    }
  }
  const target = agent.tmuxTarget || `${agent.agentId}:0.0`;
  return tmuxSessionAlive(target);
}
