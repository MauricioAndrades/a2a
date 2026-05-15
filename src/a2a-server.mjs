#!/usr/bin/env node
"use strict";

import { createServer, request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { spawnSync } from "child_process";
import { activePort, activeHost, activeKey, writePid, removePid, loadConfig, peerKeyForUrl, appendMessageLog } from "./a2a-config.mjs";
import { wrapEnvelope } from "./server/envelope.mjs";
import { authFromRequest, configuredPeerUrl, isTrustedBrowserLoopbackHostname } from "./server/auth.mjs";
import { readJsonBody } from "./server/read-json-body.mjs";

process.title = "a2a-bridge";

const PORT = activePort();
const HOST = activeHost();

const registry = new Map();

const MAX_BODY = 1024 * 1024; // 1 MB

function ok(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data, timestamp: Date.now() }));
}

function fail(res, status, error) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error }));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Per-target serialization. Before tmuxDeliver became async the bridge implicitly serialized
// every delivery via spawnSync's event-loop-blocking behaviour. With awaited sleeps, concurrent
// /api/a2a/send requests to the SAME pane could interleave paste-buffer/Enter sequences and
// scramble each other. Per-target lock preserves "one delivery in flight per pane" while still
// allowing cross-target deliveries to run in parallel.
const targetLocks = new Map();

function withTargetLock(target, fn) {
    const prev = targetLocks.get(target) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    targetLocks.set(target, next);
    // Use .then(cleanup, cleanup) rather than .finally(cleanup) so the rejection in `next`
    // is consumed by this branch instead of propagating into a derived unhandled promise.
    // The caller still receives `next` and handles the rejection via their own await.
    const cleanup = () => { if (targetLocks.get(target) === next) targetLocks.delete(target); };
    next.then(cleanup, cleanup);
    return next;
}

const PASTE_SETTLE_FLOOR_MS = Number.parseInt(process.env.A2A_PASTE_SETTLE_FLOOR_MS || "", 10) || 300;
const PASTE_SETTLE_PER_KB_MS = Number.parseInt(process.env.A2A_PASTE_SETTLE_PER_KB_MS || "", 10) || 8;
const PASTE_SETTLE_CEILING_MS = Number.parseInt(process.env.A2A_PASTE_SETTLE_CEILING_MS || "", 10) || 1500;
const PASTE_VERIFY_RETRY_DELAY_MS = Number.parseInt(process.env.A2A_PASTE_VERIFY_RETRY_DELAY_MS || "", 10) || 200;
const PASTE_MAX_ENTER_RETRIES = Number.parseInt(process.env.A2A_PASTE_MAX_ENTER_RETRIES || "", 10) || 5;
const PASTE_VERIFY = process.env.A2A_PASTE_VERIFY !== "0";
const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #\d+/;

function computeSettleMs(byteLength) {
    const scaled = PASTE_SETTLE_FLOOR_MS + Math.floor(byteLength / 1024) * PASTE_SETTLE_PER_KB_MS;
    return Math.max(0, Math.min(PASTE_SETTLE_CEILING_MS, scaled));
}

function placeholderStillPresent(target) {
    const r = spawnSync("tmux", ["capture-pane", "-t", target, "-p", "-S", "-10"]);
    if (r.status !== 0) return false;
    return PASTE_PLACEHOLDER_PATTERN.test((r.stdout || "").toString());
}

function tmuxDeliver(target, content) {
    return withTargetLock(target, () => deliverOnce(target, content));
}

