import test from "node:test";
import assert from "node:assert/strict";
import { resolveReconnectTargets } from "../src/cli/reconnect-targets.mjs";

const base = {
    isGroup: () => false,
    listGroupMembers: () => [],
    loadResolvedTeamSpec: () => null,
    tmuxListSessions: () => ["bob", "leah", "ops-view"],
    loadRegistry: () => ({ agents: ["leah"] }),
};

test("explicit name resolves to that target", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: "bob", hasAll: false }), { targets: ["bob"], viewSession: null });
});

test("--all resolves all live non-view sessions", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: null, hasAll: true }), { targets: ["bob", "leah"], viewSession: "a2a-view" });
});

test("no name prefers cached live agents", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: null, hasAll: false }), { targets: ["leah"], viewSession: null });
});

test("group name resolves group members and view", () => {
    const result = resolveReconnectTargets({
        ...base,
        name: "squad",
        isGroup: (name) => name === "squad",
        listGroupMembers: () => [{ name: "a" }, { name: "b" }],
    });
    assert.deepEqual(result, { targets: ["a", "b"], viewSession: "squad-view" });
});
