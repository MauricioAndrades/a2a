import { afterEach, describe, expect, test } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  constantTimeEquals, parseSigningSecret, sign, signedPayload, signingHeaders,
  verifySignatureHeader, webhookId, MAX_PAYLOAD_BYTES,
} from "../src/dots/webhooks.mjs";
import { addressReason, createCallbackGuard, parseCallbackUrl } from "../src/dots/callback-guard.mjs";
import { createEventStore, EventStateError, redactSubscription } from "../src/dots/event-store.mjs";
import { canonicalJson, createEventService, EVENT_NAME, matchesFilters, subscriptionIdFor } from "../src/dots/events.mjs";
import {
  createModernHandler, HEADER_MISMATCH, INVALID_PARAMS, isModernRequest, METHOD_NOT_FOUND,
  PROTOCOL_VERSION, UNSUPPORTED_PROTOCOL_VERSION, CALLBACK_ENDPOINT_ERROR, RpcError,
  META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_SERVER_INFO,
} from "../src/dots/mcp-modern.mjs";
import { eventsConfig } from "../src/dots/config.mjs";
import { createToolRouter } from "../src/dots/tools.mjs";

// A valid whsec_ secret: 32 bytes, so inside the 24-64 byte window.
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const SECRET_TWO = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const EVENTS_KEY = "fixture-events-key-0123456789";
const PRINCIPAL = "chatgpt";
// An ordinary public address. The fixture swaps the transport, never the
// address policy, so production's public-only rule is exercised as written.
const PUBLIC_IP = "93.184.216.34";
const CALLBACK = "https://events.example.com/hook";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "a2a-events-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Acts as the subscriber endpoint. Verification always echoes the challenge
// unless the test overrides it; event posts follow the supplied handler.
async function subscriber(handler, verifyHandler) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      const entry = { headers: req.headers, raw, body };
      received.push(entry);
      const outcome = body?.type === "verification"
        ? (verifyHandler ? verifyHandler(entry) : { status: 200, body: { challenge: body.challenge } })
        : (handler ? handler(entry, received) : { status: 200, body: { ok: true } });
      res.writeHead(outcome.status, { "content-type": "application/json" });
      res.end(typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? {}));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const { port } = server.address();
  return {
    port, received,
    events: () => received.filter((entry) => entry.body?.type !== "verification"),
    verifications: () => received.filter((entry) => entry.body?.type === "verification"),
  };
}

// Only the transport is injected. Address classification stays production.
const publicLookup = () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);
function fixtureHttps(port) {
  return (url, options, onResponse) => {
    const target = new URL(url);
    return httpRequest({
      hostname: "127.0.0.1", port, path: `${target.pathname}${target.search}`,
      method: options.method, headers: options.headers,
    }, onResponse);
  };
}

function testConfig(overrides = {}) {
  return {
    ...eventsConfig({ A2A_DOTS_EVENTS_KEY: EVENTS_KEY }, "http://127.0.0.1:7743"),
    retryBaseMs: 1, retryMaxMs: 5, maxAttempts: 3, deliveryDeadlineMs: 500,
    ...overrides,
  };
}

function makeService({ dir = stateDir(), port, config = {}, now, maxJournal } = {}) {
  const store = createEventStore({ dir, maxJournal });
  const guard = createCallbackGuard({
    lookup: publicLookup, request: fixtureHttps(port), deadlineMs: 500,
  });
  // A virtual clock that sleep advances. Backoff is then deterministic and
  // costs no wall time, while the retry schedule is still genuinely honoured
  // rather than skipped.
  let clock = Date.now();
  const service = createEventService({
    dotId: "dot", store, guard, config: testConfig(config),
    schedule: () => undefined,
    now: now || (() => clock),
    sleep: (ms) => { clock += Math.max(ms, 1); return Promise.resolve(); },
  });
  return { store, guard, service, dir };
}

const subscribeParams = (overrides = {}) => ({
  name: EVENT_NAME,
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  ...overrides,
});

const accepted = (overrides = {}) => ({
  to: "dot", messageId: "a2amsg_fixture", from: "worker", origin: "peer",
  action: "reply", text: "fixture body", receivedAt: "2026-10-08T00:00:00.000Z",
  ...overrides,
});

const PROVENANCE = { senderClaimed: true, bridgeAuthenticated: false, transport: "a2a-bridge-callback" };

// ---------------------------------------------------------------- signing

