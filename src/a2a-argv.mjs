export { isColonFlagArgv, parseColonFlagArgv } from "./a2a-tokens.mjs";

const ACTION_ALIASES = {
    message: "message",
    reply: "reply",
    ask: "ask",
    write: "message",
};

const VALUE_FLAGS = new Set(["content", "from", "origin", "to"]);

function isKnownRecipient(key, registry) {
    if (registry == null || typeof registry !== "object") return true;
    const agents = registry.agents instanceof Set ? registry.agents : new Set();
    const groups = registry.groups instanceof Set ? registry.groups : new Set();
    const lower = key.toLowerCase();
    return agents.has(key) || agents.has(lower) || groups.has(key) || groups.has(lower);
}

function assertKnownRecipient(key, registry) {
    if (!isKnownRecipient(key, registry)) throw new Error(`unknown flag --${key}`);
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
        throw new Error(`--${args[index].slice(2)} requires a value, got flag '${value}'`);
    }
    return { value, nextIndex: index + 2 };
}

export function isFlagSendArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return false;
    if (!argv[0]?.startsWith("--")) return false;

    try {
        return parseFlagSendArgv(argv) !== null;
    } catch {
        return false;
    }
}

export function parseFlagSendArgv(argv, registry = null) {
    if (!Array.isArray(argv) || argv.length === 0) return null;

    const recipients = [];
    const positional = [];
    const flags = {};
    let action = "message";
    let sawSendSyntax = false;

    for (let i = 0; i < argv.length;) {
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

        if (key in ACTION_ALIASES && eqIdx === -1) {
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

        assertKnownRecipient(key, registry);
        recipients.push(key);
        sawSendSyntax = true;
        i += 1;
    }

    if (!sawSendSyntax) return null;

    const content = typeof flags.content === "string"
        ? flags.content
        : positional.join(" ").trim();

    const to = typeof flags.to === "string" ? flags.to : undefined;
    if (to) assertKnownRecipient(to, registry);

    return {
        action,
        recipients: [...new Set([...(to ? [to] : []), ...recipients])],
        broadcast: !to && recipients.length === 0,
        content,
        from: typeof flags.from === "string" ? flags.from : null,
        origin: typeof flags.origin === "string" ? flags.origin : null,
        meta: {},
    };
}
