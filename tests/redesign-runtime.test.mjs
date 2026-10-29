import { test } from "vitest";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { buildStatusSnapshot } from "../src/cli/status-snapshot.mjs";
import {
  buildAttentionStack,
  buildDoctorSnapshot,
  buildItermAttachScript,
  buildLayoutPlan,
  buildPmWorkerSpec,
  buildReloadPlan,
  buildRuntimeEvents,
  dumpTeamSpec,
  formatAttentionStack,
  formatDoctorSnapshot,
  formatLayoutPlan,
  formatReloadPlan,
  formatRuntimeEvents,
  maskConfig,
} from "../src/cli/redesign-runtime.mjs";

test("runtime events and attention stack project status snapshot facts", () => {
  const snapshot = buildStatusSnapshot({
    bridgeError: "connection refused",
    generatedAt: "2026-06-03T00:00:00.000Z",
    inventory: {
      registered: [
        {
          agentId: "builder",
          status: "bridge-only",
          cohort: "red",
          backend: "codex",
          yolo: true,
        },
      ],
      views: [
        {
          session: "mystery-view",
          baseName: "mystery",
          known: false,
          existsInTmux: true,
          sources: ["tmux"],
        },
      ],
      orphans: ["stray"],
    },
  });

  const events = buildRuntimeEvents(snapshot);
  assert.ok(events.some((entry) => entry.type === "bridge.error"));
  assert.ok(events.some((entry) => entry.type === "agent.status"));
  assert.ok(events.some((entry) => entry.type === "agent.tmux-only"));
  assert.ok(events.some((entry) => entry.type === "view.status"));
  assert.ok(events.some((entry) => entry.type === "attention"));
  assert.equal(events[0].sequence, 1);
  assert.match(formatRuntimeEvents(events), /bridge\.error/);

  const stack = buildAttentionStack(snapshot);
  assert.deepEqual(
    stack.map((item) => item.kind),
    ["bridge-error", "bridge-only", "tmux-only", "unknown-view"],
  );
  assert.match(formatAttentionStack(stack), /#1 error bridge-error bridge/);
});

test("layout plan validates nested flex trees and reports drift", () => {
  const teamSpec = {
    name: "ops",
    agents: [{ id: "pm" }, { id: "worker-1" }, { id: "worker-2" }],
  };

  const valid = buildLayoutPlan(teamSpec, {
    direction: "row",
    panes: [
      { agent: "pm", flex: 2, focus: true },
      {
        direction: "column",
        panes: [{ agent: "worker-1" }, { agent: "worker-2", zoom: true }],
      },
    ],
  });

  assert.equal(valid.valid, true);
  assert.equal(valid.leaves.length, 3);
  assert.match(formatLayoutPlan(valid), /agent=pm flex=2 focus/);

  const duplicate = buildLayoutPlan(teamSpec, {
    direction: "row",
    panes: [{ agent: "pm" }, { agent: "pm" }, { agent: "pm" }],
  });
  assert.equal(duplicate.valid, false);
  assert.deepEqual(duplicate.missing, ["worker-1", "worker-2"]);
  assert.deepEqual(duplicate.duplicateAgents, ["pm"]);

  assert.throws(
    () =>
      buildLayoutPlan(teamSpec, {
        direction: "row",
        panes: [{ agent: "missing" }],
      }),
    /unknown agent 'missing'/,
  );
});

test("reload plan separates safe additions from unsafe team reshapes", () => {
  const teamSpec = {
    name: "ops",
    agents: [
      { id: "pm", backend: "claude", cwd: "/repo", yolo: true },
      { id: "worker-1", backend: "codex", cwd: "/repo", yolo: true },
    ],
  };

  const additive = buildReloadPlan(teamSpec, [
    {
      agentId: "pm",
      description: "team:ops",
      backend: "claude",
      cwd: "/repo",
      yolo: true,
    },
  ]);
  assert.equal(additive.safeToApply, true);
  assert.deepEqual(additive.safeAdds.map((change) => change.agent), ["worker-1"]);
  assert.match(formatReloadPlan(additive), /safe\s+add-agent/);

  const unsafe = buildReloadPlan(teamSpec, [
    {
      agentId: "pm",
      description: "team:ops",
      backend: "gemini",
      cwd: "/repo",
      yolo: true,
    },
    { agentId: "old-worker", description: "team:ops" },
  ]);
  assert.equal(unsafe.safeToApply, false);
  assert.deepEqual(
    unsafe.unsafe.map((change) => change.action),
    ["replace-agent", "remove-agent"],
  );
});

test("pm worker generator emits a version 2 team spec", () => {
  const spec = buildPmWorkerSpec({
    name: "triage",
    workers: 2,
    backend: "codex",
    workerBackend: "claude",
  });

  assert.equal(spec.version, 2);
  assert.equal(spec.dashboard, true);
  assert.equal(spec.agents.pm.backend, "codex");
  assert.equal(spec.agents["worker-2"].backend, "claude");

  const parsed = yaml.load(dumpTeamSpec(spec));
  assert.equal(parsed.name, "triage");
  assert.match(parsed.agents.pm.role, /project manager/);
  assert.throws(
    () => buildPmWorkerSpec({ name: "bad", workers: 0 }),
    /positive integer/,
  );
});

test("iterm script wraps the existing native-scroll attach command", () => {
  const script = buildItermAttachScript("scout");
  assert.match(script, /tell application "iTerm2"/);
  assert.match(script, /a2a attach scout --native-scroll/);
});

test("doctor snapshot masks secrets and summarizes diagnostics", () => {
  const snapshot = buildStatusSnapshot({
    generatedAt: "2026-06-03T00:00:00.000Z",
    inventory: { registered: [], views: [], orphans: [] },
  });
  const masked = maskConfig({
    key: "root-secret",
    peers: {
      dylan: { url: "https://dylan.example", key: "peer-secret" },
    },
  });
  assert.equal(masked.key, "***");
  assert.equal(masked.peers.dylan.key, "***");

  const doctor = buildDoctorSnapshot({
    status: snapshot,
    events: buildRuntimeEvents(snapshot),
    config: {
      key: "root-secret",
      peers: {
        dylan: { url: "https://dylan.example", key: "peer-secret" },
      },
    },
    registry: {
      agents: ["scout"],
      groups: ["ops"],
      installToken: "install-secret",
    },
    tmuxSessions: ["scout"],
    paths: { cwd: "/repo" },
    versions: { node: "v20.0.0", a2a: "1.1.0" },
  });

  const encoded = JSON.stringify(doctor);
  assert.equal(doctor.registry.installTokenPresent, true);
  assert.equal(encoded.includes("root-secret"), false);
  assert.equal(encoded.includes("peer-secret"), false);
  assert.equal(encoded.includes("install-secret"), false);
  assert.match(formatDoctorSnapshot(doctor), /a2a doctor: ok/);
});
