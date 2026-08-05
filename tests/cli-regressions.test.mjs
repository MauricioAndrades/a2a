// Hermetic end-to-end regression tests for src/cli.mjs bug fixes.
//
// Strategy: spawn the real CLI (node src/cli.mjs ...) against
//   - a fake `tmux` (and `claude`) shim on PATH that logs argv and exits 0
//     (same pattern as attach.test.mjs),
//   - a fake a2a HTTP bridge (real node:http server, pointed at via
//     A2A_BRIDGE) that records every request,
//   - a fake iTerm2 bridge (real unix-socket ndjson server, pointed at via
//     A2A_ITERM2_BRIDGE_SOCKET) — or a dead socket path to simulate
//     "bridge down".
// No internal mocks: every assertion observes process exit codes, stdout /
// stderr, or the requests the CLI actually made.

import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

const tempDirs = new Set();
const cleanups = new Set();

afterEach(async () => {
  for (const cleanup of [...cleanups]) {
    await cleanup();
    cleanups.delete(cleanup);
  }
  for (const dir of [...tempDirs]) {
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
});

function makeTempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `a2a-regress-${label}-`));
  tempDirs.add(dir);
  return dir;
}

/**
 * Fake tmux + claude executables on PATH. tmux logs each invocation's argv
 * to $A2A_FAKE_TMUX_LOG and exits 0 with empty stdout; `claude` exists only
 * so requireBackendCommand passes.
 */
function createFakeBin({ tmuxScript = null } = {}) {
  const dir = makeTempDir("bin");
  const log = join(dir, "tmux.log");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "tmux"),
    tmuxScript ||
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$A2A_FAKE_TMUX_LOG"\nexit 0\n',
  );
  chmodSync(join(dir, "tmux"), 0o755);
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "claude"), 0o755);
  return { dir, log };
}

/** Fake a2a HTTP bridge recording every request it serves. */
function startFakeA2aBridge({ agents = [], runtimeSnapshot = null } = {}) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: raw ? JSON.parse(raw) : null,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/a2a/agents") {
        res.end(JSON.stringify({ success: true, data: { agents } }));
        return;
      }
      if (
        req.method === "GET" &&
        req.url?.startsWith("/api/a2a/runtime-snapshot") &&
        runtimeSnapshot
      ) {
        res.end(JSON.stringify({ success: true, data: runtimeSnapshot }));
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        // bridgeHealthy() requires `success === true`; anything else makes
        // the CLI believe the bridge is down and auto-start a real one.
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.end(JSON.stringify({ success: true, data: { removed: true } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.add(() => new Promise((done) => server.close(done)));
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
      });
    });
  });
}

/**
 * Fake iTerm2 bridge: newline-delimited JSON over a unix socket, answering
 * ping and list_sessions exactly like the python bridge does.
 */
function startFakeItermBridge({ sessions = [], pingOk = true } = {}) {
  const dir = makeTempDir("sock");
  const socketPath = join(dir, "iterm2-bridge.sock");
  const requests = [];
  const server = createNetServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const request = JSON.parse(buf.slice(0, nl));
      requests.push(request);
      buf = buf.slice(nl + 1);
      let response = { ok: false, error: `unsupported op ${request.op}` };
      if (request.op === "ping") response = { ok: pingOk, version: "test" };
      if (request.op === "list_sessions") response = { ok: true, sessions };
      if (request.op === "configure_session") response = { ok: true };
      sock.write(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      cleanups.add(() => new Promise((done) => server.close(done)));
      resolve({ socketPath, requests });
    });
  });
}

/** Socket path that exists nowhere — the iTerm bridge is "down". */
function deadItermSocket() {
  return join(makeTempDir("dead"), "no-bridge.sock");
}

function writeRepoConfigForTest(config) {
  const path = "config.json";
  let previous = null;
  try {
    previous = readFileSync(path, "utf8");
  } catch {
    previous = null;
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  cleanups.add(() => {
    if (previous === null) rmSync(path, { force: true });
    else writeFileSync(path, previous);
  });
}

/**
 * Spawn the CLI asynchronously. The fake bridges run on THIS process's event
 * loop, so the child must not be awaited with spawnSync (it would block the
 * loop and every fake server with it).
 */
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TMUX: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * This install's token, as the CLI itself resolves it (lazily generated into
 * the repo-root registry.json on first use).
 */
