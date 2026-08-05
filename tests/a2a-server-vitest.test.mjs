import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "config.json");
const pidPath = join(repoRoot, "bridge.pid");
const logPath = join(repoRoot, "messages.log");
const trackedPaths = [configPath, pidPath, logPath];
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-server-vitest-"));
const SERVER_TEST_TIMEOUT_MS = 15000;

function backupPathFor(targetPath) {
  return join(backupRoot, basename(targetPath));
}

function backupTrackedPaths() {
  for (const targetPath of trackedPaths) {
    if (!existsSync(targetPath)) continue;
    cpSync(targetPath, backupPathFor(targetPath), { recursive: true });
  }
}

function restoreTrackedPaths() {
  for (const targetPath of trackedPaths) {
    rmSync(targetPath, { recursive: true, force: true });
    const backupPath = backupPathFor(targetPath);
    if (existsSync(backupPath)) {
      cpSync(backupPath, targetPath, { recursive: true });
    }
  }
}

function readUtf8(targetPath) {
  return readFileSync(targetPath, "utf8");
}

function writeServerTestConfig(overrides = {}) {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port: 7742,
        host: "127.0.0.1",
        url: null,
        key: null,
        peers: {},
        log: {
          mode: "on",
          path: logPath,
          maxBytes: 0,
          redactRemote: false,
        },
        ...overrides,
      },
      null,
      2,
    )  }\n`,
  );
}

function jsonHeaders(extra = {}) {
  return { "content-type": "application/json", ...extra };
}

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

async function startA2AServer(port, extraEnv = {}) {
  writeServerTestConfig();
  const child = spawn(process.execPath, ["src/a2a-server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      A2A_HOST: "127.0.0.1",
      A2A_PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForCondition(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.status === 200;
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

async function postJson(url, body, headers = {}) {
  return await fetch(url, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
}

/**
 * Drop-in tmux replacement so the spawned bridge exercises its REAL local
 * delivery path (load-buffer / paste-buffer / send-keys) without a live tmux.
 * Captures every load-buffer stdin payload (the wrapped envelope) to a file.
 */
function createTmuxStub(options = {}) {
  const stubDir = mkdtempSync(join(tmpdir(), "a2a-tmux-stub-"));
  const captureFile = join(stubDir, "deliveries.txt");
  const commandsFile = join(stubDir, "commands.txt");
  writeFileSync(
    join(stubDir, "tmux"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  load-buffer)",
      '    cat >> "$A2A_TEST_TMUX_CAPTURE"',
      "    printf '\\n--- a2a-delivery-end ---\\n' >> \"$A2A_TEST_TMUX_CAPTURE\"",
      "    ;;",
      "  capture-pane)",
      '    printf "%s\\n" "$A2A_TEST_TMUX_CAPTURE_PANE"',
      "    ;;",
      "  send-keys)",
      "    printf 'send-keys\\n' >> \"$A2A_TEST_TMUX_COMMANDS\"",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    captureFile,
    commandsFile,
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      A2A_TEST_TMUX_CAPTURE: captureFile,
      A2A_TEST_TMUX_COMMANDS: commandsFile,
      A2A_TEST_TMUX_CAPTURE_PANE: options.capturePaneText || "",
      A2A_PASTE_VERIFY: "0",
      A2A_PASTE_SETTLE_FLOOR_MS: "0",
      A2A_PASTE_SETTLE_CEILING_MS: "0",
      A2A_PASTE_VERIFY_RETRY_DELAY_MS: "0",
      A2A_PASTE_MAX_ENTER_RETRIES: "2",
      ...(options.env || {}),
    },
    cleanup() {
      rmSync(stubDir, { recursive: true, force: true });
    },
  };
}

beforeAll(() => {
  backupTrackedPaths();
});

afterEach(() => {
  restoreTrackedPaths();
});

afterAll(() => {
  restoreTrackedPaths();
  rmSync(backupRoot, { recursive: true, force: true });
});

describe.sequential("a2a-server real repo tests", () => {
  test("version negotiation and capability gates for spec routes", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const runtime = await startA2AServer(port);

    try {
      const defaultVersion = await fetch(
        `http://127.0.0.1:${port}/.well-known/agent-card.json`,
      );
      expect(defaultVersion.status).toBe(200);

      const malformedVersion = await fetch(
        `http://127.0.0.1:${port}/.well-known/agent-card.json`,
        {
          headers: { "A2A-Version": "bad-version" },
        },
      );
      expect(malformedVersion.status).toBe(400);
      expect(await malformedVersion.json()).toMatchObject({
        error: {
          name: "VersionNotSupportedError",
          requestedVersion: "bad-version",
          supportedVersions: ["1.0"],
        },
      });

      const unsupportedMajor = await fetch(
        `http://127.0.0.1:${port}/.well-known/agent-card.json`,
        {
          headers: { "A2A-Version": "2.7" },
        },
      );
      expect(unsupportedMajor.status).toBe(400);
      expect(await unsupportedMajor.json()).toMatchObject({
        error: {
          name: "VersionNotSupportedError",
          requestedVersion: "2.7",
          supportedVersions: ["1.0"],
        },
      });

      const streamRoute = await fetch(
        `http://127.0.0.1:${port}/message:stream`,
        {
          method: "POST",
          headers: jsonHeaders({ "A2A-Version": "1.0" }),
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(streamRoute.status).toBe(501);
      expect(await streamRoute.json()).toMatchObject({
        error: {
          name: "StreamingNotSupportedError",
        },
      });

      const subscribeRoute = await fetch(
        `http://127.0.0.1:${port}/tasks/task-123/subscribe`,
        {
          method: "POST",
          headers: jsonHeaders({ "A2A-Version": "1.0" }),
          body: JSON.stringify({}),
        },
      );
      expect(subscribeRoute.status).toBe(501);
      expect(await subscribeRoute.json()).toMatchObject({
        error: {
          name: "PushNotificationNotSupportedError",
        },
      });

      const pushConfigRoute = await fetch(
        `http://127.0.0.1:${port}/tasks/task-123/push-config`,
        {
          method: "POST",
          headers: jsonHeaders({ "A2A-Version": "1.0" }),
          body: JSON.stringify({}),
        },
      );
      expect(pushConfigRoute.status).toBe(501);
      expect(await pushConfigRoute.json()).toMatchObject({
        error: {
          name: "PushNotificationNotSupportedError",
        },
      });
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("well-known agent card endpoint returns required fields", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const runtime = await startA2AServer(port);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/agent-card.json`,
      );
      expect(response.status).toBe(200);
      const card = await response.json();

      expect(card).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          description: expect.any(String),
          supportedInterfaces: expect.any(Array),
          version: expect.any(String),
          capabilities: expect.any(Object),
          defaultInputModes: expect.any(Array),
          defaultOutputModes: expect.any(Array),
          skills: expect.any(Array),
        }),
      );
      expect(card.version).toBe("1.0");
      expect(card.supportedInterfaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            protocolBinding: "HTTP+JSON",
            type: "http+json",
            protocolVersion: "1.0",
            url: `http://127.0.0.1:${port}`,
          }),
        ]),
      );
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("health, pid, register, and agent inventory work against a real bridge process", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const runtime = await startA2AServer(port);

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.json(),
      );
      expect(health.success).toBe(true);
      expect(health.data).toMatchObject({ ok: true, agents: 0, auth: false });
      await waitForCondition(() => existsSync(pidPath));
      expect(existsSync(pidPath)).toBe(true);
      expect(Number.parseInt(readUtf8(pidPath).trim(), 10)).toBeGreaterThan(0);

      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "local-bob",
          tmuxTarget: "local-bob:0.0",
        },
      );
      const registerBody = await register.json();
      expect(register.status).toBe(200);
      expect(registerBody.data).toMatchObject({
        agentId: "local-bob",
        kind: "local",
        tmuxTarget: "local-bob:0.0",
      });

      const agents = await fetch(
        `http://127.0.0.1:${port}/api/a2a/agents`,
      ).then((response) => response.json());
      expect(agents.data.agents).toHaveLength(1);
      expect(agents.data.agents[0]).toMatchObject({
        agentId: "local-bob",
        kind: "local",
      });

      const runtimeSnapshot = await fetch(
        `http://127.0.0.1:${port}/api/a2a/runtime-snapshot?self=local-bob&cwd=${encodeURIComponent(repoRoot)}`,
      ).then((response) => response.json());
      expect(runtimeSnapshot.status ?? 200).toBe(200);
      expect(runtimeSnapshot.success).toBe(true);
      expect(runtimeSnapshot.data.snapshot).toMatchObject({
        self: "local-bob",
        counts: {
          registeredAgents: 1,
        },
      });
      expect(runtimeSnapshot.data.inventory.registered[0]).toMatchObject({
        agentId: "local-bob",
        status: "bridge-only",
      });
    } finally {
      await stopChild(runtime.child);
    }

    expect(existsSync(pidPath)).toBe(false);
  });

  test("peer-authenticated subagent registration uses the peer owner URL", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const receiverPort = await getAvailablePort();
    const peerUrl = `http://127.0.0.1:${receiverPort}`;
    const runtime = await startA2AServer(port);

    try {
      writeServerTestConfig({
        key: "operator-secret",
        peers: {
          dylan: { url: peerUrl, key: "dylan-secret" },
        },
      });

      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "dylan__builder",
          tmuxTarget: "builder:0.0",
        },
        { authorization: "Bearer dylan-secret" },
      );
      const registerBody = await register.json();
      expect(register.status).toBe(200);
      expect(registerBody.data).toMatchObject({
        agentId: "dylan__builder",
        kind: "remote",
        bridgeUrl: peerUrl,
      });

      const rejected = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "builder",
          tmuxTarget: "builder:0.0",
        },
        { authorization: "Bearer dylan-secret" },
      );
      const rejectedBody = await rejected.json();
      expect(rejected.status).toBe(403);
      expect(rejectedBody.error).toContain(
        "authenticated peer 'dylan' may only register 'dylan' or 'dylan__<agent>'",
      );
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("remote delivery hits a real HTTP peer and appends a repo log entry", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const bridgePort = await getAvailablePort();
    const receiverPort = await getAvailablePort();
    const deliveries = [];

    const receiver = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/api/a2a/send") {
        res.writeHead(404).end();
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { bytes: 37 } }));
    });

    await new Promise((resolveListen, reject) => {
      receiver.once("error", reject);
      receiver.listen(receiverPort, "127.0.0.1", resolveListen);
    });

    const runtime = await startA2AServer(bridgePort);

    try {
      await postJson(`http://127.0.0.1:${bridgePort}/api/a2a/register`, {
        agentId: "remote-scout",
        tmuxTarget: "remote-scout:0.0",
        bridgeUrl: `http://127.0.0.1:${receiverPort}`,
      });

      const sendResponse = await postJson(
        `http://127.0.0.1:${bridgePort}/api/a2a/send`,
        {
          to: "remote-scout",
          from: "op",
          origin: "user",
          action: "ask",
          body: "status?",
        },
      );
      const sendBody = await sendResponse.json();

      expect(sendResponse.status).toBe(200);
      expect(sendBody.data).toMatchObject({
        to: "remote-scout",
        target: "remote-scout:0.0",
        bytes: 37,
      });

      await waitForCondition(() => deliveries.length === 1);
      expect(deliveries[0]).toMatchObject({
        to: "remote-scout",
        from: "op",
        origin: "user",
        action: "ask",
        body: "status?",
      });

      await waitForCondition(
        () =>
          existsSync(logPath) && readUtf8(logPath).includes("ok via remote"),
      );
      expect(readUtf8(logPath)).toContain("op -> remote-scout");
    } finally {
      await stopChild(runtime.child);
      await new Promise((resolveClose) => receiver.close(resolveClose));
    }
  });

  test("http+json message:send adapter accepts SendMessageRequest and routes through bridge send", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const bridgePort = await getAvailablePort();
    const receiverPort = await getAvailablePort();
    const deliveries = [];

    const receiver = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/api/a2a/send") {
        res.writeHead(404).end();
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { bytes: 41 } }));
    });

    await new Promise((resolveListen, reject) => {
      receiver.once("error", reject);
      receiver.listen(receiverPort, "127.0.0.1", resolveListen);
    });

    const runtime = await startA2AServer(bridgePort);

    try {
      await postJson(`http://127.0.0.1:${bridgePort}/api/a2a/register`, {
        agentId: "remote-scout",
        tmuxTarget: "remote-scout:0.0",
        bridgeUrl: `http://127.0.0.1:${receiverPort}`,
      });

      const sendResponse = await postJson(
        `http://127.0.0.1:${bridgePort}/message:send`,
        {
          message: {
            messageId: "message-001",
            role: "ROLE_USER",
            parts: [{ text: "status from spec adapter?" }],
            metadata: {
              to: "remote-scout",
              from: "op",
              origin: "user",
              action: "ask",
            },
          },
          configuration: {
            acceptedOutputModes: ["text/plain"],
          },
        },
        {
          "A2A-Version": "1.0",
          "content-type": "application/a2a+json",
        },
      );
      const sendBody = await sendResponse.json();

      expect(sendResponse.status).toBe(200);
      expect(sendBody).toEqual({
        task: expect.objectContaining({
          id: expect.any(String),
          contextId: expect.any(String),
          status: expect.objectContaining({
            state: "TASK_STATE_SUBMITTED",
            timestamp: expect.any(String),
            message: expect.objectContaining({
              role: "ROLE_AGENT",
              parts: [{ text: "Message accepted for delivery to remote-scout." }],
            }),
          }),
          history: [
            expect.objectContaining({
              messageId: "message-001",
              role: "ROLE_USER",
              parts: [{ text: "status from spec adapter?" }],
            }),
          ],
          metadata: {
            delivery: expect.objectContaining({
              to: "remote-scout",
              from: "op",
              origin: "user",
              action: "ask",
              bytes: 41,
            }),
          },
        }),
      });

      await waitForCondition(() => deliveries.length === 1);
      expect(deliveries[0]).toMatchObject({
        to: "remote-scout",
        from: "op",
        origin: "user",
        action: "ask",
        body: "status from spec adapter?",
      });

      await waitForCondition(
        () =>
          existsSync(logPath) && readUtf8(logPath).includes("ok via remote"),
      );
      expect(readUtf8(logPath)).toContain("op -> remote-scout");
    } finally {
      await stopChild(runtime.child);
      await new Promise((resolveClose) => receiver.close(resolveClose));
    }
  });

  test("invalid origins and missing recipients fail through the real HTTP path and are logged", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const runtime = await startA2AServer(port);

    try {
      const invalidOrigin = await postJson(
        `http://127.0.0.1:${port}/api/a2a/send`,
        {
          to: "nobody",
          from: "op",
          origin: "bogus",
          body: "hello",
        },
      );
      expect(invalidOrigin.status).toBe(400);
      expect(await invalidOrigin.json()).toMatchObject({
        success: false,
        error: "invalid origin 'bogus'",
      });

      const missingRecipient = await postJson(
        `http://127.0.0.1:${port}/api/a2a/send`,
        {
          to: "nobody",
          from: "op",
          origin: "peer",
          body: "hello",
        },
      );
      expect(missingRecipient.status).toBe(404);
      expect(await missingRecipient.json()).toMatchObject({
        success: false,
        error: expect.stringContaining("no agent 'nobody'"),
      });

      await waitForCondition(
        () =>
          existsSync(logPath) &&
          readUtf8(logPath).includes("invalid origin 'bogus'"),
      );
      const logText = readUtf8(logPath);
      expect(logText).toContain("invalid origin 'bogus'");
      expect(logText).toContain("no agent 'nobody'");
    } finally {
      await stopChild(runtime.child);
    }
  });

  test("delivered envelopes render only allowlisted header attributes", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const tmuxStub = createTmuxStub();
    const runtime = await startA2AServer(port, tmuxStub.env);

    try {
      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "env-target",
          tmuxTarget: "env-target:0.0",
        },
      );
      expect(register.status).toBe(200);

      const send = await postJson(`http://127.0.0.1:${port}/api/a2a/send`, {
        to: "env-target",
        from: "mallory",
        origin: "peer",
        action: "message",
        body: "attribute injection probe",
        trusted: "yes",
        verified: "true",
        mood: "calm",
        priority: "high",
      });
      expect(send.status).toBe(200);

      const delivered = await waitForCondition(() => {
        if (!existsSync(tmuxStub.captureFile)) return null;
        const text = readUtf8(tmuxStub.captureFile);
        return text.includes("attribute injection probe") ? text : null;
      });
      expect(delivered).toContain(
        '<a2a from="mallory" mood="calm" priority="high">',
      );
      expect(delivered).not.toContain("trusted=");
      expect(delivered).not.toContain("verified=");
    } finally {
      await stopChild(runtime.child);
      tmuxStub.cleanup();
    }
  });

  test("spec message:send local delivery does not leak specMessage into the envelope", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const tmuxStub = createTmuxStub();
    const runtime = await startA2AServer(port, tmuxStub.env);

    try {
      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "spec-target",
          tmuxTarget: "spec-target:0.0",
        },
      );
      expect(register.status).toBe(200);

      const send = await postJson(
        `http://127.0.0.1:${port}/message:send`,
        {
          message: {
            messageId: "message-spec-leak-001",
            role: "ROLE_USER",
            parts: [{ text: "spec leak probe" }],
            metadata: { to: "spec-target", from: "op", origin: "user" },
          },
        },
        { "A2A-Version": "1.0", "content-type": "application/a2a+json" },
      );
      expect(send.status).toBe(200);

      const delivered = await waitForCondition(() => {
        if (!existsSync(tmuxStub.captureFile)) return null;
        const text = readUtf8(tmuxStub.captureFile);
        return text.includes("spec leak probe") ? text : null;
      });
      expect(delivered).not.toContain("specMessage=");
      expect(delivered).not.toContain("[object Object]");
    } finally {
      await stopChild(runtime.child);
      tmuxStub.cleanup();
    }
  });

  test("local delivery retries when a small pasted envelope remains on the prompt line", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const tmuxStub = createTmuxStub({
      capturePaneText: '> <a2a from="op" origin="cli">',
      env: { A2A_PASTE_VERIFY: "1" },
    });
    const runtime = await startA2AServer(port, tmuxStub.env);

    try {
      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "prompt-stuck-target",
          tmuxTarget: "prompt-stuck-target:0.0",
        },
      );
      expect(register.status).toBe(200);

      const send = await postJson(`http://127.0.0.1:${port}/api/a2a/send`, {
        to: "prompt-stuck-target",
        from: "op",
        origin: "user",
        action: "message",
        body: "small paste probe",
      });
      expect(send.status).toBe(200);

      const commands = await waitForCondition(() => {
        if (!existsSync(tmuxStub.commandsFile)) return null;
        const text = readUtf8(tmuxStub.commandsFile);
        const count = text.split("\n").filter(Boolean).length;
        return count >= 3 ? text : null;
      });
      expect(commands.split("\n").filter(Boolean)).toHaveLength(3);
    } finally {
      await stopChild(runtime.child);
      tmuxStub.cleanup();
    }
  });

  test("oversize JSON bodies return 413 on send, register, and spec routes", { timeout: SERVER_TEST_TIMEOUT_MS }, async () => {
    const port = await getAvailablePort();
    const runtime = await startA2AServer(port);
    const oversizeBody = "x".repeat(1024 * 1024 + 1024);

    try {
      const send = await postJson(`http://127.0.0.1:${port}/api/a2a/send`, {
        to: "nobody",
        from: "op",
        origin: "user",
        body: oversizeBody,
      });
      expect(send.status).toBe(413);
      expect(await send.json()).toMatchObject({
        success: false,
        error: "invalid body: request body too large",
      });

      const register = await postJson(
        `http://127.0.0.1:${port}/api/a2a/register`,
        {
          agentId: "too-big",
          tmuxTarget: "too-big:0.0",
          description: oversizeBody,
        },
      );
      expect(register.status).toBe(413);
      expect(await register.json()).toMatchObject({
        success: false,
        error: "invalid body: request body too large",
      });

      const spec = await postJson(
        `http://127.0.0.1:${port}/message:send`,
        {
          message: {
            messageId: "message-413",
            role: "ROLE_USER",
            parts: [{ text: oversizeBody }],
            metadata: { to: "nobody" },
          },
        },
        { "A2A-Version": "1.0", "content-type": "application/a2a+json" },
      );
      expect(spec.status).toBe(413);
    } finally {
      await stopChild(runtime.child);
    }
  });
});
