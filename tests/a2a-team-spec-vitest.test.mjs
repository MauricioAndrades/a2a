import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION,
  loadTeamSpec,
  mergeTeamArgs,
  parseTeamFlags,
  resolveExplicitTeamSpecPath,
  resolveTeamSpecPath,
  teamArgFragments,
  teamSpecDefaultsToYolo,
} from "../src/a2a-team-spec.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxDir = join(repoRoot, ".vitest-a2a-team-spec");
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-team-spec-vitest-"));

function backupPathFor(targetPath) {
  return join(backupRoot, basename(targetPath));
}

function backupTrackedPaths() {
  if (!existsSync(sandboxDir)) return;
  cpSync(sandboxDir, backupPathFor(sandboxDir), { recursive: true });
}

function restoreTrackedPaths() {
  rmSync(sandboxDir, { recursive: true, force: true });
  const backupPath = backupPathFor(sandboxDir);
  if (existsSync(backupPath)) {
    cpSync(backupPath, sandboxDir, { recursive: true });
  }
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

describe.sequential("a2a-team-spec real repo tests", () => {
  // Fixtures are test-owned (written into sandboxDir) rather than tracked
  // repo files: commit c7826bb gitignored teams/* and deleted the old
  // placeholder specs this test used to point at. The resolution and parse
  // code under test is identical either way — only fixture ownership moved.
  test("resolves flat and nested team specs from a real teams directory", () => {
    rmSync(sandboxDir, { recursive: true, force: true });
    const teamsDir = join(sandboxDir, "teams");
    mkdirSync(join(teamsDir, "nested-killers"), { recursive: true });
    const flatPath = join(teamsDir, "flat-impl.yaml");
    const nestedPath = join(teamsDir, "nested-killers", "nested-killers.yaml");
    writeFileSync(
      flatPath,
      "version: 2\nname: flat-impl\nagents:\n  lead:\n    role: placeholder\n",
    );
    writeFileSync(
      nestedPath,
      "version: 1\nname: nested-killers\nagents:\n  lead:\n    role: placeholder\n",
    );

    expect(
      resolveTeamSpecPath("flat-impl", sandboxDir, teamsDir, teamsDir),
    ).toBe(flatPath);
    expect(
      resolveTeamSpecPath("nested-killers", sandboxDir, teamsDir, teamsDir),
    ).toBe(nestedPath);

    const flatSpec = loadTeamSpec(flatPath);
    const nestedSpec = loadTeamSpec(nestedPath);

    expect(flatSpec.name).toBe("flat-impl");
    expect(nestedSpec.name).toBe("nested-killers");
    // version 2 opts into yolo-default-true; version 1 must not.
    expect(teamSpecDefaultsToYolo(flatSpec)).toBe(true);
    expect(teamSpecDefaultsToYolo(nestedSpec)).toBe(false);
  });

  test("explicit resolution stays literal while sandbox files cover parse edge cases", () => {
    rmSync(sandboxDir, { recursive: true, force: true });
    mkdirSync(sandboxDir, { recursive: true });
    const yamlPath = join(sandboxDir, "literal-team.yaml");
    const jsonPath = join(sandboxDir, "bom-team.json");
    const invalidYamlPath = join(sandboxDir, "broken.yaml");

    writeFileSync(yamlPath, "name: literal-team\nagents:\n  - id: scout\n");
    writeFileSync(
      jsonPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          JSON.stringify({ name: "bom-team", agents: [{ id: "reviewer" }] }),
          "utf8",
        ),
      ]),
    );
    writeFileSync(invalidYamlPath, "agents: [\n  - not closed\n", "utf8");

    expect(resolveExplicitTeamSpecPath("./literal-team.yaml", sandboxDir)).toBe(
      yamlPath,
    );
    // Explicit resolution must NOT widen to teams-dir search: the same bare
    // name that resolveTeamSpecPath finds via the teams dir stays null when
    // resolved explicitly from a cwd that lacks the file.
    expect(
      resolveTeamSpecPath("literal-team", repoRoot, sandboxDir, sandboxDir),
    ).toBe(yamlPath);
    expect(resolveExplicitTeamSpecPath("literal-team", repoRoot)).toBeNull();
    expect(loadTeamSpec(jsonPath).name).toBe("bom-team");
    expect(() => loadTeamSpec(invalidYamlPath)).toThrow(
      /team spec YAML parse failed/,
    );
  });

  test("flag and args helpers preserve quoted values and version-gated yolo behavior", () => {
    expect(TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION).toBe(2);
    expect(
      parseTeamFlags(
        "--model 'grok 4.3' --label \"fast lane\" --literal a\\ b",
      ),
    ).toEqual([
      "--model",
      "grok 4.3",
      "--label",
      "fast lane",
      "--literal",
      "a b",
    ]);
    expect(
      teamArgFragments({
        args: ["--approval", "edit"],
        flags: "--model sonnet",
      }),
    ).toEqual(["--approval", "edit", "--model", "sonnet"]);
    expect(
      mergeTeamArgs(
        { args: ["--approval", "edit"], flags: "--model sonnet" },
        {
          args: ["--sandbox", "workspace-write"],
          flags: "--profile 'fast lane'",
        },
      ),
    ).toEqual([
      "--approval",
      "edit",
      "--model",
      "sonnet",
      "--sandbox",
      "workspace-write",
      "--profile",
      "fast lane",
    ]);
    expect(
      teamSpecDefaultsToYolo({ version: TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION }),
    ).toBe(true);
    expect(teamSpecDefaultsToYolo({ version: 1 })).toBe(false);
    expect(teamSpecDefaultsToYolo({ version: "2" })).toBe(true);
  });
});
