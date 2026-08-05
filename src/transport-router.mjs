// File: transport-router.mjs
//
// Per-recipient transport selection. The persisted `protocol` config setting
// is treated as a *preference* — the active transport for each delivery is
// chosen per agent based on capability:
//
//   * iTerm is viable when the agent has a recorded `itermGuid`, or when the
//     bridge is reachable AND an iTerm session whose `name` matches the
//     agent id exists.
//   * tmux is viable when the agent has a `tmuxTarget` whose session is
//     live.
//
// When both are viable, the preference wins; when only one is viable, it is
// used regardless of preference (this is the "transparent fall-through" the
// previous global switch was missing). When neither is viable, delivery
// returns a structured error explaining what's missing.
//
// This module purposely separates *decision* (transport-select.mjs, pure)
// from *probes* (transport-probes.mjs, cached IO) from *transport mechanics*
// (tmux-raw-delivery, iterm2-delivery). The router is the integrator.

import { loadConfig } from "./a2a-config.mjs";
import { deliverRawTmuxInput } from "./tmux-raw-delivery.mjs";
import {
  deliverITerm2Input,
  listITerm2Sessions,
} from "./iterm2-delivery.mjs";
import {
  bridgeReachable as probeBridgeReachable,
  itermGuidByName,
  itermGuidExists,
  itermSessionNameMatches,
  tmuxSessionAlive as probeTmuxSessionAlive,
} from "./transport-probes.mjs";
import {
  explainPick,
  pickTransport,
  viableItermGuid,
} from "./transport-select.mjs";

/**
 * Returns the active delivery protocol preference. Treat as advisory; the
 * router still consults per-agent capability before dispatching.
 *
 * @returns {"tmux"|"iterm"}
 */
export function activeProtocol() {
  return loadConfig().protocol === "iterm" ? "iterm" : "tmux";
}

/**
 * Looks up an iTerm session GUID by agent name from the cached bridge view.
 * Returns null if the bridge is unreachable or no session matches.
 *
 * Kept as an export because cli.mjs (cmdRaw, runSequenceCommand) still calls
 * it to skip name lookup when the registry already knows the guid.
 *
 * @param {string} agentName
 * @returns {Promise<{ guid: string|null, error?: string }>}
 */
export async function resolveITerm2GuidByName(agentName) {
  if (!agentName) return { guid: null, error: "agentName required" };
  if (!(await probeBridgeReachable()))
    return { guid: null, error: "bridge unreachable" };
  // Fall back to a fresh list call when the cached probe is empty; keeps
  // backward compatibility with code paths that bypass the cached probes.
  const cached = await itermGuidByName(agentName);
  if (cached) return { guid: cached };
  const list = await listITerm2Sessions();
  if (!list.ok) return { guid: null, error: list.error };
  const match = list.sessions.find((s) =>
    itermSessionNameMatches(s.name, agentName),
  );
  return { guid: match?.guid || null };
}

/**
 * Picks a transport for a single recipient, given the configured preference.
 *
 * @param {object} agent  Registry entry. Must have at least `agentId`.
 * @param {object} [deps] Probe overrides for tests.
 * @returns {Promise<{ transport: "iterm"|"tmux"|null, reason: string, itermGuid: string|null }>}
 */
