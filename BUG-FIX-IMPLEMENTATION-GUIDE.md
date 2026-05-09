# Bug Fix Implementation Guide

Source plan: `bug-fix.md`

Status: locked (2026-05-09)

Generated: 2026-05-09

This guide converts the current bug-fix plan into an execution ledger. The executable bug-fix path is rendered below. The only excluded work is the user-approved future work: full CLI decomposition and package renaming.

## Status

Open blockers: 0

Executable steps: 11

Deferred follow-up steps: 4

The executable work covers the residual correctness and trust fixes, installer and documentation corrections, test seams, test suite, YAML parser replacement, logging configuration, and parser dispatch normalization. The Phase 3 test-seam decision is resolved: use surgical pure-helper extraction before the full test suite, not subprocess-first integration tests.

## Resolved Decisions

### B1 [resolved] Test seam strategy

Decision: extract small pure helper modules before rendering Phase 3 tests. Do not use subprocess-first tests as the primary strategy for `wrapEnvelope`, `checkAuth`, or reconnect target resolution.

The implementation guide should introduce narrow helper modules such as `src/server/envelope.mjs`, `src/server/auth.mjs`, and `src/cli/reconnect-targets.mjs`. The server and CLI should import those helpers, and `tests/envelope.test.mjs`, `tests/auth.test.mjs`, and `tests/reconnect.test.mjs` should test the helpers directly. Process-level smoke tests can still exist later, but they are not the core Phase 3 seam.

### B2 [resolved] Colon flag value semantics

Decision: `--message:bob=value` means `content: "value"`. The value after `=` is message content for colon-form flags that include an action or recipient. It is not metadata and it is not ignored.

Guardrail: a colon-form `=value` and positional message content must not both be present in the same command. That case should throw a clear duplicate-content error rather than silently choosing one body.

### B3 [resolved] CLI decomposition scope

Decision: defer Phase 6 into its own implementation guide after this bug-fix guide is locked and executed through Phase 5.

This guide should not expand the full `src/cli.mjs` decomposition. It may add narrow helper seams required for tests, per resolved decision B1, but it must not attempt the broader module split, restart deduplication, or start-target deduplication here. After this guide lands, create a separate CLI extraction guide with one mechanical step per module.

### B4 [resolved] Package rename scope

Decision: defer Phase 8 until after the bug-fix work lands and the project has a name worth migrating to.

This guide should not rename the npm package, CLI, endpoints, skill directory, process title, or envelope. If the bug-fix work touches docs where Agent2Agent v1.0 confusion is likely, it may add a narrow clarification that this project is not the Agent2Agent v1.0 protocol. The actual rename/reframe belongs in a later identity and migration release.

## Step 1: Make flag-form send parsing registry-aware

Rationale: `src/a2a-argv.mjs` currently treats any bare unknown `--flag` as a recipient. That means accidental flags like `--verbose` are silently interpreted as target agents. Colon-form parsing already has registry-aware unknown flag rejection through `src/a2a-tokens.mjs`; flag-form parsing should use the same mental model during execution while preserving shape detection in `isFlagSendArgv`.

Current files read:

`src/a2a-argv.mjs`

`src/a2a-tokens.mjs`

`src/cli.mjs`

Before, in `src/a2a-argv.mjs`:

```js
export function isFlagSendArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return false;
    if (!argv[0]?.startsWith("--")) return false;

    try {
        return parseFlagSendArgv(argv) !== null;
    } catch {
        return false;
    }
}

export function parseFlagSendArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return null;

    const recipients = [];
    const positional = [];
    const flags = {};
    let action = "message";
    let sawSendSyntax = false;
```

After:

```js
function hasRegistrySet(registry, key) {
    return registry && registry[key] instanceof Set;
}

function isKnownRecipient(key, registry) {
    if (!hasRegistrySet(registry, "agents") || !hasRegistrySet(registry, "groups")) return true;
    const lower = key.toLowerCase();
    return registry.agents.has(key)
        || registry.agents.has(lower)
        || registry.groups.has(key)
        || registry.groups.has(lower);
}

function assertKnownRecipient(key, registry) {
    if (!isKnownRecipient(key, registry)) throw new Error(`unknown flag --${key}`);
}

export function isFlagSendArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return false;
    if (!argv[0]?.startsWith("--")) return false;

    try {
        return parseFlagSendArgv(argv) !== null;
    } catch {
        return false;
    }
}

export function parseFlagSendArgv(argv, registry = null) {
    if (!Array.isArray(argv) || argv.length === 0) return null;

    const recipients = [];
    const positional = [];
    const flags = {};
    let action = "message";
    let sawSendSyntax = false;
```

Before, later in `src/a2a-argv.mjs`:

```js
        if (eqIdx !== -1) {
            return null;
        }

        recipients.push(key);
        sawSendSyntax = true;
        i += 1;
    }

    if (!sawSendSyntax) return null;

    const content = typeof flags.content === "string"
        ? flags.content
        : positional.join(" ").trim();

    return {
        action,
        recipients: [...new Set(recipients)],
        content,
        from: typeof flags.from === "string" ? flags.from : undefined,
        origin: typeof flags.origin === "string" ? flags.origin : undefined,
        to: typeof flags.to === "string" ? flags.to : undefined,
    };
}
```

After:

```js
        if (eqIdx !== -1) {
            return null;
        }

        assertKnownRecipient(key, registry);
        recipients.push(key);
        sawSendSyntax = true;
        i += 1;
    }

    if (!sawSendSyntax) return null;

    const content = typeof flags.content === "string"
        ? flags.content
        : positional.join(" ").trim();

    if (typeof flags.to === "string") assertKnownRecipient(flags.to, registry);

    return {
        action,
        recipients: [...new Set(recipients)],
        content,
        from: typeof flags.from === "string" ? flags.from : undefined,
        origin: typeof flags.origin === "string" ? flags.origin : undefined,
        to: typeof flags.to === "string" ? flags.to : undefined,
    };
}
```

Before, in `src/cli.mjs`:

```js
    if (isFlagSendArgv(argv)) {
        try {
            const parsed = parseFlagSendArgv(argv);
            if (!parsed) die("could not parse send arguments", 1);
            await doParsedFlagSend(parsed); return;
        } catch (err) { die(err.message, 1); }
    }
```

After:

```js
    if (isFlagSendArgv(argv)) {
        try {
            const parsed = parseFlagSendArgv(argv, await getRegistry());
            if (!parsed) die("could not parse send arguments", 1);
            await doParsedFlagSend(parsed); return;
        } catch (err) { die(err.message, 1); }
    }
```

Verification:

```bash
node --test tests/parsers.test.mjs
```

Until Phase 3 exists, manually smoke these:

```bash
node -e 'import("./src/a2a-argv.mjs").then(({isFlagSendArgv}) => console.log(isFlagSendArgv(["--verbose","hello"])))'
node -e 'import("./src/a2a-argv.mjs").then(({parseFlagSendArgv}) => { try { parseFlagSendArgv(["--verbose","hello"], {agents:new Set(["bob"]), groups:new Set()}); } catch (e) { console.log(e.message); } })'
```

## Step 1A: Treat colon-form equals values as message content

Rationale: the parser test plan names `--message:bob=value`. Resolved decision B2 defines that value as the message body. The current parser recognizes the `message:bob` part and drops `=value`, which would make the command silently lose content.

Current files read:

`src/a2a-tokens.mjs`

Before, in `src/a2a-tokens.mjs`:

