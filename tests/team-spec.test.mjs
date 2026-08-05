import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadTeamSpec,
  mergeTeamArgs,
  parseTeamFlags,
  resolveExplicitTeamSpecPath,
  resolveTeamSpecPath,
} from "../src/a2a-team-spec.mjs";

test("loads YAML team specs with block scalars and lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-team-"));
  const spec = join(dir, "team.yaml");
  writeFileSync(
    spec,
    [
      "name: sample",
      "dashboard: true",
      "agents:",
      "  - id: bob",
      "    backend: claude",
      "    cwd: /tmp",
      "    role: |",
      "      hello",
      "      there",
    ].join("\n"),
  );
  const data = loadTeamSpec(spec);
  assert.equal(data.name, "sample");
  assert.equal(data.dashboard, true);
  assert.equal(data.agents[0].id, "bob");
  assert.match(data.agents[0].role, /hello\nthere/);
});

test("loadTeamSpec accepts UTF-8 BOM on JSON files (editor interoperability)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-teambom-"));
  const spec = join(dir, "team.json");
  const body = JSON.stringify({
    name: "bom",
    agents: [{ id: "ralph", backend: "claude" }],
  });
  writeFileSync(
    spec,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]),
  );
  const data = loadTeamSpec(spec);
  assert.equal(data.name, "bom");
  assert.equal(data.agents[0].id, "ralph");
});

test("loadTeamSpec wraps YAML syntax errors with the spec path", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-yaml-bad-"));
  const spec = join(dir, "broken.yaml");
  writeFileSync(spec, "agents: [\n  - not closed\n", "utf8");
  assert.throws(
    () => loadTeamSpec(spec),
    /team spec YAML parse failed .*broken\.yaml/,
  );
});

test("parseTeamFlags splits a YAML flags string into backend argv", () => {
  assert.deepEqual(parseTeamFlags("--model grok-4.3 --any-other-flag"), [
    "--model",
    "grok-4.3",
    "--any-other-flag",
  ]);
});

test("parseTeamFlags preserves quoted values and backslash escapes", () => {
  assert.deepEqual(
    parseTeamFlags("--model 'grok 4.3' --label \"fast lane\" --literal a\\ b"),
    ["--model", "grok 4.3", "--label", "fast lane", "--literal", "a b"],
  );
});

test("parseTeamFlags rejects unterminated quotes", () => {
  assert.throws(
    () => parseTeamFlags("--model 'grok"),
    /unterminated single quote/,
  );
});

test("mergeTeamArgs appends defaults args, defaults flags, agent args, then agent flags", () => {
  assert.deepEqual(
    mergeTeamArgs(
      { args: ["--permission-mode", "plan"], flags: "--model sonnet" },
      {
        args: ["--sandbox", "workspace-write"],
        flags: "--profile 'fast lane'",
      },
    ),
    [
      "--permission-mode",
      "plan",
      "--model",
      "sonnet",
      "--sandbox",
      "workspace-write",
      "--profile",
      "fast lane",
    ],
  );
});

// --- resolveTeamSpecPath: directory probing ---

test("resolveTeamSpecPath finds flat file in teams dir", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-flat-"));
  const teamsDir = join(root, "teams");
  mkdirSync(teamsDir);
  writeFileSync(
    join(teamsDir, "my-team.yaml"),
    "name: my-team\nagents:\n  bot:\n    backend: claude\n",
  );
  const result = resolveTeamSpecPath("my-team", root, teamsDir, teamsDir);
  assert.equal(result, join(teamsDir, "my-team.yaml"));
});

test("resolveTeamSpecPath finds <name>/<name>.yaml inside teams dir", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-named-"));
  const teamsDir = join(root, "teams");
  const subDir = join(teamsDir, "magic-extractors");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "magic-extractors.yaml"),
    "name: magic-extractors\nagents:\n  ex:\n    backend: claude\n",
  );
  const result = resolveTeamSpecPath(
    "magic-extractors",
    root,
    teamsDir,
    teamsDir,
  );
  assert.equal(result, join(subDir, "magic-extractors.yaml"));
});

test("resolveTeamSpecPath finds team.yaml inside a named directory", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-team-"));
  const teamsDir = join(root, "teams");
  const subDir = join(teamsDir, "squad-alpha");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "team.yaml"),
    "name: squad-alpha\nagents:\n  a1:\n    backend: claude\n",
  );
  const result = resolveTeamSpecPath("squad-alpha", root, teamsDir, teamsDir);
  assert.equal(result, join(subDir, "team.yaml"));
});

test("resolveTeamSpecPath finds a sole spec file in a named directory", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-sole-"));
  const teamsDir = join(root, "teams");
  const subDir = join(teamsDir, "odd-name");
  mkdirSync(subDir, { recursive: true });
  // spec file name doesn't match directory name or "team"
  writeFileSync(
    join(subDir, "config.yml"),
    "name: odd-name\nagents:\n  o1:\n    backend: claude\n",
  );
  const result = resolveTeamSpecPath("odd-name", root, teamsDir, teamsDir);
  assert.equal(result, join(subDir, "config.yml"));
});

