import { describe, expect, test } from "vitest";
import {
  KEY_TABLE,
  chordBytes,
  compileOpToBytes,
  compileOpToTmuxKeys,
  compileSequence,
  computeSettleMs,
  parseCommandDsl,
} from "../src/key-sequence.mjs";

describe("parseCommandDsl", () => {
  test("named keys", () => {
    expect(parseCommandDsl("ENTER", {})).toEqual([{ kind: "key", key: "ENTER" }]);
    expect(parseCommandDsl("ESC|ENTER", {})).toEqual([
      { kind: "key", key: "ESC" },
      { kind: "key", key: "ENTER" },
    ]);
  });

  test("body variable substitution", () => {
    expect(parseCommandDsl("$write", { write: "hello" })).toEqual([
      { kind: "paste", text: "hello" },
    ]);
    // eslint-disable-next-line no-template-curly-in-string
    expect(parseCommandDsl("${write}", { write: "hello" })).toEqual([
      { kind: "paste", text: "hello" },
    ]);
    expect(parseCommandDsl("$content", { write: "hi" })).toEqual([
      { kind: "paste", text: "hi" },
    ]);
    expect(parseCommandDsl("$command", { write: "hi" })).toEqual([
      { kind: "paste", text: "hi" },
    ]);
  });

  test("env vars require an explicit env table", () => {
    expect(
      // eslint-disable-next-line no-template-curly-in-string
      parseCommandDsl("${env:FOO}", { env: { FOO: "bar" } }),
    ).toEqual([{ kind: "paste", text: "bar" }]);
    // eslint-disable-next-line no-template-curly-in-string
    expect(() => parseCommandDsl("${env:NOPE}", { env: {} })).toThrow(
      /undefined env var/,
    );
  });

  test("slash commands type literally", () => {
    expect(parseCommandDsl("/clear", {})).toEqual([
      { kind: "type", text: "/clear" },
    ]);
    expect(parseCommandDsl("/model sonnet", {})).toEqual([
      { kind: "type", text: "/model sonnet" },
    ]);
  });

  test("quoted literals type, do not paste, no $ expansion", () => {
    expect(parseCommandDsl("'$write'", { write: "DO NOT EXPAND" })).toEqual([
      { kind: "type", text: "$write" },
    ]);
    expect(parseCommandDsl('"a|b"', {})).toEqual([
      { kind: "type", text: "a|b" },
    ]);
  });

  test("chords", () => {
    expect(parseCommandDsl("C-c", {})).toEqual([
      { kind: "chord", mods: ["C"], key: "c" },
    ]);
    expect(parseCommandDsl("C-S-Tab", {})).toEqual([
      { kind: "chord", mods: ["C", "S"], key: "TAB" },
    ]);
    expect(parseCommandDsl("M-x", {})).toEqual([
      { kind: "chord", mods: ["M"], key: "x" },
    ]);
    expect(parseCommandDsl("A-x", {})).toEqual([
      { kind: "chord", mods: ["M"], key: "x" },
    ]);
  });

  test("repeats unroll at parse time", () => {
    expect(parseCommandDsl("BSPACE*3", {})).toEqual([
      { kind: "key", key: "BSPACE" },
      { kind: "key", key: "BSPACE" },
      { kind: "key", key: "BSPACE" },
    ]);
  });

  test("explicit sleeps", () => {
    expect(parseCommandDsl("SLEEP(250)", {})).toEqual([
      { kind: "sleep", ms: 250 },
    ]);
  });

  test("rejects unknown tokens", () => {
    expect(() => parseCommandDsl("WAT", {})).toThrow(/unknown command step/);
    expect(() => parseCommandDsl("$undef", {})).toThrow(/undefined command variable/);
    expect(() => parseCommandDsl("", {})).toThrow(/must not be empty/);
    expect(() => parseCommandDsl("BSPACE*0", {})).toThrow(/repeat count/);
  });
});

