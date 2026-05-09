import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("config persists primitive and log settings in isolated HOME", async () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "a2a-home-"));
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
