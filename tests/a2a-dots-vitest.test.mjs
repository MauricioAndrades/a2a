import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function port() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(check, timeout = 10000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw lastError || new Error("timed out");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveExit(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
}

describe("a2a-dots", () => {
  test("registers dot with a callback bridge and queues asynchronous replies", async () => {
    const bridgePort = await port();
    const dotsPort = await port();
    const callbackPort = await port();
    const registrations = [];

    const bridge = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

      if (req.method === "POST" && req.url === "/api/a2a/register") {
        registrations.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: body }));
        return;
      }
      if (req.method === "DELETE" && req.url === "/api/a2a/register/dot") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { removed: true } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "not found" }));
    });

    await new Promise((resolveListen) => bridge.listen(bridgePort, "127.0.0.1", resolveListen));

    const child = spawn(process.execPath, ["src/a2a-dots.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        A2A_BRIDGE: `http://127.0.0.1:${bridgePort}`,
        A2A_DOTS_PORT: String(dotsPort),
        A2A_DOTS_CALLBACK_PORT: String(callbackPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitFor(() => registrations.length === 1);
      expect(registrations[0]).toMatchObject({
        agentId: "dot",
        tmuxTarget: "dot:0.0",
        bridgeUrl: `http://127.0.0.1:${callbackPort}`,
        backend: "mcp",
      });

      const delivery = await fetch(`http://127.0.0.1:${callbackPort}/api/a2a/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: "dot",
          from: "builder",
          origin: "peer",
          action: "reply",
          body: "finished the implementation",
        }),
      });
      expect(delivery.status).toBe(200);
      expect(await delivery.json()).toMatchObject({
        success: true,
        data: { cursor: "1" },
      });

      const health = await fetch(`http://127.0.0.1:${dotsPort}/health`).then((r) => r.json());
      expect(health.data).toMatchObject({ ok: true, agentId: "dot", inbox: 1 });
    } finally {
      await stop(child);
      await new Promise((resolveClose) => bridge.close(resolveClose));
    }
  });

  test("serves the complete Dot tool surface over Streamable HTTP MCP", async () => {
    const bridgePort = await port();
    const dotsPort = await port();
    const callbackPort = await port();

    const bridge = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.method === "POST" && req.url === "/api/a2a/register") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: {} }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: {} }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/a2a/agents") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { agents: [] } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "not found" }));
    });
    await new Promise((resolveListen) => bridge.listen(bridgePort, "127.0.0.1", resolveListen));

    const child = spawn(process.execPath, ["src/a2a-dots.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        A2A_BRIDGE: `http://127.0.0.1:${bridgePort}`,
        A2A_DOTS_PORT: String(dotsPort),
        A2A_DOTS_CALLBACK_PORT: String(callbackPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const client = new Client({ name: "a2a-dots-test", version: "1.0.0" });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${dotsPort}/health`)).ok);
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${dotsPort}/mcp`));
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_agent",
        "list_agents",
        "receive_messages",
        "send_message",
        "start_team",
        "stop_agent",
      ]);
    } finally {
      await client.close().catch(() => {});
      await stop(child);
      await new Promise((resolveClose) => bridge.close(resolveClose));
    }
  });

  test("rejects deliveries addressed to another peer", async () => {
    const bridgePort = await port();
    const dotsPort = await port();
    const callbackPort = await port();

    const bridge = createServer(async (req, res) => {
      for await (const _ of req) {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: {} }));
    });
    await new Promise((resolveListen) => bridge.listen(bridgePort, "127.0.0.1", resolveListen));

    const child = spawn(process.execPath, ["src/a2a-dots.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        A2A_BRIDGE: `http://127.0.0.1:${bridgePort}`,
        A2A_DOTS_PORT: String(dotsPort),
        A2A_DOTS_CALLBACK_PORT: String(callbackPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${dotsPort}/health`)).ok);
      const response = await fetch(`http://127.0.0.1:${callbackPort}/api/a2a/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "someone-else", from: "builder", body: "nope" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await stop(child);
      await new Promise((resolveClose) => bridge.close(resolveClose));
    }
  });
});
