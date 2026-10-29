import {
  appendMessageLog,
  bridgeUrl,
  configGet,
  configSet,
  ensureDirs,
  findNextLineStartedHeader,
  formatLogBody,
  formatLogBytes,
  formatLogHeader,
  formatLogStatus,
  generateKey,
  activeHost,
  activeKey,
  activePort,
  activeUrl,
  installToken,
  isAsciiDigit,
  isCsiFinalByte,
  isCsiIntermediateByte,
  isCsiParamByte,
  isEscFinalByte,
  isExistingDirectory,
  isGroup,
  isTrustedGroupPathSegment,
  isUtf8Continuation,
  isoLogHeaderStartsAt,
  listGroupMembers,
  listGroupNames,
  listTeamSpecNames,
  loadConfig,
  loadRegistry,
  logConfig,
  looksLikeFilePath,
  messageLogEnabled,
  messageLogMaxBytes,
  messageLogPath,
  messageLogRedactRemote,
  nestedGet,
  nestedSet,
  normalizeFsPath,
  patchConfig,
  peerKeyForUrl,
  readJson,
  readPid,
  removePid,
  resolvedTrustedGroupDirectory,
  rotateLogIfNeeded,
  sanitizeAgentName,
  saveRegistry,
  scanCsi,
  scanGenericEsc,
  scanOsc,
  stripAnsiCodes,
  stripLeadingUtf8Continuations,
  stripTrailingSlash,
  targetDirectoryFor,
  teamSpecsDir,
  truncateRotatedMessageLogTail,
  writeJson,
  writePid,
} from "../src/a2a-config.mjs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxDir = join(repoRoot, ".vitest-a2a-config");
const configPath = join(repoRoot, "config.json");
const registryPath = join(repoRoot, "registry.json");
const groupsDir = join(repoRoot, "groups");
const teamsDir = join(repoRoot, "teams");
const pidPath = join(repoRoot, "bridge.pid");
const logPath = join(repoRoot, "messages.log");
const trackedPaths = [
  configPath,
  registryPath,
  groupsDir,
  teamsDir,
  pidPath,
  logPath,
  sandboxDir,
];
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-config-vitest-"));
const originalEnv = new Map(Object.entries(process.env));

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

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!originalEnv.has(key)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of originalEnv.entries()) {
    process.env[key] = value;
  }
}

function removeConfigArtifacts() {
  rmSync(configPath, { force: true });
  rmSync(registryPath, { force: true });
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  rmSync(groupsDir, { recursive: true, force: true });
  rmSync(teamsDir, { recursive: true, force: true });
  rmSync(sandboxDir, { recursive: true, force: true });
}

function readUtf8(targetPath) {
  return readFileSync(targetPath, "utf8");
}

beforeAll(() => {
  backupTrackedPaths();
});

afterEach(() => {
  restoreTrackedPaths();
  restoreEnv();
});

afterAll(() => {
  restoreTrackedPaths();
  restoreEnv();
  rmSync(backupRoot, { recursive: true, force: true });
});

