import { test } from "vitest";
import assert from "node:assert/strict";
import { buildSessionInventory } from "../src/cli/session-inventory.mjs";


test("registered aliases use their actual tmux sessions for liveness and orphan exclusion", () => {
  const inventory = buildSessionInventory({
    registeredAgents: [{ agentId: "alias", tmuxTarget: "=actual:3.2" }],
    tmuxSessions: ["actual"],
    isA2aOwnedSession: () => true,
  });
  assert.equal(inventory.registered[0].status, "live");
  assert.deepEqual(inventory.orphans, []);
});

test("registered iTerm GUIDs are not orphans after the user renames their windows", () => {
  const inventory = buildSessionInventory({
    registeredAgents: [{ agentId: "alias", itermGuid: "stable-guid" }],
    itermSessions: [{ guid: "stable-guid", name: "renamed window" }],
    isA2aOwnedITermSession: () => true,
  });
  assert.deepEqual(inventory.itermOrphans, []);
});

test("a view already known from registration skips filesystem team discovery", () => {
  let discoveries = 0;
  const inventory = buildSessionInventory({
    registeredAgents: [{ agentId: "alpha", description: "team:ops" }],
    tmuxSessions: ["ops-view"],
    isGroup: () => { discoveries++; return false; },
    loadResolvedTeamSpec: () => { discoveries++; return null; },
  });
  assert.equal(discoveries, 0);
  assert.deepEqual(inventory.views[0].sources, ["description", "tmux"]);
});
