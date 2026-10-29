import { describe, expect, test } from "vitest";
import {
  isFlagSendArgv,
  isSequenceFlagArgv,
  parseFlagSendArgv,
  parseSequenceFlagArgv,
} from "../src/a2a-argv.mjs";

const registry = {
  actions: new Set(["message", "reply", "ask", "write"]),
  agents: new Set(["bob", "leah", "scout"]),
  groups: new Set(["ops"]),
};

describe("isSequenceFlagArgv", () => {
  test("detects --command anywhere in argv", () => {
    expect(isSequenceFlagArgv(["--bob", "--command", "ENTER"])).toBe(true);
    expect(isSequenceFlagArgv(["--command=ENTER", "--bob"])).toBe(true);
    expect(isSequenceFlagArgv(["--bob", "hello"])).toBe(false);
    expect(isSequenceFlagArgv([])).toBe(false);
  });

  test("send-syntax routing yields to sequence mode when --command is present", () => {
    // --write alone is the broadcast alias. With --command also present, the
    // send parser must NOT claim the argv.
    expect(
      isFlagSendArgv(["--write", "broadcast", "--command", "ENTER"]),
    ).toBe(false);
  });
});

describe("parseSequenceFlagArgv", () => {
  test("recipients via bare --<name> flags", () => {
    const parsed = parseSequenceFlagArgv(
      ["--bob", "--leah", "--command", "ENTER"],
      registry,
    );
    expect(parsed.action).toBe("sequence");
    expect(parsed.recipients).toEqual(["bob", "leah"]);
    expect(parsed.command).toBe("ENTER");
    expect(parsed.submit).toBe(true);
  });

  test("--write taken as a value flag in sequence mode", () => {
    const parsed = parseSequenceFlagArgv(
      ["--bob", "--command", "ENTER", "--write", "hi there"],
      registry,
    );
    expect(parsed.write).toBe("hi there");
  });

  test("multiple --command flags concatenate with implicit |", () => {
    const parsed = parseSequenceFlagArgv(
      ["--bob", "--command", "ESC", "--command", "ENTER"],
      registry,
    );
    expect(parsed.command).toBe("ESC|ENTER");
  });

  test("--no-submit clears the trailing-Enter rule", () => {
    const parsed = parseSequenceFlagArgv(
      ["--bob", "--command", "$write", "--write", "hi", "--no-submit"],
      registry,
    );
    expect(parsed.submit).toBe(false);
  });

  test("--stdin marks stdin sourcing", () => {
    const parsed = parseSequenceFlagArgv(
      ["--bob", "--command", "$write|ENTER", "--stdin"],
      registry,
    );
    expect(parsed.stdin).toBe(true);
  });

  test("rejects positional content", () => {
    expect(() =>
      parseSequenceFlagArgv(
        ["--bob", "--command", "ENTER", "leftover", "body"],
        registry,
      ),
    ).toThrow(/does not accept positional content/);
  });

  test("rejects unknown flags inside sequence mode", () => {
    expect(() =>
      parseSequenceFlagArgv(
        ["--bob", "--command", "ENTER", "--mystery"],
        registry,
      ),
    ).toThrow(/unknown flag --mystery/);
  });

  test("requires --command", () => {
    expect(() =>
      parseSequenceFlagArgv(["--bob", "--write", "hi"], registry),
    ).toThrow(/--command is required/);
  });

  test("rejects duplicate --write", () => {
    expect(() =>
      parseSequenceFlagArgv(
        ["--bob", "--command", "ENTER", "--write", "a", "--write", "b"],
        registry,
      ),
    ).toThrow(/--write specified more than once/);
  });

  test("--to resolves to recipient", () => {
    const parsed = parseSequenceFlagArgv(
      ["--to", "bob", "--command", "ENTER"],
      registry,
    );
    expect(parsed.recipients).toEqual(["bob"]);
    expect(parsed.broadcast).toBe(false);
  });

  test("deduplicates --to and bare sequence recipients without changing order", () => {
    const parsed = parseSequenceFlagArgv(
      ["--to", "bob", "--bob", "--leah", "--bob", "--command", "ENTER"],
      registry,
    );
    expect(parsed.recipients).toEqual(["bob", "leah"]);
  });

  test("broadcast when no recipients are given", () => {
    const parsed = parseSequenceFlagArgv(["--command", "ENTER"], registry);
    expect(parsed.recipients).toEqual([]);
    expect(parsed.broadcast).toBe(true);
  });
});

describe("legacy parseFlagSendArgv coexistence", () => {
  test("plain --write 'broadcast' still resolves to action=message", () => {
    expect(parseFlagSendArgv(["--write", "broadcast now"], registry)).toEqual({
      action: "message",
      recipients: [],
      broadcast: true,
      content: "broadcast now",
      from: null,
      origin: null,
      meta: {},
    });
  });

  test("parseFlagSendArgv returns null when --command is present", () => {
    expect(
      parseFlagSendArgv(
        ["--bob", "--command", "ENTER", "--write", "hi"],
        registry,
      ),
    ).toBeNull();
  });
});
