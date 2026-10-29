import { test } from "vitest";
import assert from "node:assert/strict";
import { parseStartArgs, BACKEND_FLAGS } from "../src/cli/parse-start-args.mjs";

// parseStartArgs is the pure flag parser for `a2a start` / `a2a start-global`.
// These tests live separately from cli.mjs because cli.mjs ends with main()
// at top level — importing it would execute the dispatcher.

// ─── defaults ─────────────────────────────────────────────────────────────

test("parseStartArgs returns defaults on empty argv", () => {
  const out = parseStartArgs([]);
  assert.equal(out.name, null);
  assert.equal(out.backend, "claude");
  assert.equal(out.backendCommand, null);
  assert.deepEqual(out.backendArgs, []);
  assert.equal(out.dashboard, null);
  assert.equal(out.promptText, null);
  assert.deepEqual(out.skills, []);
  assert.equal(out.yolo, true); // a2a default is unattended
  assert.equal(out.teamFile, null);
  assert.equal(out.cohort, null);
  // global is tri-state and starts null so the dispatcher can fall back to
  // config.global. Anything else here would silently override config.
  assert.equal(out.global, null);
});

// ─── --cohort: the change under test ──────────────────────────────────────

test("parseStartArgs accepts --cohort with a space-separated value", () => {
  const out = parseStartArgs(["--cohort", "disputewell-action-contracts"]);
  assert.equal(out.cohort, "disputewell-action-contracts");
  assert.deepEqual(out.backendArgs, []); // must NOT leak to backend argv
});

test("parseStartArgs accepts --cohort=NAME (equals form)", () => {
  const out = parseStartArgs(["--cohort=growth-lane"]);
  assert.equal(out.cohort, "growth-lane");
  assert.deepEqual(out.backendArgs, []);
});

test("parseStartArgs errors when --cohort is missing its value", () => {
  assert.throws(
    () => parseStartArgs(["--cohort"]),
    /--cohort requires a value/,
  );
});

test("parseStartArgs errors when --cohort= is empty", () => {
  assert.throws(
    () => parseStartArgs(["--cohort="]),
    /--cohort requires a value/,
  );
});

test("parseStartArgs is silent on cohort when not passed (no inference)", () => {
  const out = parseStartArgs(["credit-implementer", "--claude", "--yolo"]);
  assert.equal(out.cohort, null);
});

// ─── --cohort interacts cleanly with --team-file (NOT mutually exclusive) ──

test("parseStartArgs returns BOTH cohort and teamFile when both are passed", () => {
  // Regression guard: --cohort must be orthogonal to --team-file. The cohort
  // is just a tmux-description tag; the team spec still loads.
  const out = parseStartArgs([
    "--team-file",
    "./teams/disputewell.yaml",
    "--cohort",
    "disputewell-action-contracts",
  ]);
  assert.equal(out.teamFile, "./teams/disputewell.yaml");
  assert.equal(out.cohort, "disputewell-action-contracts");
});

test("parseStartArgs returns BOTH cohort and teamFile regardless of flag order", () => {
  const out = parseStartArgs([
    "--cohort=disputewell-action-contracts",
    "--team-file=./teams/disputewell.yaml",
  ]);
  assert.equal(out.teamFile, "./teams/disputewell.yaml");
  assert.equal(out.cohort, "disputewell-action-contracts");
});

// ─── the literal invocation the user reported (full integration) ───────────

test("parseStartArgs handles the original failing invocation end-to-end", () => {
  // a2a start credit-implementer --claude --yolo --cohort disputewell-action-contracts --prompt-file /tmp/x
  const readFile = (abs, enc) => {
    assert.equal(enc, "utf8");
    assert.equal(abs, "/tmp/credit-implementer-prompt.txt");
    return "task body from disk\n";
  };
  const out = parseStartArgs(
    [
      "credit-implementer",
      "--claude",
      "--yolo",
      "--cohort",
      "disputewell-action-contracts",
      "--prompt-file",
      "/tmp/credit-implementer-prompt.txt",
    ],
    { readFile, cwd: "/anywhere" },
  );
  assert.equal(out.name, "credit-implementer");
  assert.equal(out.backend, "claude");
  assert.equal(out.yolo, true);
  assert.equal(out.cohort, "disputewell-action-contracts");
  assert.equal(out.promptText, "task body from disk\n");
  // Crucially, --cohort must NOT survive into backendArgs — the backend CLI
  // (claude) does not recognise it and would reject the spawn.
  assert.equal(out.backendArgs.includes("--cohort"), false);
  assert.equal(out.backendArgs.includes("disputewell-action-contracts"), false);
});

