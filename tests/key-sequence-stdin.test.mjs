import { describe, expect, test } from "vitest";
import { compileSequence, computeSettleMs } from "../src/key-sequence.mjs";

describe("compileSequence — $stdin body placement", () => {
  test("explicit $stdin in command does not duplicate auto-prepended --write body", () => {
    const body = "stdin payload";
    const { ops } = compileSequence("$stdin|ENTER", {
      vars: { write: body, stdin: body },
      submit: true,
    });

    expect(ops).toEqual([
      { kind: "paste", text: body },
      {
        kind: "sleep",
        ms: computeSettleMs(Buffer.byteLength(body, "utf8")),
      },
      { kind: "key", key: "ENTER" },
    ]);
  });
});
