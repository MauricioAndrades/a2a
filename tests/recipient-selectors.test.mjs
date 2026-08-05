import { test } from "vitest";
import assert from "node:assert/strict";
import {
  hasUnescapedGlob,
  expandGlobRecipientSelectors,
} from "../src/recipient-selectors.mjs";

test("hasUnescapedGlob only treats unescaped wildcard chars as glob syntax", () => {
  assert.equal(hasUnescapedGlob("*managers"), true);
  assert.equal(hasUnescapedGlob("managers?"), true);
  assert.equal(hasUnescapedGlob("\\*managers"), false);
  assert.equal(hasUnescapedGlob("ops"), false);
});

test("expandGlobRecipientSelectors expands globs against candidates", () => {
  const result = expandGlobRecipientSelectors(
    ["*managers", "ops", "qa?"],
    ["alpha-managers", "beta-managers", "ops", "qa1", "qa23"],
  );
  assert.deepEqual(result, {
    recipients: ["alpha-managers", "beta-managers", "ops", "qa1"],
    unmatchedSelectors: [],
  });
});

test("escaped-glob selectors unescape to the literal recipient id", () => {
  // `web\*` means "the agent literally named web*" — the backslash is
  // selector syntax and must not end up in the recipient id.
  const result = expandGlobRecipientSelectors(
    ["web\\*", "qa\\?", "lit\\\\eral"],
    ["web*", "webfoo", "qa?", "qa1"],
  );
  assert.deepEqual(result, {
    recipients: ["web*", "qa?", "lit\\eral"],
    unmatchedSelectors: [],
  });
});

test("expandGlobRecipientSelectors reports unmatched selectors", () => {
  const result = expandGlobRecipientSelectors(["*nobody"], ["alice", "bob"]);
  assert.deepEqual(result, {
    recipients: [],
    unmatchedSelectors: ["*nobody"],
  });
});
