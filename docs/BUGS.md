# a2a Bug Report

Found collaboratively by mau + sam via split codebase review.

---

## Bug 1 — Field name mismatch between parse paths (CRITICAL)

**Files:** `a2a-argv.mjs:93–100`, `a2a-tokens.mjs:82–89`

The two parse entry points return different shapes for the same conceptual fields:

| Field        | `parseFlagSendArgv` | `parseColonFlagArgv` |
|--------------|---------------------|----------------------|
| message body | `content`           | `message`            |
| recipients   | `recipients`        | `to`                 |

Any caller that handles both paths and reads `.content` or `.recipients` gets `undefined` when the colon-flag path ran. Silent data loss — no error, no warning, wrong message sent or dropped.

**Fix:** Standardise on `{ action, recipients, content, from, origin }`. `parseColonFlagArgv` must rename `message` → `content` and `to` → `recipients`.

---

## Bug 2 — Body injection guard is broken (SECURITY)

**File:** `a2a-server.mjs:43`

```js
const safeBody = msg.body.replace(/<\/a2a_message>/gi, "<\\/a2a_message>");
```

In XML, `\/` is not an escape sequence. `<\/a2a_message>` is parsed identically to `</a2a_message>`. A body containing the literal string `</a2a_message>` still closes the envelope early, allowing injection of fake envelope attributes or additional messages into the receiving agent's input stream. The guard does nothing.

**Fix:** Do not attempt fake slash escaping of untrusted body content. XML-escape body text before placing it inside the envelope, or use another structured encoding that cannot terminate the envelope.

---

## Bug 3 — Unauthenticated registry poisoning via `replyTo` (SECURITY)

**File:** `a2a-server.mjs:135–137`

```js
if (body.replyTo && !registry.has(body.from)) {
    registry.set(body.from, { agentId: body.from, tmuxTarget: `${body.from}:0.0`, bridgeUrl: body.replyTo, ... });
}
```

Any caller that can reach `/api/a2a/send` can inject arbitrary agent IDs into the in-memory registry by setting `body.from` to any name and including `body.replyTo`. When no auth key is configured (the default), this is completely open. An attacker can hijack an existing agent slot by registering as it before the real agent does.

**Fix:** Auto-registration via `replyTo` must require that the sender is authenticated and that `body.from` matches the authenticated identity — i.e. you can only self-register, not impersonate others. Alternatively, remove `replyTo` auto-registration entirely and require explicit `/api/a2a/register` calls for all peers.

---

## Bug 4 — `isFlagSendArgv` returns `true` on parse exception (ERROR MASKING)

**File:** `a2a-argv.mjs:31–35`

```js
try {
    return parseFlagSendArgv(argv) !== null;
} catch {
    return true;  // BUG: should be false, or rethrow
}
```

When `parseFlagSendArgv` throws (e.g. `--content` with no following value), `isFlagSendArgv` reports `true` — "yes, this is flag-send syntax". The caller then calls `parseFlagSendArgv` again, which throws again. The original error is effectively masked behind a second exception.

**Fix:** `catch { return false; }` if the intent is "not parseable = not flag-send". Or rethrow if the intent is "malformed flag-send should propagate". Returning `true` on exception is not defensible under either interpretation.

---

## Bug 5 — Any unrecognised bare flag silently becomes a recipient (LOGIC)

**Files:** `a2a-argv.mjs:78–84`, `a2a-tokens.mjs:74–77`

`parseFlagSendArgv`:
```js
// falls through all known flag checks
recipients.push(key);  // line 82 — key is anything not matched above
```

`parseColonFlagArgv`:
```js
if (!RESERVED_FLAG_KEYS.has(flagPart)) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { extras[flagPart] = next; i++; }
    else recipients.push(flagPart);  // unknown flag with no value → recipient
}
```

`a2a --verbose --sam hello` registers `verbose` as a recipient alongside `sam`. No error. Message is sent to both — or silently dropped if `verbose` does not resolve.

**Fix:** Only treat a bare flag as a recipient if it matches a known agent or group name from the registry. Reject unrecognised bare flags with an explicit error.