```js
export function parseColonFlagArgv(argv, registry) {
    let action = null;
    const recipients = [];
    const extras = {};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
        if (!arg.startsWith("--")) { positional.push(arg); continue; }
        const eqIdx = arg.indexOf("=");
        const flagPart = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

        if (flagPart.includes(":")) {
            const result = parseColonFlag("--" + flagPart, registry);
            if (result.action !== null && action === null) action = result.action;
            recipients.push(...result.recipients);
            continue;
        }
        if (eqIdx !== -1) { extras[flagPart] = arg.slice(eqIdx + 1); continue; }
        const c = classifyToken(flagPart, registry);
        if (c.kind === "action" && action === null) { action = c.value; continue; }
        if (c.kind === "agent" || c.kind === "group") { recipients.push(flagPart); continue; }
        if (!RESERVED_FLAG_KEYS.has(flagPart)) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) { extras[flagPart] = next; i++; }
            else if (registry.agents.has(flagPart) || registry.groups.has(flagPart)) { recipients.push(flagPart); }
            else { throw new Error(`unknown flag --${flagPart}`); }
        }
    }

    const { from: fromExtra, origin: originExtra, ...meta } = extras;
    return {
        from: fromExtra || null,
        origin: originExtra || null,
        recipients: [...new Set(recipients.filter(Boolean))],
        action: action || "message",
        content: positional.join(" ").trim(),
        ...meta,
    };
}
```

After:

```js
export function parseColonFlagArgv(argv, registry) {
    let action = null;
    let inlineContent = null;
    const recipients = [];
    const extras = {};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
        if (!arg.startsWith("--")) { positional.push(arg); continue; }
        const eqIdx = arg.indexOf("=");
        const flagPart = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);

        if (flagPart.includes(":")) {
            const result = parseColonFlag("--" + flagPart, registry);
            if (result.action !== null && action === null) action = result.action;
            recipients.push(...result.recipients);
            if (eqIdx !== -1) {
                if (inlineContent !== null) throw new Error("message content specified more than once");
                inlineContent = arg.slice(eqIdx + 1);
            }
            continue;
        }
        if (eqIdx !== -1) { extras[flagPart] = arg.slice(eqIdx + 1); continue; }
        const c = classifyToken(flagPart, registry);
        if (c.kind === "action" && action === null) { action = c.value; continue; }
        if (c.kind === "agent" || c.kind === "group") { recipients.push(flagPart); continue; }
        if (!RESERVED_FLAG_KEYS.has(flagPart)) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) { extras[flagPart] = next; i++; }
            else if (registry.agents.has(flagPart) || registry.groups.has(flagPart)) { recipients.push(flagPart); }
            else { throw new Error(`unknown flag --${flagPart}`); }
        }
    }

    const positionalContent = positional.join(" ").trim();
    if (inlineContent !== null && positionalContent) throw new Error("message content specified more than once");

    const { from: fromExtra, origin: originExtra, ...meta } = extras;
    return {
        from: fromExtra || null,
        origin: originExtra || null,
        recipients: [...new Set(recipients.filter(Boolean))],
        action: action || "message",
        content: inlineContent !== null ? inlineContent : positionalContent,
        ...meta,
    };
}
```

Verification:

```bash
node --test tests/parsers.test.mjs
```

Until Phase 3 exists, manually smoke this:

```bash
node -e 'import("./src/a2a-tokens.mjs").then(({parseColonFlagArgv}) => console.log(parseColonFlagArgv(["--message:bob=value"], {actions:new Set(["message","reply","ask","write"]), agents:new Set(["bob"]), groups:new Set()})))'
```

## Step 2: Enforce local and remote trust in `/api/a2a/register`

Rationale: current registration accepts any authenticated caller and writes whatever `bridgeUrl` the body supplies. For a local open bridge that is acceptable only on loopback. For peer-key auth, the caller should only be able to register itself as a remote peer, should get its URL from trusted config, and should not overwrite a local registration.

Current files read:

`src/a2a-server.mjs`

Before, in `src/a2a-server.mjs`:

```js
function checkAuth(req) {
    const cfg = loadConfig();
    if (!cfg.key && !Object.keys(cfg.peers||{}).length) return { ok: true };
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token) return { ok: false };
    if (cfg.key && token === cfg.key) return { ok: true };
    const peer = Object.entries(cfg.peers||{}).find(([, p]) => p.key === token);
    if (peer) return { ok: true, peer: peer[0] };
    return { ok: false };
}
```

After:

```js
function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress || "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function configuredPeerUrl(peerName) {
    const cfg = loadConfig();
    const url = cfg.peers?.[peerName]?.url;
    return typeof url === "string" && url ? url.replace(/\/$/, "") : null;
}

function checkAuth(req) {
    const cfg = loadConfig();
    const loopback = isLoopbackRequest(req);
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
```

Before, in the register route:

```js
    if (method === "POST" && path === "/api/a2a/register") {
        try {
            const body = await readJsonBody(req);
            if (!body.agentId || !body.tmuxTarget) { fail(res, 400, "agentId and tmuxTarget are required"); return true; }
            registry.set(body.agentId, {
                agentId: body.agentId,
                tmuxTarget: body.tmuxTarget,
                cwd: body.cwd,
                description: body.description,
                bridgeUrl: body.bridgeUrl,
                backend: body.backend,
                backendArgs: Array.isArray(body.backendArgs) ? body.backendArgs : undefined,
                backendEnv: body.backendEnv && typeof body.backendEnv === "object" ? body.backendEnv : undefined,
                registeredAt: Date.now(),
            });
            ok(res, registry.get(body.agentId));
        } catch (e) { fail(res, 400, `invalid body: ${e.message}`); }
        return true;
    }
```

After:

```js
    if (method === "POST" && path === "/api/a2a/register") {
        try {
            const body = await readJsonBody(req);
            if (!body.agentId || !body.tmuxTarget) { fail(res, 400, "agentId and tmuxTarget are required"); return true; }

            const local = auth.kind === "operator" || (auth.kind === "local-open" && auth.loopback);
            const peer = auth.kind === "peer" && auth.peer === body.agentId;
            if (!local && !peer) { fail(res, 403, "not allowed to register this agent"); return true; }

            const existing = registry.get(body.agentId);
            if (peer && existing?.kind === "local") { fail(res, 409, "remote peer cannot overwrite local registration"); return true; }

            const kind = local ? "local" : "remote";
            const bridgeUrl = kind === "remote" ? configuredPeerUrl(body.agentId) : body.bridgeUrl;
            if (kind === "remote" && !bridgeUrl) { fail(res, 403, "remote peer URL is not configured"); return true; }

            registry.set(body.agentId, {
                agentId: body.agentId,
                kind,
                tmuxTarget: body.tmuxTarget,
                cwd: body.cwd,
                description: body.description,
                bridgeUrl,
                backend: body.backend,
                backendArgs: Array.isArray(body.backendArgs) ? body.backendArgs : undefined,
                backendEnv: body.backendEnv && typeof body.backendEnv === "object" ? body.backendEnv : undefined,
                registeredAt: Date.now(),
            });
            ok(res, registry.get(body.agentId));
        } catch (e) { fail(res, 400, `invalid body: ${e.message}`); }
        return true;
    }
```

Also update the send-route auto-registration block, currently:

```js
            if (body.replyTo && !registry.has(body.from) && auth.peer === body.from) {
                registry.set(body.from, { agentId: body.from, tmuxTarget: `${body.from}:0.0`, bridgeUrl: body.replyTo, registeredAt: Date.now() });
            }
```

