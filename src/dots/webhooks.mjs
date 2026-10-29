import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Standard Webhooks signing, implemented here because the repository has no
// webhook dependency and adding one is out of scope. The signed string, header
// names, version prefix and secret envelope follow the specification at
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
// and the MCP Events requirements at
// https://developers.openai.com/plugins/build/mcp-events
const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
export const SIGNATURE_VERSION = "v1";
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export function parseSigningSecret(value, name = "delivery.secret") {
  if (typeof value !== "string" || !value.startsWith(SECRET_PREFIX)) {
    throw new Error(`${name} must be a ${SECRET_PREFIX} prefixed base64 key`);
  }
  const encoded = value.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${name} must be base64`);
  }
  const key = Buffer.from(encoded, "base64");
  // Reject non-canonical spellings. Subscription identity is derived from
  // stored material, so two encodings of one key must not both be accepted.
  if (key.toString("base64").replace(/[=]+$/, "") !== encoded.replace(/[=]+$/, "")) {
    throw new Error(`${name} must be canonical base64`);
  }
  if (key.length < MIN_SECRET_BYTES || key.length > MAX_SECRET_BYTES) {
    throw new Error(`${name} must decode to ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes`);
  }
  return key;
}

export function webhookId(prefix = "msg") {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error("webhook id prefix must be alphanumeric");
  }
  // The signed string is '<id>.<timestamp>.<body>'. A '.' inside the id would
  // make that string ambiguous, which the specification calls out directly.
  return `${prefix}_${randomUUID()}`;
}

export function signedPayload(id, timestampSeconds, body) {
  if (typeof id !== "string" || !id || id.includes(".")) {
    throw new Error("webhook id must be a string without '.'");
  }
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error("webhook timestamp must be whole unix seconds");
  }
  if (typeof body !== "string") {
    throw new Error("webhook body must be the exact serialized string");
  }
  return `${id}.${timestampSeconds}.${body}`;
}

export function sign(secretKey, id, timestampSeconds, body) {
  const digest = createHmac("sha256", secretKey)
    .update(signedPayload(id, timestampSeconds, body), "utf8")
    .digest("base64");
  return `${SIGNATURE_VERSION},${digest}`;
}

// Hash both sides before comparing so the comparison reveals neither content
// nor length. This mirrors secretsEqualUtf8 in src/server/auth.mjs.
export function constantTimeEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function verifySignatureHeader(header, secretKey, id, timestampSeconds, body) {
  if (typeof header !== "string" || !header) {
    return false;
  }
  const expected = sign(secretKey, id, timestampSeconds, body);
  // The header is a space delimited list so a producer can rotate keys with no
  // downtime. Evaluate every candidate so a match's position cannot leak.
  let matched = false;
  for (const candidate of header.split(" ")) {
    if (candidate && constantTimeEquals(candidate, expected)) {
      matched = true;
    }
  }
  return matched;
}

// secretKeys may carry more than one key so a rotation can be served with no
// downtime: the receiver accepts the request if any listed signature verifies.
// The spec makes webhook-signature a space delimited list for exactly this.
export function signingHeaders({ secretKey, secretKeys, id, body, subscriptionId, timestampSeconds }) {
  const keys = (secretKeys && secretKeys.length ? secretKeys : [secretKey]).filter(Boolean);
  if (!keys.length) {
    throw new Error("signing requires at least one secret key");
  }
  const stamp = Number.isSafeInteger(timestampSeconds) ? timestampSeconds : Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(stamp),
    "webhook-signature": keys.map((key) => sign(key, id, stamp, body)).join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

export function challengeValue() {
  return randomUUID().replace(/-/g, "");
}
