#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import { createCallbackGuard } from "./dots/callback-guard.mjs";
import { agentId, dotsConfig } from "./dots/config.mjs";
import { createEventStore } from "./dots/event-store.mjs";
import { createEventService, newMessageId } from "./dots/events.mjs";
import { createInbox } from "./dots/inbox.mjs";
import { createModernHandler, INVALID_PARAMS, isModernRequest, PROTOCOL_VERSION, RpcError } from "./dots/mcp-modern.mjs";
import { createToolRouter } from "./dots/tools.mjs";
import { constantTimeEquals } from "./dots/webhooks.mjs";

const config = dotsConfig();
const HOST = config.host;
const PORT = config.port;
const MCP_PATH = config.mcpPath;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = config.callbackPort;
const BRIDGE_URL = config.bridgeUrl;
const BRIDGE_KEY = config.bridgeKey;
const DOT_ID = config.dotId;
const A2A_BIN = config.bin;
const CALLBACK_URL = config.callbackUrl;
const MCP_URL = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
const VALID_ACTIONS = new Set([ "message", "reply", "ask" ]);
const VALID_ORIGINS = new Set([ "user", "peer", "self" ]);
const inbox = createInbox(config.maxInbox);
const SERVER_INFO = { name: "a2a-dots", version: "1.1.0" };
// Event subscriptions are fail-closed: with no configured key the endpoint
// still answers server/discover, but no callback destination is ever accepted
// and no durable state is created.
const EVENTS_ENABLED = Boolean(config.events.eventsKey);
const eventStore = EVENTS_ENABLED ? createEventStore({ dir: config.events.stateDir, maxJournal: config.events.maxJournal }) : null;
const callbackGuard = createCallbackGuard({ deadlineMs: config.events.deliveryDeadlineMs });
const events = EVENTS_ENABLED
    ? createEventService({
        dotId: config.dotId,
        store: eventStore,
        guard: callbackGuard,
        config: config.events,
        schedule: (task) =>
            setTimeout(() => {
                task().catch(() => {/* Delivery state records the failure. */});
            }, 0)
    })
    : null;
// With events enabled the durable journal is the record of accepted messages,
// so a restarted adapter restores them instead of starting empty. Inbox
// cursors stay per-instance, so a client resuming on an old cursor still sees
// reset=true and replays the restored window.
if (events) {
    for ( const stored of events.accepted().messages ) {
        // The whole persisted record is restored, including team/task identifiers
        // and the original acceptance time. Rebuilding a subset here would quietly
        // drop metadata the sender actually supplied.
        const { provenance: _provenance, eventCursor: _eventCursor, ...record } = stored;
        inbox.enqueue({ ...record, restored: true });
    }
}
const registrationOwner = randomUUID();
const requests = new Set();
let stopping = false;
let reconcileTimer;
let reconcilePromise;
let registrationAttempted = false;
let retryMs = config.reconcileMs;
let readiness = { ok: false, state: "starting", checkedAt: null, error: null };

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
}

async function readJson(req) {
    const chunks = [];
    let bytes = 0;
    for await ( const chunk of req ) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
            throw Object.assign(new Error("request body too large"), { statusCode: 413 });
        }
        chunks.push(chunk);
    }
    let body;
    try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch ( cause ) {
        throw Object.assign(new Error("invalid JSON", { cause }), { statusCode: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw Object.assign(new Error("body must be a JSON object"), { statusCode: 400 });
    }
    return body;
}

async function bridgeRequest(path, init = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("a2a bridge request timed out")), config.requestTimeoutMs);
    try {
        const response = await fetch(`${BRIDGE_URL}${path}`, { ...init, signal: controller.signal, headers: { "content-type": "application/json", ...(BRIDGE_KEY ? { authorization: `Bearer ${BRIDGE_KEY}` } : {}), ...(init.headers || {}) } });
        const text = await response.text();
        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`a2a bridge returned non-JSON HTTP ${response.status}`);
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("invalid a2a bridge response");
        }
        if (!response.ok || payload.success === false) {
            throw new Error(payload.error || `a2a bridge HTTP ${response.status}`);
        }
        return payload.data ?? payload;
    } finally {
        clearTimeout(timeout);
        requests.delete(controller);
    }
}

function registerDot() {
    // Capability was confirmed by bridgeAgents. Even if the response is lost,
    // shutdown can safely remove a route created by this instance's request.
    registrationAttempted = true;
    return bridgeRequest("/api/a2a/register", { method: "POST", body: JSON.stringify({ agentId: DOT_ID, tmuxTarget: `${DOT_ID}:0.0`, bridgeUrl: CALLBACK_URL, backend: "mcp", description: "ChatGPT Dot MCP peer", registrationOwner }) });
}

