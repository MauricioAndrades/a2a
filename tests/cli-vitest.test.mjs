import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
const registryPath = join(repoRoot, "registry.json");
const pidPath = join(repoRoot, "bridge.pid");
const logPath = join(repoRoot, "messages.log");
// Team-spec fixtures are test-owned: commit c7826bb gitignored teams/* and
// removed the repo specs these tests used to resolve. Tests that exercise
// team-ref resolution write these fixture files and the backup/restore
// cycle below protects any local copies a developer may have.
const bugKillersSpecPath = join(repoRoot, "teams", "bug-killers.yaml");
const dwBugKillersSpecPath = join(repoRoot, "teams", "dw-bug-killers.yaml");
const trackedPaths = [
  configPath,
  registryPath,
  pidPath,
  logPath,
  bugKillersSpecPath,
  dwBugKillersSpecPath,
];
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-cli-vitest-"));
const cliTestSessions = new Set();
const cliBridgeChildren = new Set();

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

function writeJson(targetPath, data) {
  writeFileSync(targetPath, `${JSON.stringify(data, null, 2)  }\n`);
}

function writeBaseConfig(overrides = {}) {
  writeJson(configPath, {
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
  });
}

function writeBaseRegistry(overrides = {}) {
  writeJson(registryPath, {
    agents: [],
    groups: [],
    installToken: null,
    ...overrides,
  });
}

/**
 * Write a minimal-but-valid version-2 team spec fixture. Shape matches what
 * normalizeTeamSpec requires (src/cli.mjs): top-level object, agents map of
 * id → object, role resolvable via defaults.
 */
function writeTeamSpecFixture(specPath, name, agentIds) {
  const agents = agentIds.map((id) => `  ${id}: {}`).join("\n");
  writeFileSync(
    specPath,
    [
      "version: 2",
      `name: ${name}`,
      "defaults:",
      "  backend: claude",
      "  role: placeholder fixture role",
      "agents:",
      agents,
      "",
    ].join("\n"),
  );
}

function uniqueSessionName(label) {
  return `a2a-vitest-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function tmux(args, options = {}) {
  return spawnSync("tmux", args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function rememberSession(name) {
  cliTestSessions.add(name);
  return name;
}

function forgetSession(name) {
  cliTestSessions.delete(name);
}

function tmuxSessionExists(name) {
  return tmux(["has-session", "-t", name]).status === 0;
}

function killTmuxSessionBestEffort(name) {
  if (!tmuxSessionExists(name)) {
    forgetSession(name);
    return;
  }
  tmux(["kill-session", "-t", name]);
  forgetSession(name);
}

function tmuxInstallToken(name) {
  const result = tmux(["show-options", "-t", name, "-q", "-v", "@a2a-install-token"]);
  return result.status === 0 ? (result.stdout || "").trim() || null : null;
}

function createRealTmuxSession(name, command = "sleep 60") {
  const result = tmux(["new-session", "-d", "-s", name, "-c", repoRoot, command]);
  if (result.status !== 0) {
    throw new Error(`tmux new-session failed: ${(result.stderr || "").trim() || "unknown"}`);
  }
  rememberSession(name);
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

async function startRealBridge() {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ["src/a2a-server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      A2A_HOST: "127.0.0.1",
      A2A_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cliBridgeChildren.add(child);

  await waitForCondition(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.status === 200;
  });

  return {
    child,
    url: `http://127.0.0.1:${port}`,
    async close() {
      cliBridgeChildren.delete(child);
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => {
        child.kill("SIGKILL");
      });
    },
  };
}

async function getBridgeAgents(bridgeUrl) {
  const response = await fetch(`${bridgeUrl}/api/a2a/agents`);
  const body = await response.json();
  if (response.status !== 200 || !body?.success) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body.data?.agents || [];
}