describe("Standard Webhooks signing", () => {
  test("signs the normative id.timestamp.body string", () => {
    expect(signedPayload("msg_1", 1700000000, "{}")).toBe("msg_1.1700000000.{}");
    const key = parseSigningSecret(SECRET);
    const expected = `v1,${createHmac("sha256", key).update("msg_1.1700000000.{}", "utf8").digest("base64")}`;
    expect(sign(key, "msg_1", 1700000000, "{}")).toBe(expected);
  });

  test("rejects an id containing a full stop, which would make the signed string ambiguous", () => {
    expect(() => signedPayload("msg.1", 1, "{}")).toThrow(/without '\.'/);
    expect(webhookId("msg")).not.toContain(".");
  });

  test("accepts only a whsec_ secret decoding to 24-64 bytes", () => {
    expect(parseSigningSecret(SECRET)).toHaveLength(32);
    expect(() => parseSigningSecret("nope")).toThrow(/whsec_/);
    expect(() => parseSigningSecret(`whsec_${Buffer.alloc(8).toString("base64")}`)).toThrow(/24-64/);
    expect(() => parseSigningSecret(`whsec_${Buffer.alloc(80).toString("base64")}`)).toThrow(/24-64/);
    expect(() => parseSigningSecret("whsec_!!!!")).toThrow(/base64/);
  });

  test("verifies a correct signature and refuses a wrong one", () => {
    const key = parseSigningSecret(SECRET);
    const good = sign(key, "msg_1", 10, "body");
    expect(verifySignatureHeader(good, key, "msg_1", 10, "body")).toBe(true);
    expect(verifySignatureHeader(good, key, "msg_1", 11, "body")).toBe(false);
    expect(verifySignatureHeader(good, key, "msg_1", 10, "other")).toBe(false);
    expect(verifySignatureHeader("v1,AAAA", key, "msg_1", 10, "body")).toBe(false);
  });

  test("emits a space delimited list so a key rotation verifies under either key", () => {
    const first = parseSigningSecret(SECRET);
    const second = parseSigningSecret(SECRET_TWO);
    const headers = signingHeaders({ secretKeys: [first, second], id: "msg_1", body: "b", subscriptionId: "sub_1", timestampSeconds: 10 });
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(verifySignatureHeader(headers["webhook-signature"], first, "msg_1", 10, "b")).toBe(true);
    expect(verifySignatureHeader(headers["webhook-signature"], second, "msg_1", 10, "b")).toBe(true);
  });

  test("sets every required delivery header", () => {
    const headers = signingHeaders({ secretKey: parseSigningSecret(SECRET), id: "msg_1", body: "{}", subscriptionId: "sub_9", timestampSeconds: 42 });
    expect(headers["webhook-id"]).toBe("msg_1");
    expect(headers["webhook-timestamp"]).toBe("42");
    expect(headers["X-MCP-Subscription-Id"]).toBe("sub_9");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("constant time comparison handles unequal lengths without throwing", () => {
    expect(constantTimeEquals("a", "a")).toBe(true);
    expect(constantTimeEquals("a", "abcdef")).toBe(false);
  });
});

// -------------------------------------------------------- address policy

describe("callback address policy", () => {
  test("refuses IPv4 loopback, private, link-local and CGNAT", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(addressReason(address), address).not.toBeNull();
    }
  });

  test("refuses IPv4-mapped IPv6 in hex group spelling, not only dotted", () => {
    // Regression: a dotted-only match let ::ffff:7f00:1 through as public.
    expect(addressReason("::ffff:7f00:1")).toBe("loopback");
    expect(addressReason("::ffff:a00:1")).toBe("private");
    expect(addressReason("::ffff:c0a8:1")).toBe("private");
    expect(addressReason("::ffff:127.0.0.1")).toBe("loopback");
    expect(addressReason("::ffff:10.0.0.1")).toBe("private");
  });

  test("refuses IPv6 loopback, unique local, link-local, site-local and reserved", () => {
    expect(addressReason("::1")).toBe("loopback");
    expect(addressReason("::")).toBe("unspecified");
    expect(addressReason("::2")).toBe("reserved");
    expect(addressReason("fc00::1")).toBe("unique local");
    expect(addressReason("fe80::1")).toBe("link-local");
    expect(addressReason("fec0::1")).toBe("site-local");
    expect(addressReason("ff02::1")).toBe("multicast");
    expect(addressReason("2001:db8::1")).toBe("documentation");
  });

  test("allows ordinary public addresses", () => {
    expect(addressReason(PUBLIC_IP)).toBeNull();
    expect(addressReason("2606:2800:220:1::1")).toBeNull();
  });

  test("requires https and refuses embedded credentials", () => {
    expect(() => parseCallbackUrl("http://events.example.com/hook")).toThrow(/https/);
    expect(() => parseCallbackUrl("https://u:p@events.example.com/hook")).toThrow(/credentials/);
    expect(() => parseCallbackUrl("https://events.example.com/hook#frag")).toThrow(/fragment/);
    expect(parseCallbackUrl(CALLBACK).hostname).toBe("events.example.com");
  });

  test("refuses the whole hostname when any resolved address is non-public", async () => {
    const guard = createCallbackGuard({
      lookup: () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }, { address: "127.0.0.1", family: 4 }]),
      request: fixtureHttps(1), deadlineMs: 200,
    });
    await expect(guard.validate(CALLBACK)).rejects.toThrow(/loopback/);
  });

  test("rejects a literal private address in the URL", async () => {
    const guard = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(1), deadlineMs: 200 });
    await expect(guard.validate("https://127.0.0.1/hook")).rejects.toThrow(/loopback/);
    await expect(guard.validate("https://[::1]/hook")).rejects.toThrow(/loopback/);
  });

  test("refuses to follow a redirect", async () => {
    const endpoint = await subscriber(() => ({ status: 302, body: {} }));
    const guard = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(endpoint.port), deadlineMs: 500 });
    await expect(guard.deliver(CALLBACK, {
      body: "{}", secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1", id: "msg_1",
    })).rejects.toThrow(/redirect/);
  });

  test("pins the validated address in the shape Node actually asks for", async () => {
    // The fixture transport ignores options.lookup, so the pinning contract is
    // asserted directly: with autoSelectFamily on, Node passes all:true and
    // expects an array, and the two-argument string form breaks the pin.
    const endpoint = await subscriber(() => ({ status: 200, body: {} }));
    const forward = fixtureHttps(endpoint.port);
    let captured;
    const guard = createCallbackGuard({
      lookup: publicLookup,
      request: (url, options, onResponse) => {
        captured = options;
        return forward(url, options, onResponse);
      },
      deadlineMs: 500,
    });
    await guard.deliver(CALLBACK, {
      body: "{}", secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1", id: "msg_1",
    });
    expect(captured.autoSelectFamily).toBe(false);

    const asArray = await new Promise((done) => captured.lookup("events.example.com", { all: true }, (_e, value) => done(value)));
    expect(asArray).toEqual([{ address: PUBLIC_IP, family: 4 }]);

    const asString = await new Promise((done) => captured.lookup("events.example.com", {}, (_e, address, family) => done({ address, family })));
    expect(asString).toEqual({ address: PUBLIC_IP, family: 4 });
  });

  test("enforces the deadline when DNS never settles", async () => {
    // Regression: aborting the signal does not reject a resolver promise that
    // never settles, so the whole operation has to be raced against the clock.
    const guard = createCallbackGuard({
      lookup: () => new Promise(() => undefined), request: fixtureHttps(1), deadlineMs: 20,
    });
    const started = Date.now();
    await expect(guard.validate(CALLBACK)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("rejects an oversized response instead of truncating it", async () => {
    const endpoint = await subscriber(() => ({ status: 200, body: "x".repeat(70 * 1024) }));
    const guard = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(endpoint.port), deadlineMs: 500 });
    await expect(guard.deliver(CALLBACK, {
      body: "{}", secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1", id: "msg_1",
    })).rejects.toThrow(/exceeded/);
  });

  test("verification requires a 2xx and an exact challenge echo", async () => {
    const good = await subscriber(null, (entry) => ({ status: 200, body: { challenge: entry.body.challenge } }));
    const guardGood = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(good.port), deadlineMs: 500 });
    await expect(guardGood.verify(CALLBACK, { secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1" })).resolves.toBe(true);
    expect(good.verifications()).toHaveLength(1);
    expect(good.verifications()[0].headers["x-mcp-subscription-id"]).toBe("sub_1");

    const wrong = await subscriber(null, () => ({ status: 200, body: { challenge: "not-it" } }));
    const guardWrong = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(wrong.port), deadlineMs: 500 });
    await expect(guardWrong.verify(CALLBACK, { secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1" })).rejects.toThrow(/echo/);

    const refused = await subscriber(null, () => ({ status: 403, body: {} }));
    const guardRefused = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(refused.port), deadlineMs: 500 });
    await expect(guardRefused.verify(CALLBACK, { secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1" })).rejects.toThrow(/HTTP 403/);
  });

  test("signs the verification request with the subscription secret", async () => {
    const endpoint = await subscriber(null, (entry) => ({ status: 200, body: { challenge: entry.body.challenge } }));
    const guard = createCallbackGuard({ lookup: publicLookup, request: fixtureHttps(endpoint.port), deadlineMs: 500 });
    await guard.verify(CALLBACK, { secretKey: parseSigningSecret(SECRET), subscriptionId: "sub_1" });
    const sent = endpoint.verifications()[0];
    expect(verifySignatureHeader(
      sent.headers["webhook-signature"], parseSigningSecret(SECRET),
      sent.headers["webhook-id"], Number(sent.headers["webhook-timestamp"]), sent.raw,
    )).toBe(true);
  });
});

// -------------------------------------------------------- durable store

describe("durable event state", () => {
  test("reuses generation, subscriptions and journal across a restart", () => {
    const dir = stateDir();
    const first = createEventStore({ dir });
    first.putSubscription({ id: "sub_1", principal: PRINCIPAL, url: CALLBACK, name: EVENT_NAME, arguments: {}, secret: SECRET });
    const record = first.appendEvent({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() });

    const second = createEventStore({ dir });
    expect(second.generation).toBe(first.generation);
    expect(second.sequence).toBe(1);
    expect(second.getSubscription("sub_1").secret).toBe(SECRET);
    expect(second.journalEvent("evt_1").cursor).toBe(record.cursor);
  });

  test("fails closed on a corrupt state file and leaves the bytes untouched", () => {
    const dir = stateDir();
    const path = join(dir, "events.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{not json");
    expect(() => createEventStore({ dir })).toThrow(EventStateError);
    // The original file must survive: overwriting would destroy live
    // subscriptions and the generation behind every issued cursor.
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  test("fails closed on an unsupported version without rewriting", () => {
    const dir = stateDir();
    const path = join(dir, "events.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, generation: "x" }));
    expect(() => createEventStore({ dir })).toThrow(/unsupported version/);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(99);
  });

  test("a queued delivery keeps its envelope when the journal cap evicts the event", () => {
    const store = createEventStore({ dir: stateDir(), maxJournal: 1 });
    const first = store.appendEventWithDeliveries(
      { eventId: "evt_one", name: EVENT_NAME, timestamp: "t1", data: accepted({ text: "first" }) }, ["sub_1"],
    );
    store.appendEvent({ eventId: "evt_two", name: EVENT_NAME, timestamp: "t2", data: accepted({ text: "second" }) });
    expect(store.journalEvent("evt_one")).toBeUndefined();
    const delivery = store.getDelivery(`sub_1:${first.eventId}`);
    expect(delivery.state).toBe("queued");
    expect(delivery.event.data.text).toBe("first");
  });

  test("never evicts a queued delivery to honour the outbox cap", () => {
    const store = createEventStore({ dir: stateDir(), maxOutbox: 1 });
    store.appendEventWithDeliveries({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() }, ["sub_1"]);
    store.appendEventWithDeliveries({ eventId: "evt_2", name: EVENT_NAME, timestamp: "t", data: accepted() }, ["sub_1"]);
    expect(store.listDeliveries().filter((entry) => entry.state === "queued")).toHaveLength(2);
  });

  test("appends the journal entry and its outbox rows in one commit", () => {
    const dir = stateDir();
    const store = createEventStore({ dir });
    store.appendEventWithDeliveries({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() }, ["sub_a", "sub_b"]);
    const persisted = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
    expect(persisted.journal).toHaveLength(1);
    expect(Object.keys(persisted.outbox)).toEqual(["sub_a:evt_1", "sub_b:evt_1"]);
  });

  test("rejects a cursor ahead of the store rather than reporting nothing new", () => {
    const store = createEventStore({ dir: stateDir() });
    store.appendEvent({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() });
    expect(() => store.eventsAfter(`${store.generation}:100`)).toThrow(/ahead of/);
    expect(() => store.eventsAfter("garbage")).toThrow(/invalid event cursor/);
  });

  test("reports truncated for a cursor from a different generation", () => {
    const store = createEventStore({ dir: stateDir() });
    store.appendEvent({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() });
    const foreign = "11111111-2222-3333-4444-555555555555:1";
    expect(store.eventsAfter(foreign)).toEqual({ events: [], truncated: true });
  });

  test("a null replay cursor means from now, while allAccepted returns the retained window", () => {
    // These two reads are deliberately different: restart restore must not be
    // expressed through the replay contract, whose null cursor yields nothing.
    const store = createEventStore({ dir: stateDir() });
    store.appendEvent({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() });
    expect(store.eventsAfter(null).events).toHaveLength(0);
    expect(store.allAccepted().records).toHaveLength(1);
  });

  test("writes state readable only by its owner", () => {
    const dir = stateDir();
    const store = createEventStore({ dir });
    store.appendEvent({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  test("redaction removes current and retiring signing material", () => {
    const view = redactSubscription({ id: "sub_1", url: CALLBACK, secret: SECRET, previousSecret: SECRET_TWO });
    expect(view.secret).toBeUndefined();
    expect(view.previousSecret).toBeUndefined();
    expect(view).toMatchObject({ secretStored: true, rotatingSecret: true });
    expect(JSON.stringify(view)).not.toContain("whsec_");
  });

  test("the unauthenticated health projection exposes counts but no destinations or ids", () => {
    const store = createEventStore({ dir: stateDir() });
    store.putSubscription({ id: "sub_secret_id", principal: PRINCIPAL, url: CALLBACK, name: EVENT_NAME, arguments: {}, secret: SECRET });
    store.appendEventWithDeliveries({ eventId: "evt_1", name: EVENT_NAME, timestamp: "t", data: accepted() }, ["sub_secret_id"]);
    const serialized = JSON.stringify(store.publicSnapshot());
    expect(store.publicSnapshot()).toMatchObject({ subscriptions: 1, deliveries: { queued: 1, delivered: 0, failed: 0 } });
    expect(serialized).not.toContain("sub_secret_id");
    expect(serialized).not.toContain("events.example.com");
    expect(serialized).not.toContain("whsec_");
  });
});

// ------------------------------------------------------ subscription flow

describe("subscription identity and lifecycle", () => {
  test("canonical arguments give one identity for reordered filters", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
    const left = subscriptionIdFor({ principal: PRINCIPAL, url: CALLBACK, name: EVENT_NAME, args: { from: ["a"], action: ["reply"] } });
    const right = subscriptionIdFor({ principal: PRINCIPAL, url: CALLBACK, name: EVENT_NAME, args: { action: ["reply"], from: ["a"] } });
    expect(left).toBe(right);
  });

  test("identity changes with principal, url, name or arguments", () => {
    const base = { principal: PRINCIPAL, url: CALLBACK, name: EVENT_NAME, args: {} };
    const id = subscriptionIdFor(base);
    expect(subscriptionIdFor({ ...base, principal: "other" })).not.toBe(id);
    expect(subscriptionIdFor({ ...base, url: "https://other.example.com/h" })).not.toBe(id);
    expect(subscriptionIdFor({ ...base, args: { action: ["ask"] } })).not.toBe(id);
  });

  test("subscribe verifies the callback, persists, and returns a finite expiry", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    const result = await service.subscribe(subscribeParams(), PRINCIPAL);
    expect(result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(Date.parse(result.refreshBefore)).toBeGreaterThan(Date.now());
    expect(result.truncated).toBe(false);
    expect(endpoint.verifications()).toHaveLength(1);
    expect(store.getSubscription(result.id).principal).toBe(PRINCIPAL);
  });

  test("a failed callback verification is a CallbackEndpointError with a reason and stores nothing", async () => {
    const endpoint = await subscriber(null, () => ({ status: 200, body: { challenge: "wrong" } }));
    const { service, store } = makeService({ port: endpoint.port });
    await expect(service.subscribe(subscribeParams(), PRINCIPAL)).rejects.toMatchObject({
      code: CALLBACK_ENDPOINT_ERROR, data: { reason: expect.stringMatching(/echo/) },
    });
    expect(store.listSubscriptions()).toHaveLength(0);
  });

  test("a non-public callback destination is refused before any application data", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await expect(service.subscribe(subscribeParams({
      delivery: { mode: "webhook", url: "https://127.0.0.1/hook", secret: SECRET },
    }), PRINCIPAL)).rejects.toMatchObject({ code: CALLBACK_ENDPOINT_ERROR });
    expect(endpoint.received).toHaveLength(0);
  });

  test("subscribe is idempotent and a refresh updates the same row", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    const first = await service.subscribe(subscribeParams(), PRINCIPAL);
    const second = await service.subscribe(subscribeParams(), PRINCIPAL);
    expect(second.id).toBe(first.id);
    expect(store.listSubscriptions()).toHaveLength(1);
    // A cached verification means the refresh does not re-challenge.
    expect(endpoint.verifications()).toHaveLength(1);
  });

  test("a refresh with a new secret keeps the retiring key for a bounded window", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    const first = await service.subscribe(subscribeParams(), PRINCIPAL);
    await service.subscribe(subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: SECRET_TWO } }), PRINCIPAL);
    const stored = store.getSubscription(first.id);
    expect(stored.secret).toBe(SECRET_TWO);
    expect(stored.previousSecret).toBe(SECRET);
    expect(Date.parse(stored.previousSecretUntil)).toBeGreaterThan(Date.now());
  });

  test("grants no more than the requested ttl and never an unbounded one by default", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    const short = await service.subscribe(subscribeParams({ ttlMs: 120000 }), PRINCIPAL);
    expect(Date.parse(short.refreshBefore) - Date.now()).toBeLessThanOrEqual(120000 + 1000);
    const unbounded = await service.subscribe(subscribeParams({ ttlMs: null }), PRINCIPAL);
    expect(unbounded.refreshBefore).not.toBeNull();
  });

  test("rejects an unknown event, a non-webhook delivery and an unknown filter", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await expect(service.subscribe(subscribeParams({ name: "other" }), PRINCIPAL)).rejects.toThrow(/unknown event/);
    await expect(service.subscribe(subscribeParams({ delivery: { mode: "sse", url: CALLBACK, secret: SECRET } }), PRINCIPAL)).rejects.toThrow(/webhook/);
    await expect(service.subscribe(subscribeParams({ arguments: { nope: 1 } }), PRINCIPAL)).rejects.toThrow(/unknown filter/);
    await expect(service.subscribe(subscribeParams({ arguments: { to: "someone-else" } }), PRINCIPAL)).rejects.toThrow(/recipient filter/);
    await expect(service.subscribe(subscribeParams({ arguments: { origin: ["nope"] } }), PRINCIPAL)).rejects.toThrow(/invalid origin/);
  });

  test("unsubscribe is idempotent and cannot reach another principal's subscription", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    const created = await service.subscribe(subscribeParams(), PRINCIPAL);

    // Identity includes the principal, so another caller computes a different
    // id and cannot address this row at all. Its unsubscribe is a no-op
    // success, and the owner's subscription survives untouched.
    await expect(service.unsubscribe(subscribeParams(), "intruder")).resolves.toEqual({});
    expect(store.getSubscription(created.id)).toBeDefined();

    await expect(service.unsubscribe(subscribeParams(), PRINCIPAL)).resolves.toEqual({});
    await expect(service.unsubscribe(subscribeParams(), PRINCIPAL)).resolves.toEqual({});
    expect(store.listSubscriptions()).toHaveLength(0);
  });

  test("the stored-row ownership guard refuses a principal mismatch", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    const created = await service.subscribe(subscribeParams(), PRINCIPAL);
    // Defense in depth for a row whose principal does not match the id that
    // addresses it, which identity derivation alone would never produce.
    store.putSubscription({ ...store.getSubscription(created.id), principal: "someone-else" });
    await expect(service.subscribe(subscribeParams(), PRINCIPAL)).rejects.toThrow(/another principal/);
    await expect(service.unsubscribe(subscribeParams(), PRINCIPAL)).rejects.toThrow(/another principal/);
    expect(store.getSubscription(created.id)).toBeDefined();
  });

  test("refuses to act without an authenticated principal", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    for (const bad of [undefined, null, ""]) {
      await expect(service.subscribe(subscribeParams(), bad)).rejects.toMatchObject({ httpStatus: 401 });
      await expect(service.unsubscribe(subscribeParams(), bad)).rejects.toMatchObject({ httpStatus: 401 });
    }
  });

  test("authorize is fail-closed with no configured key and constant-time with one", () => {
    const open = makeService({ port: 1, config: { eventsKey: "" } });
    expect(() => open.service.authorize(`Bearer ${EVENTS_KEY}`)).toThrow(/not enabled/);
    const keyed = makeService({ port: 1 });
    expect(keyed.service.authorize(`Bearer ${EVENTS_KEY}`)).toBe(PRINCIPAL);
    expect(() => keyed.service.authorize("Bearer wrong")).toThrow(/unauthorized/);
    expect(() => keyed.service.authorize(EVENTS_KEY)).toThrow(/unauthorized/);
    expect(() => keyed.service.authorize(undefined)).toThrow(/unauthorized/);
  });

  test("events/list describes the event as webhook-only and names content as data", () => {
    const { service } = makeService({ port: 1 });
    const listed = service.list({}, PRINCIPAL);
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0].name).toBe(EVENT_NAME);
    expect(listed.events[0].delivery).toEqual(["webhook"]);
    expect(listed.events[0].description).toMatch(/never an instruction/);
    expect(listed.events[0].payloadSchema.required).toContain("provenance");
  });
});

