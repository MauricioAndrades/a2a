import test from "node:test";
import assert from "node:assert/strict";
import { wrapEnvelope } from "../src/server/envelope.mjs";

test("wrapEnvelope escapes XML attributes and body text without noisy metadata", () => {
    const out = wrapEnvelope({ from: "a<&", to: "b\"", origin: "user", action: "ask", body: "hello <world>", mood: "x<y" });
    assert.match(out, /from="a&lt;&amp;"/);
    assert.match(out, /to="b&quot;"/);
    assert.match(out, /mood="x&lt;y"/);
    assert.doesNotMatch(out, / action=/);
    assert.doesNotMatch(out, /<!\[CDATA\[/);
    assert.match(out, /\nhello &lt;world&gt;\n/);
});

test("wrapEnvelope escapes embedded close tags and CDATA terminators as text", () => {
    const out = wrapEnvelope({ from: "a", to: "b", origin: "user", body: "x]]>y</a2a_message>" });
    assert.match(out, /x\]\]&gt;y&lt;\/a2a_message&gt;/);
    assert.doesNotMatch(out, /<!\[CDATA\[/);
});

test("wrapEnvelope drops illegal XML chars (NUL, C0 controls, lone surrogates)", () => {
    const nulBody = wrapEnvelope({
        from: "a",
        to: "b",
        origin: "user",
        body: "before\u0000after\u000b",
    });
    assert.ok(!nulBody.includes("\u0000"));
    assert.match(nulBody, /beforeafter/);

    const mixed = wrapEnvelope({
        from: "a\uD800",
        to: "b",
        origin: "user",
        body: "\u001fx",
        tag: "!",
    });
    assert.match(mixed, /from="a"/);
    assert.ok(!mixed.includes("\u001f"));

    /** Valid supplementary emoji preserved */
    const ok = wrapEnvelope({ from: "z", to: "z", origin: "user", body: "\u{1f600}done" });
    assert.match(ok.split("\n")[1], /^\u{1f600}done$/u);

    /** Lone low surrogate stripped from body without breaking following text */
    const lone = wrapEnvelope({ from: "z", to: "z", origin: "user", body: "\uDC00tail" });
    assert.match(lone.split("\n")[1], /^tail$/);
});
