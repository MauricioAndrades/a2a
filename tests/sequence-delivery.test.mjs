// Regression tests for sequence-delivery against real tmux sessions.
// Transport selection runs for real (per-recipient probes); the iTerm side
// is simply not viable for these uniquely-named throwaway agents.
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  buildTmuxOperationBatches,
  deliverSequenceViaActiveProtocol,
} from "../src/sequence-delivery.mjs";
import { resetTransportProbeCache } from "../src/transport-probes.mjs";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const BASE = `a2a-seqtest-${process.pid}`;
const created = [];

function newSession(name, command) {
  const r = spawnSync("tmux", ["new-session", "-d", "-s", name, command]);
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr?.toString()}`);
  }
  created.push(name);
}

function capturePane(name) {
  const r = spawnSync("tmux", [
    "capture-pane",
    "-t",
    `=${name}:0.0`,
    "-p",
    "-S",
    "-30",
  ]);
  return (r.stdout || "").toString();
}

afterAll(() => {
  for (const name of created) {
    spawnSync("tmux", ["kill-session", "-t", `=${name}`]);
  }
});

beforeEach(() => {
  resetTransportProbeCache();
});

test("buildTmuxOperationBatches combines adjacent compatible operations", () => {
  expect(
    buildTmuxOperationBatches([
      { kind: "type", text: "/model" },
      { kind: "type", text: " sonnet" },
      { kind: "key", key: "ENTER" },
      { kind: "key", key: "ESC" },
      { kind: "sleep", ms: 25 },
      { kind: "paste", text: "body" },
      { kind: "key", key: "ENTER" },
    ]),
  ).toEqual([
    { kind: "type", text: "/model sonnet" },
    { kind: "keys", keys: ["Enter", "Escape"], bytes: 11 },
    { kind: "sleep", ms: 25 },
    { kind: "paste", text: "body" },
    { kind: "keys", keys: ["Enter"], bytes: 5 },
  ]);
});

describe.skipIf(!hasTmux)("deliverSequenceViaActiveProtocol — real tmux", () => {
  test("type ops starting with '-' are sent literally, not parsed as flags", async () => {
    newSession(`${BASE}-lit`, "cat");
    const result = await deliverSequenceViaActiveProtocol({
      agentName: `${BASE}-lit`,
      tmuxTarget: `${BASE}-lit:0.0`,
      ops: [
        { kind: "type", text: "--dash-flag literal" },
        { kind: "key", key: "ENTER" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("tmux");
    expect(capturePane(`${BASE}-lit`)).toContain("--dash-flag literal");
  });

  test("a dead agent with a live -worker sibling fails with transport 'none' and leaks nothing", async () => {
    newSession(`${BASE}-px-worker`, "cat");
    const result = await deliverSequenceViaActiveProtocol({
      agentName: `${BASE}-px`,
      tmuxTarget: `${BASE}-px:0.0`,
      ops: [
        { kind: "type", text: "leaked into sibling" },
        { kind: "key", key: "ENTER" },
      ],
    });
    // The dead `-px` session must not prefix-match `-px-worker`...
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no viable transport/);
    // ...the error must not claim a transport that was never attempted...
    expect(result.transport).toBe("none");
    // ...and nothing may have been typed into the sibling's pane.
    expect(capturePane(`${BASE}-px-worker`)).not.toContain(
      "leaked into sibling",
    );
  });
});
