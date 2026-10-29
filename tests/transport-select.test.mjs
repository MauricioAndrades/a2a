import { describe, expect, test } from "vitest";
import { explainPick, pickTransport } from "../src/transport-select.mjs";

describe("pickTransport — capability matrix", () => {
  test("only iterm viable → iterm regardless of preference", () => {
    const inputs = {
      agent: { agentId: "bob", itermGuid: "guid-1" },
      preference: "tmux",
      bridgeReachable: true,
      itermNameMatch: false,
      tmuxSessionAlive: false,
    };
    expect(pickTransport(inputs)).toBe("iterm");
  });

  test("only tmux viable → tmux regardless of preference", () => {
    const inputs = {
      agent: { agentId: "bob", tmuxTarget: "bob:0.0" },
      preference: "iterm",
      bridgeReachable: false,
      itermNameMatch: false,
      tmuxSessionAlive: true,
    };
    expect(pickTransport(inputs)).toBe("tmux");
  });

  test("both viable → preference wins", () => {
    const both = {
      agent: { agentId: "bob", itermGuid: "g", tmuxTarget: "bob:1.1" },
      bridgeReachable: true,
      itermNameMatch: true,
      tmuxSessionAlive: true,
    };
    expect(pickTransport({ ...both, preference: "iterm" })).toBe("iterm");
    expect(pickTransport({ ...both, preference: "tmux" })).toBe("tmux");
  });

  test("neither viable → null", () => {
    const inputs = {
      agent: { agentId: "bob" },
      preference: "iterm",
      bridgeReachable: false,
      itermNameMatch: false,
      tmuxSessionAlive: false,
    };
    expect(pickTransport(inputs)).toBeNull();
  });

  test("iterm name-match without guid still counts as viable", () => {
    const inputs = {
      agent: { agentId: "bob" }, // no guid
      preference: "iterm",
      bridgeReachable: true,
      itermNameMatch: true,
      tmuxSessionAlive: false,
    };
    expect(pickTransport(inputs)).toBe("iterm");
  });

  test("bridge unreachable + no guid + no tmux → null", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", tmuxTarget: "bob:0.0" },
        preference: "iterm",
        bridgeReachable: false,
        itermNameMatch: false,
        tmuxSessionAlive: false, // pane is dead
      }),
    ).toBeNull();
  });

  test("transparent fall-through: iterm preference + tmux-only live agent → tmux", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", tmuxTarget: "bob:0.0" },
        preference: "iterm",
        bridgeReachable: false,
        itermNameMatch: false,
        tmuxSessionAlive: true,
      }),
    ).toBe("tmux");
  });

  test("transparent fall-through: tmux preference + iterm-only live agent → iterm", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", itermGuid: "g" },
        preference: "tmux",
        bridgeReachable: true,
        itermNameMatch: false,
        tmuxSessionAlive: false,
      }),
    ).toBe("iterm");
  });

  test("placeholder tmux does not compete when iTerm path is viable", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", itermGuid: "g", tmuxTarget: "bob:0.0" },
        preference: "tmux",
        bridgeReachable: true,
        itermNameMatch: false,
        tmuxSessionAlive: true,
      }),
    ).toBe("iterm");
  });

  test("placeholder tmux falls through when iTerm is dead", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", itermGuid: "g", tmuxTarget: "bob:0.0" },
        preference: "iterm",
        bridgeReachable: false,
        itermNameMatch: false,
        tmuxSessionAlive: true,
      }),
    ).toBe("tmux");
  });
});

describe("explainPick", () => {
  test("annotates picked transport", () => {
    expect(
      explainPick({
        agent: { agentId: "bob", itermGuid: "g" },
        preference: "iterm",
        bridgeReachable: true,
        itermNameMatch: false,
        tmuxSessionAlive: false,
      }),
    ).toMatch(/picked iterm/);
  });

  test("explains why nothing is viable", () => {
    const s = explainPick({
      agent: { agentId: "bob", tmuxTarget: "bob:0.0" },
      preference: "iterm",
      bridgeReachable: false,
      itermNameMatch: false,
      tmuxSessionAlive: false,
    });
    expect(s).toMatch(/no viable transport/);
    expect(s).toMatch(/bridge unreachable/);
    expect(s).toMatch(/bob:0\.0 is dead/);
  });
});
