

// Resolve the sender identity stamped onto an outbound a2a message.
//
// Lives outside cli.mjs because cli.mjs ends with `main()` at top level —
// importing it for testing would execute the dispatcher. Mirrors the
// established pattern in src/cli/{parse-start-args, session-inventory,
// reconnect-targets, team-agent-args}.mjs.
//
// CONTRACT: this function NEVER throws. The a2a channel must stay up even
// when callers feed it wonky inputs (invalid --origin, no tmux env, no
// TTY, etc.). The discipline is: `from` is the actor, `origin` is the
// internal authority class used by the bridge, and `source` is optional
// operator-surface provenance for human sends.
//
// Why this matters:
// The receiver of an a2a message treats user-origin traffic as human
// authority. A peer agent that silently gets stamped as origin=user can spoof
// op and cause the recipient to take actions it would normally confirm with
// op first. The bridge validates the enum, but the caller context is resolved
// here.
//
// Old logic was:
//     origin = explicitOrigin || (selfId ? "peer" : "user")
//     fromId = explicitFrom   || selfId || "cli"
// — which meant ANY caller without a tmux session defaulted to op. That
// fires for sudo-wrapped invocations, env-stripping spawn wrappers, and
// non-TTY shells. None of those are op typing.
//
// New rule: human/operator sends default to from="user" origin="user" with a
// source such as "cli". Agent sends default to from=<agent-id> origin="peer".
// If we cannot prove either an agent identity or an operator surface, the
// message still delivers as from="cli" origin="peer" so it cannot impersonate
// the human.

const VALID_ORIGINS = new Set(["user", "peer", "self"]);
const VALID_OPERATOR_SOURCES = new Set(["cli"]);

function normalizeOperatorSource(value, warn) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const source = value.trim();
  if (VALID_OPERATOR_SOURCES.has(source)) return source;
  if (warn) {
    warn(
      `a2a: ignoring invalid operator source '${source}', expected one of: ${[
        ...VALID_OPERATOR_SOURCES,
      ].join(", ")}`,
    );
  }
  return null;
}

function normalizeOriginForContext(
  explicitOrigin,
  operatorEvidence,
  warn,
) {
  if (!explicitOrigin) return null;

  if (!VALID_ORIGINS.has(explicitOrigin)) {
    if (warn) {
      warn(
        `a2a: ignoring invalid origin '${explicitOrigin}', clamping to default`,
      );
    }
    return null;
  }

  if (explicitOrigin === "user" && !operatorEvidence) {
    if (warn) {
      warn(
        "a2a: ignoring --origin user without operator evidence; stamping origin=peer",
      );
    }
    return "peer";
  }

  return explicitOrigin;
}

/**
 * @param {object} opts
 * @param {string|null|undefined} opts.explicitFrom   - caller-supplied --from
 * @param {string|null|undefined} opts.explicitOrigin - caller-supplied --origin
 * @param {string|null}           opts.selfId         - currentTmuxSession()
 *        result with dashboard/view sessions already null-ed out, or null if
 *        we're outside tmux / detection failed
 * @param {string|null|undefined} opts.agentId        - locked a2a agent id
 *        injected into launched sessions as A2A_AGENT_ID. Used when tool
 *        subprocesses lose TMUX but still inherit the agent process env.
 * @param {boolean}               opts.interactiveTTY - true iff stdin AND
 *        stdout are TTYs (real op-at-keyboard evidence)
 * @param {string|null|undefined} opts.operatorSource - trusted local operator
 *        surface, e.g. `cli`, used by non-interactive a2a control surfaces
 *        such as dashboard-tui.
 * @param {(msg: string) => void} [opts.warn]         - optional sink for
 *        diagnostics on suspicious-but-recoverable paths
 * @returns {{ fromId: string, origin: "user"|"peer"|"self", source?: string }}
 *        — always; this function does not throw
 */
export function resolveSenderIdentity(opts) {
  const explicitFrom = nonEmpty(opts.explicitFrom);
  const explicitOrigin = nonEmpty(opts.explicitOrigin);
  const selfId = nonEmpty(opts.selfId);
  const agentId = validAgentId(opts.agentId);
  const lockedId = selfId || agentId;
  const interactiveTTY = Boolean(opts.interactiveTTY);
  const warn = typeof opts.warn === "function" ? opts.warn : null;
  const operatorSource =
    normalizeOperatorSource(opts.operatorSource, warn) ||
    (interactiveTTY ? "cli" : null);
  const operatorEvidence = Boolean(operatorSource);

  if (explicitFrom && lockedId && explicitFrom !== lockedId && warn) {
    warn(
      `a2a: ignoring --from ${explicitFrom}; sender identity is locked to ${lockedId}`,
    );
  }

  const normalizedExplicitOrigin = normalizeOriginForContext(
    explicitOrigin,
    operatorEvidence,
    warn,
  );
  if (normalizedExplicitOrigin) {
    if (normalizedExplicitOrigin === "user") {
      return {
        fromId: explicitFrom || "user",
        origin: "user",
        source: operatorSource || "cli",
      };
    }
    return {
      fromId: lockedId || explicitFrom || "cli",
      origin: normalizedExplicitOrigin,
    };
  }

  // Registered tmux session or locked launched-agent env -> peer. The env
  // path catches Codex/Claude tool subprocesses that lose TMUX but still
  // inherit the launched agent identity.
  if (lockedId) {
    return { fromId: lockedId, origin: "peer" };
  }

  // No tmux session, but an operator surface is proven. This covers both a
  // bare interactive CLI and dashboard-tui, which shells out non-interactively
  // while still being driven by the human.
  if (operatorEvidence) {
    return {
      fromId: explicitFrom || "user",
      origin: "user",
      source: operatorSource,
    };
  }

  // No tmux session AND no TTY → subprocess that lost its a2a context
  // (sudo, env strip, wrapper script, CI). The message still goes
  // through, but as origin=peer so it can't masquerade as op. The warn
  // makes the suspicious call site visible in op's terminal/log.
  if (warn) {
    warn(
      "a2a: sender context unclear (no tmux session, no interactive TTY); " +
        "stamping origin=peer to avoid impersonating op. " +
        "Pass --from <agent-id> explicitly to name the sender.",
    );
  }
  return { fromId: explicitFrom || "cli", origin: "peer" };
}

/**
 * The agent identity used to exclude *self* from auto-inferred recipients and
 * broadcasts. Prefers the live tmux session name; falls back to the launched-
 * agent id carried in A2A_AGENT_ID so iTerm-backed agents — which have no TMUX
 * env, so currentTmuxSession() is null — don't deliver their own broadcasts or
 * auto-inferred sends back to themselves. Same selfId||agentId precedence as
 * lockedId in resolveSenderIdentity(); kept as its own export because the
 * exclusion path must not borrow the human-send "user" fallback fromId.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.selfId  - currentTmuxSession() result
 *        with dashboard/view sessions already null-ed out.
 * @param {string|null|undefined} opts.agentId - A2A_AGENT_ID injected into
 *        launched sessions.
 * @returns {string|null} the id to exclude, or null when self is unknown.
 */
export function selfExclusionId({ selfId, agentId } = {}) {
  return nonEmpty(selfId) || validAgentId(agentId);
}

function nonEmpty(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validAgentId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
}

export { VALID_ORIGINS };