export async function selectTransportForAgent(agent, deps = {}) {
  const bridgeReachable = deps.bridgeReachable || probeBridgeReachable;
  const itermGuidExistsProbe = deps.itermGuidExists || itermGuidExists;
  const itermGuidByNameProbe = deps.itermGuidByName || itermGuidByName;
  const tmuxSessionAliveProbe =
    deps.tmuxSessionAlive || probeTmuxSessionAlive;
  const preference = activeProtocol();
  const agentName = agent?.agentId || "";
  const tmuxAlive = tmuxSessionAliveProbe(agent?.tmuxTarget || agentName);
  let resolvedGuid =
    typeof agent?.itermGuid === "string" && agent.itermGuid.trim()
      ? agent.itermGuid.trim()
      : null;

  if (
    preference === "tmux" &&
    tmuxAlive &&
    !viableItermGuid(resolvedGuid)
  ) {
    const pickInputs = {
      agent: { ...agent, itermGuid: undefined },
      preference,
      bridgeReachable: false,
      itermNameMatch: false,
      tmuxSessionAlive: true,
    };
    return {
      transport: pickTransport(pickInputs),
      reason: explainPick(pickInputs),
      itermGuid: null,
    };
  }

  // iTerm capability: explicit guid OR (bridge up + name match).
  const bridgeUp = await bridgeReachable();
  let itermNameMatch = false;
  // A registry guid can be stale (window closed, iTerm restarted). Trusting
  // it whenever the bridge is up fails delivery with "unknown session"
  // instead of falling through to a live tmux session. Validate against the
  // bridge's live session list and drop dead guids.
  if (resolvedGuid && bridgeUp && !(await itermGuidExistsProbe(resolvedGuid))) {
    resolvedGuid = null;
  }
  if (!resolvedGuid && bridgeUp && agentName) {
    resolvedGuid = await itermGuidByNameProbe(agentName);
    itermNameMatch = Boolean(resolvedGuid);
  }
  const transport = pickTransport({
    agent: { ...agent, itermGuid: resolvedGuid || undefined },
    preference,
    bridgeReachable: bridgeUp,
    itermNameMatch: itermNameMatch || Boolean(resolvedGuid),
    tmuxSessionAlive: tmuxAlive,
  });

  return {
    transport,
    reason: explainPick({
      agent: { ...agent, itermGuid: resolvedGuid || undefined },
      preference,
      bridgeReachable: bridgeUp,
      itermNameMatch: itermNameMatch || Boolean(resolvedGuid),
      tmuxSessionAlive: tmuxAlive,
    }),
    itermGuid: resolvedGuid,
  };
}

/**
 * Delivers raw text to an agent. Picks transport per-recipient with
 * transparent fall-through (iterm pref + tmux-only agent still works).
 *
 * @param {object} opts
 * @param {string} opts.agentName
 * @param {string} [opts.tmuxTarget]
 * @param {string} [opts.itermGuid]
 * @param {object} [opts.agent]      Full registry entry (preferred input).
 * @param {string} opts.content
 * @param {string} [opts.backend]
 * @param {boolean} [opts.submit=true]
 * @param {boolean} [opts.verify]
 * @returns {Promise<{ok:boolean,bytes?:number,error?:string,warning?:string,transport:"tmux"|"iterm"|"none"}>}
 */
export async function deliverViaActiveProtocol(opts) {
  const agentInput = opts.agent || {
    agentId: opts.agentName,
    tmuxTarget: opts.tmuxTarget,
    itermGuid: opts.itermGuid,
    backend: opts.backend,
  };
  const { transport, reason, itermGuid } = await selectTransportForAgent(
    agentInput,
  );
  if (transport === null) {
    // No transport was attempted — reporting the *preference* here produced
    // misleading "via tmux failed" messages. "none" renders truthfully.
    return {
      ok: false,
      transport: "none",
      error: reason,
    };
  }
  if (transport === "iterm") {
    return await deliverIterm({ ...opts, itermGuid });
  }
  return deliverTmux(opts);
}

async function deliverIterm({
  itermGuid,
  content,
  backend = "",
  submit = true,
  verify,
}) {
  const r = await deliverITerm2Input({
    target: itermGuid,
    content,
    backend,
    submit,
    verify,
  });
  return { ...r, transport: "iterm" };
}

function deliverTmux({
  agentName,
  tmuxTarget,
  content,
  backend = "",
  submit = true,
  verify,
}) {
  const target = tmuxTarget || `${agentName}:0.0`;
  const r = deliverRawTmuxInput({
    target,
    content,
    backend,
    submit,
    verify,
  });
  return { ...r, transport: "tmux" };
}
