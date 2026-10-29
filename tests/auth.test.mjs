import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  authFromRequest,
  configuredPeerUrl,
  isLoopbackAddress,
  isTrustedBrowserLoopbackHostname,
  secretsEqualUtf8,
} from "../src/server/auth.mjs";
import {
  channelStartupProblem,
  parseAllowedSenders,
} from "../src/channel/auth.mjs";

async function evaluateAuth(cfg, { authorization = "", address } = {}) {
  const server = createServer((req, res) => {
    if (address) {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: address,
        configurable: true,
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(authFromRequest(req, cfg)));
  });

  const port = await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const details = server.address();
      resolvePort(typeof details === "object" && details ? details.port : null);
    });
  });

  try {
    return await new Promise((resolveAuth, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
          headers: authorization ? { authorization } : undefined,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolveAuth(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("open bridge allows loopback only", async () => {
  assert.deepEqual(await evaluateAuth({ key: null, peers: {} }), {
    ok: true,
    kind: "local-open",
    loopback: true,
  });
  assert.deepEqual(
    await evaluateAuth({ key: null, peers: {} }, { address: "10.0.0.4" }),
    { ok: false },
  );
});

test("operator key authenticates as operator", async () => {
  assert.deepEqual(
    await evaluateAuth(
      {
      key: "root",
      peers: {},
      },
      { authorization: "Bearer root" },
    ),
    {
      ok: true,
      kind: "operator",
      loopback: true,
    },
  );
});

test("secretsEqualUtf8 is exact full-string match under SHA-256 digests", () => {
  assert.equal(secretsEqualUtf8("root", "root"), true);
  assert.equal(secretsEqualUtf8("root", "rootx"), false);
  assert.equal(secretsEqualUtf8("snowman-\u2603", "snowman-\u2603"), true);
});

test("peer key authenticates as peer", async () => {
  assert.deepEqual(
    await evaluateAuth(
      {
        key: "root",
        peers: { bob: { key: "peer-key", url: "https://bob.example/" } },
      },
      { authorization: "peer-key" },
    ),
    {
      ok: true,
      kind: "peer",
      peer: "bob",
      loopback: true,
    },
  );
});

test("configuredPeerUrl normalizes trailing slash", () => {
  assert.equal(
    configuredPeerUrl(
      { peers: { bob: { url: "https://bob.example/" } } },
      "bob",
    ),
    "https://bob.example",
  );
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
  assert.equal(
    channelStartupProblem({
      host: "0.0.0.0",
      allowed: parseAllowedSenders(""),
      key: "",
    }),
    "a2a-channel non-loopback host requires A2A_CHANNEL_SENDERS and A2A_CHANNEL_KEY",
  );
  assert.equal(
    channelStartupProblem({
      host: "0.0.0.0",
      allowed: parseAllowedSenders("ci"),
      key: "secret",
    }),
    null,
  );
  assert.equal(
    channelStartupProblem({
      host: "127.0.0.1",
      allowed: parseAllowedSenders(""),
      key: "",
    }),
    null,
  );
});
