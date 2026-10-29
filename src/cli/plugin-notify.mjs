// Agent-event wire format shared with cmd/a2a-iterm2-plugin/plugin.py.
//
//   OSC 1337 ; Custom=id=a2a:v1:<agentId>:<token>:<base64url(JSON {kind,text})> BEL
//
// iTerm2 hands the sequence to the plugin together with the id of the session
// that emitted it. The plugin accepts it only when <token> equals
// notifyToken(secret, agentId) and that session presents <agentId>; anything
// else is rejected and recorded. The secret is the plugin's install secret
// (iterm2-plugin.secret next to the bridge socket, mode 0600).
//
// Kept out of cli.mjs (which runs main() on import) so it can be unit-tested.

import { createHmac } from "node:crypto";

export const NOTIFY_IDENTITY = "a2a";
export const NOTIFY_KINDS = Object.freeze([ "attention", "done", "info" ]);
export const NOTIFY_MAX_TEXT = 512;

/**
 * Per-agent token: the first 32 hex chars of HMAC-SHA256(secret,
 * "a2a-notify-v1:<agentId>"). Mirror of notify_token() in plugin.py.
 *
 * @param {string} secret   64-hex-char install secret.
 * @param {string} agentId
 * @returns {string}
 */
export function notifyToken(secret, agentId) {
    return createHmac("sha256", Buffer.from(String(secret), "ascii")).update(`a2a-notify-v1:${agentId}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Validate and normalize an event body. Throws with a usage-ready message.
 *
 * @param {{ kind?: string, text?: string }} body
 * @returns {{ kind: string, text: string }}
 */
export function normalizeNotifyBody({ kind = "info", text = "" } = {}) {
    if (!NOTIFY_KINDS.includes(kind)) {
        throw new Error(`--kind must be one of: ${NOTIFY_KINDS.join(", ")}`);
    }
    if (typeof text !== "string" || [ ...text ].length > NOTIFY_MAX_TEXT) {
        throw new Error(`notify text must be at most ${NOTIFY_MAX_TEXT} characters`);
    }
    return { kind, text };
}

/**
 * The OSC payload after `Custom=id=a2a:`.
 *
 * @param {{ agentId: string, token: string, kind: string, text: string }} event
 * @returns {string}
 */
export function encodeNotifyPayload({ agentId, token, kind, text }) {
    const body = Buffer.from(JSON.stringify({ kind, text }), "utf8").toString("base64url");
    return `v1:${agentId}:${token}:${body}`;
}

/**
 * The full control sequence to write to the agent's terminal.
 *
 * @param {string} payload  From encodeNotifyPayload.
 * @returns {string}
 */
export function buildNotifySequence(payload) {
    return `\x1b]1337;Custom=id=${NOTIFY_IDENTITY}:${payload}\x07`;
}