describe.sequential("a2a-config real repo tests", () => {
  test("path helpers normalize, classify, and create directories correctly", () => {
    removeConfigArtifacts();

    expect(stripTrailingSlash("https://example.test/")).toBe(
      "https://example.test",
    );
    expect(stripTrailingSlash("plain")).toBe("plain");

    const plainFile = join(sandboxDir, "nested", "config.json");
    const plainDir = join(sandboxDir, "nested-dir");
    const dotfile = join(sandboxDir, ".env");
    const fileUrl = pathToFileURL(plainFile).href;

    expect(normalizeFsPath(fileUrl)).toBe(resolve(plainFile));
    expect(normalizeFsPath(plainFile)).toBe(resolve(plainFile));
    expect(normalizeFsPath("tests")).toBe(resolve("tests"));
    expect(() => normalizeFsPath("https://example.test/config.json")).toThrow(
      /unsupported URL scheme/,
    );

    expect(looksLikeFilePath(dotfile)).toBe(true);
    expect(looksLikeFilePath(plainFile)).toBe(true);
    expect(looksLikeFilePath(plainDir)).toBe(false);

    expect(() => ensureDirs("")).toThrow(/non-empty string/);
    ensureDirs(plainFile);
    expect(existsSync(dirname(plainFile))).toBe(true);

    ensureDirs(plainDir);
    expect(existsSync(plainDir)).toBe(true);

    writeFileSync(plainFile, "{}\n");
    expect(targetDirectoryFor(plainFile)).toBe(dirname(plainFile));
    expect(targetDirectoryFor(plainDir)).toBe(plainDir);
  });

  test("json and nested object helpers round-trip real files and handle invalid input", () => {
    removeConfigArtifacts();
    const helperPath = join(sandboxDir, "helper.json");
    const invalidPath = join(sandboxDir, "invalid.json");
    const defaults = { a: 1, nested: { ok: true } };

    expect(readJson(helperPath, defaults)).toEqual(defaults);

    ensureDirs(invalidPath);
    writeFileSync(invalidPath, "{not-json\n");
    expect(() => readJson(invalidPath, defaults)).toThrow(
      /failed to read JSON/,
    );

    writeJson(helperPath, { value: 2 });
    expect(readJson(helperPath, defaults)).toEqual({ ...defaults, value: 2 });

    const input = { top: { inner: 1 } };
    expect(nestedGet(input, "top.inner")).toBe(1);
    expect(nestedGet(input, "top.missing")).toBeUndefined();
    expect(nestedSet(input, "top.next", 3)).toEqual({
      top: { inner: 1, next: 3 },
    });
  });

  test("config functions persist and validate settings against the real repo config file", () => {
    removeConfigArtifacts();

    expect(loadConfig().port).toBe(7742);
    expect(configGet("port")).toBe(7742);
    expect(configGet()).toMatchObject({ port: 7742, host: "127.0.0.1" });
    expect(() => configGet("unknown")).toThrow(/unknown setting/);

    expect(configSet("port", "8123")).toBe(8123);
    expect(configSet("host", "127.0.0.2")).toBe("127.0.0.2");
    expect(configSet("url", "https://example.ngrok-free.dev/")).toBe(
      "https://example.ngrok-free.dev",
    );
    expect(configSet("key", "secret")).toBe("secret");
    // global is a tri-state CLI flag; here we verify the setter accepts the
    // documented string forms and rejects everything else, so
    // `a2a config set global true` can be the canonical way to opt the swarm
    // into global mode by default.
    expect(configSet("global", "true")).toBe(true);
    expect(configSet("global", "false")).toBe(false);
    expect(configSet("global", true)).toBe(true);
    expect(() => configSet("global", "maybe")).toThrow(/true or false/);
    expect(configGet("global")).toBe(true);
    expect(configSet("log.mode", "off")).toBe("off");
    expect(configSet("log.path", "")).toBeNull();
    expect(configSet("log.maxBytes", "12")).toBe(12);
    expect(configSet("log.redactRemote", "true")).toBe(true);

    expect(loadConfig()).toMatchObject({
      port: 8123,
      host: "127.0.0.2",
      url: "https://example.ngrok-free.dev",
      key: "secret",
      log: { redactRemote: true },
    });

    expect(
      patchConfig({
        peers: { demo: { url: "https://peer.test", key: "peer-key" } },
      }).peers.demo.key,
    ).toBe("peer-key");

    expect(() => configSet("port", "0")).toThrow(/between 1 and 65535/);
    expect(() => configSet("host", "https://bad-host")).toThrow(
      /bare hostname/,
    );
    expect(() => configSet("url", "ssh://bad-url")).toThrow(
      /http:\/\/ or https:\/\//,
    );
    expect(() => configSet("log.mode", "maybe")).toThrow(/must be on or off/);
    expect(() => configSet("log.maxBytes", "-1")).toThrow(
      /non-negative integer/,
    );
    expect(() => configSet("log.redactRemote", "maybe")).toThrow(
      /true or false/,
    );
  });

  test("environment-driven accessors prefer env overrides and handle invalid edge cases", () => {
    removeConfigArtifacts();
    patchConfig({
      port: 9000,
      host: "10.0.0.1",
      url: "https://stored.test",
      key: "stored-key",
    });

    expect(activeKey()).toBe("stored-key");
    process.env.A2A_KEY = "env-key";
    expect(activeKey()).toBe("env-key");

    expect(activePort()).toBe(9000);
    process.env.A2A_PORT = "9010";
    expect(activePort()).toBe(9010);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    process.env.A2A_PORT = "nope";
    expect(activePort()).toBe(9000);
    console.warn = originalWarn;
    expect(warnings.at(-1)).toMatch(/not a valid port number/);

    expect(activeHost()).toBe("10.0.0.1");
    process.env.A2A_HOST = "192.168.0.10";
    expect(activeHost()).toBe("192.168.0.10");

    expect(activeUrl()).toBe("https://stored.test");
    process.env.A2A_PUBLIC_URL = "https://env.test/";
    expect(activeUrl()).toBe("https://env.test");

    expect(bridgeUrl()).toBe("http://192.168.0.10:9000");
    process.env.A2A_BRIDGE = "https://bridge.override";
    expect(bridgeUrl()).toBe("https://bridge.override");
  });

  test("pid helpers write, read, and remove the real pid file", () => {
    removeConfigArtifacts();

    expect(readPid()).toBeNull();
    writePid(4242);
    expect(readPid()).toBe(4242);
    removePid();
    expect(readPid()).toBeNull();

    writeFileSync(pidPath, "not-a-number\n");
    expect(readPid()).toBeNull();
  });

  test("group and team helpers operate on the repo directories with traversal guards", () => {
    removeConfigArtifacts();

    mkdirSync(join(groupsDir, "squad"), { recursive: true });
    writeFileSync(join(groupsDir, "squad", "Roger One.md"), "roger\n");
    mkdirSync(join(groupsDir, "ops"), { recursive: true });
    mkdirSync(join(groupsDir, "empty"), { recursive: true });

    expect(isTrustedGroupPathSegment("squad")).toBe(true);
    expect(isTrustedGroupPathSegment("../escape")).toBe(false);
    expect(isTrustedGroupPathSegment("")).toBe(false);
    expect(resolvedTrustedGroupDirectory("squad")).toBe(
      join(groupsDir, "squad"),
    );
    expect(resolvedTrustedGroupDirectory("../escape")).toBeNull();
    expect(isExistingDirectory(join(groupsDir, "squad"))).toBe(true);
    expect(isExistingDirectory(join(groupsDir, "missing"))).toBe(false);
    expect(sanitizeAgentName("Roger One.md")).toBe("Roger-One");
    expect(sanitizeAgentName("***.md")).toBe("agent");
    expect(isGroup("squad")).toBe(true);
    expect(isGroup("../escape")).toBe(false);
    expect(listGroupNames()).toEqual(["empty", "ops", "squad"]);
    expect(listGroupMembers("squad")).toEqual([
      { name: "Roger-One", fullPath: join(groupsDir, "squad", "Roger One.md") },
    ]);
    expect(listGroupMembers("../escape")).toEqual([]);

    expect(teamSpecsDir()).toBe(teamsDir);
    writeFileSync(join(teamsDir, "alpha.yaml"), "name: alpha\n");
    writeFileSync(join(teamsDir, "beta.yml"), "name: beta\n");
    writeFileSync(join(teamsDir, "gamma.json"), "{}\n");
    writeFileSync(join(teamsDir, "ignore.txt"), "x\n");
    expect(listTeamSpecNames()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("registry, token, key, peer, and log config helpers use the real repo files", () => {
    removeConfigArtifacts();

    expect(loadRegistry()).toEqual({
      agents: [],
      groups: [],
      installToken: null,
    });
    saveRegistry({ agents: ["one"], groups: ["blue"], installToken: null });
    expect(loadRegistry()).toEqual({
      agents: ["one"],
      groups: ["blue"],
      installToken: null,
    });

    const install = installToken();
    expect(install).toMatch(/^ai-[a-f0-9]{16}$/);
    expect(installToken()).toBe(install);
    expect(generateKey()).toMatch(/^a2a-[a-f0-9]{32}$/);

    patchConfig({
      peers: {
        bob: { url: "https://peer.example/", key: "peer-secret" },
      },
      log: { mode: "off", maxBytes: 9, redactRemote: true },
    });

    expect(peerKeyForUrl("https://peer.example")).toBe("peer-secret");
    expect(peerKeyForUrl("https://missing.example")).toBeNull();
    expect(logConfig()).toMatchObject({
      mode: "off",
      path: logPath,
      maxBytes: 9,
      redactRemote: true,
    });
    expect(messageLogPath()).toBe(logPath);
    expect(messageLogEnabled()).toBe(false);
    expect(messageLogMaxBytes()).toBe(9);
    expect(messageLogRedactRemote()).toBe(true);

    process.env.A2A_LOG = "1";
    process.env.A2A_LOG_FILE = join(repoRoot, "custom.log");
    expect(messageLogEnabled()).toBe(true);
    expect(messageLogPath()).toBe(join(repoRoot, "custom.log"));
  });

  test("messageLogPath expands ~ and resolves relative paths against the install root", () => {
    removeConfigArtifacts();

    // Regression: log.path got no ~ expansion (literal ./~/ directories) and
    // relative paths resolved against the per-process cwd, scattering logs.
    configSet("log.path", "~/a2a-test-logs/messages.log");
    expect(messageLogPath()).toBe(
      join(homedir(), "a2a-test-logs", "messages.log"),
    );

    configSet("log.path", "rel-logs/messages.log");
    expect(messageLogPath()).toBe(join(repoRoot, "rel-logs", "messages.log"));

    // Absolute paths pass through untouched; env override gets the same rules.
    configSet("log.path", join(repoRoot, "abs.log"));
    expect(messageLogPath()).toBe(join(repoRoot, "abs.log"));
    process.env.A2A_LOG_FILE = "~/env-logs/env.log";
    expect(messageLogPath()).toBe(join(homedir(), "env-logs", "env.log"));
    process.env.A2A_LOG_FILE = "env-rel.log";
    expect(messageLogPath()).toBe(join(repoRoot, "env-rel.log"));
  });

  test("invalid persisted protocol is coerced to tmux with a one-time warning", () => {
    removeConfigArtifacts();
    writeFileSync(
      configPath,
      `${JSON.stringify({ port: 7742, host: "127.0.0.1", protocol: "telnet" }, null, 2)}\n`,
    );

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      expect(loadConfig().protocol).toBe("tmux");
      expect(loadConfig().protocol).toBe("tmux");
    } finally {
      console.warn = originalWarn;
    }
    const protocolWarnings = warnings.filter((w) =>
      /persisted protocol "telnet" is invalid/.test(w),
    );
    // Warned loudly, but only once per process for the same value.
    expect(protocolWarnings.length).toBe(1);
    expect(protocolWarnings[0]).toMatch(/tmux, iterm/);

    // configSet still rejects the same value outright.
    expect(() => configSet("protocol", "telnet")).toThrow(
      /protocol must be one of tmux, iterm/,
    );
  });

  test("nestedSet replaces non-object intermediates instead of spreading them", () => {
    // Regression: nestedSet({log:"broken"}, "log.mode", "off") spread the
    // string into {"0":"b","1":"r",...} index keys.
    expect(nestedSet({ log: "broken" }, "log.mode", "off")).toEqual({
      log: { mode: "off" },
    });
    expect(nestedSet({ log: [1, 2] }, "log.mode", "off")).toEqual({
      log: { mode: "off" },
    });
    expect(nestedSet({ log: { mode: "on", maxBytes: 4 } }, "log.mode", "off")).toEqual({
      log: { mode: "off", maxBytes: 4 },
    });

    // End-to-end: a corrupted persisted log value is repaired, not exploded.
    removeConfigArtifacts();
    writeFileSync(
      configPath,
      `${JSON.stringify({ port: 7742, host: "127.0.0.1", log: "broken" }, null, 2)}\n`,
    );
    expect(configSet("log.mode", "off")).toBe("off");
    const persisted = JSON.parse(readUtf8(configPath));
    expect(persisted.log).toEqual({ mode: "off" });
  });

  test("configSet rejects unknown keys inside schema-closed namespaces", () => {
    removeConfigArtifacts();

    expect(() => configSet("log.bogus", "x")).toThrow(
      /unknown setting: log\.bogus/,
    );
    expect(() => configSet("log", "broken")).toThrow(/unknown setting: log/);
    expect(() => configSet("peers", "broken")).toThrow(
      /unknown setting: peers/,
    );
    expect(() => configSet("peers.demo.url", "https://x.test")).toThrow(
      /unknown setting/,
    );
    // Novel top-level keys remain allowed — config.schema.json sets
    // additionalProperties: true at the top level.
    expect(configSet("customKnob", "enabled")).toBe("enabled");
    expect(configGet("customKnob")).toBe("enabled");
  });

  test("a non-object config.json or registry.json fails loudly instead of acting as defaults", () => {
    removeConfigArtifacts();

    writeFileSync(configPath, "[]\n");
    expect(() => loadConfig()).toThrow(/must be a JSON object/);

    writeFileSync(configPath, '"just a string"\n');
    expect(() => loadConfig()).toThrow(/must be a JSON object/);

    writeFileSync(configPath, "null\n");
    expect(() => loadConfig()).toThrow(/must be a JSON object/);

    writeFileSync(registryPath, "[1, 2]\n");
    expect(() => loadRegistry()).toThrow(/must be a JSON object/);
  });

  test("saveRegistry drops unknown keys so writes always satisfy the registry schema", () => {
    removeConfigArtifacts();

    saveRegistry({
      agents: ["one"],
      groups: ["blue"],
      installToken: null,
      rogue: { sneaky: true },
    });
    expect(JSON.parse(readUtf8(registryPath))).toEqual({
      agents: ["one"],
      groups: ["blue"],
      installToken: null,
    });
  });

  test("installToken: concurrent first claims converge on one persisted token", async () => {
    removeConfigArtifacts();
    mkdirSync(sandboxDir, { recursive: true });

    // Regression: two concurrent first spawns minted different tokens with
    // last-writer-wins persistence — sessions tagged with the losing token
    // became invisible to `kill --all`. Four child processes block on a go
    // file, then race installToken() against the same missing registry.json.
    const goFile = join(sandboxDir, "install-token-go");
    const moduleHref = pathToFileURL(join(repoRoot, "src", "a2a-config.mjs")).href;
    const childScript = [
      'import { existsSync } from "node:fs";',
      `const mod = await import(${JSON.stringify(moduleHref)});`,
      `while (!existsSync(${JSON.stringify(goFile)}));`,
      "process.stdout.write(mod.installToken());",
    ].join("\n");

    const run = promisify(execFile);
    const children = Array.from({ length: 4 }, () =>
      run(process.execPath, ["--input-type=module", "-e", childScript], {
        timeout: 30_000,
      }),
    );
    await delay(700);
    writeFileSync(goFile, "go\n");

    const tokens = (await Promise.all(children)).map((r) => r.stdout.trim());
    for (const token of tokens) expect(token).toMatch(/^ai-[a-f0-9]{16}$/);
    expect(new Set(tokens).size).toBe(1);
    expect(JSON.parse(readUtf8(registryPath)).installToken).toBe(tokens[0]);
  });

  test("installToken adopts an already-persisted token instead of overwriting it", () => {
    removeConfigArtifacts();
    saveRegistry({
      agents: [],
      groups: [],
      installToken: "ai-0123456789abcdef",
    });
    expect(installToken()).toBe("ai-0123456789abcdef");
    expect(JSON.parse(readUtf8(registryPath)).installToken).toBe(
      "ai-0123456789abcdef",
    );
  });

  test("byte-oriented log tail helpers cover UTF-8 and header edge cases", () => {
    const emoji = Buffer.from([0xf0, 0x9f, 0x98, 0x80]);
    const combined = Buffer.concat([
      Buffer.from([0x80, 0x81]),
      Buffer.from("A"),
    ]);
    expect(isAsciiDigit(0x35)).toBe(true);
    expect(isAsciiDigit(0x2f)).toBe(false);
    expect(isUtf8Continuation(0x80)).toBe(true);
    expect(isUtf8Continuation(0xc2)).toBe(false);
    expect([...stripLeadingUtf8Continuations(combined)]).toEqual([0x41]);

    const header = Buffer.from("[2026-05-02T12:34:56.789Z] ok\n", "utf8");
    expect(isoLogHeaderStartsAt(header, 0, true)).toBe(0);
    expect(
      isoLogHeaderStartsAt(
        Buffer.from("x[2026-05-02T12:34:56.789Z]", "utf8"),
        1,
        false,
      ),
    ).toBeNull();

    const withNoise = Buffer.from(
      "noise\n[2026-05-02T12:34:56.789Z] ok\n",
      "utf8",
    );
    expect(findNextLineStartedHeader(withNoise)).toBe(6);

    const utf8Window = Buffer.concat([
      Buffer.from("A".repeat(10)),
      emoji,
      Buffer.from("B".repeat(27)),
    ]);
    const truncatedUtf8 = truncateRotatedMessageLogTail(utf8Window, 30);
    expect(() =>
      new TextDecoder("utf8", { fatal: true }).decode(truncatedUtf8),
    ).not.toThrow();

    const entryA = "[2026-05-01T00:00:00.001Z] a -> b  message/user  -  ok\n";
    const entryB =
      "[2026-05-02T12:34:56.789Z] c -> d  reply/peer  3B  ok\ntrail";
    const garbled = ":00:00.001Z] noise\n";
    const rotated = truncateRotatedMessageLogTail(
      Buffer.from(entryA + garbled + entryB, "utf8"),
      Buffer.byteLength(entryB, "utf8"),
    );
    expect(rotated.toString("utf8")).toBe(entryB);
  });

  test("ansi classification and scanner helpers handle valid and malformed sequences", () => {
    expect(isCsiParamByte(0x30)).toBe(true);
    expect(isCsiParamByte(0x2f)).toBe(false);
    expect(isCsiIntermediateByte(0x20)).toBe(true);
    expect(isCsiIntermediateByte(0x30)).toBe(false);
    expect(isCsiFinalByte(0x40)).toBe(true);
    expect(isCsiFinalByte(0x3f)).toBe(false);
    expect(isEscFinalByte(0x30)).toBe(true);
    expect(isEscFinalByte(0x2f)).toBe(false);

    expect(scanCsi("\u001b[31mred", 0)).toBe(5);
    expect(scanCsi("\u001b[", 0)).toBe(2);
    expect(scanOsc("\u001b]0;title\u0007done", 0)).toBe(10);
    expect(scanOsc("\u001b]0;title", 0)).toBe(9);
    expect(scanGenericEsc("\u001bcdone", 0)).toBe(2);
    expect(scanGenericEsc("\u001b\u0005done", 0)).toBe(1);

    expect(stripAnsiCodes("plain")).toBe("plain");
    expect(stripAnsiCodes("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsiCodes("\u001b]0;title\u0007shown")).toBe("shown");
    expect(stripAnsiCodes("a\u001b\u0005b")).toBe("a\u0005b");
    expect(stripAnsiCodes("good\u001b]0;unterminated")).toBe("good");
  });

  test("log formatting, rotation, and append operate on the repo log file", () => {
    removeConfigArtifacts();

    expect(formatLogStatus({ ok: true, transport: "tmux" })).toBe(
      "ok via tmux",
    );
    expect(
      formatLogStatus({ ok: false, transport: "remote", error: "boom" }),
    ).toBe("FAIL via remote: boom");
    expect(formatLogBytes({ bytes: 12 })).toBe("12B");
    expect(formatLogBytes({ bytes: NaN })).toBe("-");

    const stamp = "2026-05-23T00:00:00.000Z";
    const header = formatLogHeader(
      {
        from: "alice",
        to: "bob",
        origin: "cli",
        action: "message",
        bytes: 4,
        ok: true,
      },
      stamp,
    );
    expect(header).toBe(
      "[2026-05-23T00:00:00.000Z] alice -> bob  message/cli  4B  ok",
    );

    patchConfig({
      log: { mode: "on", path: logPath, maxBytes: 80, redactRemote: true },
    });
    expect(formatLogBody({ body: "a\r\nb", transport: "local" })).toBe(
      "    a\n    b",
    );
    expect(formatLogBody({ body: "secret", transport: "remote" })).toBe(
      "    [redacted remote body]",
    );

    const oversized = [
      "[2026-05-01T00:00:00.000Z] a -> b  message/cli  1B  ok\n    one\n",
      "[2026-05-02T00:00:00.000Z] b -> c  message/cli  1B  ok\n    two\n",
    ].join("");
    writeFileSync(logPath, oversized);
    rotateLogIfNeeded(logPath);
    expect(statSync(logPath).size).toBeLessThanOrEqual(80);
    expect(readUtf8(logPath)).toContain("[2026-05-02T00:00:00.000Z]");

    unlinkSync(logPath);
    appendMessageLog({
      ts: stamp,
      from: "alice",
      to: "bob",
      origin: "cli",
      action: "reply",
      body: "hello",
      ok: true,
      bytes: 5,
    });
    const appended = readUtf8(logPath);
    expect(appended).toContain(
      "[2026-05-23T00:00:00.000Z] alice -> bob  reply/cli  5B  ok",
    );
    expect(appended).toContain("    hello");

    patchConfig({
      log: { mode: "on", path: logPath, maxBytes: 0, redactRemote: true },
    });
    appendMessageLog({
      ts: stamp,
      from: "alice",
      to: "remote",
      origin: "peer",
      transport: "remote",
      body: "secret body",
      ok: true,
      bytes: 11,
    });
    expect(readUtf8(logPath)).toContain("[redacted remote body]");
  });
});
