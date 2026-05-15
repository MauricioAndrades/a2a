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
