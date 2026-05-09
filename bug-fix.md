# a2a bug-fix plan

This is the consolidated fix list from the two deep-research assessments (mine + Codex's), in execution order. Each item names the concrete problem, the affected files with line ranges, the fix, and what "done" looks like. No abstractions, no scope hedging — every problem in scope, fix all of them.

The order is chosen so each step lands on top of stable ground. Don't reorder casually; the trust-model work depends on knowing the bug list is closed, the CLI decomposition depends on having tests around the parsers, and the rename depends on docs being correct in the first place.

---

## Phase 1 — close the residual bugs

### 1.1 Flag-form parser silently promotes unknown flags to recipients

**Files:** `src/a2a-argv.mjs:78–84`

**Current behavior:** in `parseFlagSendArgv`, any `--xxx` that isn't an action alias and isn't in `VALUE_FLAGS` is pushed onto `recipients`. So `a2a --verbose --sam hello` produces `recipients: ['verbose', 'sam']`. The colon-form parser (`a2a-tokens.mjs:73–80`) was already fixed to reject unknown bare flags by checking against the registry; the flag-form parser was missed in that pass.

**Fix:** make `parseFlagSendArgv` registry-aware. Take the same `registry` argument the colon-form parser takes (built via `buildRegistry()`), and only accept a bare flag as a recipient if `registry.agents.has(key)` or `registry.groups.has(key)`. If neither, throw `unknown flag --${key}`.

Because `parseFlagSendArgv` is called from two places (`isFlagSendArgv` for detection, `doParsedFlagSend` for execution), and registry construction reaches the network (`listAgents` inside `getRegistry`), introduce a sync overload: caller resolves the registry once and passes it in. `isFlagSendArgv` keeps its current "best-effort detection" semantics by passing an empty registry — detection only cares whether the *shape* is flag-form, not whether names resolve.

**Done when:**
- `parseFlagSendArgv(['--verbose', '--sam', 'hello'], { agents: new Set(['sam']), groups: new Set() })` throws `unknown flag --verbose`.
- `parseFlagSendArgv(['--sam', 'hello'], { agents: new Set(['sam']), groups: new Set() })` returns `{ recipients: ['sam'], content: 'hello', ... }`.
- `isFlagSendArgv(['--verbose', '--sam', 'hello'])` still returns `true` (it's flag-form even if invalid) — the validation happens at execution time.
- `doParsedFlagSend` passes the live registry so users get a clear error instead of silent wrong delivery.

### 1.2 Open `/api/a2a/register` accepts arbitrary registrations

**Files:** `src/a2a-server.mjs:183–198`, `src/a2a-server.mjs:137–147`

**Current behavior:** any caller that passes `checkAuth` can register any `agentId` with any `tmuxTarget` and any `bridgeUrl`. When the bridge is open (no `key`, no `peers`), that's any caller at all. When auth is on, any authenticated caller can still impersonate any name. The `replyTo` self-registration check (line 229) closed one path but not this one.

**Fix:** introduce a `kind` field on registry entries (`local` | `remote`), and apply these rules:

- **Open bridge** (no key, no peers): `/api/a2a/register` only accepts requests from `127.0.0.1`/`::1`. Reject all other origins regardless of auth header. Document this as the explicit local-only contract.
- **Authenticated bridge with operator key** (`cfg.key` set, request authenticates with that key): can register any `agentId` as `kind: "local"`. This is the operator path used by `a2a start`.
- **Authenticated bridge with peer key** (request authenticates as one of `cfg.peers[name]`): can only register `agentId === name` (the peer's own identity), and the registration is forced to `kind: "remote"` with `bridgeUrl` taken from `cfg.peers[name].url`, not from the request body. A peer cannot register a third name and cannot override its own `bridgeUrl`.
- A `kind: "remote"` entry never overwrites an existing `kind: "local"` entry with the same `agentId`. Collision returns `409 conflict`.

**Done when:**
- An open bridge bound to `0.0.0.0` rejects `/api/a2a/register` from non-loopback IPs with `403`.
- An authenticated peer cannot register a name other than its own.
- Local registrations survive remote registration attempts at the same `agentId`.
- `a2a start-global` warns or refuses when no `key` is configured (see 1.3).

### 1.3 `start-global` exposes unauthenticated bridges silently

**Files:** `src/cli.mjs:1032–1083` (`cmdStartGlobal`)

**Current behavior:** running `a2a start-global` exposes the local bridge through ngrok regardless of whether `cfg.key` is set. An open bridge becomes a public bridge with no warning.

**Fix:** in `cmdStartGlobal`, before calling `resolveNgrok`, check `loadConfig().key`. If null:
- Refuse by default: print `start-global requires a bridge key. Run 'a2a gen-key' and 'a2a config set key <generated>' first, or pass --insecure to override.`
- Accept `--insecure` as an explicit override that prints a multi-line warning and proceeds.

**Done when:**
- `a2a start-global` with no key fails with the message above and exits non-zero.
- `a2a start-global --insecure` proceeds and prints a clearly-visible warning block.
- `a2a start-global` with a configured key proceeds normally.

### 1.4 Channel `X-Sender` defaults to `"dev"` and binds independently

**Files:** `src/a2a-channel.mjs:33–40`, `src/a2a-channel.mjs:183–190`

**Current behavior:** `A2A_CHANNEL_SENDERS` defaults to `"dev"`. Anyone on the same machine, or anyone reachable when `A2A_CHANNEL_HOST` is changed, can POST into the channel and have the body forwarded to Claude Code as a notification. The `dev` default exists because of how Claude Code permission-relay testing was set up; it's a development-time convenience that became the deploy default.

**Fix:** treat the channel as a separate trust boundary with its own explicit configuration:

- Default `A2A_CHANNEL_SENDERS` to empty (no senders allowed) instead of `"dev"`. Document that the channel must be configured before it accepts traffic.
- When `A2A_CHANNEL_HOST` is anything other than `127.0.0.1`/`localhost`/`::1`, refuse to start unless `A2A_CHANNEL_SENDERS` is non-empty AND a new `A2A_CHANNEL_KEY` is set. Require Bearer auth in addition to `X-Sender` for non-loopback binds.
- Document the channel's trust model in `docs/cli.md` alongside the bridge's, naming the three states explicitly: localhost-only with `X-Sender`, remote-bound with `X-Sender + Bearer`, and unconfigured (refuses traffic).

**Done when:**
- Fresh install with no configuration: channel starts, accepts no POSTs, returns `403`.
- Localhost bind + `A2A_CHANNEL_SENDERS=dev`: works as today.
- Non-loopback bind without key: refuses to start with a clear message.
- Non-loopback bind with key: requires both `X-Sender` and `Authorization: Bearer <key>`.

---

## Phase 2 — reconcile docs and install behavior

### 2.1 Skill and welcome doc location drift

**Files:** `README.md:77–84`, `AGENTS.md:25–33`, `docs/cli.md:41–49`, `scripts/install.mjs:424–455`

**Current state:** README, AGENTS, and docs/cli claim `npm run bootstrap` copies `skill/` to `~/.claude/skills/a2a/` and the welcome doc to `~/.claude/a2a-welcome.md`. The current installer keeps both in the package and points hooks/CLAUDE.md at the package paths. Codex caught this; both behaviors are defensible but they cannot both be claimed.

**Fix:** decide one truth. Recommended: **install copies to `~/.claude`** because (a) the docs say so, (b) it's what users expect from a "skill", (c) it survives the package being moved or deleted, and (d) other agents looking under `~/.claude/skills/` (the standard location) will find it.

Concretely:
- Update `scripts/install.mjs` to copy `skill/SKILL.md` → `~/.claude/skills/a2a/SKILL.md` and `src/a2a-welcome.md` → `~/.claude/a2a-welcome.md` during bootstrap.
- Make the copy idempotent: if the destination exists and matches the source byte-for-byte, skip; if it exists and differs, back up to `<file>.bak.<timestamp>` and overwrite (matches the existing settings.json pattern).
- Update `hooks/a2a-session-start.mjs` candidate-paths order to prefer `~/.claude/skills/a2a/a2a-welcome.md` and `~/.claude/a2a-welcome.md` before falling back to the hardcoded package path.
- Remove the hardcoded `/Users/op/Documents/dev/a2a/src/a2a-welcome.md` from `hooks/a2a-session-start.mjs:11` — that's a personal-machine path that shipped to git.

**Done when:**
- After `npm run bootstrap`, `~/.claude/skills/a2a/SKILL.md` and `~/.claude/a2a-welcome.md` exist and match the package versions.
- Re-running bootstrap is a no-op when files match.
- Re-running bootstrap when files differ creates a `.bak.<timestamp>` and updates.
- The session-start hook works without the personal hardcoded path.
- `README.md`, `AGENTS.md`, `docs/cli.md` describe the actual installed locations.

### 2.2 Channel trust documentation

**Files:** `docs/cli.md`

**Current state:** the channel section (~line 130+) describes the `X-Sender` allowlist but doesn't name the trust boundary or the localhost-vs-remote distinction.

**Fix:** add a `Channel trust model` subsection that names the three states from 1.4 explicitly, with the env-var matrix and the difference from the bridge's auth model. This is documentation, but it's load-bearing — users won't know they need to configure auth for non-loopback binds unless we say so.

**Done when:** `docs/cli.md` has a `Channel trust model` section, and the env-var table includes `A2A_CHANNEL_KEY`.

---

## Phase 3 — tests around the load-bearing behavior

Before any of the larger refactors, lock down the behavior with focused tests. The bug catalog is concentrated in three places (parsers, envelope wrapping, auth decisions); tests there pay rent immediately.

### 3.1 Test infrastructure

**Files (new):** `tests/run.mjs`, `tests/parsers.test.mjs`, `tests/envelope.test.mjs`, `tests/auth.test.mjs`, `tests/team-spec.test.mjs`, `tests/config.test.mjs`, `tests/reconnect.test.mjs`

**Approach:** node's built-in `node:test` runner. No new deps. Tests run via `npm test` → `node --test tests/*.test.mjs`. Add `"test"` script to `package.json`.

The bridge tests use an injected fake `tmux` via env-var or module mock — `spawnSync` calls become a thin wrapper that reads from a fake when `A2A_TEST_TMUX_FAKE=1`. The fake records calls and returns scripted outputs.

### 3.2 Parser tests (parsers.test.mjs)

Cover the explicit cases from BUGS.md and from 1.1:

- Field-name normalization: both `parseFlagSendArgv` and `parseColonFlagArgv` return `{ action, recipients, content, from, origin }`.
- Unknown bare flag with empty registry: throws.
- Unknown bare flag with matching registry agent: accepted as recipient.
- `--content "x" extra words`: `content === "x"`, positional ignored.
- `--message:bob=value`: parses to `{ action: "message", recipients: ["bob"], extras: { value }: ... }` (verify the actual fix shape; the bug fix at `a2a-tokens.mjs:63-69` strips the `=value` correctly).
- `isFlagSendArgv` returns `false` on parse exception, `true` on parseable flag-form.
- Action aliases: `--write` → `message`.
- Multi-recipient: `--bob --mike 'hi'` → `recipients: ['bob', 'mike']`.
- Legacy: `say --to bob hi`, `to:bob hi`, `from:me to:bob origin:user --message hi`.

### 3.3 Envelope tests (envelope.test.mjs)

- `wrapEnvelope({ from, to, origin, body, action })` produces XML with CDATA-wrapped body.
- Body containing `]]>` is split correctly: `]]]]><![CDATA[>`.
- Body containing `<a2a_message>` literal does not break the envelope (CDATA neutralizes it).
- Extras (`mood`, custom keys) appear as escaped XML attributes, reserved keys are not duplicated.
- XML attribute escaping handles `"`, `<`, `>`, `&`.

### 3.4 Auth tests (auth.test.mjs)

For each combination from 1.2:

- Open bridge + loopback request: register/send accepted.
- Open bridge + non-loopback request to `/register`: `403`.
- Auth bridge + no Bearer: `401`.
- Auth bridge + operator key: register accepted with any `agentId`, kind `local`.
- Auth bridge + peer key: register only accepted with own `agentId`, forced to kind `remote`, `bridgeUrl` from peers config not body.
- Remote registration cannot overwrite local: `409`.
- `replyTo` auto-registration: only when `auth.peer === body.from`.

### 3.5 Team-spec tests (team-spec.test.mjs)

Lock down the YAML subset's actual behavior before swapping the parser (Phase 4):

- Block scalars (`|`, `>`) preserve and join lines correctly.
- Inline scalars: numbers, booleans, null/`~`, quoted strings.
- Comments inside quoted strings are preserved (the `#` in `'foo # bar'` is data, not comment).
- Nested mappings and sequences with mixed indentation.
- The `bug-killers.yaml` and `west-world.yaml` samples parse identically before and after the parser swap.

These tests become the conformance suite for the parser replacement.

### 3.6 Config tests (config.test.mjs)

- `configSet("port", "abc")` throws.
- `configSet("port", 0)` throws.
- `configSet("host", "")` throws (already fixed).
- `configSet("host", "  ")` throws (whitespace-only).
- `activePort()` with `A2A_PORT=abc`: warns and falls back, returns config value.
- `peerKeyForUrl` matches with and without trailing slash.

### 3.7 Reconnect tests (reconnect.test.mjs)

`resolveReconnectTargets` is the brain of `a2a reconnect` and the most subtle-state-machine code in the CLI. Lock its behavior:

- No name, no `--all`, cached registry has live members: returns cached intersect live.
- No name, no `--all`, cached registry empty: returns all live.
- No name, `--all`: returns all live, view session `a2a-view`.
- Group name: returns group members, view `<group>-view`.
- Team name: returns team members, view `<team>-view`, description `team:<name>`.
- Single agent name: returns just that name.

**Done when:**
- `npm test` runs all tests, all pass, in under 5 seconds.
- Coverage is descriptive (each fix from BUGS.md and Phase 1 has at least one test that locks the corrected behavior).
- The team-spec parser tests pass against the current implementation, so they form a contract for the replacement in Phase 4.

---

## Phase 4 — replace the YAML parser

**Files:** `src/a2a-team-spec.mjs:27–199` (the entire hand-rolled parser), `package.json` (add `js-yaml` dep)

**Current state:** 247 lines of hand-rolled YAML covering indentation, block scalars, inline scalars, mappings, sequences. Doesn't handle anchors, aliases, flow style, multi-document streams, multiline quoted strings, tagged values. Failure mode is silent miscompile.

**Fix:** replace with `js-yaml`. The package already depends on `@modelcontextprotocol/sdk` and `zod`; one more dep is not a philosophical issue.

Concrete changes:
- `npm install js-yaml`.
- Replace `parseYaml`, `tokenizeYaml`, `parseScalar`, `parseBlockScalar`, `splitKeyValue`, `parseNode`, `parseSequence`, `parseMapping`, `stripYamlComment` with a single `import yaml from "js-yaml"` and `yaml.load(raw, { schema: yaml.CORE_SCHEMA })`.
- Keep the file's public API (`loadTeamSpec`, `resolveTeamSpecPath`, `TEAM_EXTENSIONS`) unchanged.
- The Phase 3.5 tests are the contract: they must all still pass after the swap.

**Done when:**
- `src/a2a-team-spec.mjs` shrinks from 247 lines to ~40.
- All Phase 3.5 tests pass.
- `bug-killers.yaml`, `west-world.yaml`, and any team specs in `~/.claude/skills/a2a/teams/` still load and produce identical normalized output.
- `js-yaml` is in `package.json` dependencies.

---

## Phase 5 — make logging an explicit product setting

**Files:** `src/a2a-config.mjs:179–215` (`appendMessageLog`), `src/a2a-server.mjs` (callsites at lines 215+, 240, 248, 261), `docs/cli.md`

**Current state:** every send (success or failure) appends `from`, `to`, `action`, `origin`, full body, and bytes to `~/.claude/skills/a2a/messages.log` in plaintext. Disable switch (`A2A_LOG=0`) exists but is not surfaced as a config option, retention is unbounded, no body redaction, no distinction between local and remote messages.

**Fix:** elevate logging to a first-class setting with named modes:

- Add `log.mode` to `loadConfig()` defaults: `"full"` (current behavior), `"headers"` (envelope metadata only, no body), `"off"` (no log at all). Default to `"full"` for backward compat.
- Add `log.path` for explicit path override (replaces ad-hoc `A2A_LOG_FILE` env-var precedence: env still wins, but config is honored).
- Add `log.maxBytes` for size-based rotation (default `10 * 1024 * 1024` = 10 MB). When the log exceeds this size, rotate to `messages.log.1` and start fresh. No multi-file ring; one rotation is enough for a tail-style log.
- Add `log.redactRemote` (boolean, default `false`). When `true`, messages where `transport === "remote"` log envelope only, body redacted to `[REDACTED <bytes>B]`. Useful when ngrok'd peers might be sending content the operator shouldn't store.
- Surface as CLI: `a2a config get log.mode`, `a2a config set log.mode headers`. Extend `USER_KEYS` in `a2a-config.mjs:23`.

**Done when:**
- `a2a config set log.mode headers` works and `appendMessageLog` writes only the header line.
- A log exceeding `maxBytes` rotates atomically.
- `log.redactRemote=true` redacts body for remote messages while preserving local message bodies.
- `docs/cli.md` documents the new keys and the trust/privacy implications.

---

## Phase 6 — decompose `cli.mjs`

**Files:** `src/cli.mjs` (1488 lines today), splits into:
- `src/cli/main.mjs` — argv dispatch (the `main()` function and direct dispatch logic)
- `src/cli/messaging.mjs` — `doSend`, `doParsedFlagSend`, `sendNormalizedEnvelope`, the dead-session-restart logic
- `src/cli/sessions.mjs` — `startSingle`, `startGroup`, `startTeam`, `cmdStart`, `cmdStartGlobal`, `cmdKill`, `cmdAttach`, `cmdPeek`, `cmdReconnect`, `cmdList`, `cmdRegister`, `cmdUnregister`
- `src/cli/bridge.mjs` — `cmdBridge`, `bridgeHealthy`, `isProcessAlive`, ngrok logic (`getNgrokUrl`, `startNgrok`, `resolveNgrok`)
- `src/cli/persona.mjs` — `composePersona`, `applyPersonaToBackendArgs`, `buildRoleLaunchArgs`, `readSkillBody`
- `src/cli/backend.mjs` — `BACKENDS`, `applyBackendDefaults`, `translateCommonAgentSettings`, `buildAgentLaunchCommand`
- `src/cli/team.mjs` — `loadResolvedTeamSpec`, `normalizeTeamSpec`, `normalizeTeamAgent`, `combinedRolePrompt`, `loadRoleText`, `resolveTeamRef`
- `src/cli/parsers.mjs` — `parseStartArgs`, `parseArgs`, `parseAuthArgs`
- `src/cli/auth.mjs` — `cmdAuth`, `authAdd`, `authList`, `authRevoke`
- `src/cli/config.mjs` — `cmdConfig`
- `src/cli/log.mjs` — `cmdLog`
- `src/cli/util.mjs` — `tmux`, `tmuxSessionExists`, `tmuxListSessions`, `tmuxPanePath`, `currentTmuxSession`, `attachTmuxSession`, `sanitizeId`, `validateAgentId`, `shellQuote`, `info`, `die`, `request`

`bin/a2a.mjs` continues to be a 2-line entrypoint that imports and runs `main()` from `cli/main.mjs`.

**Approach:** mechanical extraction, one file at a time, after Phase 3 tests are passing. Each extraction is its own commit; no behavior changes during decomposition.

Order of extraction (least entangled first, most entangled last):
1. `util.mjs` — pure helpers, no dependencies on other CLI code.
2. `backend.mjs` — depends only on util.
3. `persona.mjs` — depends on util.
4. `parsers.mjs` — depends on util, die.
5. `team.mjs` — depends on util, backend, persona, parsers, plus existing `a2a-team-spec.mjs`.
6. `bridge.mjs` — depends on util.
7. `auth.mjs` — depends on util, parsers, config.
8. `config.mjs` — depends on util.
9. `log.mjs` — depends on util.
10. `messaging.mjs` — depends on util, parsers (for the dead-session restart, depends on backend for `buildAgentLaunchCommand`).
11. `sessions.mjs` — depends on everything above.
12. `main.mjs` — pulls them all together.

**Eliminate the duplication along the way:**
- The dead-session restart logic is duplicated in `sendNormalizedEnvelope` (cli.mjs ~610-630) and `doParsedFlagSend` (~660-680). Extract to a single `restartIfDead(agentId, registry)` helper in `messaging.mjs`.
- `cmdStart` and `cmdStartGlobal` share most of their structure (parse args, resolve team/group/single, dispatch). Extract a shared `resolveStartTarget(args)` that returns a discriminated union (`{ kind: "team", spec }` | `{ kind: "group", name }` | `{ kind: "single", name, backend, args }`).

**Done when:**
- `src/cli.mjs` no longer exists (or is reduced to a pass-through).
- No file in `src/cli/` exceeds 400 lines.
- The dead-session restart logic exists in exactly one place.
- All Phase 3 tests still pass.
- `npm install && a2a help` works on a fresh checkout.

---

## Phase 7 — unify the parser dispatch

**Files:** `src/cli/main.mjs` (the `main()` dispatch), `src/cli/parsers.mjs`, `src/a2a-argv.mjs`, `src/a2a-tokens.mjs`

**Current state:** main dispatch (cli.mjs:1434-1488) checks four parser dialects in order: legacy `say|ask|reply` with `to:` fields, colon-form, flag-form, then fall-through to subcommands. Each dialect has its own parser file with its own conventions.

**Fix:** unify behind one normalized envelope shape:

```js
{
  action: "message" | "reply" | "ask",
  recipients: string[],
  content: string,
  from: string | null,
  origin: "user" | "peer" | "self" | null,
  extras: Record<string, string>
}
```

All three parsers produce this shape. The dispatch becomes:

```js
const parsed = parseSendArgv(argv, registry);
if (parsed) return executeSend(parsed);
return dispatchSubcommand(argv);
```

`parseSendArgv` internally tries colon-form → flag-form → legacy in that order, returning `null` if none match.

**Done when:**
- One callsite per parse path, one execute path.
- All Phase 3.2 parser tests still pass.
- The legacy `say|ask|reply` subcommands still work.

---

## Phase 8 — rename and reframe

This is the strategic move both assessments converged on. Do it last because (a) it's load-bearing on every doc and the docs need to be correct first (Phase 2), (b) it touches every public surface and you don't want to do it twice, and (c) once it's done, the next external user reads consistent material.

### 8.1 Pick the name

Both assessments suggested directionally similar names. Concrete candidates:

- **`tmux-bridge`** — accurate, descriptive, available on npm.
- **`agent-bridge`** — broader, less tied to tmux as the substrate.
- **`paste-bridge`** — emphasizes the actual delivery mechanism, memorable.
- **`coding-agent-network`** — too generic.
- **`agent-tmux`** — reads OK but inverts the usual convention (the substrate goes second).

Recommendation: **`tmux-bridge`** for the package name. The CLI binary stays `a2a` for muscle memory and short typing. The product framing in README/AGENTS/docs/cli.md becomes "tmux-bridge: a terminal bridge for live coding-agent CLIs."

### 8.2 Make the rename

- `package.json` `name` → `tmux-bridge`.
- `package.json` `bin` keeps `a2a` (and `a2a-server`, `a2a-channel`).
- `README.md` title and opening section reframe to "tmux-bridge" with one explicit paragraph: "this is not an implementation of Agent2Agent v1.0; it is a tmux bridge for live agent CLIs. The CLI command is `a2a` for brevity, but the product and protocol are unrelated to the A2A spec."
- `AGENTS.md` reframe similarly.
- `docs/cli.md` reframe similarly.
- HTTP endpoint paths: keep `/api/a2a/*` for backwards compatibility with anything that's already calling them; document that they're stable. Optionally add `/api/v1/*` aliases that future versions can evolve.
- `process.title` in `a2a-server.mjs:11` stays `"a2a-bridge"` (process names are part of the user's `ps` muscle memory; don't churn).
- The skill directory `~/.claude/skills/a2a/` stays put for backwards compat. The skill itself reframes its opening to name the product as "tmux-bridge" while keeping the `<a2a_message>` envelope name (which is wire format, not branding).

### 8.3 Update README's positioning

The README currently leads with mechanism ("HTTP bridge plus CLI"). Lead with product instead:

> tmux-bridge lets multiple coding-agent CLI sessions on your machine collaborate. Claude Code, Codex, Gemini, and Cursor Agent each run in their own tmux session and become addressable as named peers. Send messages between them, group them into teams, watch them work, intervene when needed.
>
> This is not Agent2Agent (A2A) v1.0. The two solve different problems — A2A is a protocol for opaque agent services to interoperate; tmux-bridge is a substrate for interactive agent CLIs to collaborate locally. The CLI command happens to be `a2a` for brevity. If you came here looking for an A2A implementation, see https://a2a-protocol.org.

**Done when:**
- `package.json` name updated.
- `README.md`, `AGENTS.md`, `docs/cli.md` lead with the new framing and the disambiguation paragraph.
- No file in the repo claims this is an A2A implementation.
- The CLI binary, HTTP paths, and skill location are unchanged so existing users aren't broken.

---

## Out of scope, deliberately

These are real concerns but don't belong in this plan:

- **Full A2A spec compliance** (Tasks, artifacts, OAuth, signed Agent Cards, gRPC binding). Both assessments converged on "don't." Add a spec facade later if it makes sense; do not chase compliance.
- **Persistent registry across bridge restarts.** `a2a reconnect` is the right level of solution for the current product. If the product moves toward swarm-launcher framing (Codex's strategic option 4), revisit then.
- **Durable task/conversation state.** Same — this becomes relevant only if the product framing shifts.
- **Switching from XML envelopes to JSON.** The envelope works, the CDATA escaping is correct, the LLM-parsing of the envelope is fine. Don't churn the wire format for a marginal improvement.

---

## Order of execution and stopping points

1. Phase 1 (residual bugs) — land all four fixes. Push.
2. Phase 2 (docs/install) — land the install behavior change and doc updates. Push.
3. Phase 3 (tests) — land the test suite. Push. Stop here if time-boxed; everything below depends on tests being green.
4. Phase 4 (YAML) — swap the parser. Push.
5. Phase 5 (logging) — surface as config. Push.
6. Phase 6 (CLI decomposition) — extract one module at a time, commit per module. Push after each major boundary (util/backend/persona done, then team/bridge/auth done, then messaging/sessions done).
7. Phase 7 (parser unification) — land after decomposition. Push.
8. Phase 8 (rename) — land last. Push.

After phase 8, the project is in a state where the spec-facade question (Path B from my assessment) becomes a clean separate decision rather than a half-mixed concern. That's the right time to evaluate whether to add it.
