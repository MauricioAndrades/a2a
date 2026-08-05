import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildSessionInventory,
  findOwnedItermSessionByName,
  isViewName,
  baseFromView,
  makeItermOwnershipChecker,
} from "../src/cli/session-inventory.mjs";

const baseInputs = {
  registeredAgents: [],
  tmuxSessions: [],
  cachedAgentIds: [],
  isGroup: () => false,
  loadResolvedTeamSpec: () => null,
  // Default to "everything is a2a-owned" so the orphan-classifier tests
  // that pre-date the install-token gate keep their original intent.
  // Tests that specifically exercise the ownership marker pass their own.
  isA2aOwnedSession: () => true,
  launchCwd: "/tmp",
};

// ─── isViewName / baseFromView ────────────────────────────────────────────

test("isViewName accepts a2a-view, *-view with prefix, and rejects literal '-view'", () => {
  assert.equal(isViewName("a2a-view"), true);
  assert.equal(isViewName("bug-killers-view"), true);
  assert.equal(isViewName("squad-view"), true);
  assert.equal(isViewName("-view"), false);
  assert.equal(isViewName("view"), false);
  assert.equal(isViewName(""), false);
  assert.equal(isViewName(null), false);
});

test("baseFromView strips the -view suffix and handles a2a-view specially", () => {
  assert.equal(baseFromView("bug-killers-view"), "bug-killers");
  assert.equal(baseFromView("a2a-view"), "a2a");
  assert.equal(baseFromView("squad-view"), "squad");
  assert.equal(baseFromView("notview"), null);
});

// ─── registered bucket ────────────────────────────────────────────────────

test("registered agents pass through with live status when tmux session exists", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      {
        agentId: "scout",
        description: "team:bug-killers",
        tmuxTarget: "scout:0.0",
        cwd: "/x",
      },
    ],
    tmuxSessions: ["scout"],
  });
  assert.deepEqual(out.registered, [
    {
      agentId: "scout",
      tmuxTarget: "scout:0.0",
      cwd: "/x",
      description: "team:bug-killers",
      cohort: "bug-killers",
      status: "live",
      yolo: null,
      backend: "",
    },
  ]);
});

test("registered agents marked bridge-only when tmux session missing", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "scout", description: "team:bug-killers" }],
    tmuxSessions: [],
  });
  assert.equal(out.registered[0].status, "bridge-only");
  assert.equal(out.registered[0].tmuxTarget, "scout:0.0"); // default fill
});

test("registered agents marked live when iTerm session is present", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "alpha-mgr", description: "team:dw-bug-killers" }],
    tmuxSessions: [],
    itermLiveAgentIds: ["alpha-mgr"],
  });
  assert.equal(out.registered[0].status, "live");
});

test("registered agent without a team/group description has cohort=null", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "solo", description: "" }],
  });
  assert.equal(out.registered[0].cohort, null);
});

// ─── views bucket ─────────────────────────────────────────────────────────

test("view session is inferred from a registered agent's team description even if absent from tmux", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      { agentId: "scout", description: "team:bug-killers" },
      { agentId: "reproducer", description: "team:bug-killers" },
    ],
    tmuxSessions: [],
  });
  const view = out.views.find((v) => v.session === "bug-killers-view");
  assert.ok(view, "view should be inferred from team description");
  assert.equal(view.baseName, "bug-killers");
  assert.equal(view.known, true);
  assert.equal(view.existsInTmux, false);
});

test("view session present in tmux is discovered even with no live agents (link-window survivor)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["bug-killers-view"],
    loadResolvedTeamSpec: (name) => (name === "bug-killers" ? { name } : null),
  });
  const view = out.views.find((v) => v.session === "bug-killers-view");
  assert.ok(view);
  assert.equal(view.known, true);
  assert.equal(view.existsInTmux, true);
});

test("view session in tmux with unknown base is recorded as unknown but still existsInTmux", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["random-view"],
  });
  const view = out.views.find((v) => v.session === "random-view");
  assert.ok(view);
  assert.equal(view.known, false);
  assert.equal(view.existsInTmux, true);
});

