export { isColonFlagArgv, parseColonFlagArgv } from "./a2a-tokens.mjs";

const ACTION_ALIASES = {
    message: "message",
    reply: "reply",
    ask: "ask",
    write: "message",
};

const VALUE_FLAGS = new Set(["content", "from", "origin", "to"]);

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

export function parseFlagSendArgv(argv) {
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

        recipients.push(key);
        sawSendSyntax = true;
        i += 1;
    }

    if (!sawSendSyntax) return null;

    const content = typeof flags.content === "string"
        ? flags.content
        : positional.join(" ").trim();

    return {
        action,
        recipients: [...new Set(recipients)],
        content,
        from: typeof flags.from === "string" ? flags.from : undefined,
        origin: typeof flags.origin === "string" ? flags.origin : undefined,
        to: typeof flags.to === "string" ? flags.to : undefined,
    };
}
