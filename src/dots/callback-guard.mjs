import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { constantTimeEquals, challengeValue, signingHeaders, webhookId } from "./webhooks.mjs";

// Callback destinations are attacker-influenced input. Every address is
// resolved once, classified, and then pinned for the connection, so the name
// cannot resolve to a public address during validation and a private one at
// connect time (DNS rebinding). Redirects are refused outright because a
// redirect is a second, unvalidated destination.

const MAX_RESPONSE_BYTES = 64 * 1024;

function ipv4Reason(address) {
  const [a, b] = address.split(".").map(Number);
  if (a === 0) {
    return "unspecified";
  }
  if (a === 10) {
    return "private";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade NAT";
  }
  if (a === 169 && b === 254) {
    return "link-local";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private";
  }
  if (a === 192 && b === 168) {
    return "private";
  }
  if (a === 192 && b === 0) {
    return "reserved";
  }
  if (a === 192 && b === 88) {
    return "reserved";
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return "benchmarking";
  }
  if (a === 198 && b === 51) {
    return "documentation";
  }
  if (a === 203 && b === 0) {
    return "documentation";
  }
  if (a >= 224) {
    return "multicast or reserved";
  }
  return null;
}

function expandIpv6(address) {
  const plain = address.split("%")[0].toLowerCase();
  const [head, tail = ""] = plain.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = plain.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return groups.map((group) => Number.parseInt(group || "0", 16));
}

const ipv4FromGroups = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

function ipv6Reason(address) {
  const plain = address.split("%")[0].toLowerCase();
  // Mixed notation (…:127.0.0.1) is normalized into two 16-bit groups first so
  // that every spelling of one address reaches the same classification. The
  // dotted form is only one spelling: ::ffff:7f00:1 is the same destination.
  const mixed = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(plain);
  let groups;
  if (mixed) {
    const octets = mixed[2].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return "unparsable";
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    groups = expandIpv6(`${mixed[1]}${high}:${low}`);
  } else {
    groups = expandIpv6(plain);
  }
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return "unparsable";
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:0:0/96 (IPv4-mapped) carries an IPv4 destination; apply IPv4 policy.
  if (firstFiveZero && g5 === 0xffff) {
    return ipv4Reason(ipv4FromGroups(g6, g7));
  }
  if (firstFiveZero && g5 === 0) {
    if (g6 === 0 && g7 === 0) {
      return "unspecified";
    }
    if (g6 === 0 && g7 === 1) {
      return "loopback";
    }
    // ::/96 IPv4-compatible is deprecated and never a public destination.
    return "reserved";
  }
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return "NAT64";
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return "discard-only";
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return "unique local";
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return "link-local";
  }
  if ((g0 & 0xffc0) === 0xfec0) {
    return "site-local";
  }
  if ((g0 & 0xff00) === 0xff00) {
    return "multicast";
  }
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return "documentation";
  }
  if (g0 === 0x2001 && g1 === 0x0000) {
    return "Teredo";
  }
  if (g0 === 0x2002) {
    return "6to4";
  }
  return null;
}

export function addressReason(address) {
  const family = isIP(address);
  if (family === 4) {
    return ipv4Reason(address);
  }
  if (family === 6) {
    return ipv6Reason(address);
  }
  return "unparsable";
}

export function parseCallbackUrl(value, name = "delivery.url") {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be an absolute URL`); }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not embed credentials`);
  }
  if (url.hash) {
    throw new Error(`${name} must not carry a fragment`);
  }
  return url;
}