async function deliverOnce(target, content) {
    const buf = `a2a-${process.pid}-${Date.now()}-${Math.floor(Math.random()*0xffff).toString(16)}`;
    const load = spawnSync("tmux", ["load-buffer", "-b", buf, "-"], { input: content });
    if (load.status !== 0) return { ok: false, error: `tmux load-buffer failed: ${load.stderr?.toString().trim()||"unknown"}` };

    const paste = spawnSync("tmux", ["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
    if (paste.status !== 0) { spawnSync("tmux", ["delete-buffer", "-b", buf]); return { ok: false, error: `tmux paste-buffer failed: ${paste.stderr?.toString().trim()||"unknown"}` }; }

    // Wait for the receiving TUI to process the bracketed-paste end marker and render its
    // placeholder before we send Enter. Without this the Enter races the placeholder commit
    // and gets absorbed into the paste, leaving the message sitting unsubmitted.
    await sleep(computeSettleMs(Buffer.byteLength(content, "utf8")));

    // Send Enter and verify it took effect. If the placeholder is still visible after the
    // delay, the Enter landed before the TUI committed the paste -- send it again. Retry up
    // to PASTE_MAX_ENTER_RETRIES times with exponential backoff on the verify delay.
    for (let attempt = 0; attempt < PASTE_MAX_ENTER_RETRIES; attempt++) {
        const enter = spawnSync("tmux", ["send-keys", "-t", target, "Enter"]);
        if (enter.status !== 0) return { ok: false, error: `tmux send-keys failed: ${enter.stderr?.toString().trim()||"unknown"}` };

        if (!PASTE_VERIFY) break;

        // Backoff: 200, 300, 450, 675, 1012 -- gives the TUI progressively more time
        const delay = Math.floor(PASTE_VERIFY_RETRY_DELAY_MS * Math.pow(1.5, attempt));
        await sleep(delay);

        if (!placeholderStillPresent(target)) break;
    }

    return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
}

function checkAuth(req) {
    return authFromRequest(req, { ...loadConfig(), key: activeKey() });
}

function remoteDeliver(targetUrl, payload) {
    return new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        const url = new URL("/api/a2a/send", targetUrl);
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const authKey = peerKeyForUrl(targetUrl);
        const req = transport({
            method: "POST",
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            headers: {
                "Content-Type": "application/json",
                "Content-Length": body.length,
                ...(authKey ? { "Authorization": `Bearer ${authKey}` } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    resolve(data.success ? { ok: true, bytes: data.data?.bytes ?? body.length } : { ok: false, error: `remote: ${data.error||"unknown"}` });
                } catch { resolve({ ok: false, error: `non-JSON response (${res.statusCode})` }); }
            });
        });
        req.on("error", (err) => resolve({ ok: false, error: `unreachable: ${err.message}` }));
        req.write(body); req.end();
    });
}

