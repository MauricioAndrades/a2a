import { createHash, timingSafeEqual } from "crypto";

export function isLoopbackAddress(address) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Constant-time UTF-8 string compare without revealing length via `===` short-circuit.
 * Maps both sides through SHA-256 so `timingSafeEqual` always runs on 32-byte digests.
 */
export function secretsEqualUtf8(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const da = createHash("sha256").update(a, "utf8").digest();
    const db = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(da, db);
}

/**
 * True when `origin` parses to an http(s) URL whose hostname is loopback-safe for CORS
 * mirrors (matches local-open peer traffic). WHATWG preserves IPv6 literals with brackets:
 * hostname is `[::1]`, never bare `::1`.
 */
export function isTrustedBrowserLoopbackHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return false;
    const lc = hostname.toLowerCase();
    if (lc === "127.0.0.1" || lc === "localhost") return true;
    const bare = lc.startsWith("[") && lc.endsWith("]") ? lc.slice(1, -1) : lc;
    return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

export function authFromRequest(req, cfg) {
    const loopback = isLoopbackAddress(req.socket?.remoteAddress || "");
    if (!cfg.key && !Object.keys(cfg.peers || {}).length) {
        return loopback ? { ok: true, kind: "local-open", loopback } : { ok: false };
    }
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token) return { ok: false };

    /** Always evaluate every peer digest so match position does not leak via early exit */
    let matchedPeer = null;
    for (const [name, p] of Object.entries(cfg.peers || {})) {
        const pk = typeof p?.key === "string" ? p.key : "";
        if (pk && secretsEqualUtf8(token, pk)) matchedPeer = name;
    }

    const operatorConfigured = typeof cfg.key === "string" && cfg.key !== "";
    if (operatorConfigured && secretsEqualUtf8(token, cfg.key)) {
        return { ok: true, kind: "operator", loopback };
    }
    if (matchedPeer !== null) return { ok: true, kind: "peer", peer: matchedPeer, loopback };
    return { ok: false };
}

export function configuredPeerUrl(cfg, peerName) {
    const url = cfg.peers?.[peerName]?.url;
    return typeof url === "string" && url ? url.replace(/\/$/, "") : null;
}
