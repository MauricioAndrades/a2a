import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { readTextBody } from "../src/channel/read-text-body.mjs";

function reqWithChunks(chunks) {
    const req = new EventEmitter();
    return {
        req,
        emitAll() {
            for (const c of chunks) {
                req.emit("data", Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"));
            }
            req.emit("end");
        },
    };
}

test("readTextBody preserves UTF-8 across chunk boundaries", async () => {
    const smile = Buffer.from("🙂", "utf8");
    const a = smile.subarray(0, 2);
    const b = smile.subarray(2);
    const { req, emitAll } = reqWithChunks([a, b]);
    const promise = readTextBody(req);
    emitAll();
    assert.equal(await promise, "🙂");
});

test("readTextBody rejects when byte budget exceeded (bytes not code units)", async () => {
    const big = Buffer.alloc(64, "x");
    const { req, emitAll } = reqWithChunks([big, big]);
    const promise = readTextBody(req, { maxBytes: 100 });
    emitAll();
    await assert.rejects(promise, /body too large/);
});
