export { isColonFlagArgv, parseColonFlagArgv } from "./a2a-tokens.mjs";
import { hasUnescapedGlob } from "./recipient-selectors.mjs";

const ACTION_ALIASES = {
  message: "message",
  reply: "reply",
  ask: "ask",
  write: "message",
};

const VALUE_FLAGS = new Set(["content", "from", "origin", "to"]);
// Flags that take a value AND are exclusive to sequence/command mode. The
// presence of any of these (or --command itself) switches the parser into
// sequence mode. In legacy mode they would be misclassified — see
// isSequenceFlagArgv() below.
const SEQUENCE_VALUE_FLAGS = new Set(["command", "write"]);
const SEQUENCE_BOOLEAN_FLAGS = new Set(["stdin", "no-submit", "submit"]);
const EMPTY_REGISTRY_SET = new Set();

function normalizeRecipientRegistry(registry) {
  if (registry == null || typeof registry !== "object") return null;
  return {
    agents:
      registry.agents instanceof Set ? registry.agents : EMPTY_REGISTRY_SET,
    groups:
      registry.groups instanceof Set ? registry.groups : EMPTY_REGISTRY_SET,
  };
}

function isKnownRecipient(key, recipientRegistry) {
  if (recipientRegistry === null) return true;
  const { agents, groups } = recipientRegistry;
  const lower = key.toLowerCase();
  return (
    agents.has(key) || agents.has(lower) || groups.has(key) || groups.has(lower)
  );
}

function assertKnownRecipient(key, registry) {
  if (hasUnescapedGlob(key)) return;
  if (!isKnownRecipient(key, registry))
    throw new Error(`unknown flag --${key}`);
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

function readFlagValue(args, index, eqIdx) {
  if (eqIdx !== -1) {
    return { value: args[index].slice(eqIdx + 1), nextIndex: index + 1 };
  }

  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`--${args[index].slice(2)} requires a value`);
  }
  if (value.startsWith("--")) {
    throw new Error(
      `--${args[index].slice(2)} requires a value, got flag '${value}'`,
    );
  }
  return { value, nextIndex: index + 2 };
}

/**
 * True when the argv carries a `--command` flag — switches the parser into
 * sequence mode (raw local key/text delivery), which is mutually exclusive
 * with the legacy message-envelope path.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function isSequenceFlagArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  return argv.some((arg) => {
    if (typeof arg !== "string" || !arg.startsWith("--")) return false;
    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    return key === "command";
  });
}

export function isFlagSendArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (!argv[0]?.startsWith("--")) return false;
  if (isSequenceFlagArgv(argv)) return false;

  try {
    return parseFlagSendArgv(argv) !== null;
  } catch {
    return false;
  }
}

export function parseFlagSendArgv(argv, registry = null) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (isSequenceFlagArgv(argv)) return null;

  const recipientRegistry = normalizeRecipientRegistry(registry);
  const recipients = [];
  const positional = [];
  const flags = {};
  let action = "message";
  let sawSendSyntax = false;

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      i += 1;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

    // Object.hasOwn, NOT `in`: `in` walks the prototype chain, so a flag like
    // `--toString` would resolve to Function.prototype.toString and become the
    // parsed "action". Plain-object lookups on user input must be own-key only.
    if (Object.hasOwn(ACTION_ALIASES, key) && eqIdx === -1) {
      action = ACTION_ALIASES[key];
      sawSendSyntax = true;
      i += 1;
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      const { value, nextIndex } = readFlagValue(argv, i, eqIdx);
      flags[key] = value;
      sawSendSyntax = true;
      i = nextIndex;
      continue;
    }

    if (eqIdx !== -1) {
      return null;
    }

    assertKnownRecipient(key, recipientRegistry);
    recipients.push(key);
    sawSendSyntax = true;
    i += 1;
  }

  if (!sawSendSyntax) return null;

  const positionalContent = positional.join(" ").trim();
  // `--content "hi" extra words` used to silently discard the positionals;
  // the sibling colon parser throws for the same ambiguity, so match it.
  if (typeof flags.content === "string" && positionalContent) {
    throw new Error("message content specified more than once");
  }
  const content =
    typeof flags.content === "string" ? flags.content : positionalContent;

  const to = typeof flags.to === "string" ? flags.to : undefined;
  if (to && !hasUnescapedGlob(to)) assertKnownRecipient(to, recipientRegistry);

  return {
    action,
    recipients: normalizeRecipients(to, recipients),
    broadcast: !to && recipients.length === 0,
    content,
    from: typeof flags.from === "string" ? flags.from : null,
    origin: typeof flags.origin === "string" ? flags.origin : null,
    meta: {},
  };
}

/**
 * Parse a sequence-mode argv. Required: `--command 'SEQ'`. Optional:
 * `--write 'TEXT'`, `--stdin`, `--no-submit`. Recipients are bare `--<name>`
 * flags as in the send-syntax path.
 *
 * @param {string[]} argv
 * @param {object|null} [registry]
 * @returns {{
 *   action: "sequence",
 *   recipients: string[],
 *   broadcast: boolean,
 *   command: string,
 *   write: string|null,
 *   stdin: boolean,
 *   submit: boolean,
 *   from: string|null,
 *   origin: string|null,
 * }}
 */
