import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/iterm2-delivery.mjs", () => ({
  pingITerm2Bridge: vi.fn(),
  listITerm2Sessions: vi.fn(),
  deliverITerm2Input: vi.fn(),
}));

import { listITerm2Sessions, pingITerm2Bridge } from "../src/iterm2-delivery.mjs";
import {
  itermGuidByName,
  resetTransportProbeCache,
} from "../src/transport-probes.mjs";
import {
  deliverViaActiveProtocol,
  resolveITerm2GuidByName,
  selectTransportForAgent,
} from "../src/transport-router.mjs";

const DECORATED_DRIVER = "driver — ~/Documents/dev/a2a";

beforeEach(() => {
  vi.clearAllMocks();
  resetTransportProbeCache();
  vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: true, version: "0.3" });
});

describe("resolveITerm2GuidByName", () => {
  test("returns guid when cached probe is empty but fresh list has decorated title", async () => {
    let listCalls = 0;
    vi.mocked(listITerm2Sessions).mockImplementation(() => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({ ok: true, sessions: [] });
      }
      return Promise.resolve({
        ok: true,
        sessions: [{ guid: "guid-driver", name: DECORATED_DRIVER }],
      });
    });

    // Prime the probe cache with an empty session list.
    expect(await itermGuidByName("driver")).toBeNull();
    expect(listCalls).toBe(1);

    const result = await resolveITerm2GuidByName("driver");

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({ guid: "guid-driver" });
  });
});

// The registry can hold a guid for an iTerm window that no longer exists
// (window closed, iTerm restarted). Trusting it whenever the bridge is up
// fails delivery with "unknown session" instead of falling through — the
// transparent fall-through the module header promises.
describe("selectTransportForAgent — stale registry guid", () => {
  test("tmux-preferred live tmux agents skip iTerm bridge probing", async () => {
    const bridgeReachable = vi.fn();
    const pick = await selectTransportForAgent({
      agentId: `a2a-routertest-${process.pid}-tmux-fast`,
      tmuxTarget: `a2a-routertest-${process.pid}-tmux-fast:0.0`,
    }, {
      bridgeReachable,
      tmuxSessionAlive: () => true,
    });

    expect(pick.transport).toBe("tmux");
    expect(bridgeReachable).not.toHaveBeenCalled();
  });

  test("a registry guid missing from the bridge session list is dropped", async () => {
    vi.mocked(listITerm2Sessions).mockResolvedValue({ ok: true, sessions: [] });

    const pick = await selectTransportForAgent({
      agentId: `a2a-routertest-${process.pid}-ghost`,
      itermGuid: "stale-guid-123",
    });

    // No live iTerm session and no tmux target: nothing is viable. Before
    // validation, the stale guid made this pick "iterm" and delivery died
    // with "unknown session".
    expect(pick.transport).toBeNull();
    expect(pick.itermGuid).toBeNull();
  });

  test("a registry guid present on the bridge stays viable", async () => {
    vi.mocked(listITerm2Sessions).mockResolvedValue({
      ok: true,
      sessions: [{ guid: "live-guid", name: "anything" }],
    });

    const pick = await selectTransportForAgent({
      agentId: `a2a-routertest-${process.pid}-live`,
      itermGuid: "live-guid",
    });

    expect(pick.transport).toBe("iterm");
    expect(pick.itermGuid).toBe("live-guid");
  });

  test("agents without registry guids resolve name directly to guid", async () => {
    const itermGuidByNameProbe = vi.fn().mockResolvedValue("guid-driver");
    const itermSessionNameMatchProbe = vi.fn().mockResolvedValue(true);

    const pick = await selectTransportForAgent(
      { agentId: `a2a-routertest-${process.pid}-by-name` },
      {
        bridgeReachable: () => Promise.resolve(true),
        itermGuidByName: itermGuidByNameProbe,
        itermSessionNameMatch: itermSessionNameMatchProbe,
        tmuxSessionAlive: () => false,
      },
    );

    expect(pick.transport).toBe("iterm");
    expect(pick.itermGuid).toBe("guid-driver");
    expect(itermGuidByNameProbe).toHaveBeenCalledWith(
      `a2a-routertest-${process.pid}-by-name`,
    );
    expect(itermSessionNameMatchProbe).not.toHaveBeenCalled();
  });
});

describe("deliverViaActiveProtocol — no viable transport", () => {
  test("reports transport 'none' instead of the unattempted preference", async () => {
    vi.mocked(pingITerm2Bridge).mockResolvedValue({ ok: false, error: "down" });

    const result = await deliverViaActiveProtocol({
      agentName: `a2a-routertest-${process.pid}-nothing`,
      content: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no viable transport/);
    // Nothing was attempted, so claiming "via tmux"/"via iterm" would be a
    // lie that callers render into misleading failure messages.
    expect(result.transport).toBe("none");
  });
});