async function repoInstallToken(bridgeUrl) {
  const read = () => {
    try {
      const reg = JSON.parse(readFileSync("registry.json", "utf8"));
      return typeof reg.installToken === "string" && reg.installToken
        ? reg.installToken
        : null;
    } catch {
      return null;
    }
  };
  let token = read();
  if (!token) {
    // Any inventory-building command makes the CLI persist a token.
    const dead = deadItermSocket();
    await runCli(["list", "--no-peers", "--json"], {
      A2A_BRIDGE: bridgeUrl,
      A2A_ITERM2_BRIDGE_SOCKET: dead,
    });
    token = read();
  }
  assert.ok(token, "installToken could not be resolved from registry.json");
  return token;
}

// ─── finding 10: `in` against plain-object lookup tables ─────────────────

test("prototype-chain command names are not dispatched as legacy actions", { timeout: 60_000 }, async () => {
  // `lead in LEGACY_ACTION_CMD` matched inherited keys, so
  // `a2a toString from:bob to:X hi` dispatched doSend with
  // Object.prototype.toString (a Function) as the action — the envelope went
  // out with no usable action at all (JSON.stringify drops function values).
  // It must instead fall through to the generic kv-send branch, which
  // defaults the action to "message".
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({
    agents: [
      {
        agentId: "a2a-test-recv",
        tmuxTarget: "a2a-test-recv:0.0",
        description: "",
        cwd: "/tmp",
      },
    ],
  });
  const result = await runCli(
    ["toString", "from:bob", "to:a2a-test-recv", "hi"],
    {
      A2A_FAKE_TMUX_LOG: fake.log,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      A2A_BRIDGE: bridge.url,
      A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const send = bridge.requests.find(
    (r) => r.method === "POST" && r.url === "/api/a2a/send",
  );
  assert.ok(send, "expected a send POST");
  assert.equal(send.body.action, "message");
  assert.equal(send.body.body, "toString hi");
});

test("prototype-chain flag names are rejected as unknown flags", async () => {
  // parseArgs checked `key in flagSpec`, so `--toString` passed the
  // known-flag gate via Object.prototype on every command using a spec.
  const fake = createFakeBin();
  const result = await runCli(["reconnect", "--toString=x"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 2, result.stderr); // die() default exit code
  assert.match(result.stderr, /unknown flag --toString/);
});

test("prototype-chain recipient names do not revive phantom registered agents", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({ agents: [] });
  const result = await runCli(["from:alice", "to:toString", "hello"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const send = bridge.requests.find(
    (r) => r.method === "POST" && r.url === "/api/a2a/send",
  );
  assert.ok(send, "expected a send POST");
  assert.equal(send.body.to, "toString");
  const tmuxCalls = readFileSync(fake.log, "utf8");
  assert.doesNotMatch(tmuxCalls, /new-session/);
});

// ─── finding 6: peek must pull tmux scrollback, not just the visible pane ──

test("peek passes -S -<lines> to capture-pane so --lines exceeds pane height", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({ agents: [] });
  const result = await runCli(["peek", "a2a-test-peek", "--lines=200"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.log, "utf8");
  assert.match(calls, /capture-pane -t a2a-test-peek -p -S -200/);
});

test("targetless peek reuses the inferred peer registry listing", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({
    agents: [{ agentId: "a2a-test-peer", tmuxTarget: "a2a-test-peer:0.0" }],
  });
  const result = await runCli(["peek", "--lines=5"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    bridge.requests.filter(
      (request) =>
        request.method === "GET" && request.url === "/api/a2a/agents",
    ).length,
    1,
  );
});

test("peek falls back after one failed iTerm bridge ping", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({
    agents: [
      {
        agentId: "a2a-test-iterm-peek",
        tmuxTarget: "a2a-test-iterm-peek:0.0",
        itermGuid: "g-peek",
      },
    ],
  });
  const iterm = await startFakeItermBridge({ pingOk: false });
  const result = await runCli(["peek", "a2a-test-iterm-peek", "--lines=5"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    iterm.requests.filter((request) => request.op === "ping").length,
    1,
    "peek must reuse resolver bridge reachability instead of pinging twice",
  );
  const tmuxCalls = readFileSync(fake.log, "utf8");
  assert.match(tmuxCalls, /capture-pane -t a2a-test-iterm-peek -p -S -5/);
});

test("targetless attach reuses the inferred peer registry listing", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({
    agents: [{ agentId: "a2a-test-peer", tmuxTarget: "a2a-test-peer:0.0" }],
  });
  const result = await runCli(["attach"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    bridge.requests.filter(
      (request) =>
        request.method === "GET" && request.url === "/api/a2a/agents",
    ).length,
    1,
  );
});

// ─── finding 4: kill of an iTerm-backed agent with the bridge down ────────

test("kill refuses an iTerm-backed agent when the iterm bridge is down (no false success, no unregister)", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({
    agents: [
      {
        agentId: "a2a-test-iterm-kill",
        tmuxTarget: "a2a-test-iterm-kill:0.0",
        itermGuid: "g-zombie",
        description: "",
        cwd: "/tmp",
      },
    ],
  });
  const result = await runCli(["kill", "a2a-test-iterm-kill"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  // Previously: fell into the tmux path, "killed" nothing, unregistered the
  // agent, exited 0 — orphaning the live iTerm window.
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /iterm bridge unreachable/);
  assert.match(result.stdout, /a2a bridge iterm start/);
  const deletes = bridge.requests.filter((r) => r.method === "DELETE");
  assert.deepEqual(deletes, [], "agent must NOT be unregistered");
});

// ─── finding 5: reconnect sees iTerm-backed agents as live ────────────────

test("reconnect registers a live owned iTerm session with its guid", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({ agents: [] });
  const token = await repoInstallToken(bridge.url);
  const iterm = await startFakeItermBridge({
    sessions: [
      { guid: "g-rec", name: "a2a-test-rec", install_token: token },
    ],
  });
  const result = await runCli(["reconnect", "a2a-test-rec"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
  });
  // Previously: liveness came from tmux only → "no live tmux session",
  // exit 1, no registration.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /a2a-test-rec: reconnected/);
  const register = bridge.requests.find(
    (r) => r.method === "POST" && r.url === "/api/a2a/register",
  );
  assert.ok(register, "expected a register POST");
  assert.equal(register.body.agentId, "a2a-test-rec");
  assert.equal(register.body.itermGuid, "g-rec");
  assert.equal(register.body.installToken, token);
});

test("reconnect --all batches tmux ownership instead of probing each session", async () => {
  const bridge = await startFakeA2aBridge({ agents: [] });
  const token = await repoInstallToken(bridge.url);
  const fake = createFakeBin({
    tmuxScript: [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$A2A_FAKE_TMUX_LOG"',
      'if [ "$1" = "list-sessions" ] && [ "$2" = "-F" ]; then',
      '  case "$3" in',
      '    *"@a2a-install-token"*)',
      '      printf "a2a-test-owned\\t%s\\na2a-test-unowned\\tother-install\\na2a-test-view\\t%s\\n" "$A2A_TEST_INSTALL_TOKEN" "$A2A_TEST_INSTALL_TOKEN"',
      "      ;;",
      '    "#S")',
      '      printf "a2a-test-owned\\na2a-test-unowned\\na2a-test-view\\n"',
      "      ;;",
      "  esac",
      "fi",
      'if [ "$1" = "display-message" ] && [ "$3" = "-t" ] && [ "$5" = "#{pane_current_path}" ]; then',
      '  printf "/tmp/a2a-test-owned\\n"',
      "fi",
      "exit 0",
    ].join("\n"),
  });
  const result = await runCli(["reconnect", "--all"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    A2A_TEST_INSTALL_TOKEN: token,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /a2a-test-owned: reconnected/);
  assert.match(result.stdout, /a2a-test-unowned: skipped unowned tmux session/);
  const register = bridge.requests.find(
    (r) => r.method === "POST" && r.url === "/api/a2a/register",
  );
  assert.ok(register, "expected one owned session to be registered");
  assert.equal(register.body.agentId, "a2a-test-owned");
  assert.equal(register.body.installToken, token);
  const tmuxCalls = readFileSync(fake.log, "utf8");
  assert.equal(
    (tmuxCalls.match(/^list-sessions -F/gm) || []).length,
    1,
    "reconnect --all should reuse one formatted session listing",
  );
  assert.doesNotMatch(
    tmuxCalls,
    /^show-options /m,
    "ownership should come from the formatted list-sessions output",
  );
});

// ─── findings 1 + 8: iTerm orphan detection and list rendering ────────────

test("list --json reports an owned unregistered iTerm session as an iterm orphan", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({ agents: [] });
  const token = await repoInstallToken(bridge.url);
  const iterm = await startFakeItermBridge({
    sessions: [
      { guid: "g-ghost", name: "a2a-test-ghost", install_token: token },
      { guid: "g-foreign", name: "someone-elses", install_token: "other" },
    ],
  });
  const env = {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
  };
  // Previously the async ownership checker made itermOrphans ALWAYS empty.
  const json = await runCli(["list", "--no-peers", "--json"], env);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.itermOrphans, [
    { guid: "g-ghost", name: "a2a-test-ghost" },
  ]);
});

test("human-readable list renders iterm orphans instead of '(no agents registered)'", async () => {
  const fake = createFakeBin();
  const bridge = await startFakeA2aBridge({ agents: [] });
  const token = await repoInstallToken(bridge.url);
  const iterm = await startFakeItermBridge({
    sessions: [
      { guid: "g-ghost", name: "a2a-test-ghost", install_token: token },
    ],
  });
  const result = await runCli(["list", "--no-peers"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /no agents registered/);
  assert.match(result.stdout, /a2a-test-ghost/);
  assert.match(result.stdout, /iterm-only/);
});

test("kill --all uses a fresh daemon runtime snapshot", async () => {
  const fake = createFakeBin();
  const agents = [
    {
      agentId: "a2a-test-kill-all",
      tmuxTarget: "a2a-test-kill-all:0.0",
      kind: "local",
    },
  ];
  const bridge = await startFakeA2aBridge({
    agents,
    runtimeSnapshot: {
      snapshot: {
        health: "ok",
        attention: [],
      },
      inventory: {
        registered: [
          {
            agentId: "a2a-test-kill-all",
            tmuxTarget: "a2a-test-kill-all:0.0",
            status: "live",
            cwd: "",
            description: "",
            cohort: null,
            yolo: null,
            backend: "",
          },
        ],
        views: [],
        orphans: [],
        itermOrphans: [],
      },
      registeredAgents: agents,
      peerSnapshots: [],
      registry: {
        agents: ["a2a-test-kill-all"],
        groups: [],
        cachedAgentIds: ["a2a-test-kill-all"],
        installToken: null,
        error: null,
      },
      bridgeError: null,
    },
  });

  const result = await runCli(["kill", "--all"], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    A2A_BRIDGE: bridge.url,
    A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    bridge.requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.startsWith("/api/a2a/runtime-snapshot?") &&
        request.url.includes("fresh=1"),
    ),
    "kill --all must bypass the read-only runtime snapshot cache",
  );
  assert.equal(
    bridge.requests.filter(
      (request) =>
        request.method === "GET" && request.url === "/api/a2a/agents",
    ).length,
    0,
    "kill --all must not reread /api/a2a/agents per registered agent",
  );
  const tmuxCalls = readFileSync(fake.log, "utf8");
  assert.equal(
    (tmuxCalls.match(/^has-session -t a2a-test-kill-all$/gm) || []).length,
    1,
    "kill --all must probe each tmux session once before killing",
  );
  assert.ok(
    bridge.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url === "/api/a2a/register/a2a-test-kill-all",
    ),
    "kill --all must still unregister agents from the shared inventory",
  );
});

// ─── finding 7: probeAgentAlive must not adopt unowned iTerm sessions ──────

test(
  "start under protocol=tmux ignores a same-named unowned iTerm session",
  { timeout: 60_000 },
  async () => {
    const fake = createFakeBin();
    const bridge = await startFakeA2aBridge({ agents: [] });
    const iterm = await startFakeItermBridge({
      sessions: [
        // Name collision with the agent, but stamped by a DIFFERENT install:
        // must not hijack the agent onto the iTerm surface.
        { guid: "g-imp", name: "a2a-test-imp", install_token: "other-install" },
      ],
    });
    const result = await runCli(["start", "a2a-test-imp"], {
      A2A_FAKE_TMUX_LOG: fake.log,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      A2A_BRIDGE: bridge.url,
      A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
    });
    // The fake tmux answers has-session with 0, so the agent reads as alive
    // in tmux; previously the reachable iTerm bridge won by bare name match
    // and re-registered against the foreign iTerm session.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      /already exists \(tmux\)/,
      "agent must be detected on tmux, not hijacked onto iTerm",
    );
    const register = bridge.requests.find(
      (r) => r.method === "POST" && r.url === "/api/a2a/register",
    );
    assert.ok(register, "expected a register POST");
    assert.equal(
      register.body.itermGuid,
      undefined,
      "must not register the foreign iTerm guid",
    );
  },
);

