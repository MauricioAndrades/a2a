import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(25);
  }
  throw lastError || new Error("timed out waiting for fixture");
}

export async function freePort() {
  const listener = createServer();
  await new Promise((done, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", done);
  });
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

export async function json(url, path, init = {}) {
  const response = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(2000) });
  return { status: response.status, body: await response.json() };
}

export function post(url, path, body) {
  return json(url, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
export const reply = (body = "fixture reply") => ({ to: "dot", from: "worker", origin: "peer", action: "reply", body });

export async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse(response.content[0].text);
}

export function runtimeFixture() {
  // Bridge and CLI runtime files are relative to their source location. Copy
  // source so tests never back up or mutate the live checkout configuration.
  const root = mkdtempSync(join(tmpdir(), "a2a-dots-test-"));
  cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
  cpSync(join(repo, "bin"), join(root, "bin"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "teams"));
  mkdirSync(join(root, "fake-bin"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 7742, key: null, peers: {}, global: false, protocol: "tmux", log: { mode: "off" } }));
  writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: [], groups: [], installToken: "ai-fixture" }));
  writeFileSync(join(root, "fake-bin", "tmux"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const captureCli = join(root, "capture-cli.mjs");
  writeFileSync(captureCli, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const children = new Set(), listeners = new Set(), clients = new Set();
  function launch(file, args = [], extraEnv = {}) {
    const child = spawn(process.execPath, [join(root, file), ...args], {
      cwd: root,
      env: {
        PATH: `${join(root, "fake-bin")}:${process.env.PATH}`,
        A2A_KEY: "", A2A_HOST: "127.0.0.1", TMUX: "",
        A2A_ITERM2_BRIDGE_SOCKET: join(root, "absent-iterm.sock"),
        A2A_DOTS_REQUEST_TIMEOUT_MS: "200", A2A_DOTS_RECONCILE_MS: "50",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.stdoutText = "";
    child.stderrText = "";
    child.stdout.on("data", (chunk) => { child.stdoutText += chunk.toString(); });
    child.stderr.on("data", (chunk) => { child.stderrText += chunk.toString(); });
    return child;
  }
  async function exited(child) {
    if (child.exitCode === null && child.signalCode === null) await new Promise((done) => child.once("exit", done));
    children.delete(child);
    return { status: child.exitCode, signal: child.signalCode, stdout: child.stdoutText, stderr: child.stderrText };
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return exited(child);
    const finished = exited(child);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { return await finished; }
    finally { clearTimeout(timer); }
  }
  return {
    root, captureCli, launch, exited, stop,
    async bridge(requestedPort) {
      const port = requestedPort ?? await freePort();
      const child = launch("src/a2a-server.mjs", [], { A2A_PORT: String(port) });
      const url = `http://127.0.0.1:${port}`;
      await waitFor(async () => (await json(url, "/health")).status === 200);
      return { child, port, url };
    },
    async adapter(bridge, extraEnv = {}, ready = true) {
      const port = await freePort(), callbackPort = await freePort();
      const child = launch("src/a2a-dots.mjs", [], {
        A2A_BRIDGE: bridge.url, A2A_PORT: String(bridge.port), A2A_DOTS_PORT: String(port),
        A2A_DOTS_CALLBACK_PORT: String(callbackPort), A2A_DOTS_BIN: join(root, "bin", "a2a.mjs"), ...extraEnv,
      });
      const adapter = { child, url: `http://127.0.0.1:${port}`, callback: `http://127.0.0.1:${callbackPort}` };
      await waitFor(async () => {
        const response = await json(adapter.url, "/health");
        return ready ? response.status === 200 : response;
      });
      return adapter;
    },
    async mockBridge(handler) {
      const listener = createServer(handler);
      listeners.add(listener);
      await new Promise((done) => listener.listen(0, "127.0.0.1", done));
      const { port } = listener.address();
      return { listener, port, url: `http://127.0.0.1:${port}` };
    },
    async client(adapter) {
      const client = new Client({ name: "a2a-fixture", version: "1.0.0" });
      clients.add(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${adapter.url}/mcp`)));
      return client;
    },
    async close() {
      for (const client of clients) await client.close().catch(() => { /* Already closed by a test. */ });
      for (const child of children) await stop(child);
      for (const listener of listeners) {
        listener.closeAllConnections();
        await new Promise((done) => listener.close(done));
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
