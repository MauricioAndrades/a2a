import {
  loadRegistry,
  saveRegistry,
  listGroupNames,
} from "./a2a-config.mjs";

export const ACTIONS = new Set(["message", "reply", "ask", "write"]);
export const ACTION_ALIASES = { write: "message" };

const RESERVED_FLAG_KEYS = new Set([
  "from",
  "to",
  "origin",
  "content",
  "url",
  "key",
  "id",
  "target",
  "desc",
  "lines",
  "system-prompt",
  "port",
  "user",
]);
const VALUE_FLAG_KEYS = new Set(["from", "to", "origin", "content"]);
// Bare meta keys that may consume the NEXT argv word as their value. Only
// keys actually read downstream qualify: the CLI's sendNormalizedEnvelope
// (src/cli.mjs) reads `meta.source` to override the resolved sender source;
// every other meta key is spread into the bridge POST body and silently
// dropped by the server. Any other bare unknown flag throws — historically a
// typo'd recipient (`--scot`) swallowed the first word of the message into
// meta and silently broadcast the rest. Explicit `--key=value` metadata is
// still accepted (the `=` binds the value, so nothing can be swallowed).
const META_FLAG_KEYS = new Set(["source"]);

function uniqueStringValues(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function normalizeRecipients(primaryRecipient, recipients) {
  const normalized = [];
  const seen = new Set();
  if (primaryRecipient) {
    seen.add(primaryRecipient);
    normalized.push(primaryRecipient);
  }
  for (const recipient of recipients) {
    if (!recipient || seen.has(recipient)) continue;
    seen.add(recipient);
    normalized.push(recipient);
  }
  return normalized;
}

export function buildRegistry(liveAgentIds = null) {
  const cached = loadRegistry();
  const groups = listGroupNames();
  const cachedAgents = Array.isArray(cached.agents)
    ? uniqueStringValues(cached.agents)
    : [];
  const liveAgents = Array.isArray(liveAgentIds)
    ? uniqueStringValues(liveAgentIds)
    : null;
  // When we have a live list from the bridge, it is ground truth — persist
  // only those agents. Merging in cachedAgents here is what caused stale IDs
  // to accumulate: every send would re-hydrate dead agents back into the file.
  // Fall back to cachedAgents only when the bridge is unreachable (null).
  const registryAgents = liveAgents === null ? cachedAgents : liveAgents;
  saveRegistry({
    ...cached,
    agents: registryAgents,
    groups,
    installToken:
      typeof cached.installToken === "string" ? cached.installToken : null,
  });
  return {
    actions: ACTIONS,
    agents: new Set(registryAgents),
    groups: new Set(groups),
  };
}

function normalizeRegistry(registry) {
  return {
    actions: registry?.actions instanceof Set ? registry.actions : ACTIONS,
    agents: registry?.agents instanceof Set ? registry.agents : new Set(),
    groups: registry?.groups instanceof Set ? registry.groups : new Set(),
  };
}

export function classifyToken(token, registry) {
  const safe = normalizeRegistry(registry);
  const lower = token.toLowerCase();
  if (safe.actions.has(lower)) {
    return { kind: "action", value: ACTION_ALIASES[lower] || lower };
  }
  if (safe.agents.has(token) || safe.agents.has(lower)) {
    return { kind: "agent", value: token };
  }
  if (safe.groups.has(token) || safe.groups.has(lower)) {
    return { kind: "group", value: token };
  }
  return { kind: "unknown", value: token };
}

function parseColonFlag(rawFlag, registry) {
  const parts = rawFlag.slice(2).split(":");
  let action = null;
  const recipients = [];
  for (const part of parts) {
    const c = classifyToken(part, registry);
    if (c.kind === "action") {
      // A second action token used to fall through to the recipient list, so
      // `--message:ask:bob` delivered to a phantom agent named "ask".
      if (action !== null) {
        throw new Error(
          `duplicate action '${part}' in ${rawFlag}; a send takes a single action`,
        );
      }
      action = c.value;
    } else recipients.push(part);
  }
  return { action, recipients };
}

export function isColonFlagArgv(argv) {
  return (
    Array.isArray(argv) &&
    argv.some((arg) => {
      if (!arg.startsWith("--")) return false;
      const eqIdx = arg.indexOf("=");
      return (eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2)).includes(":");
    })
  );
}

export function parseColonFlagArgv(argv, registry) {
  let action = null;
  let inlineContent = null;
  const recipients = [];
  const extras = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const flagPart = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

    if (flagPart.includes(":")) {
      const result = parseColonFlag(`--${  flagPart}`, registry);
      if (result.action !== null) {
        if (action !== null) {
          throw new Error(
            `duplicate action '${result.action}'; a send takes a single action`,
          );
        }
        action = result.action;
      }
      recipients.push(...result.recipients);
      if (eqIdx !== -1) {
        if (inlineContent !== null)
          throw new Error("message content specified more than once");
        inlineContent = arg.slice(eqIdx + 1);
      }
      continue;
    }
    if (VALUE_FLAG_KEYS.has(flagPart)) {
      const value = eqIdx !== -1 ? arg.slice(eqIdx + 1) : argv[i + 1];
      if (value === undefined || (eqIdx === -1 && value.startsWith("--"))) {
        throw new Error(`--${flagPart} requires a value`);
      }
      if (eqIdx === -1) i++;
      if (flagPart === "content") {
        if (inlineContent !== null)
          throw new Error("message content specified more than once");
        inlineContent = value;
      } else {
        extras[flagPart] = value;
      }
      continue;
    }
    if (RESERVED_FLAG_KEYS.has(flagPart)) {
      throw new Error(`--${flagPart} is not valid in a2a message syntax`);
    }
    if (eqIdx !== -1) {
      // Explicit `--key=value` metadata stays accepted: the value is bound by
      // `=`, so it can never swallow message words the way the bare form did.
      extras[flagPart] = arg.slice(eqIdx + 1);
      continue;
    }
    const c = classifyToken(flagPart, registry);
    if (c.kind === "action") {
      if (action !== null) {
        throw new Error(
          `duplicate action '${flagPart}'; a send takes a single action`,
        );
      }
      action = c.value;
      continue;
    }
    if (c.kind === "agent" || c.kind === "group") {
      recipients.push(flagPart);
      continue;
    }

    // classifyToken already consulted the registry, so this token is neither
    // an action nor a known recipient. Only the real meta allowlist may
    // consume a value; anything else is a typo and must fail loudly instead
    // of eating the first word of the message.
    if (!META_FLAG_KEYS.has(flagPart)) {
      throw new Error(`unknown flag --${flagPart}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${flagPart} requires a value`);
    }
    extras[flagPart] = next;
    i++;
  }

  const positionalContent = positional.join(" ").trim();
  if (inlineContent !== null && positionalContent)
    throw new Error("message content specified more than once");

  const { from: fromExtra, origin: originExtra, to: toExtra, ...meta } = extras;
  return {
    from: fromExtra || null,
    origin: originExtra || null,
    recipients: normalizeRecipients(toExtra, recipients),
    action: action || "message",
    content: inlineContent !== null ? inlineContent : positionalContent,
    meta,
  };
}
