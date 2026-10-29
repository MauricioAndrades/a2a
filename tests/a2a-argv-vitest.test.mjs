import { describe, expect, test } from "vitest";
import {
  isColonFlagArgv,
  isFlagSendArgv,
  parseColonFlagArgv,
  parseFlagSendArgv,
} from "../src/a2a-argv.mjs";

const registry = {
  actions: new Set(["message", "reply", "ask", "write"]),
  agents: new Set(["bob", "leah", "scout"]),
  groups: new Set(["ops", "reviewers"]),
};

describe("a2a-argv real parsing tests", () => {
  test("parses send-style flags, aliases, and value flags", () => {
    expect(
      parseFlagSendArgv(
        ["--write", "--to", "bob", "--leah", "status update"],
        registry,
      ),
    ).toEqual({
      action: "message",
      recipients: ["bob", "leah"],
      broadcast: false,
      content: "status update",
      from: null,
      origin: null,
      meta: {},
    });

    expect(
      parseFlagSendArgv(
        ["--ask", "--from=op", "--origin", "peer", "--content=ready?", "--ops"],
        registry,
      ),
    ).toEqual({
      action: "ask",
      recipients: ["ops"],
      broadcast: false,
      content: "ready?",
      from: "op",
      origin: "peer",
      meta: {},
    });
  });

  test("supports broadcast sends and glob selectors while detecting invalid forms", () => {
    expect(parseFlagSendArgv(["--message", "broadcast now"], registry)).toEqual(
      {
        action: "message",
        recipients: [],
        broadcast: true,
        content: "broadcast now",
        from: null,
        origin: null,
        meta: {},
      },
    );

    expect(
      parseFlagSendArgv(["--reply", "--to", "*review*", "ready"], registry),
    ).toEqual({
      action: "reply",
      recipients: ["*review*"],
      broadcast: false,
      content: "ready",
      from: null,
      origin: null,
      meta: {},
    });

    expect(() => parseFlagSendArgv(["--from"], registry)).toThrow(
      /requires a value/,
    );
    expect(() => parseFlagSendArgv(["--unknown", "hello"], registry)).toThrow(
      /unknown flag --unknown/,
    );
    expect(isFlagSendArgv(["--reply", "--bob", "hello"])).toBe(true);
    expect(isFlagSendArgv(["--ops=hello"])).toBe(false);
    expect(isFlagSendArgv(["hello", "world"])).toBe(false);
  });

  test("deduplicates --to and bare recipients without changing order", () => {
    expect(
      parseFlagSendArgv(
        ["--to", "bob", "--bob", "--leah", "--bob", "ready"],
        registry,
      ).recipients,
    ).toEqual(["bob", "leah"]);
  });

  test("flags named after Object.prototype members never resolve to actions", () => {
    // Regression: `key in ACTION_ALIASES` walked the prototype chain, so
    // `--toString hi` parsed as a broadcast send whose action was the
    // Function.prototype.toString function.
    expect(() => parseFlagSendArgv(["--toString", "hi"], registry)).toThrow(
      /unknown flag --toString/,
    );
    expect(() =>
      parseFlagSendArgv(["--hasOwnProperty", "hi"], registry),
    ).toThrow(/unknown flag --hasOwnProperty/);

    // Without a registry the token is treated as a recipient — but the action
    // must still be a plain string, never an inherited function.
    const parsed = parseFlagSendArgv(["--toString", "hi"]);
    expect(parsed.action).toBe("message");
    expect(parsed.recipients).toEqual(["toString"]);
    expect(parsed.broadcast).toBe(false);
  });

  test("--content combined with positional words throws instead of dropping them", () => {
    // Regression: `--content "hi" extra words` silently discarded the
    // positionals; the sibling colon parser throws for the same ambiguity.
    expect(() =>
      parseFlagSendArgv(["--content", "hi", "--bob", "extra", "words"], registry),
    ).toThrow(/message content specified more than once/);

    expect(parseFlagSendArgv(["--content", "hi", "--bob"], registry)).toEqual({
      action: "message",
      recipients: ["bob"],
      broadcast: false,
      content: "hi",
      from: null,
      origin: null,
      meta: {},
    });
  });

  test("re-exported colon parsing handles recipients, metadata, and duplicate content guards", () => {
    expect(isColonFlagArgv(["--ask:bob:ops"])).toBe(true);
    expect(isColonFlagArgv(["--ask", "bob"])).toBe(false);

    expect(
      parseColonFlagArgv(
        [
          "--ask:bob:ops:bob",
          "--from=op",
          "--origin=user",
          "--source",
          "peer-cli",
          "status",
        ],
        registry,
      ),
    ).toEqual({
      from: "op",
      origin: "user",
      recipients: ["bob", "ops"],
      action: "ask",
      content: "status",
      meta: { source: "peer-cli" },
    });

    // Unknown flags must not swallow the next word into meta — a typo'd
    // recipient used to silently broadcast the remaining words.
    expect(() =>
      parseColonFlagArgv(
        ["--message:bob", "--priority", "high", "status"],
        registry,
      ),
    ).toThrow(/unknown flag --priority/);

    expect(
      parseColonFlagArgv(["--write:reviewers=follow up"], registry),
    ).toEqual({
      from: null,
      origin: null,
      recipients: ["reviewers"],
      action: "message",
      content: "follow up",
      meta: {},
    });

    expect(() =>
      parseColonFlagArgv(["--message:bob=hello", "again"], registry),
    ).toThrow(/message content specified more than once/);
  });
});