test("a2a-view session is discovered with known=false (no team/group named 'a2a' by default)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["a2a-view"],
  });
  const view = out.views.find((v) => v.session === "a2a-view");
  assert.ok(view);
  assert.equal(view.baseName, "a2a");
  assert.equal(view.existsInTmux, true);
});

test("view session known via isGroup callback", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["squad-view"],
    isGroup: (name) => name === "squad",
  });
  const view = out.views.find((v) => v.session === "squad-view");
  assert.ok(view);
  assert.equal(view.known, true);
});

test("view from registered description and view present in tmux merge into one entry (no duplicate)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "scout", description: "team:bug-killers" }],
    tmuxSessions: ["scout", "bug-killers-view"],
    loadResolvedTeamSpec: (name) => (name === "bug-killers" ? { name } : null),
  });
  const matching = out.views.filter((v) => v.session === "bug-killers-view");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].existsInTmux, true);
  assert.equal(matching[0].known, true);
  assert.deepEqual([...matching[0].sources].sort(), ["description", "tmux"]);
});

// ─── orphans bucket ───────────────────────────────────────────────────────

test("tmux session matching a cached agent id but not in bridge registry is an orphan", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["reproducer"],
    cachedAgentIds: ["reproducer", "scout"],
  });
  assert.deepEqual(out.orphans, ["reproducer"]);
});

test("tmux session that is currently registered is NOT an orphan even if also in cache", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "scout", description: "team:bug-killers" }],
    tmuxSessions: ["scout"],
    cachedAgentIds: ["scout"],
  });
  assert.deepEqual(out.orphans, []);
});

test("view sessions are never classified as orphans", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["bug-killers-view"],
    cachedAgentIds: ["bug-killers-view"], // pathological but possible
  });
  assert.deepEqual(out.orphans, []);
});

test("user's unrelated tmux sessions (not in cache) are ignored, not labelled as orphans", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["my-dev-shell", "another-project"],
    cachedAgentIds: [],
    isA2aOwnedSession: () => false,
  });
  assert.deepEqual(out.orphans, []);
});

test("corrupt cachedAgentIds (non-array) is tolerated and yields no orphans", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    tmuxSessions: ["reproducer"],
    cachedAgentIds: { not: "an array" },
    isA2aOwnedSession: () => false,
  });
  assert.deepEqual(out.orphans, []);
});

test("legacy cache still marks a tmux session as an orphan without an install token", () => {
  // The install token is the durable ownership proof for current sessions.
  // Cached names are kept only as a compatibility hint for older sessions
  // that were created before the token marker existed.
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["scout"],
    cachedAgentIds: ["scout"],
    isA2aOwnedSession: () => false,
  });
  assert.deepEqual(out.orphans, ["scout"]);
});

test("install-token ownership marks an orphan even when the cache missed it", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["scout"],
    cachedAgentIds: [],
    isA2aOwnedSession: (name) => name === "scout",
  });
  assert.deepEqual(out.orphans, ["scout"]);
});

test("install-token and legacy cache both classify unregistered tmux sessions as orphans", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["scout", "reproducer"],
    cachedAgentIds: ["scout"],
    isA2aOwnedSession: (name) => name === "reproducer",
  });
  assert.deepEqual(out.orphans, ["scout", "reproducer"]);
});

test("install-token gate: an isA2aOwnedSession callback that throws is treated as 'not owned'", () => {
  // tmuxGetInstallToken may spawnSync-throw in pathological tmux states;
  // the classifier must never propagate that into a false positive.
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    tmuxSessions: ["scout"],
    cachedAgentIds: [],
    isA2aOwnedSession: () => {
      throw new Error("tmux exploded");
    },
  });
  assert.deepEqual(out.orphans, []);
});

test("owned iTerm session not matching a registered agent is an iterm orphan", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "alice", description: "" }],
    itermSessions: [
      { guid: "guid-bob", name: "bob — ~/dev", installToken: "tok" },
    ],
    isA2aOwnedITermSession: (guid) => guid === "guid-bob",
  });
  assert.deepEqual(out.itermOrphans, [
    { guid: "guid-bob", name: "bob — ~/dev" },
  ]);
});