After:

```js
            if (body.replyTo && !registry.has(body.from) && auth.kind === "peer" && auth.peer === body.from) {
                const bridgeUrl = configuredPeerUrl(body.from) || String(body.replyTo).replace(/\/$/, "");
                registry.set(body.from, {
                    agentId: body.from,
                    kind: "remote",
                    tmuxTarget: `${body.from}:0.0`,
                    bridgeUrl,
                    registeredAt: Date.now(),
                });
            }
```

Verification:

```bash
node --test tests/auth.test.mjs
```

Until Phase 3 exists, use curl against a temporary bridge with and without `A2A_KEY`, confirming that open registration only works from loopback and that peer-key registration cannot register a different agent id.

## Step 3: Require an operator key for `start-global` unless explicitly insecure

Rationale: `a2a start-global` exposes the bridge through ngrok. Today it will do that without any configured operator key. The command should refuse by default unless the operator has configured a key or has consciously chosen `--insecure`.

Current files read:

`src/cli.mjs`

Before:

```js
async function cmdStartGlobal(args) {
    const { name: rawName, backend, backendArgs, dashboard, promptText, skills } = parseStartArgs(args);
    const hasPersona = !!(promptText || skills.length);
    const teamSpec = rawName ? loadResolvedTeamSpec(rawName) : null;
    if (teamSpec && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with team spec '${rawName}'; configure agents in the team file (role/role_file)`);
    const name = rawName ? sanitizeId(rawName) : sanitizeId(basename(process.cwd()));
    if (!teamSpec && isGroup(name) && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with group '${name}'; group members already inject their own prompts from the group's .md files`);

    const urlFlag = args.find((a) => a.startsWith("--url="))?.slice(6);
    const portFlag = args.find((a) => a.startsWith("--port="))?.slice(7);
    const filteredBackendArgs = backendArgs.filter((a) => !a.startsWith("--url=") && !a.startsWith("--port="));
```

After:

```js
async function cmdStartGlobal(args) {
    const { name: rawName, backend, backendArgs, dashboard, promptText, skills } = parseStartArgs(args);
    const hasPersona = !!(promptText || skills.length);
    const teamSpec = rawName ? loadResolvedTeamSpec(rawName) : null;
    if (teamSpec && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with team spec '${rawName}'; configure agents in the team file (role/role_file)`);
    const name = rawName ? sanitizeId(rawName) : sanitizeId(basename(process.cwd()));
    if (!teamSpec && isGroup(name) && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with group '${name}'; group members already inject their own prompts from the group's .md files`);

    const insecure = args.includes("--insecure");
    if (!loadConfig().key && !insecure) {
        die("start-global exposes the bridge and requires an operator key; run `a2a config set key <secret>` or pass --insecure", 1);
    }
    if (insecure) info("warning: exposing bridge without an operator key because --insecure was supplied");

    const urlFlag = args.find((a) => a.startsWith("--url="))?.slice(6);
    const portFlag = args.find((a) => a.startsWith("--port="))?.slice(7);
    const filteredBackendArgs = backendArgs.filter((a) => !a.startsWith("--url=") && !a.startsWith("--port=") && a !== "--insecure");
```

Verification:

```bash
node --test tests/auth.test.mjs
```

Manual smoke before tests exist:

```bash
A2A_CONFIG_DIR="$(mktemp -d)" node ./bin/a2a.mjs start-global test --insecure --port=7742 --help
```

The manual command above should be adjusted during execution so it does not actually start ngrok; once tests exist, cover the refusal before any ngrok process can be spawned.

## Step 4: Make the MCP channel default closed and require bearer auth off-loopback

Rationale: `src/a2a-channel.mjs` currently defaults `A2A_CHANNEL_SENDERS` to `dev` and accepts any body from that sender. That is convenient locally but dangerous once the channel binds to a non-loopback host. The channel should have no default sender, require explicit senders, and require `A2A_CHANNEL_KEY` bearer auth for non-loopback binds.

Current files read:

`src/a2a-channel.mjs`

Before:

```js
 *   A2A_CHANNEL_SENDERS  comma-separated X-Sender allowlist (default "dev")
 *   A2A_CHANNEL_BIN    a2a executable (default "a2a" on PATH)
 */
```

After:

```js
 *   A2A_CHANNEL_SENDERS  comma-separated X-Sender allowlist (default empty)
 *   A2A_CHANNEL_KEY      required bearer token when host is non-loopback
 *   A2A_CHANNEL_BIN      a2a executable (default "a2a" on PATH)
 */
```

Before:

```js
const PORT = Number.parseInt(process.env.A2A_CHANNEL_PORT || "8788", 10) || 8788;
const HOST = process.env.A2A_CHANNEL_HOST || "127.0.0.1";
const A2A_BIN = process.env.A2A_CHANNEL_BIN || "a2a";

const allowed = new Set(
    (process.env.A2A_CHANNEL_SENDERS || "dev")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
);
```

After:

```js
const PORT = Number.parseInt(process.env.A2A_CHANNEL_PORT || "8788", 10) || 8788;
const HOST = process.env.A2A_CHANNEL_HOST || "127.0.0.1";
const A2A_BIN = process.env.A2A_CHANNEL_BIN || "a2a";
const CHANNEL_KEY = process.env.A2A_CHANNEL_KEY || "";

const allowed = new Set(
    (process.env.A2A_CHANNEL_SENDERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
);

function isLoopbackHost(host) {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function bearerToken(req) {
    const header = (req.headers.authorization || "").toString();
    return header.startsWith("Bearer ") ? header.slice(7) : header;
}

const remoteAuthRequired = !isLoopbackHost(HOST);
if (remoteAuthRequired && (allowed.size === 0 || !CHANNEL_KEY)) {
    console.error("a2a-channel non-loopback host requires A2A_CHANNEL_SENDERS and A2A_CHANNEL_KEY");
    process.exit(1);
}
```

Before, in the POST handler:

```js
        const body = await readTextBody(req);
        const sender = (req.headers["x-sender"] || "").toString();
        if (!allowed.has(sender)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("forbidden");
            return;
        }
```

After:

```js
        const body = await readTextBody(req);
        const sender = (req.headers["x-sender"] || "").toString();
        if (!allowed.has(sender)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("forbidden");
            return;
        }
        if (remoteAuthRequired && bearerToken(req) !== CHANNEL_KEY) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("unauthorized");
            return;
        }
```

Before, at listen:

```js
httpServer.listen(PORT, HOST, () => {
    sseSend(`a2a-channel listening on http://${HOST}:${PORT} (X-Sender allowlist: ${[...allowed].join(", ")})`);
});
```

After:

```js
httpServer.listen(PORT, HOST, () => {
    const senders = allowed.size ? [...allowed].join(", ") : "(none)";
    const auth = remoteAuthRequired ? "bearer auth required" : "loopback";
    sseSend(`a2a-channel listening on http://${HOST}:${PORT} (X-Sender allowlist: ${senders}; ${auth})`);
});
```

Verification:

```bash
node --test tests/auth.test.mjs
```

Manual smoke before tests exist:

```bash
A2A_CHANNEL_HOST=0.0.0.0 node ./src/a2a-channel.mjs
```

The process should exit before listening unless both `A2A_CHANNEL_SENDERS` and `A2A_CHANNEL_KEY` are set.

## Step 5: Install the skill and welcome doc into Claude paths

Rationale: docs say bootstrap installs `skill/SKILL.md` and `src/a2a-welcome.md` under `~/.claude`, but `scripts/install.mjs` currently only checks that package-local files exist. The hook also prefers the package-local welcome file, and the committed hook contains a hardcoded developer path. Bootstrap should copy the files, use timestamped backups, and make installed paths the first non-env candidates.

Current files read:

`scripts/install.mjs`

`hooks/a2a-session-start.mjs`

Before, in `scripts/install.mjs` constants:

```js
const CLAUDE_MD_PATH = path.join(A2A_ROOT, "CLAUDE.md");
const WELCOME_DOC_PATH = path.join(A2A_ROOT, "src", "a2a-welcome.md");
```

After:

```js
const CLAUDE_MD_PATH = path.join(A2A_ROOT, "CLAUDE.md");
const WELCOME_DOC_PATH = path.join(A2A_ROOT, "src", "a2a-welcome.md");
const INSTALLED_SKILL_DIR = path.join(CLAUDE_DIR, "skills", "a2a");
const INSTALLED_SKILL_PATH = path.join(INSTALLED_SKILL_DIR, "SKILL.md");
const INSTALLED_WELCOME_DOC_PATH = path.join(CLAUDE_DIR, "a2a-welcome.md");
```

Before:

```js
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  if (!fs.statSync(filePath).isFile()) return;
  fs.copyFileSync(filePath, `${filePath}.bak`);
}
```

After:

```js
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  if (!fs.statSync(filePath).isFile()) return;
  fs.copyFileSync(filePath, `${filePath}.bak.${Date.now()}`);
}
```

Before:

```js
async function installSkill() {
  explain("skill", [
    "The a2a skill stays in this package; nothing is copied under ~/.claude/skills.",
    `Path: ${A2A_SKILL_FILE}`,
  ]);

  if (!(await confirm("Proceed with skill check?"))) {
    return { kind: "skip", reason: "user skipped skill step" };
  }

  if (!fs.existsSync(A2A_SKILL_FILE)) {
    return { kind: "skip", reason: "skill/SKILL.md not found in package" };
  }

  return { kind: "ok" };
}
```

After:

```js
async function installSkill() {
  explain("skill", [
    "This step installs the a2a skill under ~/.claude/skills/a2a.",
    `Source: ${A2A_SKILL_FILE}`,
    `Destination: ${INSTALLED_SKILL_PATH}`,
    "If the destination exists and differs, it will be backed up with a timestamped .bak suffix.",
  ]);

  if (!(await confirm("Proceed with skill install?"))) {
    return { kind: "skip", reason: "user skipped skill step" };
  }

  if (!fs.existsSync(A2A_SKILL_FILE)) {
    return { kind: "skip", reason: "skill/SKILL.md not found in package" };
  }

  const result = copyFileWithBackup(A2A_SKILL_FILE, INSTALLED_SKILL_PATH);
  return result.status === "skip" ? { kind: "skip", reason: result.message } : { kind: "ok" };
}
```

Before:

```js
async function installWelcomeDoc() {
  explain("welcome doc", [
    "The session welcome document stays in this package; nothing is copied to ~/.claude.",
    `Path: ${WELCOME_DOC_PATH}`,
  ]);

  if (!(await confirm("Proceed with welcome doc check?"))) {
    return { kind: "skip", reason: "user skipped welcome doc step" };
  }

  if (!fs.existsSync(WELCOME_DOC_PATH)) {
    return { kind: "skip", reason: "src/a2a-welcome.md not found in package" };
  }

  return { kind: "ok" };
}
```

After:

```js
async function installWelcomeDoc() {
  explain("welcome doc", [
    "This step installs the a2a session welcome document under ~/.claude.",
    `Source: ${WELCOME_DOC_PATH}`,
    `Destination: ${INSTALLED_WELCOME_DOC_PATH}`,
    "If the destination exists and differs, it will be backed up with a timestamped .bak suffix.",
  ]);

  if (!(await confirm("Proceed with welcome doc install?"))) {
    return { kind: "skip", reason: "user skipped welcome doc step" };
  }

  if (!fs.existsSync(WELCOME_DOC_PATH)) {
    return { kind: "skip", reason: "src/a2a-welcome.md not found in package" };
  }

  const result = copyFileWithBackup(WELCOME_DOC_PATH, INSTALLED_WELCOME_DOC_PATH);
  return result.status === "skip" ? { kind: "skip", reason: result.message } : { kind: "ok" };
}
```

Before, inside the generated hook contents in `scripts/install.mjs`:

```js
const candidates = [
  process.env.A2A_WELCOME_FILE,
  ${pkgWelcomeLiteral},
  join(home, ".claude", "a2a-welcome.md"),
  join(home, ".claude", "skills", "a2a", "a2a-welcome.md"),
].filter(Boolean);
```

After:

```js
const candidates = [
  process.env.A2A_WELCOME_FILE,
  join(home, ".claude", "a2a-welcome.md"),
  join(home, ".claude", "skills", "a2a", "a2a-welcome.md"),
  ${pkgWelcomeLiteral},
].filter(Boolean);
```

Before, in `hooks/a2a-session-start.mjs`:

```js
const candidates = [
  process.env.A2A_WELCOME_FILE,
  "/Users/op/Documents/dev/a2a/src/a2a-welcome.md",
  join(home, ".claude", "a2a-welcome.md"),
  join(home, ".claude", "skills", "a2a", "a2a-welcome.md"),
].filter(Boolean);
```

After:

```js
const candidates = [
  process.env.A2A_WELCOME_FILE,
  join(home, ".claude", "a2a-welcome.md"),
  join(home, ".claude", "skills", "a2a", "a2a-welcome.md"),
].filter(Boolean);
```

Verification:

```bash
A2A_SETUP_YES=1 node ./scripts/install.mjs --yes
test -f "$HOME/.claude/skills/a2a/SKILL.md"
test -f "$HOME/.claude/a2a-welcome.md"
```

This writes under `~/.claude`, so run it only in an environment where that integration side effect is intended.

## Step 6: Document the channel trust model

Rationale: once the channel defaults closed and requires bearer auth off-loopback, the README and CLI docs must stop teaching the old `dev` default.

Current files read:

`README.md`

`docs/cli.md`

Before, in `README.md`:

```md
Claude Code loads the server over **stdio**; the same process listens on **`127.0.0.1`** (default **`A2A_CHANNEL_PORT=8788`**). Inbound **`POST`/`PUT`/`PATCH`** require **`X-Sender`** in **`A2A_CHANNEL_SENDERS`** (comma-separated, default **`dev`**). **`GET /events`** is SSE for mirrored output. Configure MCP with **`node`** and **`args`** pointing at **`src/a2a-channel.mjs`** — see **`.mcp.json`** in this repo.

Useful env vars: **`A2A_CHANNEL_PORT`**, **`A2A_CHANNEL_HOST`**, **`A2A_CHANNEL_SENDERS`**, **`A2A_CHANNEL_BIN`**.
```

After:

```md
Claude Code loads the server over **stdio**; the same process listens on **`127.0.0.1`** (default **`A2A_CHANNEL_PORT=8788`**). Inbound **`POST`/`PUT`/`PATCH`** require **`X-Sender`** in **`A2A_CHANNEL_SENDERS`**. The sender allowlist defaults to empty. When **`A2A_CHANNEL_HOST`** is not loopback, the process also requires **`A2A_CHANNEL_KEY`** and incoming webhook requests must send it as a bearer token. **`GET /events`** is SSE for mirrored output. Configure MCP with **`node`** and **`args`** pointing at **`src/a2a-channel.mjs`** - see **`.mcp.json`** in this repo.

Useful env vars: **`A2A_CHANNEL_PORT`**, **`A2A_CHANNEL_HOST`**, **`A2A_CHANNEL_SENDERS`**, **`A2A_CHANNEL_KEY`**, **`A2A_CHANNEL_BIN`**.
```

Before, in `docs/cli.md`, the Environment variables table ends with:

```md
| `A2A_LOG_FILE`      | `~/.claude/skills/a2a/messages.log` | Where the bridge appends every send       |
| `A2A_LOG`           | `1`                | Set to `0` to disable message logging                   |
```

After:

```md
| `A2A_LOG_FILE`      | `~/.claude/skills/a2a/messages.log` | Where the bridge appends every send       |
| `A2A_LOG`           | `1`                | Set to `0` to disable message logging                   |
| `A2A_CHANNEL_PORT`  | `8788`             | MCP channel HTTP sidecar listen port                    |
| `A2A_CHANNEL_HOST`  | `127.0.0.1`        | MCP channel HTTP sidecar bind address                   |
| `A2A_CHANNEL_SENDERS` | empty            | Comma-separated allowed `X-Sender` values for channel webhooks |
| `A2A_CHANNEL_KEY`   | empty              | Required bearer token when the channel host is non-loopback |
| `A2A_CHANNEL_BIN`   | `a2a`              | CLI executable used by the channel reply tool           |
```

Then add this paragraph immediately after the table:

```md
The MCP channel is closed by default for inbound webhook posts because `A2A_CHANNEL_SENDERS` defaults to empty. For local webhook testing, set an explicit sender such as `A2A_CHANNEL_SENDERS=dev` and send `X-Sender: dev`. For non-loopback binds, set both `A2A_CHANNEL_SENDERS` and `A2A_CHANNEL_KEY`; requests must include `Authorization: Bearer <key>`.
```

Verification:

```bash
rg "default \\*\\*`dev`|A2A_CHANNEL_KEY|X-Sender" README.md docs/cli.md
```

## Step 7: Extract pure seams for tests

Rationale: resolved decision B1 requires narrow helper modules before the test suite. This keeps `src/a2a-server.mjs` and `src/cli.mjs` from being imported directly by unit tests while preserving runtime behavior.

Current files read:

`src/a2a-server.mjs`

`src/cli.mjs`

Before, in `src/a2a-server.mjs`:

```js
function escapeXml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

const ENVELOPE_RESERVED = new Set(["to","from","origin","body","action","replyTo"]);

function wrapEnvelope(msg) {
    const ts = new Date().toISOString();
    const safeBody = String(msg.body).replace(/]]>/g, "]]]]><![CDATA[>");
    const extras = Object.entries(msg)
        .filter(([k]) => !ENVELOPE_RESERVED.has(k))
        .map(([k, v]) => ` ${escapeXml(k)}="${escapeXml(String(v))}"`)
        .join("");
    return `<a2a_message from="${escapeXml(msg.from)}" to="${escapeXml(msg.to)}" origin="${escapeXml(msg.origin)}" action="${escapeXml(msg.action||"message")}"${extras} ts="${ts}">\n<![CDATA[\n${safeBody}\n]]>\n</a2a_message>`;
}
```

After, create `src/server/envelope.mjs`:

```js
const ENVELOPE_RESERVED = new Set(["to","from","origin","body","action","replyTo"]);

