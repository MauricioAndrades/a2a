import { loadConfig, patchConfig, loadRegistry, saveRegistry, listGroupNames } from "./a2a-config.mjs";

export const ACTIONS = new Set(["message", "reply", "ask", "write"]);
export const ACTION_ALIASES = { write: "message" };

const RESERVED_FLAG_KEYS = new Set([
    "from", "to", "origin", "content", "url", "key",
    "id", "target", "desc", "lines", "system-prompt", "port", "user",
]);

export function buildRegistry(liveAgentIds = null) {
    const cached = loadRegistry();
    const groups = listGroupNames();
    const agents = Array.isArray(liveAgentIds)
        ? [...new Set(liveAgentIds)]
        : [...new Set(cached.agents)];
    saveRegistry({ agents, groups });
    return {
        actions: ACTIONS,
        agents: new Set(agents),
        groups: new Set(groups),
    };
}

export function classifyToken(token, registry) {
    const lower = token.toLowerCase();
    if (registry.actions.has(lower)) return { kind: "action", value: ACTION_ALIASES[lower] || lower };
    if (registry.agents.has(token) || registry.agents.has(lower)) return { kind: "agent", value: token };
    if (registry.groups.has(token) || registry.groups.has(lower)) return { kind: "group", value: token };
    return { kind: "unknown", value: token };
}

function parseColonFlag(rawFlag, registry) {
    const parts = rawFlag.slice(2).split(":");
    let action = null;
    const recipients = [];
    for (const part of parts) {
        const c = classifyToken(part, registry);
        if (c.kind === "action" && action === null) action = c.value;
        else recipients.push(part);
    }
    return { action, recipients };
}

export function isColonFlagArgv(argv) {
    return Array.isArray(argv) && argv.some((arg) => {
        if (!arg.startsWith("--")) return false;
        const eqIdx = arg.indexOf("=");
        return (eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2)).includes(":");
    });
}

export function parseColonFlagArgv(argv, registry) {
    let action = null;
    const recipients = [];
    const extras = {};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
        if (!arg.startsWith("--")) { positional.push(arg); continue; }
        const eqIdx = arg.indexOf("=");
        const flagPart = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

        if (flagPart.includes(":")) {
            const result = parseColonFlag("--" + flagPart, registry);
            if (result.action !== null && action === null) action = result.action;
            recipients.push(...result.recipients);
            continue;
        }
        if (eqIdx !== -1) { extras[flagPart] = arg.slice(eqIdx + 1); continue; }
        const c = classifyToken(flagPart, registry);
        if (c.kind === "action" && action === null) { action = c.value; continue; }
        if (c.kind === "agent" || c.kind === "group") { recipients.push(flagPart); continue; }
        if (!RESERVED_FLAG_KEYS.has(flagPart)) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) { extras[flagPart] = next; i++; }
            else if (registry.agents.has(flagPart) || registry.groups.has(flagPart)) { recipients.push(flagPart); }
            else { throw new Error(`unknown flag --${flagPart}`); }
        }
    }

    const { from: fromExtra, origin: originExtra, ...meta } = extras;
    return {
        from: fromExtra || null,
        origin: originExtra || null,
        recipients: [...new Set(recipients.filter(Boolean))],
        action: action || "message",
        content: positional.join(" ").trim(),
        ...meta,
    };
}
