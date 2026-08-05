# a2a Team-Spec Contract

Binding reference for writing the YAML in SKILL.md Stage 7. Field names, version,
sanitization, and resolution rules are not negotiable — `a2a start` depends on them.

## File resolution

`a2a start <team-name>` resolves, in order:
- flat: `teams/<team-name>.yaml`  ← **preferred**
- nested: `teams/<team-name>/<team-name>.yaml` or `teams/<team-name>/team.yaml`

Use flat layout unless companion role files are large enough that a folder is
cleaner. The file stem must equal `name`. A `.team.yaml` suffix does **not** resolve.

`role_file` paths resolve relative to the spec file:
- flat spec → reference companions as `<team-name>/<file>` (e.g. `bug-killers/scanner.md`)
- nested spec → reference companions as `<file>`

`role` and `role_file` must not both appear at the same level.

## Required top-level shape

```yaml
version: 2
name: <team-name>
description: <one concrete sentence>
dashboard: true            # optional; enables the live dashboard
defaults: { ... }          # optional but recommended
agents: { ... }            # required
```

## version

New teams use `version: 2`. This makes agents **unattended by default** (yolo): the
launcher injects backend bypass flags automatically. Only use `yolo: false` on a
specific human-gated reviewer or final-signoff agent. Under version 2, omit
`approval:` and `sandbox:` unless that same agent has `yolo: false` — with yolo true,
those entries are misleading stale text.

## name and id sanitization

`name` and every agent id must be lowercase kebab-case so `sanitizeId` leaves them
unchanged. Keep `name`, the file stem, and the launch name identical.

## defaults.role

`defaults.role` is prepended to every agent's role. Put shared content here once —
the mission, the canonical handoff file, peek-before-message, message economy,
out-of-lane routing, and compaction recovery. Per-agent roles are specializations
only; do not copy shared text into each one.

For a pass over previous team output, add a clause to `defaults.role`: prior-run
markers like `DONE`, `GREEN`, `PARKED`, `COMPLETE` describe the old pass only; this
run follows the new objective until this run writes its own closure.

For a **fix-to-terminus / execution swarm**, `defaults.role` also carries the shared
discipline spine — AUTHORITIES (load before work, re-load after compaction), the
run-lock token, the static-worklist rule, the correct-side contract, the
non-negotiable bans + falsifiability gate, thinking-not-documenting /
procedure-never-blocks, drift re-anchor, prior-run-failure prohibitions, and never-park.
These are shared, so they live in `defaults.role` once, not in every agent. The
labelled drop-in blocks are in `references/execution-discipline.md`;
`assets/fix-swarm.example.yaml` shows them assembled in a real spec.

Do **not** put shared `approval`, `sandbox`, model flags, or duplicated lane text in
`defaults`.

## model

Use typed `model:` for model selection — `model: opus` or `model: sonnet`.
Orchestrator and heavy-synthesis roles get `opus`; focused workers get `sonnet`. Do
**not** use `args: [--model, ...]` or `flags: --model ...` — those are deprecated
shapes.

## backend

`claude` (default), `codex`, `gemini`, `cursor-agent`. Default `claude`; pick another
backend deliberately for a distinct lane (e.g. `codex` with `model: gpt-5.3-codex`
for a code lane).

## flags and args (rare)

Use `flags:` only for a backend-specific flag the schema does not model
(`--reasoning-effort high`, `--system-prompt ...`). Quote values containing spaces and
verify the backend supports the flag. Use `args:` only when neither `model:` nor
`flags:` can express the setting. Never split one logical setting across `args` and
`flags`.

## Permissions: off by default

Do **not** add read/write permissions, messaging-glob selectors, filesystem access
constraints, backend tool allow/deny-lists, or per-agent `approval:`/`sandbox:`
clauses unless the user explicitly asks. The default posture is that every agent
inherits the team's yolo bypass and writes wherever the canonical handoff requires. A
tighter posture (read-only researcher, write-restricted reviewer, scoped fan-out) is
opt-in — omit those fields entirely until the user requests them.

## Orchestrator role requirements (orchestrated teams)

The orchestrator role must include startup and loop behavior, expressed as real a2a
commands only:
- startup: read the brief/status, `a2a list`, `a2a peek <peer> --lines=20` for every
  peer, create or refresh the canonical handoff file, assign first-pass work.
- loop: every ~60s peek peers, update lane status in the file, respond only to
  substantive messages, route targeted follow-ups.
- liveness: distinguish healthy quiet work from a stall by peeking twice with a delay
  and checking for background activity before intervening.
- failure: on a provider error or dead pane, mark the lane `BLOCKED: provider` or
  `BLOCKED: dead-pane`, continue other lanes, then absorb the work or ask the human to
  restart via real commands (`a2a kill`, `a2a start`, `a2a reconnect`).

There is no `a2a respawn`. Recovery uses `a2a peek`, `a2a kill`, `a2a start`,
`a2a reconnect`, `a2a list`. Verify any non-messaging command against `a2a --help`
before putting it in a role.

## Validation checklist (run before reporting)

- [ ] Parses as YAML; has top-level `agents`; `version: 2` (unless interactive was asked for).
- [ ] Resolves under `a2a start <team-name>` from `$HOME/Documents/dev/a2a`.
- [ ] Every `role_file` exists and is addressed relative to the spec file.
- [ ] No `role` and `role_file` at the same level.
- [ ] Every `cwd` resolves to a real directory.
- [ ] Every backend supported; every id lowercase kebab-case.
- [ ] No stale shapes: no `args: [--model]`, no `flags: --model`, no `approval:`/`sandbox:` on a yolo agent.
- [ ] Every role has a distinct lane, scope boundary, coordination contract, done-condition.
- [ ] Every role ends with a concrete NEXT ACTION (no cold-start stall).
- [ ] Orchestrator uses only real a2a commands.
- [ ] (Execution swarm) AUTHORITIES, run-lock, static-worklist, correct-side, bans, and
      never-park live in `defaults.role`; managers carry a decisiveness contract; fixers
      are told their output is the diff and they never poll the oracle.

## Report template (after writing files)

```text
IMPLEMENTED: teams/<team-name>.yaml
COMPANIONS:  teams/<team-name>/<file>.md, ...
VALIDATED:   schema shape, path resolution, ids, yolo posture, role files, command surface
LAUNCH:      a2a list
             a2a kill --all        # only if an old cohort is present
             a2a start <team-name>
INSPECT:     a2a list --json
             a2a peek <agent> --lines=20
```

Keep the report about files and launch commands. Do not write a prose launch guide
unless the user asks.