export function escapeXml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function wrapEnvelope(msg) {
    const ts = new Date().toISOString();
    const safeBody = String(msg.body).replace(/]]>/g, "]]]]><![CDATA[>");
    const extras = Object.entries(msg)
        .filter(([k]) => !ENVELOPE_RESERVED.has(k))
        .map(([k, v]) => ` ${escapeXml(k)}="${escapeXml(String(v))}"`)
        .join("");
    return `<a2a_message from="${escapeXml(msg.from)}" to="${escapeXml(msg.to)}" origin="${escapeXml(msg.origin)}" action="${escapeXml(msg.action||"message")}"${extras} ts="${ts}">\n<![CDATA[\n${safeBody}\n]]>\n</a2a_message>`;
}
```

Then replace the server-local block with:

```js
import { wrapEnvelope } from "./server/envelope.mjs";
```

Before, in `src/a2a-server.mjs`:

```js
function checkAuth(req) {
    const cfg = loadConfig();
    if (!cfg.key && !Object.keys(cfg.peers||{}).length) return { ok: true };
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token) return { ok: false };
    if (cfg.key && token === cfg.key) return { ok: true };
    const peer = Object.entries(cfg.peers||{}).find(([, p]) => p.key === token);
    if (peer) return { ok: true, peer: peer[0] };
    return { ok: false };
}
```

After, create `src/server/auth.mjs`:

```js
export function isLoopbackAddress(address) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
```

Then replace the server-local `checkAuth` body with:

```js
import { authFromRequest, configuredPeerUrl } from "./server/auth.mjs";