// deps: { lookup, request } so tests can inject a fixture resolver and a
// fixture HTTPS transport. The classification policy above is never injected,
// so a test cannot reach a loopback destination through a relaxed rule.
export function createCallbackGuard({ lookup = dnsLookup, request = httpsRequest, deadlineMs = 5000 } = {}) {
  // One deadline covers name resolution, connection and the response body. A
  // socket idle timeout alone would let a drip-feeding endpoint hold the
  // operation open indefinitely.
  function withDeadline(label, task) {
    const controller = new AbortController();
    let expiry;
    // The task is raced against the deadline, not merely signalled. A DNS
    // resolver that never settles ignores an abort signal entirely, so
    // awaiting the task alone would hang past the deadline forever.
    const expired = new Promise((_resolve, reject) => {
      expiry = setTimeout(() => {
        const error = new Error(`${label} exceeded the ${deadlineMs}ms deadline`);
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });
    return Promise.race([task(controller.signal), expired]).finally(() => clearTimeout(expiry));
  }

  async function resolvePinned(url, name, signal) {
    // URL.hostname keeps the brackets around an IPv6 literal, which isIP does
    // not accept. Without stripping them a bracketed literal would skip the
    // literal-address check and fall through to name resolution.
    const literal = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(literal)) {
      const reason = addressReason(literal);
      if (reason) {
        throw new Error(`${name} is a ${reason} address (${literal}) and is refused`);
      }
      return literal;
    }
    const resolved = await lookup(url.hostname, { all: true });
    const addresses = (Array.isArray(resolved) ? resolved : [resolved]).map((entry) => entry.address);
    if (!addresses.length) {
      throw new Error(`${name} did not resolve to any address`);
    }
    // Every answer must be public. Accepting a hostname because one of its
    // records is public would let a round-robin or rebinding answer steer the
    // connection at an internal address.
    for (const address of addresses) {
      const reason = addressReason(address);
      if (reason) {
        throw new Error(`${name} resolves to a ${reason} address (${address}) and is refused`);
      }
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("callback resolution aborted");
    }
    return addresses[0];
  }

  function send(url, address, { body, headers, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const call = request(
        url,
        {
          method: "POST",
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
          // Pinning the already-validated address as the lookup result means no
          // second DNS query happens between validation and connection.
          // Node calls this with all:true when autoSelectFamily is on (the
          // default from Node 24) and then expects an array; the two-argument
          // string form silently breaks the pin. Both shapes are honoured, and
          // autoSelectFamily is disabled since exactly one address is pinned.
          lookup: (_hostname, options, done) => (options && options.all
            ? done(null, [{ address, family: isIP(address) }])
            : done(null, address, isIP(address))),
          autoSelectFamily: false,
          // SNI carries the original hostname so the certificate is validated
          // against the name, not the pinned address. An IP literal has no
          // name to present.
          servername: url.hostname === address || url.hostname === `[${address}]` ? undefined : url.hostname,
          signal,
          timeout: deadlineMs,
        },
        (response) => {
          const status = response.statusCode || 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            finish(null, { status, redirected: true, text: "" });
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              // Settle with the real reason BEFORE destroying: destroy emits
              // 'aborted', which would otherwise win and mask why it failed.
              // An oversized response is a failure, never a truncated success.
              finish(new Error(`callback response exceeded ${MAX_RESPONSE_BYTES} bytes`));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => finish(null, { status, redirected: false, text: Buffer.concat(chunks).toString("utf8") }));
          response.once("error", (error) => finish(error));
          response.once("aborted", () => finish(new Error("callback response was aborted")));
          response.once("close", () => finish(new Error("callback response closed before completing")));
        },
      );
      call.once("error", (error) => finish(error));
      call.once("timeout", () => call.destroy(new Error("callback request timed out")));
      call.end(body);
    });
  }

  function exchange(label, value, name, body, headers) {
    return withDeadline(label, async (signal) => {
      const url = parseCallbackUrl(value, name);
      const address = await resolvePinned(url, name, signal);
      const response = await send(url, address, { body, headers: headers(url), signal });
      if (response.redirected) {
        throw new Error(`${name} returned a redirect (HTTP ${response.status}); redirects are refused`);
      }
      return response;
    });
  }

  return {
    addressReason,
    validate(value, name = "delivery.url") {
      return withDeadline(`${name} validation`, async (signal) => {
        const url = parseCallbackUrl(value, name);
        return { url, address: await resolvePinned(url, name, signal) };
      });
    },
    deliver(value, { body, secretKey, secretKeys, subscriptionId, id, name = "delivery.url" }) {
      return exchange("callback delivery", value, name, body,
        () => signingHeaders({ secretKey, secretKeys, id, body, subscriptionId }));
    },
    // The verification handshake proves the caller controls the destination
    // before any application data is sent to it.
    async verify(value, { secretKey, subscriptionId, name = "delivery.url" }) {
      const challenge = challengeValue();
      const body = JSON.stringify({ type: "verification", challenge });
      const id = webhookId("msg_verification");
      const response = await exchange("callback verification", value, name, body,
        () => signingHeaders({ secretKey, id, body, subscriptionId }));
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`verification returned HTTP ${response.status}`);
      }
      let echoed;
      try { echoed = JSON.parse(response.text); }
      catch { throw new Error("verification response was not JSON"); }
      if (!constantTimeEquals(String(echoed?.challenge ?? ""), challenge)) {
        throw new Error("verification response did not echo the challenge");
      }
      return true;
    },
  };
}
