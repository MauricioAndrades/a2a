import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "config.json");
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-config-protocol-test-"));

function backupConfig() {
  if (existsSync(configPath)) {
    cpSync(configPath, join(backupRoot, basename(configPath)));
  }
}

function restoreConfig() {
  rmSync(configPath, { force: true });
  const backupPath = join(backupRoot, basename(configPath));
  if (existsSync(backupPath)) {
    cpSync(backupPath, configPath);
  }
}

function writeConfig(data) {
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
}

let loadConfig;
let patchConfig;
let configSet;
let configGet;
let activeProtocol;

beforeAll(async () => {
  backupConfig();
  const configMod = await import("../src/a2a-config.mjs");
  ({ loadConfig, patchConfig, configSet, configGet } = configMod);
  ({ activeProtocol } = await import("../src/transport-router.mjs"));
});

afterEach(() => {
  restoreConfig();
});

describe("protocol config normalization", () => {
  test("configSet coerces iterm2 alias to iterm", () => {
    writeConfig({
      port: 7742,
      host: "127.0.0.1",
      url: null,
      key: null,
      peers: {},
      global: false,
      protocol: "tmux",
      log: { mode: "on", path: null, maxBytes: 0, redactRemote: false },
    });

    expect(configSet("protocol", "iterm2")).toBe("iterm");
    expect(configGet("protocol")).toBe("iterm");
    expect(loadConfig().protocol).toBe("iterm");
    expect(activeProtocol()).toBe("iterm");
  });

  test("patchConfig iterm2 is normalized on read so activeProtocol picks iTerm", () => {
    writeConfig({
      port: 7742,
      host: "127.0.0.1",
      url: null,
      key: null,
      peers: {},
      global: false,
      protocol: "tmux",
      log: { mode: "on", path: null, maxBytes: 0, redactRemote: false },
    });

    patchConfig({ protocol: "iterm2" });

    expect(loadConfig().protocol).toBe("iterm");
    expect(activeProtocol()).toBe("iterm");
  });
});