// ─── existing surface area: confirm the new branch did not regress others ──

test("parseStartArgs recognises every known backend flag", () => {
  for (const backend of BACKEND_FLAGS) {
    const out = parseStartArgs([`--${backend}`]);
    assert.equal(
      out.backend,
      backend,
      `--${backend} should select that backend`,
    );
    assert.equal(
      out.backendArgs.length,
      0,
      `--${backend} must not leak into backendArgs`,
    );
  }
});

test("parseStartArgs accepts --claude=PATH as a backend command override", () => {
  const out = parseStartArgs([
    "someguy",
    "--claude=~/Documents/dev/claude-enforcer/bin/claude",
  ]);
  assert.equal(out.name, "someguy");
  assert.equal(out.backend, "claude");
  assert.equal(
    out.backendCommand,
    "~/Documents/dev/claude-enforcer/bin/claude",
  );
  assert.deepEqual(out.backendArgs, []);
});

test("parseStartArgs accepts path-looking --claude PATH without stealing normal names", () => {
  const withPath = parseStartArgs(["someguy", "--claude", "./bin/claude"]);
  assert.equal(withPath.name, "someguy");
  assert.equal(withPath.backend, "claude");
  assert.equal(withPath.backendCommand, "./bin/claude");
  assert.deepEqual(withPath.backendArgs, []);

  const withName = parseStartArgs(["--claude", "someguy"]);
  assert.equal(withName.name, "someguy");
  assert.equal(withName.backend, "claude");
  assert.equal(withName.backendCommand, null);
  assert.deepEqual(withName.backendArgs, []);
});

test("parseStartArgs rejects an empty --claude= override", () => {
  assert.throws(
    () => parseStartArgs(["--claude="]),
    /--claude requires a path/,
  );
});

test("parseStartArgs still rejects valued non-claude backend selectors", () => {
  assert.throws(
    () => parseStartArgs(["--codex=/tmp/codex"]),
    /does not take a value/,
  );
});

test("parseStartArgs forwards unknown flags to backendArgs verbatim", () => {
  // NAME comes first so the positional slot doesn't sponge a value-looking
  // token; once NAME is set, every remaining non-`--` arg also forwards.
  const out = parseStartArgs([
    "bob",
    "--some-future-flag",
    "value",
    "--another",
  ]);
  assert.equal(out.name, "bob");
  assert.deepEqual(out.backendArgs, [
    "--some-future-flag",
    "value",
    "--another",
  ]);
});

test("parseStartArgs forwards unknown flag with =VALUE form intact", () => {
  // No positional ambiguity: the whole `--some-future-flag=value` token is
  // forwarded as one arg, the backend CLI splits on '=' itself.
  const out = parseStartArgs(["--some-future-flag=value"]);
  assert.deepEqual(out.backendArgs, ["--some-future-flag=value"]);
});

test("parseStartArgs forwards unknown --flag value pair with no name", () => {
  const out = parseStartArgs(["--some-future-flag", "myvalue"]);
  assert.deepEqual(out.backendArgs, ["--some-future-flag", "myvalue"]);
  assert.strictEqual(out.name, null);
});

test("parseStartArgs treats -- as a passthrough boundary", () => {
  const out = parseStartArgs([
    "--cohort",
    "tag",
    "--",
    "--cohort",
    "ignored-by-us",
  ]);
  assert.equal(out.cohort, "tag");
  // Everything after `--` goes straight to the backend, even if it looks
  // like one of our flags. That's the established passthrough contract.
  assert.deepEqual(out.backendArgs, ["--cohort", "ignored-by-us"]);
});

