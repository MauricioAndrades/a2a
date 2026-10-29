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

/**
 * Fake `tmux` and `osascript` on PATH. Both append to $A2A_FAKE_TMUX_LOG:
 * tmux logs its argv, osascript logs its stdin (the AppleScript it was asked
 * to run) prefixed with `osascript:`. `tmuxScript` overrides the tmux body
 * so a test can answer specific queries.
 */
function createFakeBin({ tmuxScript = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-fake-tmux-"));
  tempDirs.add(dir);
  const log = join(dir, "tmux.log");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "tmux"),
    tmuxScript ||
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$A2A_FAKE_TMUX_LOG"\nexit 0\n',
  );
  chmodSync(join(dir, "tmux"), 0o755);
  writeFileSync(
    join(dir, "osascript"),
    '#!/bin/sh\nprintf "osascript:" >> "$A2A_FAKE_TMUX_LOG"\ncat >> "$A2A_FAKE_TMUX_LOG"\nexit 0\n',
  );
  chmodSync(join(dir, "osascript"), 0o755);
  return { dir, log };
}

function logLines(log) {
  return readFileSync(log, "utf8").trim().split("\n");
}

test("attach from inside tmux switches the current client", () => {
  const sessionName = uniqueSessionName("switch");
  const fake = createFakeBin();

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "iTerm.app",
    TMUX: "/tmp/tmux-501/default,123,0",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(logLines(fake.log), [
    `has-session -t =${sessionName}`,
    `switch-client -t =${sessionName}`,
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

test("attach from iTerm2 outside tmux opens the session in a new iTerm2 tab (control mode) and leaves the shell alone", () => {
  const sessionName = uniqueSessionName("tab");
  const fake = createFakeBin();

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "iTerm.app",
    TMUX: "",
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = logLines(fake.log);
  // No in-place `attach` call: the gateway lives in the tab osascript opens.
  assert.equal(lines.some((line) => /^-CC attach|^attach /.test(line)), false, lines.join("\n"));
  assert.deepEqual(lines.slice(0, 3), [
    `has-session -t =${sessionName}`,
    `list-clients -t =${sessionName} -F #{client_tty}\t#{client_control_mode}`,
    "list-sessions -F #{session_id}\t#{session_name}",
  ]);
  const script = readFileSync(fake.log, "utf8").split("osascript:")[1];
  assert.ok(script, "osascript must be invoked");
  assert.match(script, /tell current window to create tab with default profile command/);
  assert.match(script, new RegExp(`tmux -CC attach -t =${sessionName}`));
  assert.match(result.stderr, new RegExp(`opened '${sessionName}' in a new iTerm2 tab`));
});

test("attach from iTerm2 detaches a stale control-mode client and clears @hidden before opening the tab", () => {
  const sessionName = uniqueSessionName("stale");
  const fake = createFakeBin({
    tmuxScript: [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$A2A_FAKE_TMUX_LOG"',
      // First list-clients answers with one control-mode gateway; after the
      // detach every later query reports none.
      'if [ "$1" = "list-clients" ]; then',
      '  if [ ! -f "$A2A_FAKE_TMUX_LOG.detached" ]; then printf "/dev/ttys099\\t1\\n/dev/ttys100\\t0\\n"; fi',
      "fi",
      'if [ "$1" = "detach-client" ]; then : > "$A2A_FAKE_TMUX_LOG.detached"; fi',
      'if [ "$1" = "list-sessions" ]; then printf "\\$7\\t%s\\n\\$8\\tother\\n" "$A2A_TEST_SESSION"; fi',
      "exit 0",
    ].join("\n"),
  });

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    A2A_TEST_SESSION: sessionName,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "iTerm.app",
    TMUX: "",
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = logLines(fake.log);
  const detachIndex = lines.indexOf("detach-client -t /dev/ttys099");
  const unhideIndex = lines.indexOf("set-option -u -t $7 @hidden");
  const scriptIndex = lines.findIndex((line) => line.startsWith("osascript:"));
  assert.notEqual(detachIndex, -1, lines.join("\n"));
  assert.notEqual(unhideIndex, -1, lines.join("\n"));
  assert.notEqual(scriptIndex, -1, lines.join("\n"));
  // Only the control-mode client is detached; the plain client stays.
  assert.equal(lines.includes("detach-client -t /dev/ttys100"), false);
  assert.ok(detachIndex < unhideIndex && unhideIndex < scriptIndex, lines.join("\n"));
  assert.match(result.stderr, new RegExp(`detached 1 stale iTerm2 control-mode client from '${sessionName}'`));
});

test("attach outside iTerm2 attaches in place without control mode", () => {
  const sessionName = uniqueSessionName("plain");
  const fake = createFakeBin();

  const result = runAttach([sessionName], {
    A2A_FAKE_TMUX_LOG: fake.log,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TERM_PROGRAM: "Apple_Terminal",
    TMUX: "",
  });

  assert.equal(result.status, 0, result.stderr);
  // vitest gives the CLI piped stdio, so the in-place attach is skipped with
  // the same explanation `a2a start` prints for detached starts.
  assert.deepEqual(logLines(fake.log), [`has-session -t =${sessionName}`]);
  assert.match(result.stderr, /attach was skipped/);
  assert.match(result.stderr, new RegExp(`attach later: a2a attach ${sessionName}`));
  assert.doesNotMatch(readFileSync(fake.log, "utf8"), /osascript:/);
});