// ------------------------------------------------------------- filtering

describe("server-side filters", () => {
  test("matches on sender, origin, action and recipient", () => {
    const data = accepted();
    expect(matchesFilters({}, data)).toBe(true);
    expect(matchesFilters({ from: ["worker"] }, data)).toBe(true);
    expect(matchesFilters({ from: ["other"] }, data)).toBe(false);
    expect(matchesFilters({ origin: ["peer"] }, data)).toBe(true);
    expect(matchesFilters({ origin: ["user"] }, data)).toBe(false);
    expect(matchesFilters({ action: ["reply"] }, data)).toBe(true);
    expect(matchesFilters({ action: ["ask"] }, data)).toBe(false);
    expect(matchesFilters({ to: "dot" }, data)).toBe(true);
    expect(matchesFilters({ from: ["worker"], action: ["ask"] }, data)).toBe(false);
  });

  test("a non-matching message is journaled but never delivered", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams({ arguments: { from: ["someone-else"] } }), PRINCIPAL);
    service.emit(accepted({ from: "worker" }), PROVENANCE);
    await service.drain();
    expect(endpoint.events()).toHaveLength(0);
    expect(store.allAccepted().records).toHaveLength(1);
  });

  test("a matching message is delivered once with exact provenance and content", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    const created = await service.subscribe(subscribeParams({ arguments: { from: ["worker"], action: ["reply"] } }), PRINCIPAL);
    service.emit(accepted({ text: "exact body ðŸ”" }), PROVENANCE);
    await service.drain();

    expect(endpoint.events()).toHaveLength(1);
    const sent = endpoint.events()[0];
    expect(sent.body.name).toBe(EVENT_NAME);
    expect(sent.body.data.text).toBe("exact body ðŸ”");
    expect(sent.body.data.from).toBe("worker");
    expect(sent.body.data.origin).toBe("peer");
    expect(sent.body.data.provenance).toEqual(PROVENANCE);
    // No top-level type: that is reserved for protocol control messages.
    expect(sent.body.type).toBeUndefined();
    expect(sent.headers["x-mcp-subscription-id"]).toBe(created.id);
    expect(sent.headers["webhook-id"]).toBe(sent.body.eventId);
    expect(verifySignatureHeader(
      sent.headers["webhook-signature"], parseSigningSecret(SECRET),
      sent.headers["webhook-id"], Number(sent.headers["webhook-timestamp"]), sent.raw,
    )).toBe(true);
  });

  test("does not synthesize team or task identifiers that the sender never sent", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    const { data } = endpoint.events()[0].body;
    expect(data).not.toHaveProperty("teamId");
    expect(data).not.toHaveProperty("taskId");

    service.emit(accepted({ messageId: "a2amsg_two", teamId: "team-7" }), PROVENANCE);
    await service.drain();
    expect(endpoint.events()[1].body.data.teamId).toBe("team-7");
  });

  test("reports a claimed sender as claimed, not as independently authenticated", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted({ from: "impersonator" }), PROVENANCE);
    await service.drain();
    const { provenance } = endpoint.events()[0].body.data;
    expect(provenance.senderClaimed).toBe(true);
    expect(provenance.bridgeAuthenticated).toBe(false);
    expect(provenance.transport).toBe("a2a-bridge-callback");
  });
});

