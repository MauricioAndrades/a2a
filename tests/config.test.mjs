import { test } from "vitest";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as configModule from "../src/a2a-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const groupsDir = join(repoRoot, "groups");
const configPath = join(repoRoot, "config.json");
const backupRoot = mkdtempSync(join(tmpdir(), "a2a-config-node-test-"));
const trackedPaths = [groupsDir, configPath];

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

function cleanConfigArtifacts() {
  rmSync(groupsDir, { recursive: true, force: true });
  rmSync(configPath, { force: true });
}

backupTrackedPaths();

test("truncateRotatedMessageLogTail avoids splitting UTF-8 codepoints at maxBytes boundary", () => {
  const td = new TextDecoder("utf8", { fatal: true });
  const emoji = Buffer.from([0xf0, 0x9f, 0x98, 0x80]); // U+1F600
  /** Suffix after emoji so tail window starts on a UTF-8 continuation byte */
  const buf = Buffer.concat([
    Buffer.from("A".repeat(10)),
    emoji,
    Buffer.from("B".repeat(27)),
  ]);
  const maxBytes = 30;
  assert.equal(buf.length, 41);
  const naive = buf.subarray(buf.length - maxBytes);
  assert.throws(() => td.decode(naive));

  const safe = configModule.truncateRotatedMessageLogTail(buf, maxBytes);
  assert.doesNotThrow(() => td.decode(safe));
  assert.ok(safe.length <= maxBytes);
});

test("truncateRotatedMessageLogTail drops partial leading header line after rotation window", () => {
  /** Two canonical entries; slicing so only middle of header is in window yields garbage prefix */
  const a = `[2026-05-01T00:00:00.001Z] a -> b  message/user  -  ok\n`;
  const b = `[2026-05-02T12:34:56.789Z] c -> d  reply/peer  3B  ok\n`;
  const garbled = `:00:00.001Z] noise\n`;
  const buf = Buffer.from(`${a + garbled + b  }trail`, "utf8");
  const maxBytes = Buffer.byteLength(`${b  }trail`, "utf8");
  const truncated = configModule.truncateRotatedMessageLogTail(buf, maxBytes);
  assert.equal(truncated.toString("utf8"), `${b  }trail`);
});

test("isGroup / listGroupMembers reject .. path segments (no traversal out of groups dir)", () => {
  try {
    cleanConfigArtifacts();
    mkdirSync(join(groupsDir, "squad"), { recursive: true });
    writeFileSync(join(groupsDir, "squad", "roger.md"), "roger\n");
    assert.equal(configModule.isGroup("squad"), true);
    assert.equal(configModule.listGroupMembers("squad").length, 1);
    assert.equal(configModule.isGroup(".."), false);
    assert.equal(configModule.isTrustedGroupPathSegment("../foo"), false);
    assert.equal(configModule.isGroup("../foo"), false);
    assert.equal(configModule.isGroup("../skills"), false);
    assert.deepEqual(configModule.listGroupMembers(".."), []);
    assert.deepEqual(configModule.listGroupMembers("squad/../.."), []);
  } finally {
    restoreTrackedPaths();
  }
});

test("config persists primitive and log settings in repo-local config artifacts", () => {
  try {
    cleanConfigArtifacts();
    configModule.configSet("port", "9999");
    configModule.configSet("host", "127.0.0.2");
    configModule.configSet("log.mode", "off");
    configModule.configSet("log.maxBytes", "12");
    configModule.configSet("log.redactRemote", "true");
    assert.equal(configModule.configGet("port"), 9999);
    assert.equal(configModule.configGet("host"), "127.0.0.2");
    assert.equal(configModule.configGet("log.mode"), "off");
    assert.equal(configModule.configGet("log.maxBytes"), 12);
    assert.equal(configModule.configGet("log.redactRemote"), true);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).port, 9999);
  } finally {
    restoreTrackedPaths();
  }
});

process.on("exit", () => {
  restoreTrackedPaths();
  rmSync(backupRoot, { recursive: true, force: true });
});
