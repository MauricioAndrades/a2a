import test from "node:test";
import assert from "node:assert/strict";
import { broadcastSseChunk, sseFrameFromText } from "../src/channel/sse-utils.mjs";

test("sseFrameFromText emits one data line per input line", () => {
    assert.equal(sseFrameFromText("a\nb"), "data: a\ndata: b\n\n");
});

test("broadcastSseChunk removes dead emitter and delivers to surviving listeners", () => {
    const listeners = new Set();
    /** @type {string[]} */
    const got = [];
    const survivorA = /** @type {(c: string) => void} */ ((c) => got.push(`a:${c}`));
    const thrower = () => {
        throw new Error("write failed");
    };
    const survivorB = /** @type {(c: string) => void} */ ((c) => got.push(`b:${c}`));
    listeners.add(survivorA);
    listeners.add(thrower);
    listeners.add(survivorB);

    const chunk = "x";
    assert.doesNotThrow(() => broadcastSseChunk(listeners, chunk));

    assert.deepEqual(got.sort(), ["a:x", "b:x"]);
    assert.equal(listeners.has(thrower), false);
});
