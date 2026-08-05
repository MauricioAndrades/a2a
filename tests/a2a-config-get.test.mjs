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
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-config-get-test-"));

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

let configGet;
let configSet;

beforeAll(async () => {
  backupConfig();
  ({ configGet, configSet } = await import("../src/a2a-config.mjs"));
});

afterEach(() => {
  restoreConfig();
});

describe("configGet", () => {
  test("throws for unknown keys that were never persisted", () => {
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

    expect(() => configGet("unknown")).toThrow(/unknown setting/);
  });

  test("reads back arbitrary keys persisted via configSet", () => {
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

    expect(configSet("customKnob", "enabled")).toBe("enabled");
    expect(configGet("customKnob")).toBe("enabled");
  });
});
