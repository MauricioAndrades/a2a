import { describe, expect, test } from "vitest";
import { buildNotifySequence, encodeNotifyPayload, normalizeNotifyBody, notifyToken, NOTIFY_MAX_TEXT } from "../src/cli/plugin-notify.mjs";

// Reference values produced by notify_token() / decode_notify_payload() in
// cmd/a2a-iterm2-plugin/plugin.py for secret "ab"*32 and agent "bob". The
// plugin verifies what the CLI emits, so the two must agree byte for byte.
const SECRET = "ab".repeat(32);
const PY_TOKEN_BOB = "603dbad026524c0714aea51e1e421f44";
const PY_DECODED_BODY = "eyJraW5kIjoiZG9uZSIsInRleHQiOiJ0ZXN0cyBwYXNzIOKckyJ9";

describe("a2a iTerm2 plugin notify wire format", () => {
    test("token matches the plugin's HMAC derivation", () => {
        expect(notifyToken(SECRET, "bob")).toBe(PY_TOKEN_BOB);
    });

    test("tokens differ per agent and per secret", () => {
        expect(notifyToken(SECRET, "alice")).not.toBe(PY_TOKEN_BOB);
        expect(notifyToken("cd".repeat(32), "bob")).not.toBe(PY_TOKEN_BOB);
    });

    test("payload encodes as the plugin decodes it", () => {
        const payload = encodeNotifyPayload({ agentId: "bob", token: PY_TOKEN_BOB, kind: "done", text: "tests pass ✓" });
        expect(payload).toBe(`v1:bob:${PY_TOKEN_BOB}:${PY_DECODED_BODY}`);
        expect(payload).toMatch(/^v1:[A-Za-z0-9_-]+:[0-9a-f]{32}:[A-Za-z0-9_-]*$/);
    });

    test("sequence is OSC 1337 Custom with the a2a identity, BEL-terminated", () => {
        expect(buildNotifySequence("v1:x")).toBe("\x1b]1337;Custom=id=a2a:v1:x\x07");
    });

    test("body validation rejects unknown kinds and oversize text", () => {
        expect(normalizeNotifyBody({ text: "hi" })).toEqual({ kind: "info", text: "hi" });
        expect(() => normalizeNotifyBody({ kind: "urgent", text: "x" })).toThrow(/--kind/);
        expect(() => normalizeNotifyBody({ text: "x".repeat(NOTIFY_MAX_TEXT + 1) })).toThrow(/at most/);
        expect(normalizeNotifyBody({ text: "✓".repeat(NOTIFY_MAX_TEXT) }).text).toHaveLength(NOTIFY_MAX_TEXT);
    });
});