function checkAuth(req) {
    return authFromRequest(req, loadConfig());
}
```

Before, in `src/cli.mjs`:

```js
function resolveReconnectTargets(name, hasAll) {
    if (name && isGroup(name)) return { targets: listGroupMembers(name).map((m) => m.name), viewSession: `${name}-view` };
    if (name) {
        const teamSpec = loadResolvedTeamSpec(name);
        if (teamSpec) return { targets: teamSpec.agents.map((a) => a.id), viewSession: `${teamSpec.name}-view`, description: `team:${teamSpec.name}` };
    }
    if (name) return { targets: [name], viewSession: null };
    const live = tmuxListSessions().filter((id) => !id.endsWith("-view"));
    if (hasAll) return { targets: live, viewSession: "a2a-view" };

    const cached = loadRegistry().agents || [];
    const cachedLive = cached.filter((id) => live.includes(id));
    if (cachedLive.length > 0) return { targets: cachedLive, viewSession: null };
    return { targets: live, viewSession: null };
}
```

After, create `src/cli/reconnect-targets.mjs`:

```js
export function resolveReconnectTargets({ name, hasAll, isGroup, listGroupMembers, loadResolvedTeamSpec, tmuxListSessions, loadRegistry }) {
    if (name && isGroup(name)) return { targets: listGroupMembers(name).map((m) => m.name), viewSession: `${name}-view` };
    if (name) {
        const teamSpec = loadResolvedTeamSpec(name);
        if (teamSpec) return { targets: teamSpec.agents.map((a) => a.id), viewSession: `${teamSpec.name}-view`, description: `team:${teamSpec.name}` };
    }
    if (name) return { targets: [name], viewSession: null };
    const live = tmuxListSessions().filter((id) => !id.endsWith("-view"));
    if (hasAll) return { targets: live, viewSession: "a2a-view" };

    const cached = loadRegistry().agents || [];
    const cachedLive = cached.filter((id) => live.includes(id));
    if (cachedLive.length > 0) return { targets: cachedLive, viewSession: null };
    return { targets: live, viewSession: null };
}
```

Then replace the local function with:

```js
import { resolveReconnectTargets as resolveReconnectTargetsPure } from "./cli/reconnect-targets.mjs";