test(
  "start under protocol=iterm reuses a same-named iTerm session by guid",
  { timeout: 60_000 },
  async () => {
    writeRepoConfigForTest({ protocol: "iterm" });
    const fake = createFakeBin();
    const bridge = await startFakeA2aBridge({ agents: [] });
    const iterm = await startFakeItermBridge({
      sessions: [
        {
          guid: "g-existing",
          name: "a2a-test-iterm-reuse - ~/repo",
          install_token: "same-install",
        },
      ],
    });

    const result = await runCli(["start", "a2a-test-iterm-reuse"], {
      A2A_FAKE_TMUX_LOG: fake.log,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      A2A_BRIDGE: bridge.url,
      A2A_ITERM2_BRIDGE_SOCKET: iterm.socketPath,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /already exists \(iterm\)/);
    assert.equal(
      iterm.requests.some((request) => request.op === "spawn"),
      false,
      "existing iTerm session must be reused instead of duplicated",
    );
    const register = bridge.requests.find(
      (r) => r.method === "POST" && r.url === "/api/a2a/register",
    );
    assert.ok(register, "expected a register POST");
    assert.equal(register.body.itermGuid, "g-existing");
  },
);

// ─── finding 9: no misleading persona line on team starts ──────────────────

test(
  "start --team-file does not log a cmdStart-level persona line",
  { timeout: 60_000 },
  async () => {
    const fake = createFakeBin();
    const bridge = await startFakeA2aBridge({ agents: [] });
    const dir = makeTempDir("team");
    const teamFile = join(dir, "team.yaml");
    writeFileSync(
      teamFile,
      [
        "name: a2a-test-pteam",
        "agents:",
        "  - id: a2a-test-pt-solo",
        "    backend: claude",
      ].join("\n"),
    );
    const result = await runCli(["start", "--team-file", teamFile], {
      A2A_FAKE_TMUX_LOG: fake.log,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      A2A_BRIDGE: bridge.url,
      A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
    });
    // The team path discards the cmdStart-level persona, so logging
    // `persona: a2a` was pure noise. (Exit status is irrelevant here; the
    // bug is the log line emitted before the team branch.)
    assert.doesNotMatch(result.stdout + result.stderr, /persona:/);
  },
);

test(
  "single-agent start still logs its persona line",
  { timeout: 60_000 },
  async () => {
    const fake = createFakeBin();
    const bridge = await startFakeA2aBridge({ agents: [] });
    const result = await runCli(["start", "a2a-test-psolo", "--prompt", "hi"], {
      A2A_FAKE_TMUX_LOG: fake.log,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      A2A_BRIDGE: bridge.url,
      A2A_ITERM2_BRIDGE_SOCKET: deadItermSocket(),
    });
    assert.match(result.stdout + result.stderr, /persona: /);
  },
);
