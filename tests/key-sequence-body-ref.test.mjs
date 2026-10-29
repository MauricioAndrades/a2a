import { describe, expect, test } from "vitest";
import { compileSequence, computeSettleMs } from "../src/key-sequence.mjs";

describe("compileSequence — body auto-prepend vs quoted literals", () => {
  test("quoted '$write' is typed literally and does not suppress --write auto-prepend", () => {
    const body = "hello from --write";
    const { ops } = compileSequence("'$write'|ENTER", {
      vars: { write: body },
      submit: true,
    });

    expect(ops).toEqual([
      { kind: "paste", text: body },
      {
        kind: "sleep",
        ms: computeSettleMs(Buffer.byteLength(body, "utf8")),
      },
      { kind: "type", text: "$write" },
      { kind: "key", key: "ENTER" },
    ]);
  });

  test("double-quoted literal containing $write does not suppress auto-prepend", () => {
    const body = "payload";
    const { ops } = compileSequence('"$write"|ENTER', {
      vars: { write: body },
      submit: true,
    });

    expect(ops[0]).toEqual({ kind: "paste", text: body });
    expect(ops).toContainEqual({ kind: "type", text: "$write" });
  });

  test("explicit $write in sequence still suppresses duplicate auto-prepend", () => {
    const { ops } = compileSequence("$write|ENTER", {
      vars: { write: "only once" },
      submit: true,
    });

    const pastes = ops.filter((op) => op.kind === "paste");
    expect(pastes).toEqual([{ kind: "paste", text: "only once" }]);
  });
});
