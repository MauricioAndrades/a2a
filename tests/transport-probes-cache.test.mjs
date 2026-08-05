import { describe, expect, test } from "vitest";
import {
  BRIDGE_REACHABLE_TTL_MS,
  bridgeReachabilityCacheAfterPing,
  shouldCacheItermNameMatch,
} from "../src/transport-probes.mjs";

describe("transport-probes cache policy", () => {
  test("successful pings cache a TTL-bounded entry, not a forever flag", () => {
    const entry = bridgeReachabilityCacheAfterPing(null, true, 10_000);
    expect(entry).toEqual({ expires: 10_000 + BRIDGE_REACHABLE_TTL_MS });
  });

  test("failed pings never cache — even when a previous success entry exists", () => {
    expect(bridgeReachabilityCacheAfterPing(null, false, 0)).toBe(null);
    // A long-lived server must drop a stale success when the bridge dies;
    // "previous success wins forever" kept dead bridges looking reachable.
    expect(
      bridgeReachabilityCacheAfterPing({ expires: 9_999_999 }, false, 0),
    ).toBe(null);
  });

  test("iTerm name lookups cache only positive matches", () => {
    expect(shouldCacheItermNameMatch(false)).toBe(false);
    expect(shouldCacheItermNameMatch(true)).toBe(true);
  });
});
