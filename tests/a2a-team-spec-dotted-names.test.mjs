import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTeamSpec,
  resolveExplicitTeamSpecPath,
  resolveTeamSpecPath,
} from "../src/a2a-team-spec.mjs";

// Regression for the `if (!extname(ref))` gate: a team name containing a dot
// ("release-1.2") made extname() return ".2", so the .yaml/.yml/.json
// candidates were never appended and the team — although advertised by
// listTeamSpecNames — could never be resolved.
const root = mkdtempSync(join(tmpdir(), "a2a-team-spec-dotted-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("team specs with dots in the team name", () => {
  test("resolveTeamSpecPath appends extension candidates for dotted bare names", () => {
    const teamsDir = join(root, "repo-teams");
    const cwd = join(root, "cwd");
    const installedDir = join(root, "installed-teams");
    for (const dir of [teamsDir, cwd, installedDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const specPath = join(teamsDir, "release-1.2.yaml");
    writeFileSync(
      specPath,
      "version: 2\nname: release-1.2\nagents:\n  lead: {}\n",
    );

    const resolved = resolveTeamSpecPath(
      "release-1.2",
      cwd,
      teamsDir,
      installedDir,
    );
    expect(resolved).toBe(specPath);
    expect(loadTeamSpec(resolved).name).toBe("release-1.2");
  });

  test("resolveExplicitTeamSpecPath resolves a dotted bare name against the launch cwd", () => {
    const launchCwd = join(root, "launch");
    mkdirSync(launchCwd, { recursive: true });
    const specPath = join(launchCwd, "hotfix-2.0.yml");
    writeFileSync(specPath, "version: 2\nname: hotfix-2.0\nagents: {}\n");

    expect(resolveExplicitTeamSpecPath("hotfix-2.0", launchCwd)).toBe(specPath);
  });

  test("refs that already carry a spec extension still resolve directly", () => {
    const dir = join(root, "explicit");
    mkdirSync(dir, { recursive: true });
    const specPath = join(dir, "plain.yaml");
    writeFileSync(specPath, "version: 2\nagents: {}\n");

    expect(resolveExplicitTeamSpecPath("plain.yaml", dir)).toBe(specPath);
    expect(resolveTeamSpecPath("plain.yaml", dir, dir, dir)).toBe(specPath);
  });
});
