export function isLoopbackHost(host) {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function parseAllowedSenders(raw) {
    return new Set(
        String(raw || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

export function channelStartupProblem({ host, allowed, key }) {
    if (isLoopbackHost(host)) return null;
    if (allowed.size === 0 || !key) return "a2a-channel non-loopback host requires A2A_CHANNEL_SENDERS and A2A_CHANNEL_KEY";
    return null;
}

export function bearerToken(req) {
    const header = (req.headers.authorization || "").toString();
    return header.startsWith("Bearer ") ? header.slice(7) : header;
}
