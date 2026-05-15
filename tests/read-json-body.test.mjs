import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readJsonBody } from "../src/server/read-json-body.mjs";

function reqEmitSequence(events) {
    const req = new EventEmitter();
    queueMicrotask(() => {
        for (const [name, payload] of events) req.emit(name, payload);
    });
    return req;
}

test("readJsonBody parses UTF-8 object across chunk boundaries", async () => {
    const json = '{"x":"🙂"}';
    const bytes = Buffer.from(json, "utf8");
    const mid = Math.ceil(bytes.length / 2);
    const req = reqEmitSequence([
        ["data", bytes.subarray(0, mid)],
        ["data", bytes.subarray(mid)],
        ["end", undefined],
    ]);
    assert.deepEqual(await readJsonBody(req), { x: "🙂" });
});

test("readJsonBody enforces byte cap (not UTF-16 code-unit length)", async () => {
    /** Two-byte UTF-8 chars: JS .length counts 1 each but bytes are 2 — cap uses Buffer byte length */
    const payload = `{"a":"${"\u00a3".repeat(51)}"}`;
    assert.ok(Buffer.byteLength(payload, "utf8") > 100);
    const req = reqEmitSequence([["data", Buffer.from(payload, "utf8")], ["end", undefined]]);
    await assert.rejects(() => readJsonBody(req, 100), /too large/);
});

test("readJsonBody does not resolve after oversize reject even when end fires", async () => {
    let settledResult = /** @type {"rej"|"res"|null} */ (null);
    const req = new EventEmitter();
    const p = readJsonBody(req, 8).then(
        () => { settledResult = "res"; },
        () => { settledResult = "rej"; },
    );
    req.emit("data", Buffer.from('"123456789"')); // >8 bytes → reject
    req.emit("end"); // must not flip to resolved JSON
    await p;
    assert.equal(settledResult, "rej");
});
