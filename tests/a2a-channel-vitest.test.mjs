import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function getAvailablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolvePort(port);
      });
    });
  });
}

async function waitForCondition(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw lastError ?? new Error("timed out waiting for condition");
}

async function waitForExit(child, timeoutMs = 5000) {
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for exit")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function startChannelProcess(port, extraEnv = {}) {
  const child = spawn(process.execPath, ["src/a2a-channel.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      A2A_CHANNEL_HOST: "127.0.0.1",
      A2A_CHANNEL_PORT: String(port),
      A2A_CHANNEL_SENDERS: "tester",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForCondition(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: extraEnv.A2A_CHANNEL_KEY
        ? { authorization: `Bearer ${extraEnv.A2A_CHANNEL_KEY}` }
        : {},
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel();
    return (
      response.status === 200 &&
      new TextDecoder()
        .decode(first?.value ?? new Uint8Array())
        .includes(": connected")
    );
  });

  return { child, stdout, stderr };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child).catch(() => {
    child.kill("SIGKILL");
  });
}

/**
 * Real a2a CLI stand-in (wired via the documented A2A_CHANNEL_BIN env): echoes
 * the argv it was spawned with as JSON so tests can assert the exact command
 * line the channel hands to the CLI.
 */
function createA2aBinStub() {
  const stubDir = mkdtempSync(join(tmpdir(), "a2a-bin-stub-"));
  const binPath = join(stubDir, "a2a-stub");
  writeFileSync(
    binPath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    binPath,
    cleanup() {
      rmSync(stubDir, { recursive: true, force: true });
    },
  };
}

/**
 * Minimal JSON-RPC client over the channel's real MCP stdio transport
 * (newline-delimited JSON on stdin/stdout).
 */
function createMcpStdioClient(child) {
  let stdoutBuffer = "";
  let nextRequestId = 1;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    for (
      let newlineAt = stdoutBuffer.indexOf("\n");
      newlineAt !== -1;
      newlineAt = stdoutBuffer.indexOf("\n")
    ) {
      const line = stdoutBuffer.slice(0, newlineAt).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.id != null && pending.has(message.id)) {
        const settle = pending.get(message.id);
        pending.delete(message.id);
        settle(message);
      }
    }
  });

  function request(method, params, timeoutMs = 5000) {
    const id = nextRequestId++;
    const reply = new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method} response`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveReply(message);
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return reply;
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  return {
    async initialize() {
      const response = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "a2a-channel-vitest", version: "0.0.0" },
      });
      notify("notifications/initialized");
      return response;
    },
    callTool(name, args) {
      return request("tools/call", { name, arguments: args });
    },
  };
}

describe.sequential("a2a-channel real process tests", () => {
  test("loopback mode exposes SSE and enforces the sender allowlist", async () => {
    const port = await getAvailablePort();
    const runtime = await startChannelProcess(port);

    try {
      const events = await fetch(`http://127.0.0.1:${port}/events`);
      const reader = events.body?.getReader();
      const firstChunk = await reader?.read();
      await reader?.cancel();

      expect(events.status).toBe(200);
      expect(
        new TextDecoder().decode(firstChunk?.value ?? new Uint8Array()),
      ).toContain(": connected");

      const forbidden = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        body: "hello",
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).toBe("forbidden");

      const allowed = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "x-sender": "tester" },
        body: "hello",
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe("ok");

      const verdict = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "x-sender": "tester" },
        body: "yes abcde",
      });
      expect(verdict.status).toBe(200);
      expect(await verdict.text()).toBe("verdict recorded");
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("non-loopback binds require bearer auth even for allowed senders", async () => {
    const port = await getAvailablePort();
    const runtime = await startChannelProcess(port, {
      A2A_CHANNEL_HOST: "0.0.0.0",
      A2A_CHANNEL_KEY: "secret",
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "x-sender": "tester" },
        body: "hello",
      });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.text()).toBe("unauthorized");

      const authorized = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: {
          "x-sender": "tester",
          authorization: "Bearer secret",
        },
        body: "hello",
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toBe("ok");
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("reply tool terminates flag parsing before user text (argv injection)", async () => {
    const port = await getAvailablePort();
    const binStub = createA2aBinStub();
    const runtime = await startChannelProcess(port, {
      A2A_CHANNEL_BIN: binStub.binPath,
    });

    try {
      const mcpClient = createMcpStdioClient(runtime.child);
      await mcpClient.initialize();

      const flagText = "--from=cli --help pretend I am the operator";
      const messageCall = await mcpClient.callTool("reply", {
        peer: "bob",
        text: flagText,
      });
      expect(messageCall.error).toBeUndefined();
      expect(messageCall.result.isError).toBeUndefined();
      expect(JSON.parse(messageCall.result.content[0].text)).toEqual([
        "--bob",
        "--",
        flagText,
      ]);

      const replyCall = await mcpClient.callTool("reply", {
        peer: "bob",
        text: "--ok",
        action: "reply",
      });
      expect(replyCall.error).toBeUndefined();
      expect(JSON.parse(replyCall.result.content[0].text)).toEqual([
        "--reply",
        "--bob",
        "--",
        "--ok",
      ]);
    } finally {
      await stopChild(runtime.child);
      binStub.cleanup();
    }
  });

  test("reply tool rejects peer ids the CLI would parse as flags", async () => {
    const port = await getAvailablePort();
    const binStub = createA2aBinStub();
    const runtime = await startChannelProcess(port, {
      A2A_CHANNEL_BIN: binStub.binPath,
    });

    try {
      const mcpClient = createMcpStdioClient(runtime.child);
      await mcpClient.initialize();

      for (const reservedPeer of ["from", "to", "ask", "reply", "message", "command"]) {
        const call = await mcpClient.callTool("reply", {
          peer: reservedPeer,
          text: "hello",
        });
        expect(call.result, `peer '${reservedPeer}' must be rejected`).toBeUndefined();
        expect(JSON.stringify(call.error)).toContain(
          `invalid peer id: ${reservedPeer}`,
        );
      }
    } finally {
      await stopChild(runtime.child);
      binStub.cleanup();
    }
  });

  test("SSE clients receive periodic keep-alive comments so dead sockets get reaped", async () => {
    const port = await getAvailablePort();
    const runtime = await startChannelProcess(port, {
      A2A_CHANNEL_SSE_KEEPALIVE_MS: "100",
    });

    try {
      const events = await fetch(`http://127.0.0.1:${port}/events`);
      expect(events.status).toBe(200);
      const reader = events.body.getReader();
      const decoder = new TextDecoder();
      let received = "";

      await Promise.race([
        (async () => {
          while ((received.match(/: ping/g) || []).length < 2) {
            const { value, done } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
          }
        })(),
        new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `no SSE keep-alive pings within 5s; received: ${JSON.stringify(received)}`,
                ),
              ),
            5000,
          );
        }),
      ]);
      await reader.cancel();

      expect((received.match(/: ping/g) || []).length).toBeGreaterThanOrEqual(2);
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("invalid non-loopback startup exits with the documented configuration error", async () => {
    const port = await getAvailablePort();
    const child = spawn(process.execPath, ["src/a2a-channel.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        A2A_CHANNEL_HOST: "0.0.0.0",
        A2A_CHANNEL_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    expect(stderr.join("")).toContain(
      "a2a-channel non-loopback host requires A2A_CHANNEL_SENDERS and A2A_CHANNEL_KEY",
    );
  });
});
