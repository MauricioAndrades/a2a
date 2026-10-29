import { test } from "vitest";
import assert from "node:assert/strict";
import {
  teamSpecDefaultsToYolo,
  TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION,
} from "../src/a2a-team-spec.mjs";

// ─── version gate semantics ───────────────────────────────────────────────

test("spec with no version field does NOT default to yolo (pre-v2 legacy compatibility)", () => {
  // This is the critical replay-equivalence guarantee: a team spec
  // authored before yolo-default existed must keep its interactive default
  // when a2a is upgraded.
  assert.equal(teamSpecDefaultsToYolo({ agents: {} }), false);
});

test("spec with version 1 does NOT default to yolo", () => {
  assert.equal(teamSpecDefaultsToYolo({ version: 1, agents: {} }), false);
});

test(`spec with version ${TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION} defaults to yolo (opt-in to new semantics)`, () => {
  assert.equal(teamSpecDefaultsToYolo({ version: 2, agents: {} }), true);
});

test("spec with version greater than the threshold defaults to yolo (forward compatibility)", () => {
  assert.equal(teamSpecDefaultsToYolo({ version: 3, agents: {} }), true);
  assert.equal(teamSpecDefaultsToYolo({ version: 99, agents: {} }), true);
});

test("version as a string-encoded integer is honored (YAML coercion safety)", () => {
  // YAML can produce string-typed numbers depending on quoting; the gate
  // must accept "2" the same as 2.
  assert.equal(teamSpecDefaultsToYolo({ version: "2" }), true);
  assert.equal(teamSpecDefaultsToYolo({ version: "1" }), false);
});

test("version below the threshold is rejected even when numeric", () => {
  assert.equal(teamSpecDefaultsToYolo({ version: 0 }), false);
  assert.equal(teamSpecDefaultsToYolo({ version: -1 }), false);
});

// ─── defensive shape handling ─────────────────────────────────────────────

test("non-object inputs return false (null, undefined, primitives, arrays)", () => {
  assert.equal(teamSpecDefaultsToYolo(null), false);
  assert.equal(teamSpecDefaultsToYolo(undefined), false);
  assert.equal(teamSpecDefaultsToYolo("v2"), false);
  assert.equal(teamSpecDefaultsToYolo(42), false);
  assert.equal(teamSpecDefaultsToYolo([{ version: 2 }]), false);
});

test("version with non-numeric string returns false", () => {
  assert.equal(teamSpecDefaultsToYolo({ version: "not-a-number" }), false);
  assert.equal(teamSpecDefaultsToYolo({ version: "v2" }), false);
});

test("version with null or boolean returns false", () => {
  assert.equal(teamSpecDefaultsToYolo({ version: null }), false);
  assert.equal(teamSpecDefaultsToYolo({ version: true }), false);
  assert.equal(teamSpecDefaultsToYolo({ version: false }), false);
});

test("the exported threshold constant is exactly 2", () => {
  // Pin the threshold so a future bump becomes a deliberate review event
  // rather than a silent semantic drift.
  assert.equal(TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION, 2);
});
