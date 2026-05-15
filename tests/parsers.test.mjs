import test from "node:test";
import assert from "node:assert/strict";
import { parseFlagSendArgv } from "../src/a2a-argv.mjs";
import { parseColonFlagArgv } from "../src/a2a-tokens.mjs";

const registry = {
    actions: new Set(["message", "reply", "ask", "write"]),
    agents: new Set(["bob", "leah"]),
    groups: new Set(["ops"]),
};

test("flag-form rejects unknown bare flags against registry", () => {
    assert.throws(() => parseFlagSendArgv(["--verbose", "hello"], registry), /unknown flag --verbose/);
});

test("flag-form accepts registered recipients and explicit origin", () => {
    assert.deepEqual(parseFlagSendArgv(["--reply", "--bob", "--origin", "peer", "hello"], registry), {
        action: "reply",
        recipients: ["bob"],
        broadcast: false,
        content: "hello",
        from: null,
        origin: "peer",
        meta: {},
    });
});

test("flag-form folds --to into normalized recipients", () => {
    assert.deepEqual(parseFlagSendArgv(["--to", "bob", "--leah", "hello"], registry), {
        action: "message",
        recipients: ["bob", "leah"],
        broadcast: false,
        content: "hello",
        from: null,
        origin: null,
        meta: {},
    });
});

test("flag-form validates recipients when only agents OR groups Set is present", () => {
    assert.deepEqual(parseFlagSendArgv(["--reply", "--bob", "hey"], { agents: new Set(["bob"]) }), {
        action: "reply",
        recipients: ["bob"],
        broadcast: false,
        content: "hey",
        from: null,
        origin: null,
        meta: {},
    });
    assert.throws(() => parseFlagSendArgv(["--reply", "--eve", "no"], { agents: new Set(["bob"]) }), /unknown flag --eve/);
});

test("flag-form marks action-only sends as broadcast", () => {
    assert.deepEqual(parseFlagSendArgv(["--message", "done"], registry), {
        action: "message",
        recipients: [],
        broadcast: true,
        content: "done",
        from: null,
        origin: null,
        meta: {},
    });
});

test("colon-form parses action, recipients, sender, origin, and repeated recipients", () => {
    assert.deepEqual(parseColonFlagArgv(["--ask:bob:leah:bob", "--from=op", "--origin=user", "status"], registry), {
        from: "op",
        origin: "user",
        recipients: ["bob", "leah"],
        action: "ask",
        content: "status",
        meta: {},
    });
});

test("colon-form keeps unknown equals flags as metadata", () => {
    assert.deepEqual(parseColonFlagArgv(["--message:bob", "--mood=angry", "status"], registry), {
        from: null,
        origin: null,
        recipients: ["bob"],
        action: "message",
        content: "status",
        meta: { mood: "angry" },
    });
});

test("colon-form equals value is message content", () => {
    assert.equal(parseColonFlagArgv(["--message:bob=value"], registry).content, "value");
});

test("colon-form rejects duplicate inline and positional content", () => {
    assert.throws(() => parseColonFlagArgv(["--message:bob=value", "other"], registry), /message content specified more than once/);
});