async function unregisterDot() {
    if (!registrationAttempted) {
        return;
    }
    try {
        await bridgeRequest(`/api/a2a/register/${encodeURIComponent(DOT_ID)}`, { method: "DELETE", headers: { "x-a2a-registration-owner": registrationOwner } });
    } catch ( error ) {
        process.stderr.write(`a2a-dots unregister: ${error.message}\n`);
    }
}

async function bridgeAgents() {
    const responseData = await bridgeRequest("/api/a2a/agents");
    if (responseData.registrationOwnership !== true) {
        throw new Error("bridge does not support owned adapter registration; update the bridge before starting this adapter");
    }
    if (!Array.isArray(responseData.agents) || responseData.agents.some((item) => !item || typeof item.agentId !== "string")) {
        throw new Error("invalid a2a bridge agents response");
    }
    return responseData.agents;
}

function reconcileRegistration() {
    if (stopping) {
        throw new Error("adapter is stopping");
    }
    if (reconcilePromise) {
        return reconcilePromise;
    }
    reconcilePromise = (async () => {
        try {
            const agents = await bridgeAgents();
            if (stopping) {
                throw new Error("adapter is stopping");
            }
            const current = agents.find((item) => item.agentId === DOT_ID);
            if (current && current.registrationOwner !== registrationOwner) {
                throw new Error(`registration '${DOT_ID}' belongs to another instance; stop its adapter or explicitly unregister an abandoned route`);
            }
            let registered = current;
            if (!current || current.bridgeUrl !== CALLBACK_URL || current.backend !== "mcp") {
                registered = await registerDot();
                if (registered.registrationOwner !== registrationOwner || registered.bridgeUrl !== CALLBACK_URL || registered.backend !== "mcp") {
                    throw new Error("bridge does not support owned adapter registration; update the bridge before starting this adapter");
                }
            }
            if (stopping) {
                throw new Error("adapter is stopping");
            }
            if (!readiness.ok) {
                process.stderr.write(`a2a-dots registered '${DOT_ID}' with ${BRIDGE_URL}; MCP at ${MCP_URL}${MCP_PATH}\n`);
            }
            readiness = { ok: true, state: "ready", checkedAt: new Date().toISOString(), error: null };
            retryMs = config.reconcileMs;
            return current ? agents.map((item) => item.agentId === DOT_ID ? registered : item) : [ ...agents, registered ];
        } catch ( error ) {
            if (!stopping) {
                if (readiness.error !== error.message) {
                    process.stderr.write(`a2a-dots not ready: ${error.message}\n`);
                }
                readiness = { ok: false, state: "degraded", checkedAt: new Date().toISOString(), error: error.message };
                retryMs = Math.min(retryMs * 2, Math.max(30000, config.reconcileMs));
            }
            throw error;
        } finally {
            reconcilePromise = undefined;
        }
    })();
    return reconcilePromise;
}

async function reconcileLoop() {
    try {
        await reconcileRegistration();
    } catch { /* Readiness records the failure; retry without losing the inbox. */ }
    if (!stopping) {
        reconcileTimer = setTimeout(reconcileLoop, retryMs);
    }
}

async function sendMessage(to, text, action = "message") {
    const recipient = agentId(to, "to");
    if (typeof text !== "string" || !text) {
        throw new Error("text is required");
    }
    if (!VALID_ACTIONS.has(action)) {
        throw new Error(`invalid action '${action}'`);
    }
    const agents = await reconcileRegistration();
    if (!agents.some((item) => item.agentId === recipient)) {
        throw new Error(`no registered agent '${recipient}'`);
    }
    return bridgeRequest("/api/a2a/send", { method: "POST", body: JSON.stringify({ to: recipient, from: DOT_ID, origin: "peer", source: "chatgpt-dot", body: text, action }) });
}

// `cwd` is the directory the CLI runs in, so `a2a start` spawns the agent
// there; it must already exist, because a missing directory would otherwise
// surface as an opaque spawn error. The CLI reports progress on stderr
// (`'x' registered at …`), so a successful run with no stdout returns that
// instead of discarding it.
function runCli(args, { cwd } = {}) {
    if (cwd !== undefined) {
        let stat;
        try {
            stat = statSync(cwd);
        } catch {
            stat = null;
        }
        if (!stat || !stat.isDirectory()) {
            return Promise.reject(new Error(`cwd is not an existing directory: ${cwd}`));
        }
    }
    return new Promise((resolve, reject) => {
        const child = spawn(A2A_BIN, args, { env: process.env, stdio: [ "ignore", "pipe", "pipe" ], ...(cwd === undefined ? {} : { cwd }) });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", reject);
        child.once("close", (code) => {
            const out = Buffer.concat(stdout).toString("utf8").trim();
            const err = Buffer.concat(stderr).toString("utf8").trim();
            if (code === 0) {
                resolve(out || err || "ok");
            } else {
                reject(new Error(err || out || `a2a exited ${code}`));
            }
        });
    });
}

