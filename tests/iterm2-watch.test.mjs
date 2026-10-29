import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { watchITerm2Sessions } from "../src/iterm2-delivery.mjs";
import { subscribeITermSessionPush } from "../src/transport-probes.mjs";

const cleanups = [];
afterEach(async () => {
    while ( cleanups.length ) {
        await cleanups.pop()();
    }
});

/** Fake plugin socket: answers `watch` with the ack, then the given lines;
 * any other op (or `watch` on a bare bridge) gets `unknown op`. */
function fakePlugin({ supportsWatch = true, lines = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "a2a-watch-"));
    const socketPath = join(dir, "bridge.sock");
    const requests = [];
    const server = createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl < 0) {
                return;
            }
            const req = JSON.parse(buf.slice(0, nl));
            requests.push(req);
            if (req.op === "watch" && supportsWatch) {
                sock.write(`${JSON.stringify({ ok: true, watching: true, connected: true })}\n`);
                for ( const line of lines ) {
                    sock.write(`${JSON.stringify(line)}\n`);
                }
                return;
            }
            sock.end(`${JSON.stringify({ ok: false, error: `unknown op: '${req.op}'` })}\n`);
        });
    });
    return new Promise((resolve) => server.listen(socketPath, () => {
        cleanups.push(() => new Promise((done) => server.close(() => {
            rmSync(dir, { recursive: true, force: true });
            done();
        })));
        resolve({ socketPath, requests });
    }));
}

function until(predicate, ms = 2000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (predicate()) {
                resolve();
            } else if (Date.now() - started > ms) {
                reject(new Error("timed out"));
            } else {
                setTimeout(tick, 10);
            }
        };
        tick();
    });
}

describe("watchITerm2Sessions", () => {
    test("opens the stream and delivers each event line in order", async () => {
        const plugin = await fakePlugin({ lines: [ { event: "session_created", session: "S1" }, { event: "session_terminated", session: "S1" } ] });
        const events = [];
        const states = [];
        const stop = watchITerm2Sessions({ socketPath: plugin.socketPath, onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
        cleanups.push(() => Promise.resolve(stop()));
        await until(() => events.length === 3);
        expect(plugin.requests).toEqual([ { op: "watch" } ]);
        expect(states).toEqual([ "open" ]);
        expect(events.map((e) => e.event)).toEqual([ "watch_opened", "session_created", "session_terminated" ]);
    });

    test("a bare bridge without the plugin is reported unsupported, not treated as a stream", async () => {
        const plugin = await fakePlugin({ supportsWatch: false });
        const events = [];
        const states = [];
        const stop = watchITerm2Sessions({ socketPath: plugin.socketPath, onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
        cleanups.push(() => Promise.resolve(stop()));
        await until(() => states.length === 1);
        expect(states).toEqual([ "unsupported" ]);
        expect(events).toEqual([]);
    });
});

describe("subscribeITermSessionPush", () => {
    test("every pushed event drops the cached session list before the caller sees it", () => {
        const seen = [];
        let emit;
        const stopPush = subscribeITermSessionPush({
            watch: ({ onEvent }) => {
                emit = onEvent;
                return () => undefined;
            },
            onEvent: (e) => seen.push(e.event)
        });
        cleanups.push(() => Promise.resolve(stopPush()));
        emit({ event: "session_created", session: "S1" });
        emit({ event: "disconnected" });
        expect(seen).toEqual([ "session_created", "disconnected" ]);
    });
});
