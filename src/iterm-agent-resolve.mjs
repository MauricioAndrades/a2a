import { viableItermGuid } from "./transport-select.mjs";

/**
 * Prefer a live bridge lookup by agent session name over a possibly-stale
 * registered `itermGuid`. When the live guid differs from the registry,
 * optionally re-register so later deliveries use the current window.
 *
 * @param {{ agentId: string, itermGuid?: string }|null|undefined} agent
 * @param {{
 *   probeBridgeReachable: () => Promise<boolean>,
 *   itermGuidByName: (name: string) => Promise<string|null>,
 *   reregisterItermAgent?: (agent: object, guid: string) => Promise<unknown>,
 * }} deps
 * @returns {Promise<{guid:string|null, bridgeReachable:boolean}>}
 */
export async function resolveLiveItermTarget(agent, deps) {
  if (!agent?.agentId) return { guid: null, bridgeReachable: false };
  const { probeBridgeReachable, itermGuidByName, reregisterItermAgent } = deps;
  const stored = viableItermGuid(agent.itermGuid)
    ? agent.itermGuid.trim()
    : null;
  const bridgeReachable = await probeBridgeReachable();
  if (!bridgeReachable) {
    return { guid: stored, bridgeReachable };
  }
  const liveGuid = await itermGuidByName(agent.agentId);
  if (liveGuid) {
    if (liveGuid !== stored && reregisterItermAgent) {
      await reregisterItermAgent(agent, liveGuid);
    }
    return { guid: liveGuid, bridgeReachable };
  }
  return { guid: stored, bridgeReachable };
}

/**
 * Back-compatible scalar wrapper for callers that only need the guid.
 *
 * @param {{ agentId: string, itermGuid?: string }|null|undefined} agent
 * @param {{
 *   probeBridgeReachable: () => Promise<boolean>,
 *   itermGuidByName: (name: string) => Promise<string|null>,
 *   reregisterItermAgent?: (agent: object, guid: string) => Promise<unknown>,
 * }} deps
 * @returns {Promise<string|null>}
 */
export async function resolveLiveItermGuid(agent, deps) {
  return (await resolveLiveItermTarget(agent, deps)).guid;
}