test("parseStartArgs captures the first positional as NAME and forwards the rest", () => {
  const out = parseStartArgs(["bob", "extra1", "extra2"]);
  assert.equal(out.name, "bob");
  assert.deepEqual(out.backendArgs, ["extra1", "extra2"]);
});

test("parseStartArgs --no-yolo flips yolo to false (opt back into interactive)", () => {
  const out = parseStartArgs(["--no-yolo"]);
  assert.equal(out.yolo, false);
});

test("parseStartArgs --yolo is a no-op against the default but does not break", () => {
  const out = parseStartArgs(["--yolo"]);
  assert.equal(out.yolo, true);
});

test("parseStartArgs collects repeated --skill values", () => {
  const out = parseStartArgs(["--skill", "a", "--skill=b", "--skill", "c"]);
  assert.deepEqual(out.skills, ["a", "b", "c"]);
});

test("parseStartArgs merges multiple --prompt values in source order", () => {
  const out = parseStartArgs(["--prompt", "first", "--prompt=second"]);
  assert.equal(out.promptText, "first\n\nsecond");
});

test("parseStartArgs merges --prompt with --prompt-file body in source order", () => {
  const readFile = () => "from disk";
  const out = parseStartArgs(
    ["--prompt", "inline", "--prompt-file", "doesnt-matter.txt"],
    { readFile, cwd: "/tmp" },
  );
  assert.equal(out.promptText, "inline\n\nfrom disk");
});

test("parseStartArgs --dashboard and --layout both flip dashboard to true", () => {
  assert.equal(parseStartArgs(["--dashboard"]).dashboard, true);
  assert.equal(parseStartArgs(["--layout"]).dashboard, true);
});

test("parseStartArgs --team and --team-file are aliases", () => {
  assert.equal(parseStartArgs(["--team", "x.yaml"]).teamFile, "x.yaml");
  assert.equal(parseStartArgs(["--team-file", "x.yaml"]).teamFile, "x.yaml");
  assert.equal(parseStartArgs(["--team=x.yaml"]).teamFile, "x.yaml");
});

test("parseStartArgs --team-file errors on empty value", () => {
  assert.throws(
    () => parseStartArgs(["--team-file"]),
    /--team-file requires a path/,
  );
  assert.throws(() => parseStartArgs(["--team="]), /--team requires a path/);
});

test("parseStartArgs --prompt-file surfaces fs errors through die", () => {
  const readFile = () => {
    throw new Error("ENOENT: no such file");
  };
  assert.throws(
    () =>
      parseStartArgs(["--prompt-file", "missing.txt"], {
        readFile,
        cwd: "/tmp",
      }),
    /--prompt-file 'missing\.txt': ENOENT/,
  );
});

test("parseStartArgs --user overrides positional NAME", () => {
  const out = parseStartArgs(["bob", "--user", "alice"]);
  assert.equal(out.name, "alice");
});

// ─── --global / --no-global: tri-state ────────────────────────────────────

test("parseStartArgs --global flips global to true", () => {
  const out = parseStartArgs(["--global"]);
  assert.equal(out.global, true);
  // Must not leak as a backend arg — claude/codex/etc don't understand it.
  assert.deepEqual(out.backendArgs, []);
});

test("parseStartArgs --no-global flips global to false (overrides config)", () => {
  const out = parseStartArgs(["--no-global"]);
  assert.equal(out.global, false);
  assert.deepEqual(out.backendArgs, []);
});

test("parseStartArgs global stays null when neither flag is passed", () => {
  // null is the signal the dispatcher uses to fall back to config.global,
  // distinguishing "user didn't say" from "user explicitly said false".
  const out = parseStartArgs(["bob", "--claude"]);
  assert.equal(out.global, null);
});

test("parseStartArgs --global composes with --team-file and --cohort", () => {
  const out = parseStartArgs([
    "--global",
    "--team-file",
    "./teams/x.yaml",
    "--cohort",
    "swarm-a",
  ]);
  assert.equal(out.global, true);
  assert.equal(out.teamFile, "./teams/x.yaml");
  assert.equal(out.cohort, "swarm-a");
});
