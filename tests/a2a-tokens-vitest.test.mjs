import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  ACTIONS,
  ACTION_ALIASES,
  buildRegistry,
  classifyToken,
  isColonFlagArgv,
  parseColonFlagArgv,
} from "../src/a2a-tokens.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const groupsDir = join(repoRoot, "groups");
const registryPath = join(repoRoot, "registry.json");
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-tokens-vitest-"));
const trackedPaths = [groupsDir, registryPath];

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

function removeTokenArtifacts() {
  rmSync(groupsDir, { recursive: true, force: true });
  rmSync(registryPath, { force: true });
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

describe.sequential("a2a-tokens real repo tests", () => {
  test("exports canonical actions and builds registry from real repo artifacts", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    mkdirSync(join(groupsDir, "reviewers"), { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify(
        { agents: ["bob", "bob", "leah"], groups: ["stale"] },
        null,
        2,
      )  }\n`,
    );

    expect(ACTIONS.has("reply")).toBe(true);
    expect(ACTION_ALIASES.write).toBe("message");

    const registry = buildRegistry(["bob", "bob", "leah"]);
    expect([...registry.actions]).toEqual(["message", "reply", "ask", "write"]);
    expect([...registry.agents]).toEqual(["bob", "leah"]);
    expect([...registry.groups].sort()).toEqual(["ops", "reviewers"]);
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({
      agents: ["bob", "leah"],
      groups: ["ops", "reviewers"],
      installToken: null,
    });
  });

  test("classifyToken resolves actions, aliases, groups, agents, and unknown tokens", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    const registry = buildRegistry(["bob", "leah"]);

    expect(classifyToken("reply", registry)).toEqual({
      kind: "action",
      value: "reply",
    });
    expect(classifyToken("write", registry)).toEqual({
      kind: "action",
      value: "message",
    });
    expect(classifyToken("bob", registry)).toEqual({
      kind: "agent",
      value: "bob",
    });
    expect(classifyToken("ops", registry)).toEqual({
      kind: "group",
      value: "ops",
    });
    expect(classifyToken("unknown", registry)).toEqual({
      kind: "unknown",
      value: "unknown",
    });
  });

  test("parseColonFlagArgv uses the persisted registry and preserves metadata semantics", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    const registry = buildRegistry(["bob", "leah"]);

    expect(isColonFlagArgv(["--ask:bob:ops"])).toBe(true);
    // --source is the only meta key consumed downstream (sendNormalizedEnvelope
    // reads meta.source); it stays accepted in both space and = forms.
    expect(
      parseColonFlagArgv(
        [
          "--ask:bob:ops:bob",
          "--from=op",
          "--origin=peer",
          "--source",
          "peer-cli",
          "status check",
        ],
        registry,
      ),
    ).toEqual({
      from: "op",
      origin: "peer",
      recipients: ["bob", "ops"],
      action: "ask",
      content: "status check",
      meta: { source: "peer-cli" },
    });
    expect(
      parseColonFlagArgv(["--message:bob", "--source=peer-cli"], registry).meta,
    ).toEqual({ source: "peer-cli" });

    expect(
      parseColonFlagArgv(["--message:leah=inline body"], registry).content,
    ).toBe("inline body");
    expect(() =>
      parseColonFlagArgv(["--message:bob=one", "two"], registry),
    ).toThrow(/message content specified more than once/);
    expect(() => parseColonFlagArgv(["--mystery"], registry)).toThrow(
      /unknown flag --mystery/,
    );
  });

  test("unknown flags throw instead of eating the next word into meta", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    const registry = buildRegistry(["bob", "leah", "scott"]);

    // Regression: a typo'd recipient (`--scot` for agent scott) used to
    // swallow "hello" into meta and silently broadcast "world".
    expect(() =>
      parseColonFlagArgv(
        ["--message:bob", "--scot", "hello", "world"],
        registry,
      ),
    ).toThrow(/unknown flag --scot/);
    expect(() =>
      parseColonFlagArgv(["--message:bob", "--mystery", "value"], registry),
    ).toThrow(/unknown flag --mystery/);
    // Explicit `=` metadata stays accepted — the value is bound to the flag,
    // so it can never swallow message words (pinned by tests/parsers.test.mjs).
    expect(
      parseColonFlagArgv(["--message:bob", "--mystery=value"], registry).meta,
    ).toEqual({ mystery: "value" });
  });

  test("a second action token throws instead of becoming a phantom recipient", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    const registry = buildRegistry(["bob", "leah"]);

    // Regression: `--message:ask:bob` used to parse as recipients
    // ["ask", "bob"], delivering to a phantom agent named "ask".
    expect(() => parseColonFlagArgv(["--message:ask:bob"], registry)).toThrow(
      /duplicate action 'ask'/,
    );
    expect(() =>
      parseColonFlagArgv(["--ask:bob", "--message:leah"], registry),
    ).toThrow(/duplicate action 'message'/);
    expect(() =>
      parseColonFlagArgv(["--ask:bob", "--reply", "hi"], registry),
    ).toThrow(/duplicate action 'reply'/);
  });

  test("buildRegistry drops unknown registry keys on write (registry schema is closed)", () => {
    removeTokenArtifacts();

    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify(
        {
          agents: ["bob"],
          groups: [],
          installToken: null,
          rogueKey: { sneaky: true },
        },
        null,
        2,
      )}\n`,
    );

    buildRegistry(["bob"]);

    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({
      agents: ["bob"],
      groups: ["ops"],
      installToken: null,
    });
  });
});
