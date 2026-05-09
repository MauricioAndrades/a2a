import test from "node:test";
import assert from "node:assert/strict";
import { wrapEnvelope } from "../src/server/envelope.mjs";

test("wrapEnvelope escapes XML attributes and preserves body in CDATA", () => {
    const out = wrapEnvelope({ from: "a<&", to: "b\"", origin: "user", action: "ask", body: "hello <world>", mood: "x<y" });
    assert.match(out, /from="a&lt;&amp;"/);
    assert.match(out, /to="b&quot;"/);
    assert.match(out, /mood="x&lt;y"/);
    assert.match(out, /<!\[CDATA\[\nhello <world>\n\]\]>/);
});

test("wrapEnvelope splits embedded CDATA terminators", () => {
    const out = wrapEnvelope({ from: "a", to: "b", origin: "user", body: "x]]>y" });
    assert.match(out, /x\]\]\]\]><!\[CDATA\[>y/);
});