async function postJson(url, body) {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJsonAuth(url, bearer, body) {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, ["src/cli.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

beforeAll(() => {
  backupTrackedPaths();
});

afterEach(async () => {
  for (const child of [...cliBridgeChildren]) {
    cliBridgeChildren.delete(child);
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => {
      child.kill("SIGKILL");
    });
  }
  for (const sessionName of [...cliTestSessions]) {
    killTmuxSessionBestEffort(sessionName);
  }
  restoreTrackedPaths();
});

afterAll(() => {
  restoreTrackedPaths();
  rmSync(backupRoot, { recursive: true, force: true });
});

describe.sequential("cli real repo tests", () => {
  test("config and auth subcommands persist repo-local settings", () => {
    writeBaseConfig();
    writeBaseRegistry();

    const setPort = runCli(["config", "set", "port", "9999"]);
    expect(setPort.status).toBe(0);
    expect(setPort.stdout).toContain("port = 9999");

    const getPort = runCli(["config", "get", "port"]);
    expect(getPort.status).toBe(0);
    expect(getPort.stdout.trim()).toBe("9999");

    const authAdd = runCli([
      "auth",
      "add",
      "--bob",
      "--url",
      "https://bob.example/",
      "--key",
      "peer-key",
    ]);
    expect(authAdd.status).toBe(0);
    expect(authAdd.stdout).toContain("added peer 'bob'");

    const authList = runCli(["auth", "list"]);
    expect(authList.status).toBe(0);
    expect(authList.stdout).toContain("bob");
    expect(authList.stdout).toContain("https://bob.example");

    const authRevoke = runCli(["auth", "revoke", "--bob"]);
    expect(authRevoke.status).toBe(0);
    expect(authRevoke.stdout).toContain("removed peer 'bob'");

    const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    expect(savedConfig.port).toBe(9999);
    expect(savedConfig.peers).toEqual({});
  });

  test("start auto-starts the bridge before registering a new session", () => {
    writeBaseConfig({ port: 6553 });
    writeBaseRegistry();
    const sessionName = rememberSession(uniqueSessionName("orphan"));

    try {
      const result = runCli(["start", sessionName, "--claude"], {
        env: { A2A_BRIDGE: "http://127.0.0.1:6553" },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`'${sessionName}' registered at ${sessionName}:0.0`);
      expect(tmuxSessionExists(sessionName)).toBe(true);
    } finally {
      runCli(["bridge", "stop"], {
        env: { A2A_BRIDGE: "http://127.0.0.1:6553" },
      });
      killTmuxSessionBestEffort(sessionName);
    }
  });

  test("start registers a session with yolo defaults and stamps the install token", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("start"));

    try {
      const result = runCli(["start", sessionName, "--claude"], {
        env: { A2A_BRIDGE: bridge.url },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`'${sessionName}' registered at ${sessionName}:0.0`);
      expect(result.stderr).toContain("auto-attach was skipped");

      const agents = await getBridgeAgents(bridge.url);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: sessionName,
        tmuxTarget: `${sessionName}:0.0`,
        backend: "claude",
        yolo: true,
      });
      expect(agents[0].backendArgs).toContain(
        "--dangerously-skip-permissions",
      );
      expect(agents[0].installToken).toMatch(/^ai-/);
      expect(tmuxSessionExists(sessionName)).toBe(true);
      expect(tmuxInstallToken(sessionName)).toBe(agents[0].installToken);
    } finally {
      await bridge.close();
    }
  });

  test("start --claude=PATH launches that executable and records it separately from argv", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("custom-claude"));
    const fakeClaudePath = join(backupRoot, `${sessionName}-claude`);
    writeFileSync(
      fakeClaudePath,
      [
        "#!/bin/sh",
        "printf 'CUSTOM_CLAUDE_BINARY %s\\n' \"$0\"",
        "sleep 60",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeClaudePath, 0o755);

    try {
      const result = runCli(
        ["start", sessionName, `--claude=${fakeClaudePath}`],
        {
          env: { A2A_BRIDGE: bridge.url },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `'${sessionName}' registered at ${sessionName}:0.0`,
      );

      await waitForCondition(() => {
        const captured = tmux([
          "capture-pane",
          "-t",
          `${sessionName}:0.0`,
          "-p",
        ]);
        if (captured.status !== 0) return false;
        return captured.stdout.includes("CUSTOM_CLAUDE_BINARY");
      });

      const agents = await getBridgeAgents(bridge.url);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: sessionName,
        backend: "claude",
        backendCommand: fakeClaudePath,
      });
      expect(agents[0].backendArgs).toContain(
        "--dangerously-skip-permissions",
      );
      expect(agents[0].backendArgs).not.toContain(fakeClaudePath);
    } finally {
      await bridge.close();
    }
  });

  test("register stamps install tokens onto existing tmux sessions before posting to the bridge", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("register"));
    createRealTmuxSession(sessionName);

    try {
      const result = runCli(
        ["register", "--id", sessionName, "--target", `${sessionName}:0.0`],
        {
          env: { A2A_BRIDGE: bridge.url },
        },
      );

      expect(result.status).toBe(0);
      const agents = await getBridgeAgents(bridge.url);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: sessionName,
        tmuxTarget: `${sessionName}:0.0`,
      });
      expect(agents[0].installToken).toMatch(/^ai-/);
      expect(tmuxInstallToken(sessionName)).toBe(agents[0].installToken);
    } finally {
      await bridge.close();
    }
  });

  test("team spec cwd dot resolves to the launch cwd instead of escaping", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();
    const teamName = uniqueSessionName("cwd-dot-team");
    const agentName = rememberSession(uniqueSessionName("cwd-dot-agent"));
    const teamPath = join(backupRoot, `${teamName}.yaml`);
    writeFileSync(
      teamPath,
      [
        "version: 2",
        `name: ${teamName}`,
        "dashboard: false",
        "agents:",
        `  ${agentName}:`,
        "    backend: claude",
        "    cwd: .",
        "    role: dot cwd regression guard",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = runCli(["start", "--team-file", teamPath], {
        env: { A2A_BRIDGE: bridge.url },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`team '${teamName}' ready`);
      const agents = await getBridgeAgents(bridge.url);
      const agent = agents.find((entry) => entry.agentId === agentName);
      expect(agent).toBeDefined();
      expect(agent.cwd).toBe(repoRoot);
    } finally {
      await bridge.close();
    }
  });

  test("legacy say syntax auto-starts the bridge before resolving recipients", () => {
    writeBaseConfig({ port: 6554 });
    writeBaseRegistry();

    try {
      const result = runCli(["say", "to:bob", "hello"], {
        env: { A2A_BRIDGE: "http://127.0.0.1:6554" },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("send failed: no agent 'bob'");
    } finally {
      runCli(["bridge", "stop"], {
        env: { A2A_BRIDGE: "http://127.0.0.1:6554" },
      });
    }
  });

  test("list --json reflects real bridge agents through the CLI dispatcher", async () => {
    writeBaseConfig();
    writeBaseRegistry({ installToken: "ai-test-token" });
    const sessionName = rememberSession(uniqueSessionName("list"));
    const bridge = await startRealBridge();

    try {
      createRealTmuxSession(sessionName);
      const setToken = tmux(["set-option", "-t", sessionName, "-q", "@a2a-install-token", "ai-test-token"]);
      expect(setToken.status).toBe(0);
      const registerResponse = await postJson(`${bridge.url}/api/a2a/register`, {
        agentId: sessionName,
        tmuxTarget: `${sessionName}:0.0`,
        cwd: repoRoot,
        description: "team:red",
        yolo: true,
        installToken: "ai-test-token",
      });
      expect(registerResponse.status).toBe(200);

      const result = runCli(["list", "--json"], {
        env: { A2A_BRIDGE: bridge.url },
      });

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.bridgeError).toBeNull();
      expect(payload.registered).toHaveLength(1);
      expect(payload.registered[0]).toMatchObject({
        agentId: sessionName,
        tmuxTarget: `${sessionName}:0.0`,
        description: "team:red",
        yolo: true,
      });
      expect(payload.orphans).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  test("status exposes a local runtime snapshot and compact segment through the CLI dispatcher", async () => {
    const operatorKey = "test-operator-status";
    writeBaseConfig({
      key: operatorKey,
      peers: {
        offline: { url: "http://127.0.0.1:1", key: "unused" },
      },
    });
    writeBaseRegistry({ installToken: "ai-test-token" });
    const sessionName = rememberSession(uniqueSessionName("status"));
    const bridge = await startRealBridge();

    try {
      createRealTmuxSession(sessionName);
      const setToken = tmux([
        "set-option",
        "-t",
        sessionName,
        "-q",
        "@a2a-install-token",
        "ai-test-token",
      ]);
      expect(setToken.status).toBe(0);
      const registerResponse = await postJsonAuth(
        `${bridge.url}/api/a2a/register`,
        operatorKey,
        {
          agentId: sessionName,
          tmuxTarget: `${sessionName}:0.0`,
          cwd: repoRoot,
          description: "team:red",
          yolo: true,
          installToken: "ai-test-token",
        },
      );
      expect(registerResponse.status).toBe(200);

      const jsonResult = runCli(["status", "--json"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(jsonResult.status).toBe(0);
      const payload = JSON.parse(jsonResult.stdout);
      expect(payload.health).toBe("ok");
      expect(payload.counts).toMatchObject({
        localAgents: 1,
        registeredAgents: 1,
        liveAgents: 1,
        peers: 0,
      });
      expect(payload.agents[0]).toMatchObject({
        id: sessionName,
        status: "live",
        cohort: "red",
      });

      const segmentResult = runCli(["status", "--segment"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(segmentResult.status).toBe(0);
      expect(segmentResult.stdout.trim()).toBe("a2a 1/1");
    } finally {
      await bridge.close();
    }
  });

  test("redesign commands expose events, attention, doctor, layout, reload, iterm, and pm surfaces", async () => {
    const operatorKey = "test-operator-redesign";
    writeBaseConfig({
      key: operatorKey,
      peers: {
        offline: { url: "http://127.0.0.1:1", key: "unused-peer-secret" },
      },
    });
    writeBaseRegistry({ installToken: "ai-test-token" });
    const bridge = await startRealBridge();
    const bundleDir = mkdtempSync(join(tmpdir(), "a2a-doctor-"));

    try {
      const eventsResult = runCli(["events", "--json", "--no-peers"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(eventsResult.status).toBe(0);
      const events = JSON.parse(eventsResult.stdout);
      expect(Array.isArray(events)).toBe(true);
      expect(events.map((entry) => entry.type)).toContain("bridge.ok");

      const attentionResult = runCli(["attention", "--json", "--no-peers"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(attentionResult.status).toBe(0);
      expect(Array.isArray(JSON.parse(attentionResult.stdout))).toBe(true);

      const doctorResult = runCli(["doctor", "--json", "--no-peers"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(doctorResult.status).toBe(0);
      const doctor = JSON.parse(doctorResult.stdout);
      expect(doctor.config.key).toBe("***");
      expect(doctor.config.peers.offline.key).toBe("***");
      expect(doctor.registry.installTokenPresent).toBe(true);
      expect(doctorResult.stdout).not.toContain(operatorKey);
      expect(doctorResult.stdout).not.toContain("unused-peer-secret");

      const bundleResult = runCli(
        ["doctor", "--bundle", bundleDir, "--no-peers"],
        {
          env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
        },
      );
      expect(bundleResult.status).toBe(0);
      expect(existsSync(join(bundleDir, "doctor.json"))).toBe(true);
      expect(existsSync(join(bundleDir, "status.json"))).toBe(true);
      expect(existsSync(join(bundleDir, "events.json"))).toBe(true);

      writeTeamSpecFixture(bugKillersSpecPath, "bug-killers", [
        "scout",
        "patcher",
      ]);
      const layoutResult = runCli(["layout", "bug-killers", "--json"], {
        env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
      });
      expect(layoutResult.status).toBe(0);
      expect(JSON.parse(layoutResult.stdout)).toMatchObject({
        team: "bug-killers",
        valid: true,
      });

      const reloadResult = runCli(
        ["reload", "bug-killers", "--dry-run", "--json"],
        {
          env: { A2A_BRIDGE: bridge.url, A2A_KEY: operatorKey },
        },
      );
      expect(reloadResult.status).toBe(0);
      expect(JSON.parse(reloadResult.stdout)).toMatchObject({
        team: "bug-killers",
        safeToApply: true,
      });

      const itermResult = runCli(["iterm", "scout", "--print"]);
      expect(itermResult.status).toBe(0);
      expect(itermResult.stdout).toContain("tell application \"iTerm2\"");
      expect(itermResult.stdout).toContain("a2a attach scout --native-scroll");

      const pmResult = runCli(["pm", "review-lane", "--workers", "2"]);
      expect(pmResult.status).toBe(0);
      expect(pmResult.stdout).toContain("name: review-lane");
      expect(pmResult.stdout).toContain("worker-2:");
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
      await bridge.close();
    }
  });

  test("list --json fans out to configured peers and merges their swarms", async () => {
    // Stand up TWO independent bridges. The "local" bridge is what this
    // CLI invocation hits via A2A_BRIDGE. The "peer" bridge plays the role
    // of dylan's machine — exposed to us by URL+key in config.peers.dylan,
    // accessed by the new fan-out path. We register an agent on each
    // bridge and assert both surfaces in the merged JSON.
    writeBaseRegistry();
    const localBridge = await startRealBridge();
    const peerBridge = await startRealBridge();

    const operatorKey = "test-operator-shared-by-both-bridges";
    const peerSharedKey = "test-peer-secret-dylan-to-mauricio";
    writeBaseConfig({
      // Both bridges read this same repo-local config.json. We give them
      // a shared operator key so direct admin POSTs (registering arbitrary
      // agentIds for test setup) can authenticate, and we register dylan
      // as a peer with their own bearer. The CLI runs against the local
      // bridge using the operator key; the new fan-out hits the peer
      // bridge using peers.dylan.key — exactly the deployment topology.
      key: operatorKey,
      peers: {
        dylan: { url: peerBridge.url, key: peerSharedKey },
      },
    });

    // Register a peer-side agent named "builder" on the peer bridge,
    // authenticating as operator since `peer` auth could only register
    // an agentId equal to the peer name.
    const peerAgentRegister = await postJsonAuth(
      `${peerBridge.url}/api/a2a/register`,
      operatorKey,
      {
        agentId: "builder",
        tmuxTarget: "builder:0.0",
        cwd: "/peer/home",
        description: "team:dylan-squad",
        yolo: false,
      },
    );
    expect(peerAgentRegister.status).toBe(200);

    // Local-side agent on the local bridge.
    const localSession = rememberSession(uniqueSessionName("peer-list-local"));
    createRealTmuxSession(localSession);
    const localRegister = await postJsonAuth(
      `${localBridge.url}/api/a2a/register`,
      operatorKey,
      {
        agentId: localSession,
        tmuxTarget: `${localSession}:0.0`,
        cwd: repoRoot,
        description: "team:local-squad",
        yolo: true,
      },
    );
    expect(localRegister.status).toBe(200);

    try {
      const result = runCli(["list", "--json"], {
        env: { A2A_BRIDGE: localBridge.url, A2A_KEY: operatorKey },
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.bridgeError).toBeNull();
      expect(payload.registered.map((a) => a.agentId)).toContain(localSession);

      // Peer fan-out succeeded against the peer bridge.
      expect(Array.isArray(payload.peers)).toBe(true);
      expect(payload.peers).toHaveLength(1);
      const dylan = payload.peers[0];
      expect(dylan.peer).toBe("dylan");
      expect(dylan.url).toBe(peerBridge.url);
      expect(dylan.error).toBeNull();
      expect(dylan.agents.map((a) => a.agentId)).toContain("builder");

      // Human-readable table also surfaces the namespaced row.
      const human = runCli(["list"], {
        env: { A2A_BRIDGE: localBridge.url, A2A_KEY: operatorKey },
      });
      expect(human.status).toBe(0);
      expect(human.stdout).toContain("dylan/builder");
      expect(human.stdout).toContain("peer:dylan");
    } finally {
      await localBridge.close();
      await peerBridge.close();
    }
  });

  test("list --json surfaces peer auth failures as error rows without crashing", async () => {
    writeBaseRegistry();
    const localBridge = await startRealBridge();
    const peerBridge = await startRealBridge();

    // Peer bridge is on loopback with no key, but we'll send a wrong-key
    // header → the bridge currently treats loopback-no-key as local-open
    // and ignores Authorization. To actually exercise the 401 path, point
    // at a peer URL that requires auth. Simulate by writing a peer config
    // pointing to an unreachable port so we hit the network-error branch.
    const unreachable = "http://127.0.0.1:1"; // RFC 6335 reserved + always closed in CI
    writeBaseConfig({
      peers: {
        offline: { url: unreachable, key: "irrelevant" },
        broken_no_url: { url: "", key: "k" },
      },
    });

    // Local sanity: register one agent on the local bridge.
    const localSession = rememberSession(uniqueSessionName("peer-list-err"));
    createRealTmuxSession(localSession);
    await postJson(`${localBridge.url}/api/a2a/register`, {
      agentId: localSession,
      tmuxTarget: `${localSession}:0.0`,
      cwd: repoRoot,
      yolo: true,
    });

    try {
      const result = runCli(["list", "--json"], {
        env: { A2A_BRIDGE: localBridge.url },
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      const byName = Object.fromEntries(
        payload.peers.map((p) => [p.peer, p]),
      );
      expect(byName.offline.error).toMatch(/unreachable|timed out/i);
      expect(byName.offline.agents).toEqual([]);
      expect(byName.broken_no_url.error).toContain("url");
    } finally {
      await localBridge.close();
      await peerBridge.close();
    }
  });

  test("list --no-peers skips the peer fan-out entirely", async () => {
    writeBaseRegistry();
    const localBridge = await startRealBridge();
    writeBaseConfig({
      peers: {
        dylan: { url: "http://127.0.0.1:1", key: "k" }, // would error
      },
    });
    const localSession = rememberSession(uniqueSessionName("peer-list-skip"));
    createRealTmuxSession(localSession);
    await postJson(`${localBridge.url}/api/a2a/register`, {
      agentId: localSession,
      tmuxTarget: `${localSession}:0.0`,
      cwd: repoRoot,
      yolo: true,
    });
    try {
      const result = runCli(["list", "--no-peers", "--json"], {
        env: { A2A_BRIDGE: localBridge.url },
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.peers).toEqual([]);
    } finally {
      await localBridge.close();
    }
  });

  // ── --cohort join semantics ─────────────────────────────────────────────
  //
  // `--cohort NAME` must do more than stamp the COHORT column. When NAME
  // matches an already-running cohort, the joiner has to use the same
  // description prefix (team: vs group:) the existing members use — that's
  // what keeps `a2a kill <cohort>` reaping the joiner instead of orphaning
  // it under a mismatched prefix. Pre-registering a phantom cohort member
  // directly via the bridge lets us drive that branch end-to-end.

  test("start --cohort joins an existing team cohort and writes the matching team: description", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();

    // Pre-register a phantom cohort member with description "team:lane-x".
    // The bridge stores the description verbatim — no real tmux session
    // needed to populate the cohort for resolveCohortJoin to find it.
    const preRegister = await postJson(`${bridge.url}/api/a2a/register`, {
      agentId: "phantom-existing",
      tmuxTarget: "phantom-existing:0.0",
      cwd: repoRoot,
      description: "team:lane-x",
      yolo: true,
    });
    expect(preRegister.status).toBe(200);

    const sessionName = rememberSession(uniqueSessionName("cohort-join"));
    try {
      const result = runCli(
        ["start", sessionName, "--cohort", "lane-x", "--claude"],
        { env: { A2A_BRIDGE: bridge.url } },
      );

      expect(result.status).toBe(0);
      // Pre-spawn log: tells the operator they're joining, not seeding.
      // Singular "member" because there's exactly one existing member.
      expect(result.stderr).toContain(
        "joining team cohort 'lane-x' (1 existing member)",
      );

      const agents = await getBridgeAgents(bridge.url);
      const joiner = agents.find((a) => a.agentId === sessionName);
      expect(joiner).toBeDefined();
      // Critical contract: joiner's description matches existing members'
      // prefix so `a2a kill lane-x` (→ killTeam) reaps both rows.
      expect(joiner.description).toBe("team:lane-x");
    } finally {
      await bridge.close();
    }
  });

  test("start --cohort with no existing members logs a seed-cohort line and writes team: by default", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("cohort-seed"));
    try {
      const result = runCli(
        ["start", sessionName, "--cohort", "brand-new", "--claude"],
        { env: { A2A_BRIDGE: bridge.url } },
      );

      expect(result.status).toBe(0);
      // Seed-cohort log: no existing members → "no existing members" branch.
      // This is the typo-guard signal: if you fat-fingered the cohort name,
      // this message is the indicator that you're not joining what you
      // thought you were.
      expect(result.stderr).toContain(
        "starting new cohort 'brand-new' (no existing members)",
      );

      const agents = await getBridgeAgents(bridge.url);
      expect(agents).toHaveLength(1);
      // Default cohort prefix is team: when no existing members force a
      // group: match. Backward-compatible with the pre-join behavior.
      expect(agents[0].description).toBe("team:brand-new");
    } finally {
      await bridge.close();
    }
  });

  test("start --cohort joining a group cohort writes group: so kill <cohort> reaps the joiner", async () => {
    writeBaseConfig();
    writeBaseRegistry();
    const bridge = await startRealBridge();

    // Phantom group-cohort member — description prefix is `group:`, the
    // shape `startGroup` writes for its members.
    const preRegister = await postJson(`${bridge.url}/api/a2a/register`, {
      agentId: "phantom-group-member",
      tmuxTarget: "phantom-group-member:0.0",
      cwd: repoRoot,
      description: "group:dev-team",
      yolo: true,
    });
    expect(preRegister.status).toBe(200);

    const sessionName = rememberSession(uniqueSessionName("cohort-group"));
    try {
      const result = runCli(
        ["start", sessionName, "--cohort", "dev-team", "--claude"],
        { env: { A2A_BRIDGE: bridge.url } },
      );

      expect(result.status).toBe(0);
      // Log reports the kind so the operator sees which prefix won.
      expect(result.stderr).toContain(
        "joining group cohort 'dev-team' (1 existing member)",
      );

      const agents = await getBridgeAgents(bridge.url);
      const joiner = agents.find((a) => a.agentId === sessionName);
      expect(joiner).toBeDefined();
      // Critical: joiner inherits the group: prefix so `a2a kill dev-team`
      // (→ killGroup) finds and kills both rows. Without this branch the
      // joiner would write "team:dev-team" and silently survive cohort kill.
      expect(joiner.description).toBe("group:dev-team");
    } finally {
      await bridge.close();
    }
  });

  // ── --cohort full system loop ───────────────────────────────────────────
  //
  // End-to-end test for the operational contract of --cohort. The phantom
  // tests above prove the bridge-side description prefix in isolation, but
  // the user-visible promise of --cohort is bigger:
  //
  //   1. The seed `a2a start` builds the cohort with a real tmux session.
  //   2. A second `a2a start --cohort <NAME>` detects the existing cohort,
  //      registers with the matching prefix, and runs `tmux link-window`
  //      so the joiner's pane appears inside the cohort's <NAME>-view
  //      dashboard alongside the seed.
  //   3. `a2a kill <NAME>` then reaps every member AND the view session in
  //      one shot — proving the prefix the joiner chose actually matches
  //      what killTeam filters on.
  //
  // If any link in that chain regresses (prefix drift, missed link-window,
  // kill miss) this test fails at exactly that symptom. The 3 phantom tests
  // above plus this one cover the whole path.
  test(
    "start --cohort: real seed + joiner + dashboard link + kill <cohort> reaps everything",
    async () => {
      writeBaseConfig();
      writeBaseRegistry();
      const bridge = await startRealBridge();

      // Cohort name has to be a valid tmux session segment AND survive into
      // the <NAME>-view session name. Random suffix avoids collisions if a
      // previous run left stray sessions in tmux.
      const cohortName = `phoenix-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
      const viewSession = `${cohortName}-view`;
      const seedName = rememberSession(uniqueSessionName("cohort-e2e-seed"));
      const joinerName = rememberSession(uniqueSessionName("cohort-e2e-joiner"));
      rememberSession(viewSession); // ensure afterEach cleans it up if assertions fail

      try {
        // ── Step 1: seed the cohort with a REAL tmux session ─────────────
        // `start --cohort <new-name>` with no existing members must take the
        // seed branch: log "starting new cohort", write description
        // "team:<cohort>" by default, and create a live tmux session.
        const seedResult = runCli(
          ["start", seedName, "--cohort", cohortName, "--claude"],
          { env: { A2A_BRIDGE: bridge.url } },
        );
        expect(seedResult.status).toBe(0);
        expect(seedResult.stderr).toContain(
          `starting new cohort '${cohortName}' (no existing members)`,
        );
        // No dashboard exists yet, so the seed must NOT log a link line.
        expect(seedResult.stderr).not.toContain("linked into dashboard");
        expect(tmuxSessionExists(seedName)).toBe(true);

        const afterSeed = await getBridgeAgents(bridge.url);
        const seedAgent = afterSeed.find((a) => a.agentId === seedName);
        expect(seedAgent).toBeDefined();
        expect(seedAgent.description).toBe(`team:${cohortName}`);

        // ── Step 2: stand up a *-view dashboard with seed window linked ──
        // `link-window` requires a real source window from the seed session
        // and a real target session. We build the dashboard the same way a
        // human operator would after `a2a start --layout` — by creating the
        // view session and linking the seed's window into it. The joiner's
        // link-window call must then attach to this same session.
        const viewResult = tmux([
          "new-session",
          "-d",
          "-s",
          viewSession,
          "-c",
          repoRoot,
          "sleep 60",
        ]);
        expect(viewResult.status).toBe(0);
        const linkSeed = tmux([
          "link-window",
          "-s",
          `${seedName}:0`,
          "-t",
          `${viewSession}:`,
        ]);
        expect(linkSeed.status).toBe(0);

        // Baseline: 2 windows in the view session (the sleep placeholder +
        // the linked seed window). We compare against this after the join.
        const windowsBefore = tmux([
          "list-windows",
          "-t",
          viewSession,
          "-F",
          "#{window_name}",
        ]);
        expect(windowsBefore.status).toBe(0);
        const baselineCount = windowsBefore.stdout
          .split("\n")
          .filter(Boolean).length;
        expect(baselineCount).toBe(2);

        // ── Step 3: join the cohort with a second real agent ─────────────
        // resolveCohortJoin should see the seed under "team:<cohort>" and
        // return kind=team, isJoin=true. startSingle should then:
        //   - register the joiner with description "team:<cohort>" (NOT
        //     "team:<cohort>" computed from default — it must come from the
        //     resolver branch, but for a team→team join the bytes are the
        //     same, so we re-verify it explicitly)
        //   - call joinCohortDashboard, which detects <cohort>-view and
        //     runs `tmux link-window` to attach the joiner's pane.
        const joinResult = runCli(
          ["start", joinerName, "--cohort", cohortName, "--claude"],
          { env: { A2A_BRIDGE: bridge.url } },
        );
        expect(joinResult.status).toBe(0);
        expect(joinResult.stderr).toContain(
          `joining team cohort '${cohortName}' (1 existing member)`,
        );
        // The link-window success branch logs this exact phrase. If the
        // dashboard detection branch silently failed (e.g. cohortViewSession
        // returned the wrong name) we'd see no link line at all.
        expect(joinResult.stderr).toContain(
          `linked into dashboard '${viewSession}'`,
        );

        // Bridge contract: joiner is registered with the matching prefix.
        const afterJoin = await getBridgeAgents(bridge.url);
        expect(afterJoin).toHaveLength(2);
        const joinerAgent = afterJoin.find((a) => a.agentId === joinerName);
        expect(joinerAgent).toBeDefined();
        expect(joinerAgent.description).toBe(`team:${cohortName}`);

        // tmux contract: joiner's window now lives inside <cohort>-view.
        // We assert by window count growing AND by the joiner's session
        // name appearing in the window list — `link-window` defaults the
        // window name to the source pane's process, so we explicitly query
        // the windows' linked-session via #{window_linked_sessions_list}.
        const windowsAfter = tmux([
          "list-windows",
          "-t",
          viewSession,
          "-F",
          "#{window_linked_sessions_list}",
        ]);
        expect(windowsAfter.status).toBe(0);
        const linkedSessions = windowsAfter.stdout
          .split("\n")
          .filter(Boolean)
          // each line is a comma-separated list of every session that holds
          // a copy of this window via link-window — split and flatten.
          .flatMap((line) => line.split(","));
        expect(linkedSessions).toContain(joinerName);
        expect(linkedSessions).toContain(seedName);

        // ── Step 4: `a2a kill <cohort>` reaps everything in one shot ─────
        // killTeam filters by description === `team:<cohort>`. If the join
        // had written a mismatched prefix (regression case), this kill
        // would find only the seed and leave the joiner running.
        const killResult = runCli(["kill", cohortName], {
          env: { A2A_BRIDGE: bridge.url },
        });
        expect(killResult.status).toBe(0);
        // Report line proves the killer found BOTH members.
        expect(killResult.stderr).toContain(
          `killing team '${cohortName}' (2 members)`,
        );

        // Final state: bridge has zero registered agents, all three tmux
        // sessions (seed, joiner, view) are gone.
        const afterKill = await getBridgeAgents(bridge.url);
        expect(afterKill).toEqual([]);
        expect(tmuxSessionExists(seedName)).toBe(false);
        expect(tmuxSessionExists(joinerName)).toBe(false);
        expect(tmuxSessionExists(viewSession)).toBe(false);
        forgetSession(seedName);
        forgetSession(joinerName);
        forgetSession(viewSession);
      } finally {
        await bridge.close();
      }
    },
    30000,
  );

  test("attach on a team ref builds the dashboard view from live agent sessions", () => {
    writeBaseConfig();
    writeBaseRegistry();
    writeTeamSpecFixture(dwBugKillersSpecPath, "dw-bug-killers", [
      "alpha-mgr",
      "alpha-fix",
    ]);
    createRealTmuxSession("alpha-mgr");
    createRealTmuxSession("alpha-fix");
    const viewSession = rememberSession("dw-bug-killers-view");

    const result = runCli(["attach", "dw-bug-killers"]);

    expect(result.status).toBe(0);
    expect(tmuxSessionExists(viewSession)).toBe(true);
    expect(result.stderr).toContain("window 1: alpha-mgr");
    expect(result.stderr).toContain("window 2: alpha-fix");
  });

  test("start --dashboard opens an existing team view without restarting the team", () => {
    writeBaseConfig();
    writeBaseRegistry();
    writeTeamSpecFixture(dwBugKillersSpecPath, "dw-bug-killers", [
      "alpha-mgr",
      "alpha-fix",
    ]);
    createRealTmuxSession("alpha-mgr");
    createRealTmuxSession("alpha-fix");
    const viewSession = "dw-bug-killers-view";
    createRealTmuxSession(viewSession);

    const result = runCli(["start", "dw-bug-killers", "--dashboard"]);

    expect(result.status).toBe(0);
    expect(tmuxSessionExists(viewSession)).toBe(true);
    expect(result.stderr).toContain(
      "dashboard 'dw-bug-killers-view' is already running",
    );
    expect(result.stderr).toContain(
      "attach later: a2a attach dw-bug-killers-view",
    );
    expect(result.stderr).not.toContain("starting team 'dw-bug-killers'");
  });

  test("attach restarts a registered agent whose session died (bootstrap)", async () => {
    writeBaseConfig();
    writeBaseRegistry({ installToken: "ai-test-token" });
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("attach-restart"));

    try {
      // Register the agent on the bridge with NO live tmux session — the
      // state attach used to die on with "no tmux session".
      const registerResponse = await postJson(
        `${bridge.url}/api/a2a/register`,
        {
          agentId: sessionName,
          tmuxTarget: `${sessionName}:0.0`,
          cwd: repoRoot,
          description: "solo",
          backend: "claude",
          installToken: "ai-test-token",
        },
      );
      expect(registerResponse.status).toBe(200);
      expect(tmuxSessionExists(sessionName)).toBe(false);

      const result = runCli(["attach", sessionName], {
        env: { A2A_BRIDGE: bridge.url },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `'${sessionName}' is registered but not running — restarting it`,
      );
      expect(tmuxSessionExists(sessionName)).toBe(true);
    } finally {
      killTmuxSessionBestEffort(sessionName);
      await bridge.close();
    }
  });

  test("attach bootstraps a brand-new agent for an unregistered name", async () => {
    writeBaseConfig();
    writeBaseRegistry({ installToken: "ai-test-token" });
    const bridge = await startRealBridge();
    const sessionName = rememberSession(uniqueSessionName("attach-boot"));

    try {
      const result = runCli(["attach", sessionName], {
        env: { A2A_BRIDGE: bridge.url },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `no session '${sessionName}' — bootstrapping a new agent via 'a2a start ${sessionName}'`,
      );
      expect(tmuxSessionExists(sessionName)).toBe(true);
      const agents = await getBridgeAgents(bridge.url);
      expect(agents.map((a) => a.agentId)).toContain(sessionName);
    } finally {
      killTmuxSessionBestEffort(sessionName);
      await bridge.close();
    }
  });

  test("attach accepts --dashboard on a team ref (same as bare team attach)", () => {
    writeBaseConfig();
    writeBaseRegistry();
    writeTeamSpecFixture(dwBugKillersSpecPath, "dw-bug-killers", [
      "alpha-mgr",
      "alpha-fix",
    ]);
    createRealTmuxSession("alpha-mgr");
    rememberSession("dw-bug-killers-view");

    const result = runCli(["attach", "dw-bug-killers", "--dashboard"]);

    expect(result.status).toBe(0);
    expect(tmuxSessionExists("dw-bug-killers-view")).toBe(true);
  });
});