---

## Bug 6 — `--content` and positional args concatenate instead of `--content` winning (UX)

**File:** `a2a-argv.mjs:89–96`

```js
const contentParts = [];
if (typeof flags.content === "string") contentParts.push(flags.content);
if (positional.length > 0) contentParts.push(...positional);  // appended unconditionally
```

`a2a --content "scheduled message" extra words` produces content `"scheduled message extra words"`. The `--content` flag was presumably provided to set the body precisely; silently appending positional args corrupts it.

**Fix:** When `flags.content` is present, ignore `positional` entirely. Use positional only as the fallback when `--content` is absent.

---

## Bug 7 — Colon flag with `=` suffix passes full string to `classifyToken` (EDGE CASE)

**File:** `a2a-tokens.mjs:61–67`

```js
const flagPart = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);  // strips -- and =value
if (flagPart.includes(":")) {
    const result = parseColonFlag(arg, registry);  // BUG: passes full arg, not flagPart
```

For `--message:bob=value`, `flagPart` is correctly `"message:bob"` and triggers the colon-flag branch. But `parseColonFlag` receives the original `arg` (`"--message:bob=value"`). Inside, `rawFlag.slice(2).split(":")` produces `["message", "bob=value"]`. `classifyToken("bob=value")` returns `kind: "unknown"`, so `"bob=value"` is pushed into `recipients`.

**Fix:** Pass `"--" + flagPart` (the `=`-stripped form) to `parseColonFlag`, or strip the `=value` suffix inside `parseColonFlag` before splitting.

---

## Bug 8 — No body size limit in `readJsonBody` (DoS)

**File:** `a2a-server.mjs:17–23`

```js
let raw = "";
req.on("data", (c) => { raw += c.toString(); });
```

No maximum size is enforced. A sender that streams a large body can exhaust heap memory. Low-severity when the bridge is local-only, but relevant when exposed via `a2a start-global` (ngrok).

**Fix:** Add a `MAX_BODY` constant (e.g. 1 MB) and `reject()` once `raw.length` exceeds it.

---

## Bug 9 — Invalid `A2A_PORT` env var silently falls back (MISCONFIGURATION)

**File:** `a2a-config.mjs:83–86`

```js
const env = process.env.A2A_PORT;
if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n > 0) return n; }
// silently falls through to config-file port
```

If `A2A_PORT` is set to a non-numeric value, the guard silently fails and the config-file port is used with no warning. The env var is effectively ignored with no feedback.

**Fix:** If `A2A_PORT` is set but fails validation, throw or `console.warn` rather than silently falling back.

---

## Bug 10 — `configSet("host", ...)` accepts any string (MINOR)

**File:** `a2a-config.mjs:63–75`

`port` is validated with `parseInt` + `isFinite` check. `host` is not. `configSet("host", "")` succeeds and persists an empty string, which breaks `activeHost()` and the server bind.

**Fix:** Add basic hostname/IP validation for `host` in `configSet`, or at minimum reject empty string.

---

## Summary

| # | Severity | File(s) | Issue |
|---|----------|---------|-------|
| 1 | Critical | argv.mjs, tokens.mjs | Field name mismatch between parse paths (`content`/`recipients` vs `message`/`to`) |
| 2 | Security | server.mjs | Broken body injection guard (`<\/a2a_message>` is not an XML escape) |
| 3 | Security | server.mjs | Unauthenticated registry poisoning via `replyTo` |
| 4 | Logic | argv.mjs | `isFlagSendArgv` catch returns `true` instead of `false` |
| 5 | Logic | argv.mjs, tokens.mjs | Unrecognised bare flag silently promoted to recipient |
| 6 | UX | argv.mjs | `--content` + positional args concatenate instead of `--content` winning |
| 7 | Edge case | tokens.mjs | Colon flag with `=` passes full string to `classifyToken` |
| 8 | DoS | server.mjs | No body size limit in `readJsonBody` |
| 9 | Misconfiguration | config.mjs | Invalid `A2A_PORT` silently falls back with no warning |
| 10 | Minor | config.mjs | `host` not validated in `configSet` |
