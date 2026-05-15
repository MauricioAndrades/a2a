export function isLoopbackAddress(address) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
    if (!cfg.key && !Object.keys(cfg.peers||{}).length) {
        return loopback ? { ok: true, kind: "local-open", loopback } : { ok: false };
    }
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token) return { ok: false };
    if (cfg.key && token === cfg.key) return { ok: true, kind: "operator", loopback };
    const peer = Object.entries(cfg.peers||{}).find(([, p]) => p.key === token);
    if (peer) return { ok: true, kind: "peer", peer: peer[0], loopback };
    return { ok: false };
}

export function configuredPeerUrl(cfg, peerName) {
    const url = cfg.peers?.[peerName]?.url;
    return typeof url === "string" && url ? url.replace(/\/$/, "") : null;
}