// Builds the accepted record. Publishing it into the in-memory inbox is a
// separate step so the durable commit can happen first: a message whose
// persist failed must never become visible to receive_messages.
function acceptedRecord(body) {
    return ({
        to: DOT_ID,
        messageId: newMessageId(),
        // Acceptance time, recorded here because the durable event is written
        // before the inbox stamps its own copy.
        receivedAt: new Date().toISOString(),
        from: typeof body.from === "string" ? body.from : "unknown",
        origin: typeof body.origin === "string" ? body.origin : "peer",
        action: VALID_ACTIONS.has(body.action) ? body.action : "message",
        text: body.body,
        ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        // Carried through only when the sender actually supplied them. A missing
        // team or task identifier is never replaced with a synthesized one.
        ...(typeof body.teamId === "string" ? { teamId: body.teamId } : {}),
        ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {})
    });
}

function result(value) {
    return { content: [ { type: "text", text: JSON.stringify(value, null, 2) } ] };
}

const toolRouter = createToolRouter({ dotId: DOT_ID, agentId, sendMessage, reconcileRegistration, inbox, runCli, isStopping: () => stopping });

// Configuring an events key means this endpoint is reachable by a remote
// caller, so tool calls are authenticated in BOTH protocol eras. Guarding only
// the modern path would leave the legacy SDK route as an open bypass to the
// same send_message/start_agent/start_team/stop_agent handlers. With no key the adapter
// stays loopback-only and keeps its existing open local behavior.
function assertToolCallAuthorized(authorization) {
    if (!EVENTS_ENABLED) {
        return;
    }
    const presented = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!presented || !constantTimeEquals(presented, config.events.eventsKey)) {
        throw new Error("unauthorized: this adapter requires a bearer token for tool calls");
    }
}

function createMcpServer(authorization) {
    const mcp = new Server(SERVER_INFO, {
        // The legacy era advertises only what it can serve. Event support is
        // advertised through server/discover on the modern path, which is where
        // the events methods are actually reachable.
        capabilities: { tools: {} },
        instructions: `You are the a2a peer '${DOT_ID}'. Discover workers with list_agents/get_agent, delegate with send_message, collect asynchronous replies with receive_messages, look at a worker's terminal with peek_agent, and use start_agent/start_team/stop_agent for lifecycle control (start_agent launches one named agent; there is no need for any other launcher). Never impersonate the human operator.`
    });

    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolRouter.list() }));

    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        assertToolCallAuthorized(authorization);
        return result(await toolRouter.call(params.name, params.arguments));
    });

    return mcp;
}

const modern = createModernHandler({
    serverInfo: SERVER_INFO,
    toolRouter,
    // events is null when subscriptions are disabled. authorize is reached first
    // for every events method, so refusing there stops a caller before any
    // half-configured service is touched.
    events: events || {
        authorize() {
            throw new RpcError(INVALID_PARAMS, "event subscriptions are not enabled on this adapter", { httpStatus: 403 });
        }
    },
    capabilities: () => ({ tools: { listChanged: false }, ...(EVENTS_ENABLED ? { events: {} } : {}) }),
    allowedOrigins: () => config.events.allowedOrigins,
    // Configuring a key is the signal that this endpoint is reachable by a
    // remote caller, so tool calls join the authenticated boundary. With no key
    // the adapter stays loopback-only and keeps its existing open behavior.
    protectToolCalls: () => EVENTS_ENABLED
});

