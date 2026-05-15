const ENVELOPE_RESERVED = new Set(["to","from","origin","body","action","replyTo"]);

export function escapeXml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function escapeXmlText(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function wrapEnvelope(msg) {
    const ts = new Date().toISOString();
    const safeBody = escapeXmlText(msg.body);
    const extras = Object.entries(msg)
        .filter(([k]) => !ENVELOPE_RESERVED.has(k))
        .map(([k, v]) => ` ${escapeXml(k)}="${escapeXml(String(v))}"`)
        .join("");
    return `<a2a_message from="${escapeXml(msg.from)}" to="${escapeXml(msg.to)}" origin="${escapeXml(msg.origin)}"${extras} ts="${ts}">\n${safeBody}\n</a2a_message>`;
}
