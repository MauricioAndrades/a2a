import { describe, expect, test } from "vitest";
import {
  chordBytes,
  compileOpToBytes,
  compileOpToTmuxKeys,
  compileSequence,
} from "../src/key-sequence.mjs";

describe("compileSequence backend submit", () => {
  test("cursor-agent auto-submit uses C-ENTER chord", () => {
    const { ops } = compileSequence("$write", {
      vars: { write: "hello" },
      submit: true,
      backend: "cursor-agent",
    });
    expect(ops.at(-1)).toEqual({
      kind: "chord",
      mods: ["C"],
      key: "ENTER",
    });
  });
});

describe("Shift+Tab chord bytes", () => {
  test("S-TAB chord emits BTAB bytes, not plain Tab", () => {
    expect(chordBytes(["S"], "TAB")).toBe("\x1b[Z");
    expect(
      compileOpToBytes({ kind: "chord", mods: ["S"], key: "TAB" }),
    ).toBe("\x1b[Z");
  });

  test("tmux and iTerm paths stay aligned for S-Tab chord spelling", () => {
    expect(
      compileOpToTmuxKeys({ kind: "chord", mods: ["S"], key: "TAB" }),
    ).toEqual(["S-Tab"]);
    expect(compileOpToBytes({ kind: "key", key: "BTAB" })).toBe("\x1b[Z");
  });

  test("C-ENTER chord emits ESC+CR for cursor-agent submit parity", () => {
    expect(chordBytes(["C"], "ENTER")).toBe("\x1b\r");
    expect(
      compileOpToBytes({ kind: "chord", mods: ["C"], key: "ENTER" }),
    ).toBe("\x1b\r");
    expect(
      compileOpToTmuxKeys({ kind: "chord", mods: ["C"], key: "ENTER" }),
    ).toEqual(["C-Enter"]);
  });
});