function resolveReconnectTargets(name, hasAll) {
    return resolveReconnectTargetsPure({
        name,
        hasAll,
        isGroup,
        listGroupMembers,
        loadResolvedTeamSpec,
        tmuxListSessions,
        loadRegistry,
    });
}
```

Verification:

```bash
node -e 'import("./src/server/envelope.mjs").then((m) => console.log(typeof m.wrapEnvelope))'
node -e 'import("./src/server/auth.mjs").then((m) => console.log(typeof m.authFromRequest))'
node -e 'import("./src/cli/reconnect-targets.mjs").then((m) => console.log(typeof m.resolveReconnectTargets))'
```

Expected: each command prints `function`.

## Step 8: Add the Node test suite

Rationale: Phase 3 makes the bug-fix work executable. Add a local `node:test` suite that covers parser behavior, envelope escaping, auth classification, config isolation, team spec parsing, and reconnect target resolution without invoking real tmux.

Current files read:

`package.json`

`src/a2a-argv.mjs`

`src/a2a-tokens.mjs`

`src/a2a-team-spec.mjs`

`src/a2a-config.mjs`

`src/server/envelope.mjs` from Step 7

`src/server/auth.mjs` from Step 7

`src/cli/reconnect-targets.mjs` from Step 7

Before, in `package.json`:

```json
  "scripts": {
    "start": "node src/a2a-server.mjs",
    "channel": "node src/a2a-channel.mjs",
    "install-hooks": "node scripts/install.mjs",
    "setup": "node scripts/install.mjs",
    "bootstrap": "node scripts/install.mjs --yes",
    "postinstall": "node scripts/postinstall-hint.mjs"
  },
```

After:

```json
  "scripts": {
    "start": "node src/a2a-server.mjs",
    "channel": "node src/a2a-channel.mjs",
    "install-hooks": "node scripts/install.mjs",
    "setup": "node scripts/install.mjs",
    "bootstrap": "node scripts/install.mjs --yes",
    "postinstall": "node scripts/postinstall-hint.mjs",
    "test": "node tests/run.mjs"
  },
```

Before:

```text
tests directory does not exist.
```

After, create `tests/run.mjs`:

```js
import { spawnSync } from "node:child_process";

const files = [
    "tests/parsers.test.mjs",
    "tests/envelope.test.mjs",
    "tests/auth.test.mjs",
    "tests/team-spec.test.mjs",
    "tests/config.test.mjs",
    "tests/reconnect.test.mjs",
];

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
```

After, create `tests/parsers.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseFlagSendArgv } from "../src/a2a-argv.mjs";
import { parseColonFlagArgv } from "../src/a2a-tokens.mjs";

const registry = {
    actions: new Set(["message", "reply", "ask", "write"]),
    agents: new Set(["bob", "leah"]),
    groups: new Set(["ops"]),
};

test("flag-form rejects unknown bare flags against registry", () => {
    assert.throws(() => parseFlagSendArgv(["--verbose", "hello"], registry), /unknown flag --verbose/);
});

test("flag-form accepts registered recipients and explicit origin", () => {
    assert.deepEqual(parseFlagSendArgv(["--reply", "--bob", "--origin", "peer", "hello"], registry), {
        action: "reply",
        recipients: ["bob"],
        content: "hello",
        from: undefined,
        origin: "peer",
        to: undefined,
    });
});

test("colon-form parses action, recipients, sender, origin, and repeated recipients", () => {
    assert.deepEqual(parseColonFlagArgv(["--ask:bob:leah:bob", "--from=op", "--origin=user", "status"], registry), {
        from: "op",
        origin: "user",
        recipients: ["bob", "leah"],
        action: "ask",
        content: "status",
    });
});

test("colon-form equals value is message content", () => {
    assert.equal(parseColonFlagArgv(["--message:bob=value"], registry).content, "value");
});

test("colon-form rejects duplicate inline and positional content", () => {
    assert.throws(() => parseColonFlagArgv(["--message:bob=value", "other"], registry), /message content specified more than once/);
});
```

After, create `tests/envelope.test.mjs`:

```js
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
```

After, create `tests/auth.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { authFromRequest, configuredPeerUrl, isLoopbackAddress } from "../src/server/auth.mjs";

function req({ address = "127.0.0.1", authorization = "" } = {}) {
    return { socket: { remoteAddress: address }, headers: authorization ? { authorization } : {} };
}

test("open bridge allows loopback only", () => {
    assert.equal(authFromRequest(req(), { key: null, peers: {} }).ok, true);
    assert.equal(authFromRequest(req({ address: "10.0.0.4" }), { key: null, peers: {} }).ok, false);
});

test("operator key authenticates as operator", () => {
    assert.deepEqual(authFromRequest(req({ authorization: "Bearer root" }), { key: "root", peers: {} }), {
        ok: true,
        kind: "operator",
        loopback: true,
    });
});

test("peer key authenticates as peer", () => {
    assert.deepEqual(authFromRequest(req({ authorization: "peer-key" }), { key: "root", peers: { bob: { key: "peer-key", url: "https://bob.example/" } } }), {
        ok: true,
        kind: "peer",
        peer: "bob",
        loopback: true,
    });
});

test("configuredPeerUrl normalizes trailing slash", () => {
    assert.equal(configuredPeerUrl({ peers: { bob: { url: "https://bob.example/" } } }, "bob"), "https://bob.example");
});

test("loopback matcher includes IPv4-mapped loopback", () => {
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});
```

After, create `tests/team-spec.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTeamSpec } from "../src/a2a-team-spec.mjs";

test("loads YAML team specs with block scalars and lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-team-"));
    const spec = join(dir, "team.yaml");
    writeFileSync(spec, [
        "name: sample",
        "dashboard: true",
        "agents:",
        "  - id: bob",
        "    backend: claude",
        "    cwd: /tmp",
        "    role: |",
        "      hello",
        "      there",
    ].join("\n"));
    const data = loadTeamSpec(spec);
    assert.equal(data.name, "sample");
    assert.equal(data.dashboard, true);
    assert.equal(data.agents[0].id, "bob");
    assert.match(data.agents[0].role, /hello\nthere/);
});
```

After, create `tests/config.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("config persists primitive settings in isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "a2a-home-"));
    process.env.HOME = home;
    const mod = await import(`../src/a2a-config.mjs?case=${Date.now()}`);
    mod.configSet("port", "9999");
    mod.configSet("host", "127.0.0.2");
    assert.equal(mod.configGet("port"), 9999);
    assert.equal(mod.configGet("host"), "127.0.0.2");
});
```

After, create `tests/reconnect.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveReconnectTargets } from "../src/cli/reconnect-targets.mjs";

const base = {
    isGroup: () => false,
    listGroupMembers: () => [],
    loadResolvedTeamSpec: () => null,
    tmuxListSessions: () => ["bob", "leah", "ops-view"],
    loadRegistry: () => ({ agents: ["leah"] }),
};

test("explicit name resolves to that target", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: "bob", hasAll: false }), { targets: ["bob"], viewSession: null });
});

test("--all resolves all live non-view sessions", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: null, hasAll: true }), { targets: ["bob", "leah"], viewSession: "a2a-view" });
});

test("no name prefers cached live agents", () => {
    assert.deepEqual(resolveReconnectTargets({ ...base, name: null, hasAll: false }), { targets: ["leah"], viewSession: null });
});

test("group name resolves group members and view", () => {
    const result = resolveReconnectTargets({
        ...base,
        name: "squad",
        isGroup: (name) => name === "squad",
        listGroupMembers: () => [{ name: "a" }, { name: "b" }],
    });
    assert.deepEqual(result, { targets: ["a", "b"], viewSession: "squad-view" });
});
```

Verification:

```bash
npm test
```

Expected: all six test files pass.

## Step 9: Replace the hand-rolled YAML parser with `js-yaml`

Rationale: Phase 4 removes the custom YAML implementation after team-spec behavior is covered. This reduces parser debt while keeping `loadTeamSpec` as the public loader.

Current files read:

`package.json`

`src/a2a-team-spec.mjs`

Before, in `package.json`:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.2",
    "zod": "^3.24.1"
  },
```

After:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.2",
    "js-yaml": "^4.1.0",
    "zod": "^3.24.1"
  },
```

Before, in `src/a2a-team-spec.mjs`:

```js
import { existsSync, readFileSync, statSync } from "fs";
import { extname, isAbsolute, join, resolve } from "path";
```

After:

```js
import { existsSync, readFileSync, statSync } from "fs";
import { extname, isAbsolute, join, resolve } from "path";
import yaml from "js-yaml";
```

Before, in `src/a2a-team-spec.mjs`, remove the custom parser helpers from `stripYamlComment` through `parseYaml`:

```js
function stripYamlComment(line) {
    let out = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote && line[i - 1] !== "\\") quote = null;
            out += ch;
            continue;
        }
        if (ch === "'" || ch === "\"") {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "#") break;
        out += ch;
    }
    return out.replace(/\s+$/, "");
}
```

After:

```js
function parseYaml(raw) {
    const parsed = yaml.load(raw);
    return parsed == null ? {} : parsed;
}
```

Before, in `src/a2a-team-spec.mjs`:

```js
    if (ext === ".json") data = JSON.parse(raw);
    else if (ext === ".yaml" || ext === ".yml") data = parseYaml(raw);
    else throw new Error(`unsupported team spec extension '${ext}'`);
```

After:

```js
    if (ext === ".json") data = JSON.parse(raw);
    else if (ext === ".yaml" || ext === ".yml") data = parseYaml(raw);
    else throw new Error(`unsupported team spec extension '${ext}'`);
```

The loader branch remains the same; only the implementation behind `parseYaml` changes.

Verification:

```bash
npm install
npm test
```

Expected: lockfile updates, `js-yaml` is installed, and all tests pass.

## Step 10: Add explicit logging configuration

Rationale: Phase 5 makes message logging configurable without relying only on environment variables. Environment variables still override config, and logging remains best-effort so delivery never fails because log writing fails.

Current files read:

`src/a2a-config.mjs`

`src/cli.mjs`

`README.md`

`docs/cli.md`

Before, in `src/a2a-config.mjs`:

```js
const CONFIG_DEFAULTS = {
    port: 7742,
    host: "127.0.0.1",
    key:  null,
    peers: {},
};
```

After:

```js
const CONFIG_DEFAULTS = {
    port: 7742,
    host: "127.0.0.1",
    key:  null,
    peers: {},
    log: {
        mode: "on",
        path: null,
        maxBytes: 0,
        redactRemote: false,
    },
};
```

Before:

```js
const USER_KEYS = ["port", "host", "key"];
```

After:

```js
const USER_KEYS = ["port", "host", "key", "log.mode", "log.path", "log.maxBytes", "log.redactRemote"];
```

Before:

```js
export function messageLogPath() {
    const env = (process.env.A2A_LOG_FILE || "").trim();
    return env || DEFAULT_LOG_FILE;
}

export function messageLogEnabled() {
    return process.env.A2A_LOG !== "0";
}
```

After:

```js
function logConfig() {
    const cfg = loadConfig();
    return { ...CONFIG_DEFAULTS.log, ...(cfg.log || {}) };
}

export function messageLogPath() {
    const env = (process.env.A2A_LOG_FILE || "").trim();
    return env || logConfig().path || DEFAULT_LOG_FILE;
}

export function messageLogEnabled() {
    if (process.env.A2A_LOG === "0") return false;
    if (process.env.A2A_LOG === "1") return true;
    return logConfig().mode !== "off";
}

export function messageLogMaxBytes() {
    const n = Number(logConfig().maxBytes || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function messageLogRedactRemote() {
    return logConfig().redactRemote === true;
}
```

Before, in `appendMessageLog`:

```js
        const body = (entry.body == null ? "" : String(entry.body))
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((l) => "    " + l)
            .join("\n");
        appendFileSync(messageLogPath(), head + "\n" + body + "\n", { mode: 0o644 });
```

After:

```js
        const logPath = messageLogPath();
        const rawBody = messageLogRedactRemote() && entry.transport === "remote"
            ? "[redacted remote body]"
            : (entry.body == null ? "" : String(entry.body));
        const body = rawBody
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((l) => "    " + l)
            .join("\n");
        appendFileSync(logPath, head + "\n" + body + "\n", { mode: 0o644 });
        const maxBytes = messageLogMaxBytes();
        if (maxBytes > 0) {
            const size = statSync(logPath).size;
            if (size > maxBytes) writeFileSync(logPath, "", { mode: 0o644 });
        }
```

Before, in `configGet` and `configSet`, only top-level `USER_KEYS` work.

After, add helpers before `configGet`:

```js
function nestedGet(obj, dotted) {
    return dotted.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], obj);
}