test("registered iTerm agent is not classified as an iterm orphan", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "bob", description: "" }],
    itermSessions: [{ guid: "guid-bob", name: "bob", installToken: "tok" }],
    isA2aOwnedITermSession: (guid) => guid === "guid-bob",
  });
  assert.deepEqual(out.itermOrphans, []);
});

test("registered iTerm matching uses parsed session ids, not substring prefixes", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      { agentId: "bob", description: "" },
      { agentId: "not", description: "" },
    ],
    itermSessions: [
      { guid: "guid-bob", name: "bob — ~/dev", installToken: "tok" },
      { guid: "guid-title", name: "not an agent — ~/dev", installToken: "tok" },
    ],
    isA2aOwnedITermSession: (guid) =>
      guid === "guid-bob" || guid === "guid-title",
  });
  assert.deepEqual(out.itermOrphans, [
    { guid: "guid-title", name: "not an agent — ~/dev" },
  ]);
});

// ─── iTerm ownership wiring ───────────────────────────────────────────────
// Regression: cli.mjs used to wire transport-probes' ASYNC
// isA2aOwnedITermSession into buildSessionInventory, whose consumer calls the
// checker synchronously and compares `=== true`. A Promise is never `=== true`
// so itermOrphans was ALWAYS empty and `a2a kill --all` never swept orphaned
// iTerm windows. The wiring must go through the sync closure built by
// makeItermOwnershipChecker over a pre-fetched session list.

test("makeItermOwnershipChecker returns a sync boolean and drives orphan detection end to end", () => {
  const itermSessions = [
    { guid: "g-bob", name: "bob — ~/dev", installToken: "tok-1" },
    { guid: "g-other", name: "stranger", installToken: "tok-2" },
    { guid: "g-untagged", name: "shell", installToken: null },
  ];
  const checker = makeItermOwnershipChecker(itermSessions, "tok-1");
  // Must be strictly `true` synchronously — an async checker (Promise) here
  // is exactly the regression this guards against.
  assert.equal(checker("g-bob"), true);
  assert.equal(checker("g-other"), false);
  assert.equal(checker("g-untagged"), false);
  assert.equal(checker("g-missing"), false);

  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    itermSessions,
    isA2aOwnedITermSession: checker,
  });
  assert.deepEqual(out.itermOrphans, [{ guid: "g-bob", name: "bob — ~/dev" }]);
});

test("makeItermOwnershipChecker preserves first matching guid semantics", () => {
  const sessions = [
    { guid: "g", name: "first", installToken: "tok-1" },
    { guid: "g", name: "second", installToken: "tok-2" },
  ];
  assert.equal(makeItermOwnershipChecker(sessions, "tok-1")("g"), true);
  assert.equal(makeItermOwnershipChecker(sessions, "tok-2")("g"), false);
});

test("makeItermOwnershipChecker never claims ownership without an install token", () => {
  const sessions = [{ guid: "g", name: "bob", installToken: "" }];
  assert.equal(makeItermOwnershipChecker(sessions, "")("g"), false);
  assert.equal(makeItermOwnershipChecker(sessions, null)("g"), false);
  assert.equal(makeItermOwnershipChecker(sessions, undefined)("g"), false);
  // Non-array session input is tolerated.
  assert.equal(makeItermOwnershipChecker(null, "tok")("g"), false);
});

test("an async ownership checker yields no iterm orphans (the failure mode the sync wiring fixes)", () => {
  // Documents why the wiring contract matters: buildSessionInventory treats a
  // thenable as "not owned", so an async checker silently disables the
  // bucket. cli.mjs must therefore pass makeItermOwnershipChecker's closure.
  const itermSessions = [
    { guid: "g-bob", name: "bob — ~/dev", installToken: "tok-1" },
  ];
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [],
    itermSessions,
    // eslint-disable-next-line require-await -- the bug under test is an async checker
    isA2aOwnedITermSession: async () => true,
  });
  assert.deepEqual(out.itermOrphans, []);
});