// -------------------------------------------------------------- delivery

describe("delivery, retries and limits", () => {
  test("keeps the event id stable across retries while re-signing each attempt", async () => {
    let attempts = 0;
    const endpoint = await subscriber(() => {
      attempts += 1;
      return attempts < 3 ? { status: 500, body: {} } : { status: 200, body: {} };
    });
    const { service, store } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();

    const sent = endpoint.events();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((entry) => entry.headers["webhook-id"])).size).toBe(1);
    expect(new Set(sent.map((entry) => entry.headers["webhook-signature"])).size).toBeGreaterThanOrEqual(1);
    for (const entry of sent) {
      expect(verifySignatureHeader(
        entry.headers["webhook-signature"], parseSigningSecret(SECRET),
        entry.headers["webhook-id"], Number(entry.headers["webhook-timestamp"]), entry.raw,
      )).toBe(true);
    }
    expect(store.listDeliveries()[0]).toMatchObject({ state: "delivered", lastStatus: 200 });
  });

  test("does not retry a 410 and records it as terminal", async () => {
    const endpoint = await subscriber(() => ({ status: 410, body: {} }));
    const { service, store } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    expect(endpoint.events()).toHaveLength(1);
    expect(store.listDeliveries()[0]).toMatchObject({ state: "failed", lastStatus: 410, terminalReason: "endpoint gone" });
  });

  test("does not retry a 413 and records it as terminal", async () => {
    const endpoint = await subscriber(() => ({ status: 413, body: {} }));
    const { service, store } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    expect(endpoint.events()).toHaveLength(1);
    expect(store.listDeliveries()[0]).toMatchObject({ state: "failed", lastStatus: 413, terminalReason: "payload too large" });
  });

  test("stops after the configured attempts and records the exhaustion", async () => {
    const endpoint = await subscriber(() => ({ status: 503, body: {} }));
    const { service, store } = makeService({ port: endpoint.port, config: { maxAttempts: 2 } });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    expect(endpoint.events()).toHaveLength(2);
    expect(store.listDeliveries()[0]).toMatchObject({ state: "failed", attempts: 2, terminalReason: "attempts exhausted" });
  });

  test("keeps a delivery inside the 256 KiB limit by summarizing oversized content", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    const huge = "z".repeat(MAX_PAYLOAD_BYTES + 5000);
    service.emit(accepted({ text: huge }), PROVENANCE);
    await service.drain();

    const sent = endpoint.events()[0];
    expect(Buffer.byteLength(sent.raw, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(sent.body.data.contentTruncated).toBe(true);
    expect(sent.body.data.contentBytes).toBe(huge.length);
    expect(sent.body.data.text).toBeUndefined();
    // The reference points at the durable journal cursor, not the volatile inbox.
    expect(sent.body.data.contentAvailableAtCursor).toBe(sent.body.cursor);
  });

  test("the full oversized content stays readable from the durable journal", async () => {
    const endpoint = await subscriber();
    const { service } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    const huge = "z".repeat(MAX_PAYLOAD_BYTES + 5000);
    service.emit(accepted({ text: huge }), PROVENANCE);
    await service.drain();
    const stored = service.accepted().messages[0];
    expect(stored.text).toHaveLength(huge.length);
  });

  test("an expired subscription stops delivery instead of being retried", async () => {
    const endpoint = await subscriber();
    let clock = Date.now();
    const { service, store } = makeService({ port: endpoint.port, now: () => clock, config: { defaultTtlMs: 1000 } });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    clock += 60000;
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    expect(endpoint.events()).toHaveLength(0);
    expect(store.allAccepted().records).toHaveLength(1);
  });

  test("delivery state separates queued, delivered and failed without claiming completion", async () => {
    const endpoint = await subscriber(() => ({ status: 200, body: {} }));
    const { service, store } = makeService({ port: endpoint.port });
    await service.subscribe(subscribeParams(), PRINCIPAL);
    service.emit(accepted(), PROVENANCE);
    await service.drain();
    const delivery = store.listDeliveries()[0];
    expect(delivery.state).toBe("delivered");
    expect(delivery.deliveryAcknowledgedAt).toBeTruthy();
    // HTTP receipt is not task completion, so no completion field exists.
    expect(delivery).not.toHaveProperty("completed");
    expect(delivery).not.toHaveProperty("processedAt");
  });

  test("a persisted queued delivery is drained by a later process", async () => {
    const dir = stateDir();
    const endpoint = await subscriber(() => ({ status: 500, body: {} }));
    const first = makeService({ dir, port: endpoint.port, config: { maxAttempts: 1 } });
    await first.service.subscribe(subscribeParams(), PRINCIPAL);
    const firstStore = createEventStore({ dir });
    firstStore.appendEventWithDeliveries(
      { eventId: "evt_restart", name: EVENT_NAME, timestamp: "t", data: accepted() },
      firstStore.listSubscriptions().map((entry) => entry.id),
    );
    expect(createEventStore({ dir }).listDeliveries().filter((e) => e.state === "queued")).toHaveLength(1);

    // A new process opens the same state and drains what was left queued.
    const ok = await subscriber(() => ({ status: 200, body: {} }));
    const second = makeService({ dir, port: ok.port });
    await second.service.drain();
    expect(ok.events()).toHaveLength(1);
    expect(ok.events()[0].body.eventId).toBe("evt_restart");
    expect(second.store.listDeliveries().every((entry) => entry.state === "delivered")).toBe(true);
  });

  test("accepted messages survive a restart and are readable without any subscription", () => {
    const dir = stateDir();
    const first = makeService({ dir, port: 1 });
    first.service.emit(accepted({ text: "durable with no subscriber" }), PROVENANCE);
    expect(first.store.listSubscriptions()).toHaveLength(0);

    const second = makeService({ dir, port: 1 });
    const restored = second.service.accepted();
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0].text).toBe("durable with no subscriber");
    expect(restored.generation).toBe(first.store.generation);
  });

  test("a replay cursor delivers only what the subscriber missed", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port });
    service.emit(accepted({ messageId: "a2amsg_1", text: "before" }), PROVENANCE);
    const afterFirst = store.cursor(store.sequence);
    service.emit(accepted({ messageId: "a2amsg_2", text: "missed" }), PROVENANCE);

    const result = await service.subscribe(subscribeParams({ cursor: afterFirst }), PRINCIPAL);
    expect(result.truncated).toBe(false);
    await service.drain();
    expect(endpoint.events()).toHaveLength(1);
    expect(endpoint.events()[0].body.data.text).toBe("missed");
  });

  test("reports truncated when the requested replay point is no longer retained", async () => {
    const endpoint = await subscriber();
    const { service, store } = makeService({ port: endpoint.port, maxJournal: 1 });
    service.emit(accepted({ messageId: "a2amsg_1" }), PROVENANCE);
    const early = store.cursor(1);
    service.emit(accepted({ messageId: "a2amsg_2" }), PROVENANCE);
    service.emit(accepted({ messageId: "a2amsg_3" }), PROVENANCE);
    const result = await service.subscribe(subscribeParams({ cursor: early }), PRINCIPAL);
    expect(result.truncated).toBe(true);
  });
});

