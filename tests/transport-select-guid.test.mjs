import { describe, expect, test } from "vitest";
import {
  pickTransport,
  viableItermGuid,
} from "../src/transport-select.mjs";

describe("viableItermGuid", () => {
  test("rejects empty and whitespace-only guids", () => {
    expect(viableItermGuid("")).toBe(false);
    expect(viableItermGuid("   ")).toBe(false);
    expect(viableItermGuid("\t")).toBe(false);
  });

  test("accepts non-empty trimmed guids", () => {
    expect(viableItermGuid("abc-123")).toBe(true);
    expect(viableItermGuid("  guid-with-space  ")).toBe(true);
  });
});

describe("pickTransport — whitespace guid handling", () => {
  test("whitespace-only itermGuid is not viable by itself", () => {
    expect(
      pickTransport({
        agent: { itermGuid: "   ", tmuxTarget: "bob:0.0" },
        preference: "iterm",
        bridgeReachable: true,
        itermNameMatch: false,
        tmuxSessionAlive: true,
      }),
    ).toBe("tmux");
  });

  test("whitespace guid does not block iterm name-match fallback", () => {
    expect(
      pickTransport({
        agent: { agentId: "bob", itermGuid: "  " },
        preference: "iterm",
        bridgeReachable: true,
        itermNameMatch: true,
        tmuxSessionAlive: false,
      }),
    ).toBe("iterm");
  });
});
