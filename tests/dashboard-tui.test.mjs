import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const createdSessions = new Set();

function uniqueSessionName(label) {
  return `a2a-dashboard-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function tmux(args) {
  return spawnSync("tmux", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function rememberSession(name) {
  createdSessions.add(name);
  return name;
}

function tmuxSessionExists(name) {
  return tmux(["has-session", "-t", name]).status === 0;
}

function killSessionBestEffort(name) {
  tmux(["kill-session", "-t", name]);
  createdSessions.delete(name);
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw lastError || new Error("timed out waiting for dashboard condition");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function activeWindowIndex(session) {
  const result = tmux([
    "list-windows",
    "-t",
    session,
    "-F",
    "#{window_index}\t#{window_active}",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const active = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, isActive]) => isActive === "1");
  return active?.[0] || null;
}

afterEach(() => {
  for (const sessionName of [...createdSessions]) {
    killSessionBestEffort(sessionName);
  }
});

// Timeout headroom: under a full-suite run the tmux server is busy and the
// dashboard process can take several seconds to render, which used to trip
// vitest's default 5s test timeout.
test("Enter opens a surviving linked dashboard tab when the source agent session is gone", { timeout: 20000 }, async () => {
  const view = rememberSession(uniqueSessionName("view"));
  const agent = rememberSession(uniqueSessionName("agent"));

  const agentSession = tmux([
    "new-session",
    "-d",
    "-s",
    agent,
    "-n",
    agent,
    "sleep 60",
  ]);
  assert.equal(agentSession.status, 0, agentSession.stderr);

  const dashboardCommand = [
    process.execPath,
    "src/cli/dashboard-tui.mjs",
    "--session",
    view,
    "--member",
    `${agent}:1`,
  ]
    .map(shellQuote)
    .join(" ");
  const viewSession = tmux([
    "new-session",
    "-d",
    "-s",
    view,
    "-n",
    "command",
    "-c",
    repoRoot,
    dashboardCommand,
  ]);
  assert.equal(viewSession.status, 0, viewSession.stderr);

  const linked = tmux(["link-window", "-s", `${agent}:0`, "-t", `${view}:1`]);
  assert.equal(linked.status, 0, linked.stderr);
  const renamed = tmux(["rename-window", "-t", `${view}:1`, agent]);
  assert.equal(renamed.status, 0, renamed.stderr);

  await waitFor(() => {
    const capture = tmux(["capture-pane", "-t", `${view}:0.0`, "-p"]);
    return capture.status === 0 && capture.stdout.includes("a2a command center");
  }, 15000);

  const killedSource = tmux(["kill-session", "-t", agent]);
  assert.equal(killedSource.status, 0, killedSource.stderr);
  assert.equal(tmuxSessionExists(agent), false);

  const selectedCommand = tmux(["select-window", "-t", `${view}:0`]);
  assert.equal(selectedCommand.status, 0, selectedCommand.stderr);
  assert.equal(activeWindowIndex(view), "0");

  const sentEnter = tmux(["send-keys", "-t", `${view}:0.0`, "Enter"]);
  assert.equal(sentEnter.status, 0, sentEnter.stderr);

  await waitFor(() => activeWindowIndex(view) === "1");
});
