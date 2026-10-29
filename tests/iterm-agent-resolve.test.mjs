import { test } from "vitest";
import assert from "node:assert/strict";
import {
  resolveLiveItermGuid,
  resolveLiveItermTarget,
} from "../src/iterm-agent-resolve.mjs";

const agent = {
  agentId: "alpha-mgr",
  itermGuid: "C56465FD-6AF3-4C08-A5F4-D413ED0FC2C6",
};

test("resolveLiveItermGuid prefers live name lookup over stale registry guid", async () => {
  const liveGuid = "NEW-GUID-1111-2222-3333-444444444444";
  let reregistered = null;
  const guid = await resolveLiveItermGuid(agent, {
    probeBridgeReachable: () => Promise.resolve(true),
    itermGuidByName: (name) =>
      Promise.resolve(name === "alpha-mgr" ? liveGuid : null),
    reregisterItermAgent: (a, registeredGuid) => {
      reregistered = { agentId: a.agentId, guid: registeredGuid };
      return Promise.resolve();
    },
  });
  assert.equal(guid, liveGuid);
  assert.deepEqual(reregistered, { agentId: "alpha-mgr", guid: liveGuid });
});

test("resolveLiveItermGuid returns stored guid when bridge is down", async () => {
  const guid = await resolveLiveItermGuid(agent, {
    probeBridgeReachable: () => Promise.resolve(false),
    itermGuidByName: () => Promise.resolve("SHOULD-NOT-BE-USED"),
  });
  assert.equal(guid, agent.itermGuid);
});

test("resolveLiveItermTarget exposes the bridge reachability decision", async () => {
  let lookupCount = 0;
  const target = await resolveLiveItermTarget(agent, {
    probeBridgeReachable: () => Promise.resolve(false),
    itermGuidByName: () => {
      lookupCount++;
      return Promise.resolve("SHOULD-NOT-BE-USED");
    },
  });
  assert.deepEqual(target, {
    guid: agent.itermGuid,
    bridgeReachable: false,
  });
  assert.equal(lookupCount, 0);
});

test("resolveLiveItermGuid returns null when no live session and no stored guid", async () => {
  const guid = await resolveLiveItermGuid(
    { agentId: "alpha-mgr" },
    {
      probeBridgeReachable: () => Promise.resolve(true),
      itermGuidByName: () => Promise.resolve(null),
    },
  );
  assert.equal(guid, null);
});

test("resolveLiveItermGuid skips reregister when live guid matches stored guid", async () => {
  let reregistered = false;
  const guid = await resolveLiveItermGuid(agent, {
    probeBridgeReachable: () => Promise.resolve(true),
    itermGuidByName: () => Promise.resolve(agent.itermGuid),
    reregisterItermAgent: () => {
      reregistered = true;
      return Promise.resolve();
    },
  });
  assert.equal(guid, agent.itermGuid);
  assert.equal(reregistered, false);
});