function nestedSet(obj, dotted, value) {
    const parts = dotted.split(".");
    const out = { ...obj };
    let cursor = out;
    for (const part of parts.slice(0, -1)) {
        cursor[part] = { ...(cursor[part] || {}) };
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
    return out;
}
```

Then replace `configGet` and `configSet` with:

```js
export function configGet(key) {
    if (key !== undefined && !USER_KEYS.includes(key)) {
        throw new Error(`unknown setting '${key}' (available: ${USER_KEYS.join(", ")})`);
    }
    const cfg = loadConfig();
    if (key) return nestedGet(cfg, key) ?? null;
    return Object.fromEntries(USER_KEYS.map((k) => [k, nestedGet(cfg, k) ?? null]));
}

export function configSet(key, value) {
    if (!USER_KEYS.includes(key)) {
        throw new Error(`unknown setting '${key}' (available: ${USER_KEYS.join(", ")})`);
    }
    let coerced = value;
    if (key === "port") {
        coerced = parseInt(value, 10);
        if (!Number.isFinite(coerced) || coerced <= 0) throw new Error("port must be a positive integer");
    }
    if (key === "host") {
        if (typeof value !== "string" || value.trim() === "") throw new Error("host must be a non-empty string");
        coerced = value.trim();
    }
    if (key === "key" && (value === "" || value === null)) coerced = null;
    if (key === "log.mode") {
        if (value !== "on" && value !== "off") throw new Error("log.mode must be on or off");
    }
    if (key === "log.path" && value === "") coerced = null;
    if (key === "log.maxBytes") {
        coerced = parseInt(value, 10);
        if (!Number.isFinite(coerced) || coerced < 0) throw new Error("log.maxBytes must be a non-negative integer");
    }
    if (key === "log.redactRemote") {
        if (value !== "true" && value !== "false") throw new Error("log.redactRemote must be true or false");
        coerced = value === "true";
    }
    const updated = patchConfig(nestedSet(loadConfig(), key, coerced));
    return nestedGet(updated, key);
}
```

Before, docs logging configuration is limited to environment variables:

```md
| `A2A_LOG_FILE`      | `~/.claude/skills/a2a/messages.log` | Where the bridge appends every send       |
| `A2A_LOG`           | `1`                | Set to `0` to disable message logging                   |
```

After, add config docs for:

```md
`a2a config set log.mode off`
`a2a config set log.path /path/to/messages.log`
`a2a config set log.maxBytes 1048576`
`a2a config set log.redactRemote true`
```

Verification:

```bash
npm test
node ./bin/a2a.mjs config set log.mode off
node ./bin/a2a.mjs config get log.mode
```

Expected: tests pass and the final command prints `off`.

## Step 11: Extract parser dispatch behind one normalized envelope path

Rationale: colon-form sends already go through `sendNormalizedEnvelope`, while flag-form sends use `doParsedFlagSend` with duplicated delivery logic. Normalize both parser outputs to the same object shape so parser behavior is tested once and send behavior has one path.

Current files read:

`src/a2a-argv.mjs`

`src/a2a-tokens.mjs`

`src/cli.mjs`

Before, in `src/a2a-argv.mjs`, `parseFlagSendArgv` returns:

```js
    return {
        action,
        recipients: [...new Set(recipients)],
        content,
        from: typeof flags.from === "string" ? flags.from : undefined,
        origin: typeof flags.origin === "string" ? flags.origin : undefined,
        to: typeof flags.to === "string" ? flags.to : undefined,
    };
}
```

After:

```js
    const to = typeof flags.to === "string" ? flags.to : undefined;
    return {
        action,
        recipients: [...new Set([...(to ? [to] : []), ...recipients])],
        content,
        from: typeof flags.from === "string" ? flags.from : null,
        origin: typeof flags.origin === "string" ? flags.origin : null,
        meta: {},
    };
}
```

Before, in `src/a2a-tokens.mjs`, `parseColonFlagArgv` returns:

```js
    const { from: fromExtra, origin: originExtra, ...meta } = extras;
    return {
        from: fromExtra || null,
        origin: originExtra || null,
        recipients: [...new Set(recipients.filter(Boolean))],
        action: action || "message",
        content: inlineContent !== null ? inlineContent : positionalContent,
        ...meta,
    };
}
```

After:

```js
    const { from: fromExtra, origin: originExtra, ...meta } = extras;
    return {
        from: fromExtra || null,
        origin: originExtra || null,
        recipients: [...new Set(recipients.filter(Boolean))],
        action: action || "message",
        content: inlineContent !== null ? inlineContent : positionalContent,
        meta,
    };
}
```

Before, in `src/cli.mjs`:

```js
async function sendNormalizedEnvelope(envelope) {
    const rawSelfId = currentTmuxSession();
    const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
    const recipients = [...new Set([...(envelope.to ? [envelope.to] : []), ...(envelope.recipients||[])].filter(Boolean))];
```

After:

```js
async function sendNormalizedEnvelope(envelope) {
    if (!envelope.content) die("message body is required");
    const rawSelfId = currentTmuxSession();
    const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
    const recipients = [...new Set((envelope.recipients||[]).filter(Boolean))];
```

Before, later in `sendNormalizedEnvelope`:

```js
    const { message, from: _f, to: _t, action, origin: _o, ...extras } = envelope;
    for (const toId of recipients) {
```

After:

```js
    const extras = envelope.meta || {};
    for (const toId of recipients) {
```

Before, in the request body:

```js
            to: toId, from: fromId, origin, body: message, action,
            ...(replyTo ? { replyTo } : {}), ...extras,
```

After:

```js
            to: toId, from: fromId, origin, body: envelope.content, action: envelope.action || "message",
            ...(replyTo ? { replyTo } : {}), ...extras,
```

Before, in `main`:

```js
    if (isFlagSendArgv(argv)) {
        try {
            const parsed = parseFlagSendArgv(argv, await getRegistry());
            if (!parsed) die("could not parse send arguments", 1);
            await doParsedFlagSend(parsed); return;
        } catch (err) { die(err.message, 1); }
    }
```

After:

```js
    if (isFlagSendArgv(argv)) {
        try {
            const parsed = parseFlagSendArgv(argv, await getRegistry());
            if (!parsed) die("could not parse send arguments", 1);
            await sendNormalizedEnvelope(parsed); return;
        } catch (err) { die(err.message, 1); }
    }
```

Then delete `doParsedFlagSend` from `src/cli.mjs` after tests pass, because it has no remaining callers.

Verification:

```bash
npm test
rg "doParsedFlagSend|envelope\\.to|message," src/cli.mjs
```

Expected: tests pass, `rg` finds no `doParsedFlagSend`, no `envelope.to`, and no destructuring of `message` from an envelope.

## Deferred Step 12: Create the CLI decomposition guide later

Target modules from `bug-fix.md`:

`src/cli/output.mjs`

`src/cli/http.mjs`

`src/cli/tmux.mjs`

`src/cli/backend.mjs`

`src/cli/persona.mjs`

`src/cli/start.mjs`

`src/cli/groups.mjs`

`src/cli/reconnect.mjs`

`src/cli/log.mjs`

`src/cli/auth.mjs`

`src/cli/commands.mjs`

This is intentionally deferred out of the current bug-fix guide. After this guide is locked and executed through Phase 5, create a new implementation guide for CLI decomposition. Each extraction should preserve CLI behavior and run `npm test` plus at least one smoke command after the slice. Do not use this bug-fix guide to perform a large undifferentiated move.

## Deferred Step 13: Eliminate restart duplication in the CLI guide

This belongs inside the CLI extraction guide after `src/cli/start.mjs` and `src/cli/reconnect.mjs` exist. The duplicated behavior named in `bug-fix.md` is session restart logic in send paths versus reconnect/start paths.

Verification:

```bash
npm test
```

## Deferred Step 14: Eliminate start target duplication in the CLI guide

This belongs inside the CLI extraction guide after group/team/single start modules are separated. The duplicated behavior named in `bug-fix.md` is the repeated branching among single agent, group, team, local bridge, and remote bridge starts.

Verification:

```bash
npm test
```

## Deferred Step 15: Rename/reframe package identity later

Intended files include at least:

`package.json`

`README.md`

`AGENTS.md`

`docs/cli.md`

`skill/SKILL.md`

`scripts/install.mjs`

The bug-fix plan says to rename the package to `tmux-bridge`, keep the CLI binary as `a2a`, keep existing endpoints stable, keep the skill directory stable, and explicitly say this is not Google Agent2Agent v1.0. Per resolved decision B4, do not do that in this guide. Treat it as a later identity/migration release after choosing the new name.

Verification:

```bash
npm test
npm pack --dry-run
rg "Agent2Agent|tmux-bridge|\"name\": \"a2a\"" README.md docs/cli.md package.json skill/SKILL.md
```

## Final Verification

Run the full verification gate after executing all executable steps:

```bash
npm install
npm test
node ./bin/a2a.mjs help
node ./bin/a2a.mjs config set log.mode off
node ./bin/a2a.mjs config get log.mode
rg "doParsedFlagSend|envelope\\.to|default \\*\\*`dev`" src README.md docs/cli.md
```

Expected: dependencies install cleanly, the test suite passes, the CLI help command exits successfully, `config get log.mode` prints `off`, and the final `rg` command finds no stale parser-dispatch or channel-default references.

## Execution Order

Execute Steps 1 through 6 plus Step 1A first. Then extract the narrow pure helper seams chosen in resolved decision B1, render Step 7 into concrete tests, and land the tests. After that, execute the parser and logging phases as separate tested changes. Do not split `src/cli.mjs` in this guide except for the narrow test seams. Do not rename the package in this guide.

Do not spend time on full Agent2Agent v1.0 compliance, a durable remote registry, durable task state, or replacing the XML envelope as part of this bug-fix plan. Those are explicitly out of scope in `bug-fix.md`, and none of the ready defects require them.
