#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HOST = process.env.A2A_DOTS_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.A2A_DOTS_PORT || "7743", 10);
const MCP_PATH = process.env.A2A_DOTS_MCP_PATH || "/mcp";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = Number.parseInt(process.env.A2A_DOTS_CALLBACK_PORT || "7744", 10);
const BRIDGE_URL = (process.env.A2A_BRIDGE || "http://127.0.0.1:7742").replace(/\/+$/, "");
const BRIDGE_KEY = process.env.A2A_KEY || "";
const DOT_ID = process.env.A2A_DOTS_AGENT_ID || "dot";
const A2A_BIN = process.env.A2A_DOTS_BIN || "a2a";
const CALLBACK_URL = (process.env.A2A_DOTS_CALLBACK_URL || `http://${CALLBACK_HOST}:${CALLBACK_PORT}`).replace(/\/+$/, "");
const MAX_INBOX = Math.max(1, Number.parseInt(process.env.A2A_DOTS_MAX_INBOX || "1000", 10));
const VALID_ACTIONS = new Set(["message", "reply", "ask"]);
const inbox = [];
let nextCursor = 1;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function bridgeRequest(path, init = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(BRIDGE_KEY ? { authorization: `Bearer ${BRIDGE_KEY}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`a2a bridge returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `a2a bridge HTTP ${response.status}`);
  }
  return payload.data ?? payload;
}

async function registerDot() {
  return bridgeRequest("/api/a2a/register", {
    method: "POST",
    body: JSON.stringify({
      agentId: DOT_ID,
      tmuxTarget: `${DOT_ID}:0.0`,
      bridgeUrl: CALLBACK_URL,
      backend: "mcp",
      description: "ChatGPT Dot MCP peer",
    }),
  });
}

async function unregisterDot() {
  try {
    await bridgeRequest(`/api/a2a/register/${encodeURIComponent(DOT_ID)}`, { method: "DELETE" });
  } catch {}
}

async function listAgents() {
  const result = await bridgeRequest("/api/a2a/agents");
  return Array.isArray(result.agents) ? result.agents : [];
}

async function sendMessage(to, text, action = "message") {
  if (typeof to !== "string" || !to.trim()) throw new Error("to is required");
  if (typeof text !== "string" || !text) throw new Error("text is required");
  if (!VALID_ACTIONS.has(action)) throw new Error(`invalid action '${action}'`);
  return bridgeRequest("/api/a2a/send", {
    method: "POST",
    body: JSON.stringify({
      to: to.trim(),
      from: DOT_ID,
      origin: "peer",
      source: "chatgpt-dot",
      body: text,
      action,
    }),
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(A2A_BIN, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      code === 0 ? resolve(out || "ok") : reject(new Error(err || out || `a2a exited ${code}`));
    });
  });
}

function enqueue(body) {
  const message = {
    cursor: String(nextCursor++),
    receivedAt: new Date().toISOString(),
    to: DOT_ID,
    from: typeof body.from === "string" ? body.from : "unknown",
    origin: typeof body.origin === "string" ? body.origin : "peer",
    action: VALID_ACTIONS.has(body.action) ? body.action : "message",
    text: body.body,
    ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
  };
  inbox.push(message);
  if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
  return message;
}