// ------------------------------------------------------- modern protocol

describe("MCP 2026-07-28 stateless protocol", () => {
  const serverInfo = { name: "a2a-dots", version: "1.1.0" };

  function harness({ eventsEnabled = true, protectToolCalls = true, calls = [] } = {}) {
    const toolRouter = createToolRouter({
      dotId: "dot",
      agentId: (value) => value,
      sendMessage: (...args) => { calls.push(args); return Promise.resolve({ sent: true }); },
      reconcileRegistration: () => Promise.resolve([{ agentId: "dot" }, { agentId: "worker" }]),
      inbox: { read: () => ({ messages: [] }) },
      runCli: () => Promise.resolve("ok"),
      isStopping: () => false,
    });
    const authorizations = [];
    const subscriptions = [];
    const events = {
      authorize(header) {
        authorizations.push(header);
        // Mirrors the real service, which throws RpcError so the transport can
        // map it to the right HTTP status instead of a 500.
        if (!eventsEnabled) throw new RpcError(INVALID_PARAMS, "not enabled", { httpStatus: 403 });
        if (header !== `Bearer ${EVENTS_KEY}`) throw new RpcError(INVALID_PARAMS, "unauthorized", { httpStatus: 401 });
        return PRINCIPAL;
      },
      list: () => ({ events: [{ name: EVENT_NAME }] }),
      subscribe: (params, principal) => {
        subscriptions.push({ params, principal });
        return Promise.resolve({ id: "sub_1", refreshBefore: null, cursor: null, truncated: false });
      },
      unsubscribe: () => Promise.resolve({}),
    };
    const handler = createModernHandler({
      serverInfo, toolRouter, events,
      capabilities: () => ({ tools: { listChanged: false }, ...(eventsEnabled ? { events: {} } : {}) }),
      allowedOrigins: () => ["https://chatgpt.com"],
      protectToolCalls: () => protectToolCalls,
    });
    return { handler, calls, authorizations, subscriptions };
  }

  const meta = { [META_PROTOCOL_VERSION]: PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {} };
  const headersFor = (method, name) => ({
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  });

  test("detects the modern era from the header, the body meta, or a modern-only method", () => {
    expect(isModernRequest({ "mcp-protocol-version": PROTOCOL_VERSION }, { method: "tools/list" })).toBe(true);
    expect(isModernRequest({}, { method: "events/list" })).toBe(true);
    expect(isModernRequest({}, { method: "tools/list", params: { _meta: meta } })).toBe(true);
    expect(isModernRequest({ "mcp-protocol-version": "2025-11-25" }, { method: "tools/list" })).toBe(false);
    expect(isModernRequest({}, { method: "initialize" })).toBe(false);
  });

  test("server/discover advertises 2026-07-28 and the events capability", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("server/discover"),
      body: { jsonrpc: "2.0", id: 1, method: "server/discover" },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result.resultType).toBe("complete");
    expect(answer.body.result.supportedVersions[0]).toBe(PROTOCOL_VERSION);
    expect(answer.body.result.capabilities.events).toEqual({});
    expect(answer.body.result._meta[META_SERVER_INFO]).toEqual(serverInfo);
  });

  test("server/discover omits the events capability when subscriptions are disabled", async () => {
    const { handler } = harness({ eventsEnabled: false });
    const answer = await handler.handle({
      headers: headersFor("server/discover"),
      body: { jsonrpc: "2.0", id: 1, method: "server/discover" },
    });
    expect(answer.body.result.capabilities.events).toBeUndefined();
    expect(answer.body.result.supportedVersions).toContain(PROTOCOL_VERSION);
  });

  test("tools/list works with no initialize and carries a resultType", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("tools/list"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result.resultType).toBe("complete");
    expect(answer.body.result.tools.map((tool) => tool.name)).toEqual([
      "send_message", "list_agents", "get_agent", "receive_messages", "start_team", "stop_agent", "start_agent", "peek_agent",
    ]);
  });

  test("tools/call works with no initialize and returns a complete result", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("tools/call", "list_agents"),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agents", arguments: {}, _meta: meta } },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result.resultType).toBe("complete");
    expect(answer.body.result.isError).toBe(false);
    expect(answer.body.result.content[0].type).toBe("text");
  });

  test("an unknown tool is a protocol error, while a failing tool is an isError result", async () => {
    const { handler } = harness();
    const unknown = await handler.handle({
      headers: headersFor("tools/call", "nope"),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {}, _meta: meta } },
    });
    expect(unknown.body.error.code).toBe(INVALID_PARAMS);
    expect(unknown.body.error.message).toMatch(/Unknown tool/);

    const failing = await handler.handle({
      headers: headersFor("tools/call", "get_agent"),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_agent", arguments: { agent: "ghost" }, _meta: meta } },
    });
    expect(failing.body.result.isError).toBe(true);
    expect(failing.body.result.content[0].text).toMatch(/no registered agent/);
  });

  test("rejects a header that disagrees with the body", async () => {
    const { handler } = harness();
    const mismatch = await handler.handle({
      headers: { ...headersFor("tools/list"), "mcp-method": "tools/call" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(HEADER_MISMATCH);

    const versionMismatch = await handler.handle({
      headers: headersFor("tools/list"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...meta, [META_PROTOCOL_VERSION]: "2025-11-25" } } },
    });
    expect(versionMismatch.body.error.code).toBe(HEADER_MISMATCH);
  });

  test("requires MCP-Protocol-Version, Mcp-Method and Mcp-Name", async () => {
    const { handler } = harness();
    const noVersion = await handler.handle({
      headers: { "mcp-method": "tools/list" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(noVersion.body.error.code).toBe(HEADER_MISMATCH);

    const noMethod = await handler.handle({
      headers: { "mcp-protocol-version": PROTOCOL_VERSION },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(noMethod.body.error.code).toBe(HEADER_MISMATCH);

    const noName = await handler.handle({
      headers: headersFor("tools/call"),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", _meta: meta } },
    });
    expect(noName.body.error.code).toBe(HEADER_MISMATCH);
  });

  test("decodes the base64 sentinel before comparing Mcp-Name", async () => {
    const { handler } = harness();
    const encoded = `=?base64?${Buffer.from("list_agents", "utf8").toString("base64")}?=`;
    const answer = await handler.handle({
      headers: { ...headersFor("tools/call"), "mcp-name": encoded },
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", arguments: {}, _meta: meta } },
    });
    expect(answer.status).toBe(200);
  });

  test("rejects an unsupported protocol version and lists what is supported", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: { "mcp-protocol-version": "2030-01-01", "mcp-method": "tools/list" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(answer.body.error.data.supported).toContain(PROTOCOL_VERSION);
    expect(answer.body.error.data.supported).toContain("2025-11-25");
  });

  test("requires the per-request client capabilities", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("tools/list"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [META_PROTOCOL_VERSION]: PROTOCOL_VERSION } } },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe(INVALID_PARAMS);
    expect(answer.body.error.message).toMatch(/clientCapabilities/);
  });

  test("an unknown method is 404 with method not found", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("resources/read", "x"),
      body: { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "x", _meta: meta } },
    });
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  test("rejects a null or malformed id", async () => {
    const { handler } = harness();
    for (const id of [null, {}, []]) {
      const answer = await handler.handle({
        headers: headersFor("tools/list"),
        body: { jsonrpc: "2.0", id, method: "tools/list", params: { _meta: meta } },
      });
      expect(answer.status).toBe(400);
      expect(answer.body.id).toBeUndefined();
    }
  });

  test("refuses a side-effecting method sent as a notification without executing it", async () => {
    // Regression: the notification branch used to dispatch before authorizing,
    // so an unauthenticated no-id subscribe returned 202 and took effect.
    const { handler, subscriptions, authorizations, calls } = harness();
    const subscribe = await handler.handle({
      headers: headersFor("events/subscribe", EVENT_NAME),
      body: { jsonrpc: "2.0", method: "events/subscribe", params: { name: EVENT_NAME, _meta: meta } },
    });
    expect(subscribe.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
    expect(authorizations).toHaveLength(0);

    const call = await handler.handle({
      headers: headersFor("tools/call", "send_message"),
      body: { jsonrpc: "2.0", method: "tools/call", params: { name: "send_message", arguments: { to: "worker", text: "hi" }, _meta: meta } },
    });
    expect(call.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("refuses an events method without a bearer token and never dispatches it", async () => {
    const { handler, subscriptions } = harness();
    const answer = await handler.handle({
      headers: headersFor("events/subscribe", EVENT_NAME),
      body: { jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: EVENT_NAME, _meta: meta } },
    });
    expect(answer.status).toBe(401);
    expect(subscriptions).toHaveLength(0);
  });

  test("passes the authenticated principal into the events service", async () => {
    const { handler, subscriptions } = harness();
    const answer = await handler.handle({
      headers: headersFor("events/subscribe", EVENT_NAME),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: EVENT_NAME, _meta: meta } },
    });
    expect(answer.status).toBe(200);
    expect(subscriptions[0].principal).toBe(PRINCIPAL);
  });

  test("a sensitive tool call needs the same bearer once a key is configured", async () => {
    // Regression: tools/call sat outside the authenticated boundary, so
    // send_message was reachable with no credential on the modern path.
    const guarded = harness({ protectToolCalls: true });
    const refused = await guarded.handler.handle({
      headers: headersFor("tools/call", "send_message"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to: "worker", text: "hi" }, _meta: meta } },
    });
    expect(refused.status).toBe(401);
    expect(guarded.calls).toHaveLength(0);

    const allowed = await guarded.handler.handle({
      headers: headersFor("tools/call", "send_message"),
      authorization: `Bearer ${EVENTS_KEY}`,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { to: "worker", text: "hi" }, _meta: meta } },
    });
    expect(allowed.status).toBe(200);
    expect(guarded.calls).toHaveLength(1);
  });

  test("refuses a disallowed Origin with 403", async () => {
    const { handler } = harness();
    const blocked = await handler.handle({
      headers: { ...headersFor("tools/list"), origin: "https://evil.example.com" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(blocked.status).toBe(403);

    const allowed = await handler.handle({
      headers: { ...headersFor("tools/list"), origin: "https://chatgpt.com" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(allowed.status).toBe(200);

    // An absent Origin is a non-browser caller and stays allowed.
    const none = await handler.handle({
      headers: headersFor("tools/list"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(none.status).toBe(200);
  });

  test("rejects a body that is not JSON-RPC 2.0", async () => {
    const { handler } = harness();
    const answer = await handler.handle({
      headers: headersFor("tools/list"),
      body: { jsonrpc: "1.0", id: 1, method: "tools/list", params: { _meta: meta } },
    });
    expect(answer.body.error.code).toBe(INVALID_PARAMS);
  });
});
