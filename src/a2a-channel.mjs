#!/usr/bin/env node
"use strict";

/**
 * Claude Code MCP channel: local HTTP webhook -> notifications/claude/channel,
 * optional reply via a2a CLI, sender gate, SSE mirror, permission relay.
 *
 * Standalone (e.g. npm run channel): MCP stdio idles with no peer, but the HTTP
 * listener and SSE mirror still run. Inbound POSTs require a listed X-Sender;
 * those notifications do not reach a Claude session until Claude Code spawns
 * this process over stdio.
 *
 * Project-root .mcp.json is read at Claude Code session start; the next session
 * wires stdio here so channel notifications reach the agent (requires claude.ai
 * auth and org channels policy when applicable).
 *
 * Env:
 *   A2A_CHANNEL_PORT   (default 8788)
 *   A2A_CHANNEL_HOST   (default 127.0.0.1)
 *   A2A_CHANNEL_SENDERS  comma-separated X-Sender allowlist (default empty)
 *   A2A_CHANNEL_KEY      required bearer token when host is non-loopback
 *   A2A_CHANNEL_BIN      a2a executable (default "a2a" on PATH)
 */

import { createServer } from "http";
import { spawnSync } from "child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bearerToken, channelStartupProblem, isLoopbackHost, parseAllowedSenders } from "./channel/auth.mjs";

const PORT = Number.parseInt(process.env.A2A_CHANNEL_PORT || "8788", 10) || 8788;
const HOST = process.env.A2A_CHANNEL_HOST || "127.0.0.1";
const A2A_BIN = process.env.A2A_CHANNEL_BIN || "a2a";
const CHANNEL_KEY = process.env.A2A_CHANNEL_KEY || "";

const allowed = parseAllowedSenders(process.env.A2A_CHANNEL_SENDERS || "");
const remoteAuthRequired = !isLoopbackHost(HOST);
const startupProblem = channelStartupProblem({ host: HOST, allowed, key: CHANNEL_KEY });
if (startupProblem) {
    console.error(startupProblem);
    process.exit(1);
}

/** @type {Set<(chunk: string) => void>} */
const listeners = new Set();

function sseSend(text) {
    const chunk = text.split("\n").map((l) => `data: ${l}\n`).join("") + "\n";
    for (const emit of listeners) emit(chunk);
}

function validatePeerId(id) {
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
    return true;
}