function messagesAfter(after) {
  if (after == null || after === "") return [...inbox];
  const cursor = Number.parseInt(String(after), 10);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("after must be a non-negative integer cursor");
  return inbox.filter((message) => Number(message.cursor) > cursor);
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createMcpServer() {
const mcp = new Server(
    { name: "a2a-dots", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: `You are the a2a peer '${DOT_ID}'. Discover workers with list_agents/get_agent, delegate with send_message, collect asynchronous replies with receive_messages, and use start_team/stop_agent for lifecycle control. Never impersonate the human operator.`,
    },
  );
  
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "send_message",
        description: "Send a message from this Dot to a live a2a agent.",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            to: { type: "string" },
            text: { type: "string" },
            action: { type: "string", enum: ["message", "reply", "ask"] },
          },
          required: ["to", "text"],
        },
      },
      {
        name: "list_agents",
        description: "List agents from the running a2a bridge, the live source of truth.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      {
        name: "get_agent",
        description: "Get one live a2a agent by id.",
        inputSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" } }, required: ["agent"] },
      },
      {
        name: "receive_messages",
        description: "Read messages delivered asynchronously to this Dot. Pass the last cursor to receive only newer messages.",
        inputSchema: { type: "object", additionalProperties: false, properties: { after: { type: "string" } } },
      },
      {
        name: "start_team",
        description: "Launch an existing a2a team by name through the normal a2a start contract.",
        inputSchema: { type: "object", additionalProperties: false, properties: { team: { type: "string" } }, required: ["team"] },
      },
      {
        name: "stop_agent",
        description: "Stop an a2a agent through the ownership-safe a2a kill contract.",
        inputSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" } }, required: ["agent"] },
      },
    ],
  }));
  
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments || {};
    switch (params.name) {
      case "send_message":
        return result(await sendMessage(args.to, args.text, args.action || "message"));
      case "list_agents":
        return result(await listAgents());
      case "get_agent": {
        if (typeof args.agent !== "string" || !args.agent) throw new Error("agent is required");
        const agent = (await listAgents()).find((item) => item.agentId === args.agent);
        if (!agent) throw new Error(`no live agent '${args.agent}'`);
        return result(agent);
      }
      case "receive_messages":
        return result({ agentId: DOT_ID, messages: messagesAfter(args.after) });
      case "start_team":
        if (typeof args.team !== "string" || !args.team.trim()) throw new Error("team is required");
        return result({ team: args.team.trim(), output: await runCli(["start", args.team.trim()]) });
      case "stop_agent":
        if (typeof args.agent !== "string" || !args.agent.trim()) throw new Error("agent is required");
        if (args.agent.trim() === DOT_ID) throw new Error("stop_agent cannot stop the Dot adapter itself");
        return result({ agent: args.agent.trim(), output: await runCli(["kill", args.agent.trim()]) });
      default:
        throw new Error(`unknown tool: ${params.name}`);
    }
  });
  
  return mcp;
  }
  
  const callbackServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", CALLBACK_URL);
    if (req.method !== "POST" || url.pathname !== "/api/a2a/send") {
      return sendJson(res, 404, { success: false, error: "not found" });
    }
    const body = await readJson(req);
    if (body.to !== DOT_ID) return sendJson(res, 404, { success: false, error: `no agent '${body.to}'` });
    if (typeof body.body !== "string") return sendJson(res, 400, { success: false, error: "body must be a string" });
    const message = enqueue(body);
    return sendJson(res, 200, { success: true, data: { bytes: Buffer.byteLength(body.body, "utf8"), cursor: message.cursor } });
  } catch (error) {
    sendJson(res, error?.statusCode || 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (url.pathname === MCP_PATH) {
      const requestMcp = createMcpServer();
      const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.once("close", () => {
        requestTransport.close().catch(() => {});
        requestMcp.close().catch(() => {});
      });
      await requestMcp.connect(requestTransport);
      await requestTransport.handleRequest(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { success: true, data: { ok: true, agentId: DOT_ID, bridgeUrl: BRIDGE_URL, callbackUrl: CALLBACK_URL, inbox: inbox.length } });
    }
    sendJson(res, 404, { success: false, error: "not found" });
  } catch (error) {
    sendJson(res, error?.statusCode || 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

callbackServer.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
  server.listen(PORT, HOST, async () => {
  try {
    await registerDot();
    process.stderr.write(`a2a-dots registered '${DOT_ID}' with ${BRIDGE_URL}; MCP at http://${HOST}:${PORT}${MCP_PATH}\n`);
  } catch (error) {
    process.stderr.write(`a2a-dots failed to register '${DOT_ID}': ${error.message}\n`);
    server.close();
    process.exitCode = 1;
    callbackServer.close();
  }
  });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await unregisterDot();
  server.close();
  callbackServer.close(() => process.exit());
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
