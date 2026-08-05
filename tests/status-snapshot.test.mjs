import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildStatusSnapshot,
  formatHumanStatus,
  formatStatusSegment,
} from "../src/cli/status-snapshot.mjs";

test("empty healthy status hides the tmux segment", () => {
  const snapshot = buildStatusSnapshot({
    inventory: { registered: [], views: [], orphans: [] },
    generatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(snapshot.health, "ok");
  assert.equal(snapshot.counts.localAgents, 0);
  assert.equal(formatStatusSegment(snapshot), "");
});

test("status snapshot counts live, bridge-only, tmux-only, views, and attention", () => {
  const snapshot = buildStatusSnapshot({
    self: "builder",
    inventory: {
      registered: [
        {
          agentId: "builder",
          tmuxTarget: "builder:0.0",
          status: "live",
          cohort: "red",
          backend: "codex",
          yolo: true,
        },
        {
          agentId: "reviewer",
          tmuxTarget: "reviewer:0.0",
          status: "bridge-only",
          cohort: "red",
          backend: "claude",
          yolo: false,
        },
      ],
      views: [
        {
          session: "red-view",
          baseName: "red",
          known: true,
          existsInTmux: true,
          sources: ["tmux", "description"],
        },
        {
          session: "mystery-view",
          baseName: "mystery",
          known: false,
          existsInTmux: true,
          sources: ["tmux"],
        },
        {
          session: "absent-view",
          baseName: "absent",
          known: true,
          existsInTmux: false,
          sources: ["description"],
        },
      ],
      orphans: ["stray"],
    },
    generatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(snapshot.health, "warn");
  assert.deepEqual(snapshot.counts, {
    localAgents: 3,
    registeredAgents: 2,
    liveAgents: 1,
    bridgeOnlyAgents: 1,
    tmuxOnlyAgents: 1,
    views: 2,
    knownViews: 1,
    unknownViews: 1,
    peers: 0,
    remoteAgents: 0,
    peerErrors: 0,
    attention: 3,
  });
  assert.equal(snapshot.agents[0].self, true);
  assert.equal(snapshot.views.some((view) => view.session === "absent-view"), false);
  assert.equal(formatStatusSegment(snapshot), "a2a 1/3 2v !3");
});

test("bridge and peer failures surface as attention events", () => {
  const snapshot = buildStatusSnapshot({
    bridgeError: "list failed: connection refused",
    inventory: { registered: [], views: [], orphans: [] },
    peerSnapshots: [
      {
        peer: "dylan",
        url: "https://example.test",
        error: "unreachable",
        agents: [],
      },
      {
        peer: "casey",
        url: "https://casey.test",
        error: null,
        agents: [{ agentId: "remote-builder", cwd: "/tmp/x", yolo: true }],
      },
    ],
    generatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(snapshot.health, "error");
  assert.equal(snapshot.counts.peers, 2);
  assert.equal(snapshot.counts.remoteAgents, 1);
  assert.equal(snapshot.counts.peerErrors, 1);
  assert.equal(snapshot.counts.attention, 2);
  assert.equal(formatStatusSegment(snapshot), "a2a bridge down");
  assert.match(formatHumanStatus(snapshot), /peer-error dylan: unreachable/);
});
