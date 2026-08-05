// File: transport-select.mjs
//
// Per-recipient transport autodetect. Pure decision logic — no IO.
// Decides which delivery / spawn transport to use for a single agent based on
// what the agent has registered, what capabilities are reachable, and the
// global protocol preference. Tested independently of any transport stack.
//
// Decision matrix (in order):
//   1. If only one transport is viable -> pick it.
//   2. If both are viable -> pick the preference.
//   3. If neither is viable -> return null.
//
// "Viable" for iterm = the bridge is reachable AND (the agent has an
// `itermGuid` OR the agent name maps to a session by `name`).
//
// "Viable" for tmux = the agent has a `tmuxTarget` AND that target's session
// is alive.

/**
 * Inputs for the picker. All optional; missing capabilities are treated as
 * "not viable for that transport."
 *
 * @typedef {object} PickInputs
 * @property {object} agent
 * @property {string} [agent.itermGuid]      iTerm session GUID, if registered.
 * @property {string} [agent.tmuxTarget]     tmux pane target, if registered.
 * @property {string} [agent.agentId]        agent name; used for iterm-by-name fallback.
 * @property {"iterm"|"tmux"} [preference]   global config preference.
 * @property {boolean} [bridgeReachable]     iTerm bridge is up.
 * @property {boolean} [itermNameMatch]      `agentId` matched an iTerm session by name.
 * @property {boolean} [tmuxSessionAlive]    `tmuxTarget`'s session is alive.
 */

/**
 * True when a registered iTerm GUID is present and not blank whitespace.
 *
 * @param {unknown} guid
 * @returns {boolean}
 */
export function viableItermGuid(guid) {
  return typeof guid === "string" && guid.trim() !== "";
}

/**
 * True when `tmuxTarget` is the default pane placeholder (`agentId:0.0`).
 * iTerm-spawned agents register this for bridge compatibility even when no
 * tmux session exists; it must not compete with a live iTerm path.
 *
 * @param {object} agent
 * @returns {boolean}
 */
export function isDefaultTmuxPlaceholder(agent) {
  const id = agent?.agentId;
  const target = agent?.tmuxTarget;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    typeof target === "string" &&
    target === `${id}:0.0`
  );
}

/**
 * Choose a transport for one recipient.
 *
 * @param {PickInputs} inputs
 * @returns {"iterm"|"tmux"|null}
 */
export function pickTransport({
  agent = {},
  preference = "tmux",
  bridgeReachable = false,
  itermNameMatch = false,
  tmuxSessionAlive = false,
} = {}) {
  const itermViable = Boolean(
    bridgeReachable &&
      (viableItermGuid(agent.itermGuid) || itermNameMatch),
  );
  let tmuxViable = Boolean(
    agent.tmuxTarget &&
      typeof agent.tmuxTarget === "string" &&
      tmuxSessionAlive,
  );
  // iTerm-backed agents carry a placeholder tmux target for registration.
  // Ignore coincidental tmux sessions with the same name when iTerm works.
  if (
    tmuxViable &&
    isDefaultTmuxPlaceholder(agent) &&
    viableItermGuid(agent.itermGuid) &&
    itermViable
  ) {
    tmuxViable = false;
  }

  if (itermViable && !tmuxViable) return "iterm";
  if (tmuxViable && !itermViable) return "tmux";
  if (!itermViable && !tmuxViable) return null;
  // Both viable — preference wins.
  return preference === "iterm" ? "iterm" : "tmux";
}

/**
 * Explain why a transport was (or could not be) picked. Returns a human-
 * readable reason for logging. Pure function over the same input shape.
 *
 * @param {PickInputs} inputs
 * @returns {string}
 */
export function explainPick(inputs) {
  const picked = pickTransport(inputs);
  const id = inputs.agent?.agentId || "<unknown>";
  if (picked === null) {
    const reasons = [];
    // Order matters: surface the *actionable* error first so the user
    // sees the fix command before the diagnostic noise.
    const itermPreferred = inputs.preference === "iterm";
    const hasItermShape =
      Boolean(inputs.agent?.itermGuid) ||
      (typeof inputs.agent?.agentId === "string" && inputs.agent.agentId);
    if (itermPreferred && hasItermShape && !inputs.bridgeReachable) {
      reasons.push(
        "iterm bridge unreachable — start it with: a2a bridge iterm start",
      );
    } else if (
      !viableItermGuid(inputs.agent?.itermGuid) &&
      !inputs.bridgeReachable
    ) {
      reasons.push("iterm bridge unreachable and no registered guid");
    } else if (
      !inputs.itermNameMatch &&
      !viableItermGuid(inputs.agent?.itermGuid)
    ) {
      reasons.push("no iterm session matches name");
    }
    if (!inputs.agent?.tmuxTarget) reasons.push("no tmux target registered");
    else if (!inputs.tmuxSessionAlive)
      reasons.push(`tmux session ${inputs.agent.tmuxTarget} is dead`);
    return `agent '${id}': no viable transport (${reasons.join("; ")})`;
  }
  return `agent '${id}': picked ${picked} (preference=${inputs.preference || "tmux"})`;
}