describe("compileSequence", () => {
  test("auto-prepends $write paste when sequence does not reference body", () => {
    const { ops, summary } = compileSequence("ENTER", {
      vars: { write: "hello" },
      submit: true,
    });
    expect(ops[0]).toEqual({ kind: "paste", text: "hello" });
    expect(ops[1].kind).toBe("sleep");
    expect(ops[2]).toEqual({ kind: "key", key: "ENTER" });
    expect(summary.pastes).toBe(1);
    expect(summary.keys).toBe(1);
  });

  test("does NOT auto-prepend when sequence references $write", () => {
    const { ops } = compileSequence("ESC|$write|ENTER", {
      vars: { write: "hi" },
      submit: true,
    });
    // ESC, paste, sleep, ENTER (no trailing auto-Enter since the user gave one)
    expect(ops[0]).toEqual({ kind: "key", key: "ESC" });
    expect(ops[1]).toEqual({ kind: "paste", text: "hi" });
    expect(ops[2].kind).toBe("sleep");
    expect(ops[3]).toEqual({ kind: "key", key: "ENTER" });
    expect(ops.length).toBe(4);
  });

  test("appends trailing ENTER when tail is paste/type and submit=true", () => {
    const { ops } = compileSequence("$write", {
      vars: { write: "context" },
      submit: true,
    });
    expect(ops.at(-1)).toEqual({ kind: "key", key: "ENTER" });
  });

  test("submit=false suppresses trailing ENTER", () => {
    const { ops } = compileSequence("$write", {
      vars: { write: "context" },
      submit: false,
    });
    expect(ops.at(-1).kind).not.toBe("key");
  });

  test("worked example: ESC|ENTER|/cmd|$write", () => {
    const { ops } = compileSequence("ESC|ENTER|/any-command|$write", {
      vars: { write: "context" },
      submit: true,
    });
    expect(ops).toEqual([
      { kind: "key", key: "ESC" },
      { kind: "key", key: "ENTER" },
      { kind: "type", text: "/any-command" },
      { kind: "paste", text: "context" },
      { kind: "sleep", ms: computeSettleMs(Buffer.byteLength("context", "utf8")) },
      { kind: "key", key: "ENTER" },
    ]);
  });

  test("worked example: literal --command ENTER --write 'hello…' auto-prepends body", () => {
    const { ops } = compileSequence("ENTER", {
      vars: { write: "hello i just hit enter" },
      submit: true,
    });
    expect(ops).toEqual([
      { kind: "paste", text: "hello i just hit enter" },
      {
        kind: "sleep",
        ms: computeSettleMs(
          Buffer.byteLength("hello i just hit enter", "utf8"),
        ),
      },
      { kind: "key", key: "ENTER" },
    ]);
  });
});

describe("compileSequence — repeat markers on body variables", () => {
  test("$write*2 pastes exactly twice — repeat must not also auto-prepend the body", () => {
    const { ops } = compileSequence("$write*2", {
      vars: { write: "body" },
      submit: true,
    });
    expect(ops.filter((op) => op.kind === "paste")).toEqual([
      { kind: "paste", text: "body" },
      { kind: "paste", text: "body" },
    ]);
  });

  // eslint-disable-next-line no-template-curly-in-string
  test("${write}*3 is also recognized as a body reference", () => {
    // eslint-disable-next-line no-template-curly-in-string
    const { ops } = compileSequence("${write}*3", {
      vars: { write: "x" },
      submit: false,
    });
    expect(ops.filter((op) => op.kind === "paste")).toHaveLength(3);
  });

  test("quoted '$write'*2 is literal text and still auto-prepends the body", () => {
    const { ops } = compileSequence("'$write'*2|ENTER", {
      vars: { write: "body" },
      submit: true,
    });
    expect(ops.filter((op) => op.kind === "paste")).toEqual([
      { kind: "paste", text: "body" },
    ]);
    expect(ops.filter((op) => op.kind === "type")).toEqual([
      { kind: "type", text: "$write" },
      { kind: "type", text: "$write" },
    ]);
  });
});