const callbackServer = createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", CALLBACK_URL);
        if (req.method !== "POST" || url.pathname !== "/api/a2a/send") {
            return sendJson(res, 404, { success: false, error: "not found" });
        }
        const body = await readJson(req);
        if (stopping) {
            return sendJson(res, 503, { success: false, error: "adapter is stopping" });
        }
        // When a callback key is configured the route authenticates its caller, so
        // a forged direct POST is refused. Without one the route keeps its existing
        // open behavior and the event payload reports the sender as claimed only.
        let bridgeAuthenticated = false;
        if (config.events.callbackKey) {
            const header = req.headers.authorization;
            const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
            if (!presented || !constantTimeEquals(presented, config.events.callbackKey)) {
                return sendJson(res, 401, { success: false, error: "unauthorized callback caller" });
            }
            bridgeAuthenticated = true;
        }
        if (body.to !== DOT_ID) {
            return sendJson(res, 404, { success: false, error: `no agent '${body.to}'` });
        }
        if (typeof body.body !== "string") {
            return sendJson(res, 400, { success: false, error: "body must be a string" });
        }
        if ((body.from !== undefined && (typeof body.from !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.from))) || (body.origin !== undefined && !VALID_ORIGINS.has(body.origin)) || (body.action !== undefined && !VALID_ACTIONS.has(body.action))) {
            return sendJson(res, 400, { success: false, error: "invalid sender, origin, or action" });
        }
        const accepted = acceptedRecord(body);
        // Emitted from the real accepted path. The event is persisted before this
        // request is acknowledged and before the message is published to the
        // inbox: a failed persist is NOT acknowledged, because returning 200 would
        // drop the message while telling the bridge it was accepted, and
        // publishing first would leave a visible message the adapter refused.
        if (events) {
            try {
                events.emit(accepted, {
                    // from/origin are what the caller claimed. This route does not
                    // independently authenticate a peer identity, and the bridge does not
                    // attach authenticated provenance, so the payload says so plainly
                    // rather than implying a verified sender.
                    senderClaimed: true,
                    bridgeAuthenticated,
                    transport: "a2a-bridge-callback"
                });
            } catch ( error ) {
                const reason = error instanceof Error ? error.message : String(error);
                process.stderr.write(`a2a-dots event persist failed: ${reason}\n`);
                return sendJson(res, 503, { success: false, error: `event state not persisted: ${reason}` });
            }
        }
        // Durable commit succeeded (or events are disabled); publish to the inbox.
        const message = inbox.enqueue(accepted);
        return sendJson(res, 200, { success: true, data: { bytes: Buffer.byteLength(body.body, "utf8"), cursor: message.cursor } });
    } catch ( error ) {
        return sendJson(res, error?.statusCode || 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
});

// The legacy initialize-era path, served by the SDK exactly as before. A
// pre-parsed body is forwarded so era detection does not consume the stream.
async function serveLegacyMcp(req, res, parsedBody) {
    const requestMcp = createMcpServer(req.headers.authorization);
    const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => {
        requestTransport.close().catch(() => {/* The response already closed. */});
        requestMcp.close().catch(() => {/* The response already closed. */});
    });
    await requestMcp.connect(requestTransport);
    await requestTransport.handleRequest(req, res, parsedBody);
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", MCP_URL);
        if (url.pathname === MCP_PATH) {
            if (req.method !== "POST") {
                // GET and DELETE belong to the removed session/standalone-stream
                // mechanics. They stay available for legacy clients only.
                return serveLegacyMcp(req, res, undefined);
            }
            const body = await readJson(req);
            if (!isModernRequest(req.headers, body)) {
                return serveLegacyMcp(req, res, body);
            }
            const answer = await modern.handle({ headers: req.headers, body, authorization: req.headers.authorization });
            if (answer.body === undefined) {
                res.writeHead(answer.status);
                res.end();
                return undefined;
            }
            return sendJson(res, answer.status, answer.body);
        }
        if (req.method === "GET" && url.pathname === "/health") {
            try {
                await reconcileRegistration();
            } catch { /* Return the observed failure as readiness instead of HTTP 500. */ }
            return sendJson(res, readiness.ok ? 200 : 503, {
                success: true,
                data: {
                    ...readiness,
                    agentId: DOT_ID,
                    bridgeUrl: BRIDGE_URL,
                    callbackUrl: CALLBACK_URL,
                    inbox: inbox.size,
                    protocols: { modern: PROTOCOL_VERSION, events: EVENTS_ENABLED ? "enabled" : "disabled" },
                    // Counts only. This route is unauthenticated, so it discloses no
                    // callback destination, subscription id or signing material.
                    ...(events ? { events: events.publicSnapshot() } : {})
                }
            });
        }
        return sendJson(res, 404, { success: false, error: "not found" });
    } catch ( error ) {
        return sendJson(res, error?.statusCode || 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
});

callbackServer.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
    server.listen(PORT, HOST, () => {
        reconcileLoop();
        // Deliveries persisted as queued by a previous process would otherwise sit
        // idle forever, since nothing re-triggers them without a new message.
        if (events) {
            events.drain().catch(() => {/* Delivery state records the failure. */});
        }
    });
});

async function shutdown() {
    if (stopping) {
        return;
    }
    stopping = true;
    readiness = { ...readiness, ok: false, state: "stopping" };
    clearTimeout(reconcileTimer);
    for ( const controller of requests ) {
        controller.abort(new Error("adapter is stopping"));
    }
    // Close listeners immediately. A stalled unregister or open MCP connection
    // must not prevent termination; the owner guard protects replacement routes.
    server.close();
    callbackServer.close();
    const deadline = setTimeout(() => process.exit(process.exitCode || 0), config.requestTimeoutMs + 1000);
    await unregisterDot();
    clearTimeout(deadline);
    process.exit(process.exitCode || 0);
}
for ( const listener of [ server, callbackServer ] ) {
    listener.on("error", (error) => {
        process.stderr.write(`a2a-dots listener error: ${error.message}\n`);
        process.exitCode = 1;
        shutdown().catch(() => process.exit(1));
    });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
