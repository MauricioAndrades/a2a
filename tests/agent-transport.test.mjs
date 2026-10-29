import { describe, expect, test } from "vitest";
import {
  isAgentSessionAlive,
  shouldReviveAgentInTmux,
} from "../src/agent-transport.mjs";

describe("shouldReviveAgentInTmux", () => {
  test("returns false for iTerm-backed local agents", () => {
    expect(
      shouldReviveAgentInTmux({
        agentId: "bob",
        itermGuid: "guid-abc",
        tmuxTarget: null,
      }),
    ).toBe(false);
  });

  test("returns false for remote bridge agents", () => {
    expect(
      shouldReviveAgentInTmux({
        agentId: "remote",
        bridgeUrl: "http://127.0.0.1:9000",
        tmuxTarget: "remote:0.0",
      }),
    ).toBe(false);
  });

  test("returns true for tmux-only local agents", () => {
    expect(
      shouldReviveAgentInTmux({
        agentId: "bob",
        tmuxTarget: "bob:0.0",
      }),
    ).toBe(true);
  });

  test("whitespace-only itermGuid does not suppress tmux revive", () => {
    expect(
      shouldReviveAgentInTmux({
        agentId: "bob",
        itermGuid: "   ",
        tmuxTarget: "bob:0.0",
      }),
    ).toBe(true);
  });
});

describe("isAgentSessionAlive", () => {
  test("true when stored iTerm guid is present on the bridge", async () => {
    let nameChecks = 0;
    await expect(
      isAgentSessionAlive(
        { agentId: "bob", itermGuid: "guid-1" },
        {
          bridgeReachable: () => Promise.resolve(true),
          listITermSessions: () => Promise.resolve([{ guid: "guid-1", name: "bob" }]),
          itermSessionIsAgent: () => {
            nameChecks += 1;
            return false;
          },
          tmuxSessionAlive: () => false,
        },
      ),
    ).resolves.toBe(true);
    expect(nameChecks).toBe(0);
  });

  test("true when iTerm name fallback matches a live bridge session", async () => {
    let tmuxChecks = 0;
    await expect(
      isAgentSessionAlive(
        { agentId: "bob", itermGuid: "stale-guid", tmuxTarget: "bob:0.0" },
        {
          bridgeReachable: () => Promise.resolve(true),
          listITermSessions: () =>
            Promise.resolve([{ guid: "guid-2", name: "bob - ~/repo" }]),
          itermSessionIsAgent: (session, agentId) =>
            session.name === "bob - ~/repo" && agentId === "bob",
          tmuxSessionAlive: () => {
            tmuxChecks += 1;
            return true;
          },
        },
      ),
    ).resolves.toBe(true);
    expect(tmuxChecks).toBe(0);
  });

  test("true for tmux-only agent when tmux session is alive", async () => {
    await expect(
      isAgentSessionAlive(
        { agentId: "bob", tmuxTarget: "bob:0.0" },
        {
          bridgeReachable: () => Promise.resolve(false),
          listITermSessions: () => Promise.resolve([]),
          itermSessionIsAgent: () => false,
          tmuxSessionAlive: () => true,
        },
      ),
    ).resolves.toBe(true);
  });
});


test("live tmux-only agents do not probe iTerm", async () => {
  let pings = 0;
  const alive = await isAgentSessionAlive({ agentId: "alpha" }, {
    tmuxSessionAlive: () => true,
    bridgeReachable: () => { pings++; return Promise.resolve(true); },
    listITermSessions: () => Promise.resolve([]),
    itermSessionIsAgent: () => false,
  });
  expect(alive).toBe(true);
  expect(pings).toBe(0);
});

test("failed optional iTerm probes still allow a live tmux fallback", async () => {
  const alive = await isAgentSessionAlive({ agentId: "alpha", itermGuid: "old" }, {
    tmuxSessionAlive: () => true,
    bridgeReachable: () => Promise.resolve(true),
    listITermSessions: () => Promise.reject(new Error("bridge disconnected")),
    itermSessionIsAgent: () => false,
  });
  expect(alive).toBe(true);
});

test("tmux started while an iTerm probe was pending is detected on the final check", async () => {
  let tmuxLive = false;
  const alive = await isAgentSessionAlive({ agentId: "alpha" }, {
    tmuxSessionAlive: () => tmuxLive,
    bridgeReachable: () => { tmuxLive = true; return Promise.resolve(false); },
    listITermSessions: () => Promise.resolve([]),
    itermSessionIsAgent: () => false,
  });
  expect(alive).toBe(true);
});