describe("quoted literal escapes", () => {
  test("backslash before a non-quote char passes through verbatim", () => {
    expect(parseCommandDsl(String.raw`"C:\new"`, {})).toEqual([
      { kind: "type", text: "C:\\new" },
    ]);
    expect(parseCommandDsl(String.raw`'\n'`, {})).toEqual([
      { kind: "type", text: "\\n" },
    ]);
  });

  test("only \\\\, \\' and \\\" unescape", () => {
    expect(parseCommandDsl(String.raw`"a\"b"`, {})).toEqual([
      { kind: "type", text: 'a"b' },
    ]);
    expect(parseCommandDsl(String.raw`'a\'b'`, {})).toEqual([
      { kind: "type", text: "a'b" },
    ]);
    expect(parseCommandDsl(String.raw`"x\\y"`, {})).toEqual([
      { kind: "type", text: "x\\y" },
    ]);
  });
});

describe("compileOpToTmuxKeys", () => {
  test("named keys map to tmux names", () => {
    expect(compileOpToTmuxKeys({ kind: "key", key: "ENTER" })).toEqual(["Enter"]);
    expect(compileOpToTmuxKeys({ kind: "key", key: "BSPACE" })).toEqual(["BSpace"]);
    expect(compileOpToTmuxKeys({ kind: "key", key: "PGUP" })).toEqual(["PageUp"]);
  });

  test("chords use the same tmux modifier prefix", () => {
    expect(compileOpToTmuxKeys({ kind: "chord", mods: ["C"], key: "c" })).toEqual([
      "C-c",
    ]);
    expect(
      compileOpToTmuxKeys({ kind: "chord", mods: ["C", "S"], key: "Tab" }),
    ).toEqual(["C-S-Tab"]);
  });

  test("paste/type/sleep are not key ops", () => {
    expect(compileOpToTmuxKeys({ kind: "paste", text: "x" })).toBeNull();
    expect(compileOpToTmuxKeys({ kind: "type", text: "x" })).toBeNull();
    expect(compileOpToTmuxKeys({ kind: "sleep", ms: 0 })).toBeNull();
  });
});

describe("compileOpToBytes", () => {
  test("named keys map to raw bytes", () => {
    expect(compileOpToBytes({ kind: "key", key: "ENTER" })).toBe("\r");
    expect(compileOpToBytes({ kind: "key", key: "ESC" })).toBe("\x1b");
    expect(compileOpToBytes({ kind: "key", key: "TAB" })).toBe("\t");
    expect(compileOpToBytes({ kind: "key", key: "BSPACE" })).toBe("\x7f");
    expect(compileOpToBytes({ kind: "key", key: "UP" })).toBe("\x1b[A");
    expect(compileOpToBytes({ kind: "key", key: "F5" })).toBe("\x1b[15~");
  });

  test("Ctrl-letter applies the 0x1f mask", () => {
    expect(compileOpToBytes({ kind: "chord", mods: ["C"], key: "c" })).toBe(
      "\x03",
    );
    expect(compileOpToBytes({ kind: "chord", mods: ["C"], key: "d" })).toBe(
      "\x04",
    );
  });

  test("Meta prepends ESC", () => {
    expect(compileOpToBytes({ kind: "chord", mods: ["M"], key: "x" })).toBe(
      "\x1bx",
    );
  });

  test("paste/type return their literal text", () => {
    expect(compileOpToBytes({ kind: "paste", text: "hi" })).toBe("hi");
    expect(compileOpToBytes({ kind: "type", text: "/clear" })).toBe("/clear");
  });
});

describe("chordBytes", () => {
  test("Ctrl-Shift-z uppercases first then masks", () => {
    expect(chordBytes(["C", "S"], "z")).toBe("\x1a");
  });

  test("Meta with named key prepends ESC to that key's bytes", () => {
    expect(chordBytes(["M"], "ENTER")).toBe("\x1b\r");
  });
});

describe("KEY_TABLE invariants", () => {
  test("every key has both tmux name and bytes", () => {
    for (const [name, entry] of Object.entries(KEY_TABLE)) {
      expect(typeof entry.tmux, `${name}.tmux`).toBe("string");
      expect(entry.tmux.length, `${name}.tmux nonempty`).toBeGreaterThan(0);
      expect(typeof entry.bytes, `${name}.bytes`).toBe("string");
      expect(entry.bytes.length, `${name}.bytes nonempty`).toBeGreaterThan(0);
    }
  });
});
