import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { truncateRotatedMessageLogTail } from "../src/a2a-config.mjs";

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

    const safe = truncateRotatedMessageLogTail(buf, maxBytes);
    assert.doesNotThrow(() => td.decode(safe));
    assert.ok(safe.length <= maxBytes);
});

test("truncateRotatedMessageLogTail drops partial leading header line after rotation window", () => {
    /** Two canonical entries; slicing so only middle of header is in window yields garbage prefix */
    const a = `[2026-05-01T00:00:00.001Z] a -> b  message/user  -  ok\n`;
    const b = `[2026-05-02T12:34:56.789Z] c -> d  reply/peer  3B  ok\n`;
    const garbled = `:00:00.001Z] noise\n`;
    const buf = Buffer.from(a + garbled + b + "trail", "utf8");
    const maxBytes = Buffer.byteLength(b + "trail", "utf8");
    const truncated = truncateRotatedMessageLogTail(buf, maxBytes);
    assert.equal(truncated.toString("utf8"), b + "trail");
});

test("isGroup / listGroupMembers reject .. path segments (no traversal out of groups dir)", async () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(join(tmpdir(), "a2a-grp-"));
    process.env.HOME = home;
    try {
        const mod = await import(`../src/a2a-config.mjs?grp=${Date.now()}`);
        const groups = join(home, ".claude/skills/a2a/groups");
        fs.mkdirSync(join(groups, "squad"), { recursive: true });
        fs.writeFileSync(join(groups, "squad", "roger.md"), "roger\n");
        assert.equal(mod.isGroup("squad"), true);
        assert.equal(mod.listGroupMembers("squad").length, 1);
        assert.equal(mod.isGroup(".."), false);
        assert.equal(mod.isGroup("../skills"), false);
        const grpRoot = resolve(groups);
        const grpPref = grpRoot.endsWith(sep) ? grpRoot : grpRoot + sep;
        const ost = fs.statSync;
        /** @type {string[]} */
        const outsidePaths = [];
        fs.statSync = (pathLike, opts) => {
            const rp = resolve(String(pathLike));
            if (rp !== grpRoot && !rp.startsWith(grpPref)) outsidePaths.push(rp);
            return ost(pathLike, opts);
        };
        try {
            assert.equal(mod.isGroup("../foo"), false);
            assert.deepEqual(outsidePaths, [], "traversal probes must not stat outside the groups dir");
        } finally {
            fs.statSync = ost;
        }
        assert.equal(mod.isGroup("squad/../.."), false);
        assert.deepEqual(mod.listGroupMembers(".."), []);
        assert.deepEqual(mod.listGroupMembers("squad/../.."), []);
    } finally {
        process.env.HOME = originalHome;
    }
});

test("config persists primitive and log settings in isolated HOME", async () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(join(tmpdir(), "a2a-home-"));
    process.env.HOME = home;
    try {
        const mod = await import(`../src/a2a-config.mjs?case=${Date.now()}`);
        mod.configSet("port", "9999");
        mod.configSet("host", "127.0.0.2");
        mod.configSet("log.mode", "off");
        mod.configSet("log.maxBytes", "12");
        mod.configSet("log.redactRemote", "true");
        assert.equal(mod.configGet("port"), 9999);
        assert.equal(mod.configGet("host"), "127.0.0.2");
        assert.equal(mod.configGet("log.mode"), "off");
        assert.equal(mod.configGet("log.maxBytes"), 12);
        assert.equal(mod.configGet("log.redactRemote"), true);
    } finally {
        process.env.HOME = originalHome;
    }
});