test("resolveTeamSpecPath rejects ambiguous directories with multiple spec files and none match conventions", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-multi-"));
  const teamsDir = join(root, "teams");
  const subDir = join(teamsDir, "ambiguous");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "one.yaml"),
    "name: a\nagents:\n  a:\n    backend: claude\n",
  );
  writeFileSync(
    join(subDir, "two.yaml"),
    "name: b\nagents:\n  b:\n    backend: claude\n",
  );
  assert.throws(
    () => resolveTeamSpecPath("ambiguous", root, teamsDir, teamsDir),
    /ambiguous team spec directory/,
  );
});

test("resolveTeamSpecPath prefers <name>/<name>.yaml over team.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-prio-"));
  const teamsDir = join(root, "teams");
  const subDir = join(teamsDir, "my-squad");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "my-squad.yaml"),
    "name: my-squad\nagents:\n  s1:\n    backend: claude\n",
  );
  writeFileSync(
    join(subDir, "team.yaml"),
    "name: fallback\nagents:\n  s2:\n    backend: claude\n",
  );
  const result = resolveTeamSpecPath("my-squad", root, teamsDir, teamsDir);
  assert.equal(result, join(subDir, "my-squad.yaml"));
});

test("resolveTeamSpecPath works from cwd/teams subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-resolve-cwd-"));
  const cwdTeams = join(root, "teams");
  const subDir = join(cwdTeams, "local-team");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, "local-team.yml"),
    "name: local-team\nagents:\n  lt:\n    backend: claude\n",
  );
  // repoTeamsDir and installedTeamsDir point elsewhere (don't exist)
  const result = resolveTeamSpecPath(
    "local-team",
    root,
    join(root, "nope1"),
    join(root, "nope2"),
  );
  assert.equal(result, join(subDir, "local-team.yml"));
});

// --- resolveExplicitTeamSpecPath: only the literal path the user passed ---
//
// This is what `a2a start NAME --team-file=PATH` uses. Unlike the discovery
// resolver above, it must NOT widen into cwd/teams or installed-teams dirs;
// a missing path returns null so the caller can produce a precise error.

test("resolveExplicitTeamSpecPath resolves a relative file path against launchCwd", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-rel-"));
  const spec = join(root, "my-team.yaml");
  writeFileSync(spec, "name: my-team\nagents:\n  bot:\n    backend: claude\n");
  assert.equal(resolveExplicitTeamSpecPath("./my-team.yaml", root), spec);
});

test("resolveExplicitTeamSpecPath resolves an absolute file path verbatim", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-abs-"));
  const spec = join(root, "team.yaml");
  writeFileSync(spec, "name: t\nagents:\n  a:\n    backend: claude\n");
  // launchCwd is intentionally unrelated to prove the absolute path wins.
  assert.equal(resolveExplicitTeamSpecPath(spec, "/some/other/dir"), spec);
});

test("resolveExplicitTeamSpecPath probes extensions when none is given", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-ext-"));
  const spec = join(root, "no-ext.yml");
  writeFileSync(spec, "name: no-ext\nagents:\n  a:\n    backend: claude\n");
  assert.equal(resolveExplicitTeamSpecPath("./no-ext", root), spec);
});

test("resolveExplicitTeamSpecPath probes a directory for <dir>/<dir>.yaml first", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-dir-"));
  const dir = join(root, "squad");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "squad.yaml"),
    "name: squad\nagents:\n  s:\n    backend: claude\n",
  );
  writeFileSync(
    join(dir, "team.yaml"),
    "name: fallback\nagents:\n  f:\n    backend: claude\n",
  );
  assert.equal(
    resolveExplicitTeamSpecPath("./squad", root),
    join(dir, "squad.yaml"),
  );
});

test("resolveExplicitTeamSpecPath falls back to team.yaml inside a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-team-"));
  const dir = join(root, "anyname");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "team.yaml"),
    "name: anyname\nagents:\n  a:\n    backend: claude\n",
  );
  assert.equal(
    resolveExplicitTeamSpecPath(dir, "/unrelated"),
    join(dir, "team.yaml"),
  );
});

test("resolveExplicitTeamSpecPath returns null on missing path (no fallthrough)", () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-miss-"));
  assert.equal(
    resolveExplicitTeamSpecPath("./does-not-exist.yaml", root),
    null,
  );
});

test("resolveExplicitTeamSpecPath does NOT widen into cwd/teams or installed dirs", () => {
  // Even with a real spec living in <cwd>/teams/<name>.yaml — which the
  // discovery resolver finds — the explicit resolver must ignore it when
  // the user typed a different literal path.
  const root = mkdtempSync(join(tmpdir(), "a2a-explicit-nowiden-"));
  const teamsDir = join(root, "teams");
  mkdirSync(teamsDir);
  writeFileSync(
    join(teamsDir, "found-by-discovery.yaml"),
    "name: discovery\nagents:\n  d:\n    backend: claude\n",
  );
  // User passes a bare name (not a path) — must NOT walk into cwd/teams.
  assert.equal(resolveExplicitTeamSpecPath("found-by-discovery", root), null);
});

test("resolveExplicitTeamSpecPath returns null for empty or non-string refs", () => {
  assert.equal(resolveExplicitTeamSpecPath("", "/tmp"), null);
  assert.equal(resolveExplicitTeamSpecPath(null, "/tmp"), null);
  assert.equal(resolveExplicitTeamSpecPath(undefined, "/tmp"), null);
});
