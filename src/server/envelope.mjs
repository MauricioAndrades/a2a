/**
 * SECURITY: extra header attributes are an explicit allowlist, not a
 * reserved-key denylist. The bridge spreads the raw /api/a2a/send body into
 * wrapEnvelope (a2a-server.mjs handleBridgeSendBody), so any sender controls
 * every non-reserved key; rendering arbitrary keys let callers inject
 * provenance-looking attributes (e.g. trusted="yes") and leaked internal
 * fields (the spec route's specMessage object as "[object Object]").
 *
 * Keys listed here come from real sender usage:
 *   - mood:     colon-syntax meta example `--mood=angry` (skills/a2a/SKILL.md)
 *   - priority: CLI meta extras (tests/a2a-argv-vitest.test.mjs,
 *               tests/a2a-tokens-vitest.test.mjs)
 *
 * Only string values render — internal objects (specMessage) and other
 * non-string payload fields are never serialized into the header.
 */
const ENVELOPE_EXTRA_DISPLAY_KEYS = new Set(["mood", "priority"]);

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
    if (cu === 0x09 || cu === 0x0a || cu === 0x0d)
      out += String.fromCharCode(cu);
    else if (cu >= 0x20 && cu <= 0xd7ff) out += String.fromCharCode(cu);
    else if (cu >= 0xe000 && cu <= 0xfffd) out += String.fromCharCode(cu);
    /** else illegal control / NUL → drop */
    i += 1;
  }
  return out;
}

/**
 * Escape characters that would break out of a double-quoted attribute value
 * in the `<a2a ...>` sigil header. Attribute escaping is kept because the
 * header line is the only part of the envelope with positional syntax humans
 * and LLMs rely on (`from="..."`, `origin="..."`). Body content does NOT use
 * this — nothing parses the envelope, so the body is passed through verbatim
 * (after control-char sanitization) to avoid mangling `<`, `>`, `&`, code,
 * shell syntax, comparisons, JSX, and envelope-format examples.
 */
export function escapeXml(s) {
  return sanitizeForXmlCharacterData(String(s))
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function wrapEnvelope(msg) {
  const safeBody = sanitizeForXmlCharacterData(String(msg.body));
  const origin = displayOrigin(msg);
  const originAttr = origin ? ` origin="${escapeXml(origin)}"` : "";
  const extras = Object.entries(msg)
    .filter(([k]) => ENVELOPE_EXTRA_DISPLAY_KEYS.has(k))
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => ` ${escapeXml(k)}="${escapeXml(v)}"`)
    .join("");
  return `<a2a from="${escapeXml(msg.from)}"${originAttr}${extras}>\n${safeBody}\n</a2a>`;
}

function displayOrigin(msg) {
  if (msg?.origin === "user") {
    return typeof msg.source === "string" && msg.source.trim()
      ? msg.source.trim()
      : "cli";
  }
  if (msg?.origin === "self") return "self";
  return null;
}
