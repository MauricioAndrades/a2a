import { test } from "vitest";
import assert from "node:assert/strict";
import {
  resolveSenderIdentity,
  selfExclusionId,
  VALID_ORIGINS,
} from "../src/cli/sender-identity.mjs";

// resolveSenderIdentity is the security boundary that decides who an outbound
// a2a envelope is from and whether the bridge treats it as user authority or
// peer traffic. The bridge validates the origin enum; this resolver decides
// whether caller context is allowed to claim origin=user.
//
// CONTRACT: this function NEVER throws. The a2a channel stays up even with
// wonky inputs (invalid --origin, no tmux, no TTY). When op identity cannot
// be proven, the safe default is origin=peer -- message still delivers, just
// not stamped as user authority.

// ─── happy path: registered tmux session → peer ───────────────────────────

test("inside a registered tmux session, default origin=peer and from=selfId", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: "credit-implementer",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "credit-implementer", origin: "peer" });
});

test("inside a registered tmux session, locked selfId ignores mismatched explicit --from", () => {
  const out = resolveSenderIdentity({
    explicitFrom: "deputy",
    explicitOrigin: null,
    selfId: "credit-implementer",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "credit-implementer", origin: "peer" });
});

test("inside an a2a-launched tool subprocess, A2A_AGENT_ID supplies peer identity without TMUX", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    agentId: "workflow-validator",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "workflow-validator", origin: "peer" });
});

test("inside an a2a-launched tool subprocess, locked A2A_AGENT_ID ignores mismatched --from", () => {
  const warnings = [];
  const out = resolveSenderIdentity({
    explicitFrom: "cli",
    explicitOrigin: null,
    selfId: null,
    agentId: "workflow-validator",
    interactiveTTY: false,
    warn: (msg) => warnings.push(msg),
  });
  assert.deepEqual(out, { fromId: "workflow-validator", origin: "peer" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /locked to workflow-validator/);
});

// ─── happy path: bare op terminal with TTY → user ─────────────────────────

test("outside tmux WITH interactive TTY, defaults to from=user origin=user source=cli", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: true,
  });
  assert.deepEqual(out, { fromId: "user", origin: "user", source: "cli" });
});

test("outside tmux WITH interactive TTY, explicit --from is honoured", () => {
  const out = resolveSenderIdentity({
    explicitFrom: "op-laptop",
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: true,
  });
  assert.deepEqual(out, {
    fromId: "op-laptop",
    origin: "user",
    source: "cli",
  });
});

test("dashboard/operator surface can prove user authority without a TTY", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
    operatorSource: "cli",
  });
  assert.deepEqual(out, { fromId: "user", origin: "user", source: "cli" });
});

// ─── THE BUG: subprocess that lost TMUX → safe peer default, NEVER crash ──
//
// Old behaviour:
//   selfId=null, TTY=false  →  origin="user", from="cli"   (BAD: spoofs op)
// New behaviour:
//   selfId=null, TTY=false  →  origin="peer", from="cli"   (safe: never op
//                                                          without proof)
// The send still goes through; the recipient just doesn't get false
// op-authority. A `warn` callback fires so the suspicious path is visible.

test("outside tmux AND no TTY: defaults to origin=peer, NOT user, NEVER throws", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "cli", origin: "peer" });
});

test("outside tmux AND no TTY: fires warn with actionable diagnostic", () => {
  const warnings = [];
  resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sender context unclear/);
  assert.match(warnings[0], /origin=peer/);
  assert.match(warnings[0], /--from/);
});

test("outside tmux, no TTY, but explicit --from: stamps origin=peer with the named from", () => {
  const out = resolveSenderIdentity({
    explicitFrom: "credit-implementer",
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "credit-implementer", origin: "peer" });
});

// ─── explicit --origin: wins when valid, clamped silently when garbage ────

test("explicit --origin user is clamped without TTY or operator evidence", () => {
  const warnings = [];
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "user",
    selfId: null,
    interactiveTTY: false,
    warn: (msg) => warnings.push(msg),
  });
  assert.deepEqual(out, { fromId: "cli", origin: "peer" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /without operator evidence/);
});

test("explicit --origin user wins when operator source proves the caller", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "user",
    selfId: null,
    interactiveTTY: false,
    operatorSource: "cli",
  });
  assert.deepEqual(out, { fromId: "user", origin: "user", source: "cli" });
});

test("explicit --origin peer wins inside a tmux pane (lets selfId still set from)", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "peer",
    selfId: "credit-implementer",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "credit-implementer", origin: "peer" });
});

test("explicit --origin self is accepted (echo path)", () => {
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "self",
    selfId: "credit-implementer",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "credit-implementer", origin: "self" });
});

