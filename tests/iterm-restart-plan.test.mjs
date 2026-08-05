import { expect, test } from "vitest";
import { resolveItermRestartSession } from "../src/cli/iterm-restart-plan.mjs";

test("restart plan returns immediately when the stored iTerm guid is live", () => {
  expect(
    resolveItermRestartSession(
      { agentId: "bob", itermGuid: " guid-live " },
      [
        { guid: "guid-live", name: "something else" },
        { guid: "guid-bob", name: "bob - ~/repo" },
      ],
    ),
  ).toEqual({ storedGuidLive: true, liveGuid: "guid-live" });
});

test("restart plan finds a same-name live iTerm session when the stored guid is stale", () => {
  expect(
    resolveItermRestartSession(
      { agentId: "bob", itermGuid: "guid-stale" },
      [
        { guid: "guid-other", name: "alice" },
        { guid: "guid-bob", name: "bob - ~/repo" },
      ],
    ),
  ).toEqual({ storedGuidLive: false, liveGuid: "guid-bob" });
});

test("restart plan ignores malformed session lists", () => {
  expect(
    resolveItermRestartSession(
      { agentId: "bob", itermGuid: "guid-stale" },
      null,
    ),
  ).toEqual({ storedGuidLive: false, liveGuid: null });
  expect(
    resolveItermRestartSession({ agentId: "bob", itermGuid: "guid-stale" }, [
      null,
      { guid: "", name: "bob" },
      { guid: "guid-other", name: null },
    ]),
  ).toEqual({ storedGuidLive: false, liveGuid: null });
});
