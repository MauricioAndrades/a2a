const ENVELOPE_RESERVED = new Set(["to","from","origin","body","action","replyTo"]);

/**
 * XML 1.0 forbids NUL and several C0 controls inside character data; leaving them yields
 * non-well-formed payloads that choke strict parsers despite &lt;-style escapes.
 *
 * Allowed: TAB, LF, CR, U+0020–U+D7FF, U+E000–U+FFFD, and supplementary planes (non-surrogate halves).
 *
 * Strips stray surrogate code units (cannot represent Unicode scalar values in XML character data).
 */
export function sanitizeForXmlCharacterData(s) {
    let out = "";
    let i = 0;
    const str = String(s);
    while (i < str.length) {
        const cu = str.charCodeAt(i);
        /** High surrogate starts a UTF-16 pair */
        if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < str.length) {
            const low = str.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                const cp = 0x10000 + ((cu - 0xd800) << 10) + (low - 0xdc00);
                /** Supplementary BMP gap (XML allows #x10000–#x10FFFF) */
                if (cp <= 0x10ffff) out += str.slice(i, i + 2);
                i += 2;
                continue;
            }
        }
        /** Lone surrogates */
        if (cu >= 0xd800 && cu <= 0xdfff) {
            i += 1;
            continue;
        }
        /** TAB, LF, CR, printable and high BMP minus surrogate blocks */
        if (cu === 0x09 || cu === 0x0a || cu === 0x0d) out += String.fromCharCode(cu);
        else if (cu >= 0x20 && cu <= 0xd7ff) out += String.fromCharCode(cu);
        else if (cu >= 0xe000 && cu <= 0xfffd) out += String.fromCharCode(cu);
        /** else illegal control / NUL → drop */
        i += 1;
    }
    return out;
}

export function escapeXml(s) {
    return sanitizeForXmlCharacterData(String(s)).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function escapeXmlText(s) {
    return sanitizeForXmlCharacterData(String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