test("invalid --origin does NOT throw: clamps to default + warns", () => {
  const warnings = [];
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "admin",
    selfId: "bob",
    interactiveTTY: false,
    warn: (msg) => warnings.push(msg),
  });
  // Falls through to the selfId-based default
  assert.deepEqual(out, { fromId: "bob", origin: "peer" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring invalid origin 'admin'/);
});

test("invalid --origin clamps to whatever the next-best default is (TTY path)", () => {
  // No selfId, but TTY → still gets the op default after clamping
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "garbage",
    selfId: null,
    interactiveTTY: true,
  });
  assert.deepEqual(out, { fromId: "user", origin: "user", source: "cli" });
});

test("invalid --origin clamps to peer when no tmux and no TTY (safest fallback)", () => {
  // The worst-input case: bad origin string AND no identity evidence.
  // We still don't crash and still don't claim op.
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "root",
    selfId: null,
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "cli", origin: "peer" });
});

// ─── defensive: empty / undefined / non-string inputs never crash ─────────

test("empty string inputs are treated as absent", () => {
  const out = resolveSenderIdentity({
    explicitFrom: "",
    explicitOrigin: "",
    selfId: "bob",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "bob", origin: "peer" });
});

test("undefined inputs do not crash", () => {
  const out = resolveSenderIdentity({
    explicitFrom: undefined,
    explicitOrigin: undefined,
    selfId: "bob",
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "bob", origin: "peer" });
});

test("missing warn callback is harmless (suspicious-path code still returns safe defaults)", () => {
  // No warn passed at all — should still return the safe peer default
  // without any error about the missing callback.
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
  });
  assert.deepEqual(out, { fromId: "cli", origin: "peer" });
});

test("non-function warn is ignored, not crashed on", () => {
  // Defensive: someone passes warn:false or warn:"hi". Don't crash.
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: "bogus",
    selfId: null,
    interactiveTTY: false,
    warn: "not a function",
  });
  assert.deepEqual(out, { fromId: "cli", origin: "peer" });
});

// ─── regression guard for the exact reported envelope ─────────────────────

test("regression: peer subprocess with no TMUX cannot default to from=cli origin=user", () => {
  // Op reported a message arrived at revenue-manager stamped from="cli"
  // origin="user" that op did not type. Lock down the safe default that
  // closes the silent-impersonation path.
  const out = resolveSenderIdentity({
    explicitFrom: null,
    explicitOrigin: null,
    selfId: null,
    interactiveTTY: false,
  });
  assert.notEqual(out.origin, "user");
  assert.equal(out.origin, "peer");
});

// ─── selfExclusionId: who gets removed from broadcast / auto-infer ────────
//
// THE BUG (reported on iTerm agents): `a2a --message '...'` with no recipient
// broadcasts to all peers. Self-exclusion used only the tmux session name,
// which is null for iTerm-backed agents (no TMUX env), so the sender stayed in
// the recipient set and received its own broadcast — the `<a2a from="X">` echo
// appearing on X's own screen. The fix falls back to the launched-agent id in
// A2A_AGENT_ID, the same identity resolveSenderIdentity locks onto.

test("tmux agent: excludes itself by live tmux session name", () => {
  assert.equal(selfExclusionId({ selfId: "bob", agentId: undefined }), "bob");
});

test("regression: iTerm agent (no TMUX) excludes itself via A2A_AGENT_ID", () => {
  // selfId is null because currentTmuxSession() returns null without TMUX.
  // Before the fix this returned null and the agent broadcast to itself.
  assert.equal(
    selfExclusionId({ selfId: null, agentId: "typemason" }),
    "typemason",
  );
});

test("selfId wins over agentId when both present", () => {
  assert.equal(
    selfExclusionId({ selfId: "bob", agentId: "typemason" }),
    "bob",
  );
});

test("blank/whitespace selfId falls through to agentId", () => {
  assert.equal(selfExclusionId({ selfId: "   ", agentId: "typemason" }), "typemason");
});

test("no identity evidence → null (nothing excluded, human CLI broadcast)", () => {
  assert.equal(selfExclusionId({ selfId: null, agentId: undefined }), null);
  assert.equal(selfExclusionId({}), null);
  assert.equal(selfExclusionId(), null);
});

test("malformed A2A_AGENT_ID is rejected, not used as an exclusion id", () => {
  // Same validity gate as resolveSenderIdentity's lockedId: ids must match
  // [A-Za-z0-9_-]+. A junk env value must not silently exclude a real agent.
  assert.equal(selfExclusionId({ selfId: null, agentId: "bad id!" }), null);
  assert.equal(selfExclusionId({ selfId: null, agentId: "" }), null);
});

// ─── VALID_ORIGINS export ─────────────────────────────────────────────────

test("VALID_ORIGINS is exactly {user, peer, self}", () => {
  assert.deepEqual([...VALID_ORIGINS].sort(), ["peer", "self", "user"]);
});
