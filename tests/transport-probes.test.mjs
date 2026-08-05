import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/iterm2-delivery.mjs", () => ({
  pingITerm2Bridge: vi.fn(),
  listITerm2Sessions: vi.fn(),
}));

import { listITerm2Sessions, pingITerm2Bridge } from "../src/iterm2-delivery.mjs";
import {
  BRIDGE_REACHABLE_TTL_MS,
  ITERM_SESSIONS_TTL_MS,
  buildITermSessionCacheEntry,
  bridgeReachable,
  isA2aOwnedITermSession,
  itermGuidByName,
  itermGuidExists,
  itermSessionNameMatch,
  itermSessionNameMatches,
  resetTransportProbeCache,
  tmuxSessionAlive,
} from "../src/transport-probes.mjs";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

const DECORATED_DRIVER = "driver — ~/Documents/dev/a2a";

beforeEach(() => {
  vi.clearAllMocks();
  resetTransportProbeCache();
  vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: true, version: "0.3" });
  vi.mocked(listITerm2Sessions).mockResolvedValue({
    ok: true,
    sessions: [{ guid: "guid-driver", name: DECORATED_DRIVER }],
  });
});

describe("transport-probes — iTerm session name matching", () => {
  test("itermSessionNameMatch accepts iTerm-decorated session titles", async () => {
    expect(await itermSessionNameMatch("driver")).toBe(true);
  });

  test("session lookup lists once without a separate reachability ping", async () => {
    expect(await itermSessionNameMatch("driver")).toBe(true);
    expect(listITerm2Sessions).toHaveBeenCalledTimes(1);
    expect(pingITerm2Bridge).not.toHaveBeenCalled();
    expect(await bridgeReachable()).toBe(true);
    expect(pingITerm2Bridge).not.toHaveBeenCalled();
  });

  test("itermGuidByName resolves guid from decorated session title", async () => {
    expect(await itermGuidByName("driver")).toBe("guid-driver");
  });

  test("cached session indexes preserve first-match lookup semantics", async () => {
    vi.mocked(listITerm2Sessions).mockResolvedValue({
      ok: true,
      sessions: [
        {
          guid: "guid-first",
          name: "driver — ~/one",
          install_token: "token-one",
        },
        {
          guid: "guid-second",
          name: "driver — ~/two",
          install_token: "token-two",
        },
      ],
    });

    expect(await itermGuidByName("driver")).toBe("guid-first");
    expect(await itermGuidByName("driver — ~/one")).toBe("guid-first");
    expect(await itermGuidExists("guid-second")).toBe(true);
    expect(await isA2aOwnedITermSession("guid-first", "token-one")).toBe(true);
    expect(await isA2aOwnedITermSession("guid-second", "token-one")).toBe(false);
    expect(listITerm2Sessions).toHaveBeenCalledTimes(1);
  });

  test("decorated title does not match a different agent id", async () => {
    expect(await itermSessionNameMatch("other-agent")).toBe(false);
    expect(await itermGuidByName("other-agent")).toBeNull();
  });
});

// The pure matcher underneath every iTerm name->guid resolution. iTerm
// rewrites a session's `name` var to "<name><sep><pwd>" per the profile's
// title format, where <sep> is em-dash (U+2014), en-dash (U+2013), or ASCII
// hyphen, padded by ASCII space or NBSP (U+00A0). If this primitive regresses,
// agents silently become unreachable over iTerm even though the bridge is up.
// Pure function, no IO — asserted directly with the real decorated shapes.
describe("itermSessionNameMatches — decoration-tolerant name matcher", () => {
  test("exact, undecorated name matches", () => {
    expect(itermSessionNameMatches("driver", "driver")).toBe(true);
  });

  test("accepts every iTerm separator variant around the pwd", () => {
    expect(itermSessionNameMatches("driver — ~/Documents/dev/a2a", "driver")).toBe(true); // em-dash U+2014
    expect(itermSessionNameMatches("driver – ~/x", "driver")).toBe(true); // en-dash U+2013
    expect(itermSessionNameMatches("driver - ~/x", "driver")).toBe(true); // ASCII hyphen
    expect(itermSessionNameMatches("driver — ~/x", "driver")).toBe(true); // NBSP padding
  });

  test("name-boundary safe: a prefix of a longer agent id does not match", () => {
    // "driver" must NOT match the session for "driver-2" or "driver-mgr":
    // after the agent id the next char is '-', not whitespace, so the
    // separator rule fails.
    expect(itermSessionNameMatches("driver-2 — ~/x", "driver")).toBe(false);
    expect(itermSessionNameMatches("driver-mgr — ~/x", "driver")).toBe(false);
    expect(itermSessionNameMatches("driverfoo", "driver")).toBe(false);
  });

  test("anchored at start: a name appearing mid-title does not match", () => {
    expect(itermSessionNameMatches("my-driver — ~/x", "driver")).toBe(false);
  });

  test("regex metacharacters in the agent id are matched literally", () => {
    // Agent ids are treated as literal prefixes, so ".", "+", etc. never
    // gain pattern semantics.
    expect(itermSessionNameMatches("a.b — ~/x", "a.b")).toBe(true);
    expect(itermSessionNameMatches("axb — ~/x", "a.b")).toBe(false);
    expect(itermSessionNameMatches("c++ — ~/x", "c++")).toBe(true);
  });

  test("non-string session name never matches and never throws", () => {
    expect(itermSessionNameMatches(null, "driver")).toBe(false);
    expect(itermSessionNameMatches(undefined, "driver")).toBe(false);
    expect(itermSessionNameMatches(42, "driver")).toBe(false);
  });

  test("cache entry indexes decorated names and guids", () => {
    const entry = buildITermSessionCacheEntry(
      [
        { guid: "guid-a", name: "alpha — ~/x", installToken: "tok-a" },
        { guid: "guid-b", name: "alpha — ~/y", installToken: "tok-b" },
        { guid: "guid-c", name: "c++ — ~/z", installToken: "tok-c" },
      ],
      10_000,
    );
    expect(entry.guidByAgentName.get("alpha")).toBe("guid-a");
    expect(entry.guidByAgentName.get("alpha — ~/x")).toBe("guid-a");
    expect(entry.guidByAgentName.get("c++")).toBe("guid-c");
    expect(entry.sessionByGuid.get("guid-b")?.installToken).toBe("tok-b");
    expect(entry.expires).toBe(10_000 + ITERM_SESSIONS_TTL_MS);
  });
});

