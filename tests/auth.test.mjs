import test from "node:test";
import assert from "node:assert/strict";
import { authFromRequest, configuredPeerUrl, isLoopbackAddress, isTrustedBrowserLoopbackHostname } from "../src/server/auth.mjs";
import { channelStartupProblem, parseAllowedSenders } from "../src/channel/auth.mjs";

function req({ address = "127.0.0.1", authorization = "" } = {}) {
    return { socket: { remoteAddress: address }, headers: authorization ? { authorization } : {} };
}

test("open bridge allows loopback only", () => {
    assert.deepEqual(authFromRequest(req(), { key: null, peers: {} }), { ok: true, kind: "local-open", loopback: true });
    assert.deepEqual(authFromRequest(req({ address: "10.0.0.4" }), { key: null, peers: {} }), { ok: false });
});

test("operator key authenticates as operator", () => {
    assert.deepEqual(authFromRequest(req({ authorization: "Bearer root" }), { key: "root", peers: {} }), {
        ok: true,
        kind: "operator",
        loopback: true,
    });
});

test("peer key authenticates as peer", () => {
    assert.deepEqual(authFromRequest(req({ authorization: "peer-key" }), { key: "root", peers: { bob: { key: "peer-key", url: "https://bob.example/" } } }), {
        ok: true,
        kind: "peer",
        peer: "bob",
        loopback: true,
    });
});

test("configuredPeerUrl normalizes trailing slash", () => {
    assert.equal(configuredPeerUrl({ peers: { bob: { url: "https://bob.example/" } } }, "bob"), "https://bob.example");
});

test("loopback matcher includes IPv4-mapped loopback", () => {
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("trusted CORS hostnames accept IPv6 loopback literals from Origin URLs", () => {
    assert.equal(isTrustedBrowserLoopbackHostname("[::1]"), true);
    assert.equal(isTrustedBrowserLoopbackHostname("::1"), true);
    assert.equal(isTrustedBrowserLoopbackHostname("127.0.0.1"), true);
    assert.equal(isTrustedBrowserLoopbackHostname("LOCALHOST"), true);
    assert.equal(isTrustedBrowserLoopbackHostname("192.168.1.2"), false);
});

test("channel non-loopback startup requires sender allowlist and key", () => {
    assert.equal(channelStartupProblem({ host: "0.0.0.0", allowed: parseAllowedSenders(""), key: "" }), "a2a-channel non-loopback host requires A2A_CHANNEL_SENDERS and A2A_CHANNEL_KEY");
    assert.equal(channelStartupProblem({ host: "0.0.0.0", allowed: parseAllowedSenders("ci"), key: "secret" }), null);
    assert.equal(channelStartupProblem({ host: "127.0.0.1", allowed: parseAllowedSenders(""), key: "" }), null);
});