export function parseSequenceFlagArgv(argv, registry = null) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("sequence command requires --command");
  }

  const recipientRegistry = normalizeRecipientRegistry(registry);
  const recipients = [];
  const positional = [];
  const commandParts = [];
  /** @type {string|null} */
  let writeValue = null;
  let stdinFlag = false;
  let submit = true;
  /** @type {string|null} */
  let fromValue = null;
  /** @type {string|null} */
  let originValue = null;
  /** @type {string|null} */
  let toValue = null;

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      i += 1;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

    if (SEQUENCE_BOOLEAN_FLAGS.has(key)) {
      if (eqIdx !== -1) {
        throw new Error(`--${key} does not take a value`);
      }
      if (key === "no-submit") submit = false;
      else if (key === "submit") submit = true;
      else if (key === "stdin") stdinFlag = true;
      i += 1;
      continue;
    }

    if (SEQUENCE_VALUE_FLAGS.has(key)) {
      const { value, nextIndex } = readFlagValue(argv, i, eqIdx);
      if (key === "command") {
        commandParts.push(value);
      } else if (key === "write") {
        if (writeValue !== null) {
          throw new Error("--write specified more than once");
        }
        writeValue = value;
      }
      i = nextIndex;
      continue;
    }

    if (key === "from") {
      const { value, nextIndex } = readFlagValue(argv, i, eqIdx);
      fromValue = value;
      i = nextIndex;
      continue;
    }
    if (key === "origin") {
      const { value, nextIndex } = readFlagValue(argv, i, eqIdx);
      originValue = value;
      i = nextIndex;
      continue;
    }
    if (key === "to") {
      const { value, nextIndex } = readFlagValue(argv, i, eqIdx);
      toValue = value;
      i = nextIndex;
      continue;
    }

    if (eqIdx !== -1) {
      throw new Error(`unknown flag --${key} in --command sequence`);
    }

    assertKnownRecipient(key, recipientRegistry);
    recipients.push(key);
    i += 1;
  }

  if (commandParts.length === 0) {
    throw new Error("--command is required for sequence mode");
  }
  // Concatenate multiple --command flags with the same separator the DSL uses.
  const command = commandParts.join("|");

  if (toValue && !hasUnescapedGlob(toValue)) {
    assertKnownRecipient(toValue, recipientRegistry);
  }

  // Positional tokens are not valid in sequence mode — the body comes from
  // --write or --stdin. Reject them so silent drops can't happen.
  const positionalContent = positional.join(" ").trim();
  if (positionalContent) {
    throw new Error(
      "sequence mode does not accept positional content; use --write or --stdin",
    );
  }

  return {
    action: "sequence",
    recipients: normalizeRecipients(toValue, recipients),
    broadcast: !toValue && recipients.length === 0,
    command,
    write: writeValue,
    stdin: stdinFlag,
    submit,
    from: fromValue,
    origin: originValue,
  };
}