async function handleA2ARoutes(method, path, req, res, auth) {
    if (!path.startsWith("/api/a2a/")) return false;

    if (method === "POST" && path === "/api/a2a/register") {
        try {
            const body = await readJsonBody(req, MAX_BODY);
            if (!body.agentId || !body.tmuxTarget) { fail(res, 400, "agentId and tmuxTarget are required"); return true; }
            const local = auth.kind === "operator" || (auth.kind === "local-open" && auth.loopback);
            const peer = auth.kind === "peer" && auth.peer === body.agentId;
            if (!local && !peer) { fail(res, 403, "not allowed to register this agent"); return true; }

            const existing = registry.get(body.agentId);
            if (peer && existing?.kind === "local") { fail(res, 409, "remote peer cannot overwrite local registration"); return true; }

            const kind = local ? "local" : "remote";
            const bridgeUrl = kind === "remote"
                ? configuredPeerUrl(loadConfig(), body.agentId)
                : body.bridgeUrl;
            if (kind === "remote" && !bridgeUrl) { fail(res, 403, "remote peer URL is not configured"); return true; }

            registry.set(body.agentId, {
                agentId: body.agentId,
                kind,
                tmuxTarget: body.tmuxTarget,
                cwd: body.cwd,
                description: body.description,
                bridgeUrl,
                backend: body.backend,
                backendArgs: Array.isArray(body.backendArgs) ? body.backendArgs : undefined,
                backendEnv: body.backendEnv && typeof body.backendEnv === "object" ? body.backendEnv : undefined,
                startupPrompt: typeof body.startupPrompt === "string" ? body.startupPrompt : undefined,
                registeredAt: Date.now(),
            });
            ok(res, registry.get(body.agentId));
        } catch (e) { fail(res, 400, `invalid body: ${e.message}`); }
        return true;
    }

    const unregMatch = path.match(/^\/api\/a2a\/register\/(.+)$/);
    if (method === "DELETE" && unregMatch) {
        const id = decodeURIComponent(unregMatch[1]);
        ok(res, { agentId: id, removed: registry.delete(id) });
        return true;
    }

    if (method === "GET" && path === "/api/a2a/agents") {
        ok(res, { agents: Array.from(registry.values()) });
        return true;
    }

    if (method === "POST" && path === "/api/a2a/send") {
        let body = null;
        try {
            body = await readJsonBody(req, MAX_BODY);
            if (!body.to || !body.from || !body.origin || typeof body.body !== "string") {
                fail(res, 400, "to, from, origin, body are required");
                appendMessageLog({ from: body?.from || "?", to: body?.to || "?", action: body?.action, origin: body?.origin || "?", body: body?.body, ok: false, error: "missing required field (to/from/origin/body)" });
                return true;
            }
            if (!["user","peer","self"].includes(body.origin)) {
                fail(res, 400, `invalid origin '${body.origin}'`);
                appendMessageLog({ from: body.from, to: body.to, action: body.action, origin: body.origin, body: body.body, ok: false, error: `invalid origin '${body.origin}'` });
                return true;
            }
            if (body.replyTo && !registry.has(body.from) && auth.kind === "peer" && auth.peer === body.from) {
                const bridgeUrl = configuredPeerUrl(loadConfig(), body.from) || String(body.replyTo).replace(/\/$/, "");
                registry.set(body.from, {
                    agentId: body.from,
                    kind: "remote",
                    tmuxTarget: `${body.from}:0.0`,
                    bridgeUrl,
                    registeredAt: Date.now(),
                });
            }
            const recipient = registry.get(body.to);
            if (!recipient) {
                const err = `no agent '${body.to}' (registered: ${Array.from(registry.keys()).join(", ")||"none"})`;
                fail(res, 404, err);
                appendMessageLog({ from: body.from, to: body.to, action: body.action, origin: body.origin, body: body.body, ok: false, error: err });
                return true;
            }
            const transport = recipient.bridgeUrl ? "remote" : "tmux";
            const delivery = recipient.bridgeUrl ? await remoteDeliver(recipient.bridgeUrl, body) : await tmuxDeliver(recipient.tmuxTarget, wrapEnvelope(body));
            appendMessageLog({ from: body.from, to: body.to, action: body.action, origin: body.origin, body: body.body, bytes: delivery.bytes ?? Buffer.byteLength(body.body, "utf8"), ok: delivery.ok, error: delivery.error, transport });
            if (!delivery.ok) { fail(res, 502, delivery.error); return true; }
            ok(res, { to: body.to, target: recipient.tmuxTarget, bytes: delivery.bytes });
        } catch (e) {
            fail(res, 400, `invalid body: ${e.message}`);
            if (body && body.from && body.to) appendMessageLog({ from: body.from, to: body.to, action: body.action, origin: body.origin || "?", body: body.body, ok: false, error: `invalid body: ${e.message}` });
        }
        return true;
    }

    return false;
}

async function handleRequest(req, res) {
    const origin = req.headers.origin;
    if (origin) {
        try {
            const u = new URL(origin);
            if (!isTrustedBrowserLoopbackHostname(u.hostname)) { fail(res, 403, "origin not allowed"); return; }
        } catch { fail(res, 403, "invalid origin"); return; }
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

    const path = new URL(req.url, `http://${HOST}:${PORT}`).pathname;

    if (req.method === "GET" && path === "/health") {
        const cfg = loadConfig();
        ok(res, { ok: true, agents: registry.size, auth: !!(cfg.key || Object.keys(cfg.peers||{}).length) });
        return;
    }

    const auth = checkAuth(req);
    if (!auth.ok) { fail(res, 401, "unauthorized"); return; }
    if (await handleA2ARoutes(req.method, path, req, res, auth)) return;
    fail(res, 404, "not found");
}

const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
        try { if (!res.headersSent) fail(res, 500, err.message); } catch { /* ignore */ }
    });
});

process.on("SIGINT",  () => { removePid(); process.exit(0); });
process.on("SIGTERM", () => { removePid(); process.exit(0); });
process.on("exit", removePid);

server.listen(PORT, HOST, () => {
    writePid(process.pid);
    console.log(`a2a bridge listening on http://${HOST}:${PORT} (pid ${process.pid})`);
});