// Probes feed selectTransportForAgent which runs per-send inside the
// long-lived a2a-server. Process-lifetime caching made restarted agents 502
// forever and dead bridges look reachable; everything must be TTL-bounded.
describe("probe caching is TTL-bounded (long-lived server semantics)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a bridge that dies is re-detected once the success TTL expires", async () => {
    expect(await bridgeReachable()).toBe(true);
    vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: false, error: "down" });
    vi.advanceTimersByTime(BRIDGE_REACHABLE_TTL_MS + 1);
    expect(await bridgeReachable()).toBe(false);
  });

  test("bridge ping failures are never cached — a just-started bridge is seen immediately", async () => {
    vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: false, error: "down" });
    expect(await bridgeReachable()).toBe(false);
    vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: true, version: "0.3" });
    expect(await bridgeReachable()).toBe(true);
  });

  test("closed iTerm windows disappear from name/guid lookups after the session TTL", async () => {
    expect(await itermSessionNameMatch("driver")).toBe(true);
    expect(await itermGuidByName("driver")).toBe("guid-driver");
    vi.mocked(listITerm2Sessions).mockResolvedValue({ ok: true, sessions: [] });
    vi.advanceTimersByTime(ITERM_SESSIONS_TTL_MS + 1);
    expect(await itermSessionNameMatch("driver")).toBe(false);
    expect(await itermGuidByName("driver")).toBeNull();
  });

  test("newly opened iTerm windows are seen after the session TTL", async () => {
    vi.mocked(listITerm2Sessions).mockResolvedValue({ ok: true, sessions: [] });
    expect(await itermSessionNameMatch("newbie")).toBe(false);
    vi.mocked(listITerm2Sessions).mockResolvedValue({
      ok: true,
      sessions: [{ guid: "guid-newbie", name: "newbie — ~/x" }],
    });
    vi.advanceTimersByTime(ITERM_SESSIONS_TTL_MS + 1);
    expect(await itermSessionNameMatch("newbie")).toBe(true);
    expect(await itermGuidByName("newbie")).toBe("guid-newbie");
  });
});

describe.skipIf(!hasTmux)("tmuxSessionAlive — real tmux", () => {
  test("negative results are not cached: an agent spawned right after a probe is reachable", () => {
    const name = `a2a-probetest-${process.pid}-neg`;
    expect(tmuxSessionAlive(`${name}:0.0`)).toBe(false);
    const r = spawnSync("tmux", ["new-session", "-d", "-s", name, "sleep 30"]);
    expect(r.status).toBe(0);
    try {
      expect(tmuxSessionAlive(`${name}:0.0`)).toBe(true);
    } finally {
      spawnSync("tmux", ["kill-session", "-t", `=${name}`]);
    }
  });

  test("a dead session is not prefix-matched against a live sibling", () => {
    const base = `a2a-probetest-${process.pid}-px`;
    const r = spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      `${base}-worker`,
      "sleep 30",
    ]);
    expect(r.status).toBe(0);
    try {
      expect(tmuxSessionAlive(`${base}:0.0`)).toBe(false);
      expect(tmuxSessionAlive(`${base}-worker:0.0`)).toBe(true);
    } finally {
      spawnSync("tmux", ["kill-session", "-t", `=${base}-worker`]);
    }
  });
});
