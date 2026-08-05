import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

const createdSessions = new Set();
const tempDirs = new Set();

function uniqueSessionName(label) {
  return `a2a-attach-test-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function tmux(args, options = {}) {
  return spawnSync("tmux", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TMUX: "",
      ...options.env,
    },
    ...options,
  });
}

function killSessionBestEffort(name) {
  tmux(["kill-session", "-t", name]);
  createdSessions.delete(name);
}

function runAttach(args, env = {}) {
  return spawnSync(process.execPath, ["src/cli.mjs", "attach", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

afterEach(() => {
  for (const sessionName of [...createdSessions]) {
    killSessionBestEffort(sessionName);
  }
  for (const dir of [...tempDirs]) {
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
});

function createFakeTmux() {
  const dir = mkdtempSync(join(tmpdir(), "a2a-fake-tmux-"));
  tempDirs.add(dir);
  const log = join(dir, "tmux.log");
  const tmuxPath = join(dir, "tmux");
  writeFileSync(
    tmuxPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$A2A_FAKE_TMUX_LOG"\nexit 0\n',
  );
  chmodSync(tmuxPath, 0o755);
  return { dir, log };
}

test("attach from inside tmux switches the current client", () => {
  const sessionName = uniqueSessionName("switch");
  const fake = createFakeTmux();

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "iTerm.app",
    TMUX: "/tmp/tmux-501/default,123,0",
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.log, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    `has-session -t ${sessionName}`,
    `switch-client -t ${sessionName}`,
  ]);
});

// NOTE: attach on a missing *agent* name no longer rejects — it bootstraps
// the agent via the `a2a start` path (covered with an isolated bridge in
// tests/cli-vitest.test.mjs). View/dashboard names are the case that must
// still reject: a missing dashboard must never be respawned as an agent.
test("attach rejects a missing view session without bootstrapping an agent", () => {
  const sessionName = `${uniqueSessionName("missing")}-view`;
  const result = runAttach([sessionName], {
    TERM_PROGRAM: "iTerm.app",
    TMUX: "",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`no tmux session '${sessionName}'`));
});

test("plain attach outside tmux uses iTerm control mode by default", () => {
  const sessionName = uniqueSessionName("native");
  const fake = createFakeTmux();

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "iTerm.app",
    TMUX: "",
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.log, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    `has-session -t ${sessionName}`,
    `-CC attach -t ${sessionName}`,
  ]);
});
