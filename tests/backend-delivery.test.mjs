import { test } from "vitest";
import assert from "node:assert/strict";
import {
  submitKeysForBackend,
  submitRecoveryKeysForBackend,
} from "../src/backend-delivery.mjs";

test("cursor-agent messages submit with Ctrl+Enter", () => {
  assert.deepEqual(submitKeysForBackend("cursor-agent"), ["C-Enter"]);
});

test("other backends submit with Enter", () => {
  assert.deepEqual(submitKeysForBackend("claude"), ["Enter"]);
  assert.deepEqual(submitKeysForBackend("codex"), ["Enter"]);
  assert.deepEqual(submitKeysForBackend("gemini"), ["Enter"]);
  assert.deepEqual(submitKeysForBackend(undefined), ["Enter"]);
});

test("paste delivery does not use recovery keys that can cancel submitted content", () => {
  assert.deepEqual(submitRecoveryKeysForBackend("claude"), []);
  assert.deepEqual(submitRecoveryKeysForBackend("codex"), []);
  assert.deepEqual(submitRecoveryKeysForBackend("gemini"), []);
  assert.deepEqual(submitRecoveryKeysForBackend("cursor-agent"), []);
  assert.deepEqual(submitRecoveryKeysForBackend(undefined), []);
});