const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
    }),
});

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const mcp = new Server(
    { name: "a2a-channel", version: "1.0.0" },
    {
        capabilities: {
            experimental: {
                "claude/channel": {},
                "claude/channel/permission": {},
            },
            tools: {},
        },
        instructions: [
            "Inbound events arrive as <channel source=\"a2a-channel\" chat_id=\"...\" path=\"...\" method=\"...\"> (HTTP POST bodies pushed into this session). Read and act.",
            "a2a bridge (separate from this MCP process): HTTP server default http://127.0.0.1:7742 (port/host in ~/.claude/skills/a2a/config.json or A2A_PORT/A2A_HOST). It keeps an in-memory registry: each agent has agentId, tmuxTarget (e.g. bob:0.0), optional bridgeUrl for cross-machine.",
            "Sending between agents: POST /api/a2a/send JSON { to, from, origin, body, action } with origin user|peer|self. Local delivery: wrap body in <a2a_message from to origin action ts>…</a2a_message> and tmux paste-buffer into tmuxTarget then Enter. If recipient has bridgeUrl, the bridge forwards the same payload to that URL's /api/a2a/send instead.",
            "CLI `a2a` talks to the bridge (A2A_BRIDGE, optional bearer A2A_KEY). Peers reply with a2a --reply --<peer> so the other tmux session sees the message; typing only in your own pane does not reach them.",
            "This channel's reply tool runs that CLI: peer (registered agent id), text, optional action message|reply|ask. Use it to reach agents on the bridge. For in-session only, respond in the terminal without the tool.",
            "HTTP sidecars: GET /events is SSE for outbound mirror (replies, permission text). Permission relay: operator POST yes <5-letter-id> or no <id> with X-Sender in the configured allowlist. Non-loopback channel binds require Authorization: Bearer <A2A_CHANNEL_KEY>.",
        ].join(" "),
    },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "reply",
            description:
                "Send text to a registered a2a peer via the local a2a CLI (`a2a --<peer> <text>`, or `a2a --reply --<peer> ...` when action is reply). " +
                "Mirrors the command line to GET /events listeners for debugging.",
            inputSchema: {
                type: "object",
                properties: {
                    peer: {
                        type: "string",
                        description: "Registered agent id (e.g. bob). Must match [A-Za-z0-9_-]+.",
                    },
                    text: { type: "string", description: "Message body to deliver to that peer." },
                    action: {
                        type: "string",
                        enum: ["message", "reply", "ask"],
                        description: "a2a action (default message). Use reply when answering a peer.",
                    },
                },
                required: ["peer", "text"],
            },
        },
    ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "reply") throw new Error(`unknown tool: ${req.params.name}`);
    const args = req.params.arguments;
    if (!args || typeof args !== "object") throw new Error("missing arguments");
    const peer = /** @type {{ peer?: unknown; text?: unknown; action?: unknown }} */ (args).peer;
    const text = /** @type {{ peer?: unknown; text?: unknown; action?: unknown }} */ (args).text;
    const actionRaw = /** @type {{ peer?: unknown; text?: unknown; action?: unknown }} */ (args).action;
    if (typeof peer !== "string" || typeof text !== "string") throw new Error("peer and text must be strings");
    if (!validatePeerId(peer)) throw new Error(`invalid peer id: ${peer}`);
    const action =
        actionRaw === "reply" || actionRaw === "ask" || actionRaw === "message"
            ? actionRaw
            : "message";

    const argv =
        action === "message"
            ? [`--${peer}`, text]
            : [`--${action}`, `--${peer}`, text];

    const r = spawnSync(A2A_BIN, argv, {
        encoding: "utf8",
        env: process.env,
    });
    const stderr = (r.stderr || "").trim();
    const stdout = (r.stdout || "").trim();
    const summary = r.status === 0 ? "sent" : `a2a exited ${r.status}`;
    sseSend(`reply tool -> ${peer}: ${text}\n${stdout || stderr || summary}`);
    if (r.status !== 0) {
        return {
            content: [{ type: "text", text: `${summary}${stderr ? `: ${stderr}` : ""}` }],
            isError: true,
        };
    }
    return { content: [{ type: "text", text: stdout || summary }] };
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    sseSend(
        `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
            `Reply "yes ${params.request_id}" or "no ${params.request_id}" (POST body, X-Sender allowed).`,
    );
});

await mcp.connect(new StdioServerTransport());

let nextChatId = 1;

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        /** @param {string} chunk */
        const emit = (chunk) => {
            res.write(chunk);
        };
        listeners.add(emit);
        req.on("close", () => {
            listeners.delete(emit);
        });
        return;
    }

    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const body = await readTextBody(req);
        const sender = (req.headers["x-sender"] || "").toString();
        if (!allowed.has(sender)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("forbidden");
            return;
        }
        if (remoteAuthRequired && bearerToken(req) !== CHANNEL_KEY) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("unauthorized");
            return;
        }

        const m = PERMISSION_REPLY_RE.exec(body);
        if (m) {
            const word = m[1];
            const id = m[2];
            await mcp.notification({
                method: "notifications/claude/channel/permission",
                params: {
                    request_id: id.toLowerCase(),
                    behavior: word.toLowerCase().startsWith("y") ? "allow" : "deny",
                },
            });
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("verdict recorded");
            return;
        }

        const chat_id = String(nextChatId++);
        const pathname = url.pathname.replace(/[^A-Za-z0-9_/:-]+/g, "_").slice(0, 200) || "/";
        const method = (req.method || "POST").replace(/[^A-Z]+/g, "");
        await mcp.notification({
            method: "notifications/claude/channel",
            params: {
                content: body,
                meta: {
                    chat_id,
                    path: pathname,
                    method,
                },
            },
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
});

httpServer.requestTimeout = 0;
httpServer.headersTimeout = 0;
httpServer.listen(PORT, HOST, () => {
    const senders = allowed.size ? [...allowed].join(", ") : "(none)";
    const auth = remoteAuthRequired ? "bearer auth required" : "loopback";
    sseSend(`a2a-channel listening on http://${HOST}:${PORT} (X-Sender allowlist: ${senders}; ${auth})`);
});

/**
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readTextBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (c) => {
            raw += c.toString();
            if (raw.length > 2 * 1024 * 1024) {
                req.destroy();
                reject(new Error("body too large"));
            }
        });
        req.on("end", () => resolve(raw));
        req.on("error", reject);
    });
}