test("findOwnedItermSessionByName matches decorated names only with install-token ownership", () => {
  const sessions = [
    { guid: "g-bob", name: "bob — ~/dev/a2a", installToken: "tok-1" },
    { guid: "g-imp", name: "bob — ~/elsewhere", installToken: null },
    { guid: "g-other", name: "leah", installToken: "tok-1" },
  ];
  assert.equal(
    findOwnedItermSessionByName(sessions, "bob", "tok-1")?.guid,
    "g-bob",
  );
  // Wrong / missing token: a bare name collision must not match.
  assert.equal(findOwnedItermSessionByName(sessions, "bob", "tok-x"), null);
  assert.equal(findOwnedItermSessionByName(sessions, "bob", ""), null);
  assert.equal(findOwnedItermSessionByName(sessions, "bob", null), null);
  // Unowned session with an exact name is still rejected.
  assert.equal(
    findOwnedItermSessionByName(
      [{ guid: "g-imp", name: "bob", installToken: null }],
      "bob",
      "tok-1",
    ),
    null,
  );
  assert.equal(findOwnedItermSessionByName(null, "bob", "tok-1"), null);
});

// ─── yolo passthrough on registered entries ───────────────────────────────

test("registered entry exposes yolo=true when the bridge reports it", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      { agentId: "scout", description: "team:bug-killers", yolo: true },
    ],
    tmuxSessions: ["scout"],
  });
  assert.equal(out.registered[0].yolo, true);
});

test("registered entry exposes yolo=false when the bridge reports it (opt-out)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      { agentId: "scout", description: "team:bug-killers", yolo: false },
    ],
    tmuxSessions: ["scout"],
  });
  assert.equal(out.registered[0].yolo, false);
});

test("registered entry exposes yolo=null when the bridge has no record (pre-upgrade or unknown)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [{ agentId: "scout", description: "team:bug-killers" }],
    tmuxSessions: ["scout"],
  });
  assert.equal(out.registered[0].yolo, null);
});

test("registered entry treats non-boolean yolo values as null (defensive against garbage from the bridge)", () => {
  const out = buildSessionInventory({
    ...baseInputs,
    registeredAgents: [
      { agentId: "scout", description: "team:bug-killers", yolo: "yes" },
    ],
    tmuxSessions: ["scout"],
  });
  assert.equal(out.registered[0].yolo, null);
});

// ─── live-cohort regression scenario ──────────────────────────────────────

test("bug-killers post-half-kill scenario: bridge empty, *-view survives with linked windows, cached ids reflect the team", () => {
  // Reproduces the state observed during the trace: `a2a kill --all` cleared
  // the bridge and killed the source sessions, but bug-killers-view kept
  // three linked windows alive (codex/cursor-agent/gemini).
  const out = buildSessionInventory({
    registeredAgents: [],
    tmuxSessions: ["bug-killers-view"],
    cachedAgentIds: ["scout", "reproducer", "patcher", "verifier"],
    isGroup: () => false,
    loadResolvedTeamSpec: (name) => (name === "bug-killers" ? { name } : null),
    isA2aOwnedSession: () => true,
    launchCwd: "/tmp",
  });
  assert.deepEqual(out.registered, []);
  // The view session is discovered, marked known (team spec resolves), and exists.
  assert.equal(out.views.length, 1);
  assert.equal(out.views[0].session, "bug-killers-view");
  assert.equal(out.views[0].known, true);
  assert.equal(out.views[0].existsInTmux, true);
  // No orphan agent sessions because the individual sessions were already killed.
  assert.deepEqual(out.orphans, []);
});

test("partial-kill scenario with one source session left behind: cached id remains in tmux, others gone", () => {
  const out = buildSessionInventory({
    registeredAgents: [],
    tmuxSessions: ["reproducer", "bug-killers-view"],
    cachedAgentIds: ["scout", "reproducer", "patcher", "verifier"],
    isGroup: () => false,
    loadResolvedTeamSpec: (name) => (name === "bug-killers" ? { name } : null),
    isA2aOwnedSession: () => true,
    launchCwd: "/tmp",
  });
  assert.deepEqual(out.orphans, ["reproducer"]);
  assert.equal(out.views[0].session, "bug-killers-view");
});
