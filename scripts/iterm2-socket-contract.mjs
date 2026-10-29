// Socket-contract parity check for the a2a iTerm2 bridge and plugin.
//
//   node scripts/iterm2-socket-contract.mjs <bridge.sock> <plugin.sock>
//
// Sends the same requests to a bare cmd/a2a-iterm2-bridge/bridge.py and to
// cmd/a2a-iterm2-plugin/plugin.py and compares the response *shape* of every
// op the bridge defines (keys, ok flag, error text), so the plugin can replace
// the bridge on the socket without any Node client noticing. Plugin-only ops
// must answer "unknown op" on the bare bridge — that is how the CLI detects a
// bridge without the plugin and falls back (presentInItermViaPlugin).
//
// Read-only: no request creates, closes, renames, focuses, or types into a
// session (every mutating op is sent with a missing or unknown guid).

import { createConnection } from "node:net";

const [ bridgeSock, pluginSock ] = process.argv.slice(2);
if (!bridgeSock || !pluginSock) {
    process.stderr.write("usage: iterm2-socket-contract.mjs <bridge.sock> <plugin.sock>\n");
    process.exit(2);
}

function raw(socketPath, line) {
    return new Promise((resolve) => {
        const sock = createConnection({ path: socketPath });
        let buf = "";
        const timer = setTimeout(() => {
            sock.destroy();
            resolve({ timeout: true });
        }, 10000);
        sock.on("connect", () => sock.write(line));
        sock.on("data", (d) => {
            buf += d;
        });
        sock.on("end", () => {
            clearTimeout(timer);
            resolve(JSON.parse(buf));
        });
        sock.on("error", (err) => {
            clearTimeout(timer);
            resolve({ socketError: err.code });
        });
    });
}

const UNKNOWN = "00000000-0000-0000-0000-000000000000";
const shared = [
    [ "ping", "{\"op\":\"ping\"}\n" ],
    [ "bad json", "not json\n" ],
    [ "unknown op", "{\"op\":\"nope\"}\n" ],
    [ "list_sessions", "{\"op\":\"list_sessions\"}\n" ],
    [ "send_text no guid", "{\"op\":\"send_text\",\"params\":{\"text\":\"x\"}}\n" ],
    [ "send_text unknown guid", `{"op":"send_text","params":{"guid":"${UNKNOWN}","text":"x"}}\n` ],
    [ "send_keys empty steps", `{"op":"send_keys","params":{"guid":"${UNKNOWN}","steps":[]}}\n` ],
    [ "send_keys unknown guid", `{"op":"send_keys","params":{"guid":"${UNKNOWN}","steps":[{"type":"key","key":"ENTER"}]}}\n` ],
    [ "screen unknown guid", `{"op":"screen","params":{"guid":"${UNKNOWN}"}}\n` ],
    [ "spawn no name", "{\"op\":\"spawn\",\"params\":{\"command\":\"true\"}}\n" ],
    [ "spawn bad where", "{\"op\":\"spawn\",\"params\":{\"name\":\"x\",\"command\":\"true\",\"cwd\":\"/tmp\",\"where\":\"moon\"}}\n" ],
    [ "close unknown guid", `{"op":"close","params":{"guid":"${UNKNOWN}"}}\n` ],
    [ "focus unknown guid", `{"op":"focus","params":{"guid":"${UNKNOWN}"}}\n` ],
    [ "set_name no name", `{"op":"set_name","params":{"guid":"${UNKNOWN}"}}\n` ],
    [ "configure_session unknown guid", `{"op":"configure_session","params":{"guid":"${UNKNOWN}"}}\n` ]
];
const pluginOnly = [ "present", "status", "notify", "clear_unread", "show_toolbelt" ];

function shape(resp) {
    if (resp.sessions) {
        const keys = new Set(resp.sessions.flatMap((s) => Object.keys(s)));
        return { ...resp, sessions: `[${resp.sessions.length > 0 ? [ ...keys ].sort().join(",") : "empty"}]` };
    }
    return resp;
}

let failures = 0;
for ( const [ name, line ] of shared ) {
    const [ a, b ] = await Promise.all([ raw(bridgeSock, line), raw(pluginSock, line) ]);
    const same = JSON.stringify(shape(a)) === JSON.stringify(shape(b));
    if (!same) {
        failures++;
    }
    process.stdout.write(`${same ? "PASS" : "FAIL"}  ${name}  bridge=${JSON.stringify(shape(a))}${same ? "" : `  plugin=${JSON.stringify(shape(b))}`}\n`);
}
for ( const op of pluginOnly ) {
    const resp = await raw(bridgeSock, `{"op":"${op}","params":{}}\n`);
    const ok = resp.ok === false && resp.error === `unknown op: '${op}'`;
    if (!ok) {
        failures++;
    }
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  bare bridge rejects plugin op ${op}: ${JSON.stringify(resp)}\n`);
}
process.stdout.write(`${failures === 0 ? "parity: all checks pass" : `parity: ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
