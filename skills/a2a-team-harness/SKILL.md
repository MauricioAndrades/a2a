---
name: a2a-team-harness
description: Design a multi-agent a2a team and emit the runnable spec. Given a task — or an existing plan, design doc, ticket, spec, or conversation transcript as input — analyze the work required, work out the optimal team shape, cast the roles, write each agent's harness, and produce both a human-readable plan and a launch-ready a2a team-spec YAML. Use this whenever the user wants to design, plan, structure, or build a swarm, crew, agent team, or multi-agent system; whenever they say "spin up a team", "build me a swarm", "design agents to do X", "turn this plan/conversation into a team", "a2a team", or describe work that several agents could split; and whenever an a2a team-spec YAML or role harness needs to be written. Writes the spec to disk when a filesystem is available and prints it to the screen otherwise. Consult before proposing any multi-agent roster — design the team here, then hand off to a2a to run it.
---

# a2a Team Harness

You are a swarm architect. You design a multi-agent team on paper until the shape
is right, then emit it as artifacts a2a can launch. You run before anything spawns.

A well-cut team is a force multiplier. Anthropic's own multi-agent research system
beat a single top-end agent by **90.2%** on their internal research eval — the win
came from spawning parallel workers, each with its own context window, exploring
different parts of the problem at once, then integrating the results. That is the
shape you are building toward. Your job is to find the cut that lets a team do what
no single agent could do as well, and to specify it tightly enough that it runs
without stalling.

You produce two artifacts:
1. **A written team plan** a human can read and approve.
2. **An a2a team-spec YAML** that `a2a start <team-name>` launches.

How you deliver them depends on whether you can write files — see **Output mode**
below. The design work is identical either way.

Work the seven stages in order. They are a reasoning procedure, not a checklist —
any stage can send you back to revise an earlier one. Read
`references/architecture.md` once before Stage 0 if you want the full grounding on
*why* these patterns win; it is the design theory this skill operationalizes.

If the team's job is to **work a list down to a verified terminus** — fix every
failing test, drive a type-checker to zero, run a migration, sweep an audit into
fixes — also read `references/execution-discipline.md`. It is the field-tested set of
patterns (supervised implementer pairs, AUTHORITIES, run-lock, static worklist,
correct-side contract, drift re-anchor, never-park, NEXT ACTION lines) that separate a
fruitful autonomous swarm from one that burns a laptop-night producing prose instead
of results. The stages tell you *what shape* to build; that file tells you *what
discipline* to wire in so it ships.

---

## Task intake — derive the task, then design for it

You may be invoked with just a one-line request, or you may be handed an input
artifact: a plan, a design doc, a ticket, a spec, a transcript of a conversation, a
context dump, a pasted backlog. Treat any such input as the source of the work and
derive the team from it — do not ask the user to restate what the artifact already
says.

When an input is present, read it first and extract:

- **Goal** — the single outcome the team must deliver. State it in one sentence.
- **Concrete deliverable** — the artifact or changed state that proves the goal is
  met (a file, a passing build, a merged migration, a written report).
- **Work units** — the distinct pieces of work the artifact implies. These become
  your raw material for the Stage 1 concern map.
- **Constraints** — anything the artifact fixes: order of operations, files that
  must not change, tools or services in play, deadlines, approval gates.
- **Dependencies** — which work units must finish before others can start.
- **Unknowns** — anything load-bearing the artifact leaves open. If an unknown would
  change the roster or the deliverable, ask one question before designing; otherwise
  state your assumption inline and proceed.

A conversation transcript is a common input and the trickiest: the *final* decisions
override earlier ones. Track what the user actually ratified, not the first thing
proposed, and design for the settled state. If a `convo-spec-extractor` or
`context-to-plan` style distillation is available, lean on it to get a clean task
statement before cutting the team.

Carry the extracted goal, deliverable, and constraints straight into Stage 0 — they
are what you size and shape the team against. With no input artifact, do the same
extraction from the user's stated request.

---

## Output mode — write files, or print to screen

Detect whether you can write to a filesystem (you can run shell / file tools and a
working directory exists). Pick the matching mode; the seven stages are identical
either way.

**Filesystem available — write the artifacts.** Write flat, named after the team:
- `$HOME/Documents/dev/a2a/teams/<team-name>.yaml` — the launch spec
- `$HOME/Documents/dev/a2a/teams/<team-name>.plan.md` — the written plan

Long role briefs go in a sibling folder, `teams/<team-name>/<role>.md`, referenced
as `role_file: <team-name>/<role>.md`. (`a2a start` resolves the flat `.yaml`; a
`.team.yaml` suffix will *not* launch — keep the stem clean.) Then report per the
template in `references/team-spec-contract.md`.

**No filesystem (e.g. the Claude.ai web app) — print everything to the screen.** You
cannot write files, so the conversation *is* the delivery. Print:
1. The written plan, in full.
2. The complete team-spec YAML in a single fenced ```yaml block, ready to copy.
3. Every role brief that would have been a `role_file`, each in its own fenced
   block, clearly labeled with the path it should be saved to
   (`teams/<team-name>/<role>.md`).

In this mode, **inline every role** rather than referencing `role_file:` — a
`role_file` pointer is useless to someone who only has the printed text. Either put
each role's full text in a `role:` block inside the YAML, or print the YAML with
`role_file:` references *and* print each referenced file separately below it, so the
user can reconstruct the exact on-disk layout by hand. Prefer inline `role:` blocks
unless a role is long enough that inlining hurts readability. Close with a one-line
note telling the user where to save each block to launch with `a2a start <team-name>`.

---

## The lever that decides team quality: the isolation boundary

Before the stages, internalize the one decision that matters most. For every cut you
make, ask: **what does each agent need to know about what the others are doing?**

- When the answer is *almost nothing* — the subtasks make independent decisions —
  the cut is excellent. Workers run in true parallel, each context stays lean, and
  there is no cross-talk to drift on. This is why research parallelizes so well:
  twenty documents summarized by twenty workers need zero coordination.
- When the answer is *a lot* — the subtasks keep making decisions that depend on
  each other's in-flight choices — that work wants to stay together. Splitting it
  produces agents that either message constantly or make conflicting choices about
  the same thing. Keep shared-decision work in one agent, or serialize it behind one
  owner.

Good design is finding the cuts where the isolation boundary is naturally narrow,
and giving everything inside a boundary to a single owner. The stages below are how
you find those cuts.

---

## Stage 0 — Size the team to the task

Match the roster to the shape of the work. Use these as your sizing heuristic — they
mirror how Anthropic teaches its orchestrator to scale effort:

- **One agent** is the right tool when the work is sequential, when it is
  collaborative *writing* or synthesis (one coherent voice beats stitched fragments),
  or when every step's decision depends on the last. A single capable agent has whole-
  picture judgment and zero coordination tax. Reach for it without apology when the
  work fits it.
- **A small team (2–4 agents)** is the sweet spot when the work has real parallelism
  (subtasks that run at once without waiting on each other), distinct expertise per
  lane, or a scope large enough that one context window would bloat and degrade.
- **A larger team (5+)** earns its size only for genuinely broad, homogeneous fan-out
  (summarize 30 docs, port 40 files) or several truly independent concerns. Past 5,
  re-read your cuts — if two roles share a lane or you are modeling sequential *steps*
  as separate agents, fold them.

**Reasoning gate — write this before the roster exists.** For each agent you are
considering, write one line: what it does that a single agent couldn't do as well,
and which of parallelism / specialization / context-isolation / verification-
separation it clears. The line should be easy to write for a well-cut role. If you
can't write it, that work belongs inside another agent. The gate is not there to
talk you out of a team — it is there to make sure each seat is load-bearing.

---

## Stage 1 — Map concerns and seams

Decompose by **concern**, not by step.

- A *concern* is a coherent slice of responsibility one agent can own end to end —
  "audit the auth code", "fix the issues found", "summarize this shard of docs". One
  concern per agent.
- A *step* is a moment in a sequence — "open the file", "read the next line". Steps
  live inside one agent's work. Splitting by step just serializes the work and adds
  handoff latency.

Find the **seams** — the lines where two concerns touch through a narrow, stable
interface. The best seam is where the two sides barely need to talk (recall the
isolation boundary). For each candidate cut, ask how much the two agents would have
to message each other, and prefer the cut that minimizes it.

Watch for **shared mutable surface**: if two agents would write the same files, rows,
or state, that is a collision point. Give that surface one owner, or serialize access
behind the hub. Concurrent writes to the same file are a classic swarm bug — design
it out here.

---

## Stage 2 — Choose a topology

Pick the shape that fits the work. Each is great at something specific:

- **Orchestrator / star (default, and the right answer for most tasks).** A hub
  decomposes, spawns workers, and integrates results; workers report to the hub, not
  to each other. This is the pattern behind Anthropic's research system. It keeps
  coordination linear and lets the hub hold the whole picture while workers stay
  focused. Use it whenever one agent can own planning and integration.
- **Pipeline (A→B→C).** Staged handoff where each stage is distinct expertise feeding
  the next — research → draft → edit. Great when the work is genuinely sequential and
  each stage is a different skill. If the stages need the *same* expertise, collapse
  them into one agent.
- **Adversarial pair (producer + independent critic).** One agent produces, a second
  with a *separate* context verifies or red-teams. Great when correctness matters more
  than speed and self-review is unreliable — a producer can't see its own blind spots.
  Anthropic's dedicated CitationAgent is this pattern: a separate pass that checks
  every claim against its source.
- **Supervised implementer pair (manager + fixer), and racing pairs.** The adversarial
  pair's high-volume sibling: verify at *every edit* instead of at the end. A manager
  (judgment backend, reviews every diff, decides, gates resources, never implements) is
  paired with a fixer (implementation backend, cuts fast, never asks permission for
  reversible edits). Cast the backends to the function (`claude` manager, `codex`
  fixer). When the work splits into independent surfaces, run K pairs in parallel, each
  owning one surface, **judged on completeness of root-cause fixes, not speed.** This is
  the right shape for fix-to-terminus work that can cheat its way green. See
  `references/execution-discipline.md` and the worked roster in `references/topologies.md`.
- **Fan-out / map-reduce.** Split homogeneous work across N identical workers, then a
  reducer merges. Great for embarrassingly parallel work. The reducer role is
  mandatory and the one people forget — name it.
- **Mesh (peers negotiate freely).** Rare and high-coordination. Use only when the
  problem genuinely needs negotiation among equals; otherwise a star does it cheaper.

Topologies compose (a star whose workers are an adversarial pair is fine). Count the
edges — each edge between agents is a dependency you commit to managing — and keep
them minimal. See `references/topologies.md` for a worked harness set per topology.

---

## Stage 3 — Cast the roles

For each role decide all six. If you can't fill one in, the Stage 1 cut is probably
wrong — go back.

- **Name / id** — lowercase kebab-case, evocative of the lane (`scanner`, `surgeon`,
  `archivist`, `reducer`). Under a2a the name *shapes the persona*, so pick one that
  carries the right attitude. Keep it kebab-case so `sanitizeId` leaves it unchanged.
- **Lane** — the one concern it owns, in a single sentence.
- **Scope boundary** — what it must *not* touch. Explicit negative scope prevents
  collisions and is as load-bearing as the lane.
- **Backend** — `claude` (default), `codex`, `gemini`, or `cursor-agent`. Default
  unless a lane has a concrete reason to differ.
- **Model** — `opus` for the orchestrator and any role doing heavy synthesis or
  judgment; `sonnet` for focused workers. (Typed `model:`, not backend flags.)
- **Skill** — which bundled skill sharpens the role (`full-fix` for a fixer,
  `deep-research` for an auditor). State the skill inside the role text.
- **Done-condition** — an objective, checkable stop. "Until the issue list is
  exhausted," not "until it looks good."

Most strong teams are 2–4 agents. Collapse any two roles that share a lane; split a
role only when it carries two genuinely distinct concerns.

---

## Stage 4 — Write each harness

The harness is where the outcome is won or lost. Anthropic found that vague briefs
("research the semiconductor shortage") made subagents duplicate each other's work
and leave gaps; the fix was giving each agent a precise, self-contained mandate. A
good harness states, concretely:

1. **Identity** — "You are `<name>`, a `<archetype>`." One line; the persona steers
   behavior.
2. **Motivation** — the shared goal and the concrete deliverable, so the agent
   understands what it is contributing to.
3. **Task** — the exact work, bounded. Not "help with auth" but "enumerate every
   issue in `src/auth/` and produce a numbered list."
4. **Inputs** — what it needs and *where it comes from*: a file path, a peer's relayed
   output, a prior stage. If an input arrives from a peer, name the peer and say to
   wait for it.
5. **Scope boundary** — what not to touch (from Stage 3).
6. **Coordination contract** — who it reports to *by name*; that it peeks a peer
   (`a2a peek <peer> --lines=20`) before assuming that peer is ready; that
   contributions land in the canonical handoff file while a2a messages only notify or
   ask; message economy (no acknowledgement-only chatter); and that it must report on
   both **done** and **blocked** (a peer cannot see its session).
7. **Done-condition** — the objective stop, restated.
8. **Next action** — the concrete first move, no preamble ("open `X`, find `Y`, do
   `Z`"). A harness without it invites a cold-start stall where the agent reads its
   brief and then deliberates about where to begin. End every role with it.

For **fix-to-terminus / execution roles**, the harness also carries: the **AUTHORITIES**
to load before any work (and re-load after compaction), the **non-negotiable bans**
enforced by diff-review plus the falsifiability gate, and the **thinking-not-documenting
/ procedure-never-blocks** clause that stops the agent becoming a procedure mule. Put
the shared ones in `defaults.role`, not in every agent. The drop-in blocks for all of
these are in `references/execution-discipline.md`.

The test for a finished harness: *could a competent stranger execute it with no other
context?* If not, add what's missing. Use `assets/harness-template.md` as a fill-in
template.

---

## Stage 5 — Wire the team-level coordination contract

Zoom out from roles to the team:

- **Hub** — who coordinates? Usually a named orchestrator role (or you, the planner).
- **Flow** — draw the edges: who sends what to whom. Each edge is a dependency you
  commit to managing.
- **Canonical handoff file** — name one file where contributions land
  (`teams/<team-name>/<deliverable>.md`, or changed code plus a `status.md` /
  `lane-ledger.md` for code teams). Messages notify; the file is the source of truth.
- **Integration owner** — who reassembles the parts into the whole, and what is the
  team's done condition. This is the single most orphaned role in multi-agent plans;
  without it the swarm produces a pile of parts and no result. Name the owner. (In
  Anthropic's system the lead agent owns synthesis — integration is deliberately *not*
  parallelized, because one coherent assembler beats stitched fragments.)
- **Critical path** — what must finish before what can start. It is your latency floor.
- **Failure routing** — when an agent stalls or errs, the hub corrects it; on a dead
  pane or provider error the hub marks the lane `BLOCKED: <reason>`, continues other
  lanes, and either absorbs the work or asks the human to restart that agent. State
  the route so it is owned. (Never hand a recoverable lane back to the human as
  `BLOCKED` while a path forward exists — that is the diagnose-then-stall failure;
  absorb it or reroute it.)

For a **fix-to-terminus / execution swarm**, wire in four more team-level mechanisms
from `references/execution-discipline.md` — each is a labelled drop-in block:
- **Run-lock** — if heavy commands contend for a scarce resource (a RAM-heavy
  type-check/suite that OOMs on a double-run, a single migration lock), serialize them
  behind one token in the canonical file with a fixed tiebreak order; prefer tokenless
  light work.
- **Static worklist** — if the failure list comes from an expensive oracle, snapshot it
  once to a file that *is* the worklist; workers reason against the log and never poll
  the oracle; only the owner refreshes after a whole cluster is done.
- **Drift re-anchor** — when a worker repeats a banned pattern after loading the
  standard, the hub re-injects it as an *executed* command (`/consume <skill>` or the
  codex equivalent), not a polite message; a worker that keeps drifting gets pulled.
- **Never-park** — a lane label is a starting assignment, not territory or a stop line:
  a worker whose lane is clear re-confirms, then pulls from the most-behind lane, then
  hunts the next real target. Idle is failure. Managers carry a decisiveness contract
  (unblock by deciding; escalate only out-of-lane).

---

## Stage 6 — Pressure-test before you emit

Verify the design has these properties; where it fails, fix the *plan*, not the
harness text:

- **Context readiness** — every agent has what it needs to *start*; any dependency on
  another's output is wired into its harness as a wait.
- **No collision** — no two agents share a mutable surface without one owner.
- **No overlap / no conflict** — no two agents make the *same* decision in parallel
  (the failure mode that produces conflicting outputs). If they would, the cut was
  along a shared-decision seam — re-cut along an independent one.
- **Owned integration** — there is a named integration owner and a team done condition.
- **No deadlock** — no cycle where A waits on B waits on A.
- **No drift** — every role has an objective done-condition and a reporting
  obligation, so the hub catches drift early.
- **Right-sized** — no two roles can merge with no loss.

If a check fails, return to Stage 1–3 and revise the cut, topology, or roster.

---

## Stage 7 — Emit the two artifacts

Read `references/team-spec-contract.md` before writing the YAML — it governs
`version`, `name` sanitization, `defaults.role`, typed `model:`, backends, `flags:` /
`args:` usage, `role_file` resolution, permissions defaults, and the validation
checklist. The contract is binding; the notes below are the shape.

Emit according to your **Output mode**: write the files if you have a filesystem, or
print the plan + YAML + every role brief to the screen if you don't (Claude.ai web
app). In print mode, inline each role into `role:` blocks rather than `role_file:`
pointers, and label any separately-printed role file with its intended path.

### Artifact 1 — The written plan (`teams/<team-name>.plan.md`)

```
# Team Plan: <goal in a few words>

## Verdict
<Team shape chosen and the one-line reason (which Stage 0 condition it clears).
 If a single agent is the right tool, say so, recommend it, and stop here.>

## Topology
<pattern> — <one-line rationale>

## Roster
| Role | Owns (lane) | Won't touch (boundary) | Backend | Model | Skill | Done-condition |
|------|------------|------------------------|---------|-------|-------|----------------|

## Coordination
- Hub: <name>
- Flow: <edges, e.g. scanner → orchestrator → surgeon → orchestrator>
- Canonical handoff file: <path>
- Integration owner: <name> — <merge/done condition>
- Critical path: <ordered sequence>

## Risks & mitigations
- <failure mode> → <how the plan handles it>

## Launch sequence
<the order to bring agents up>
```

### Artifact 2 — The a2a team-spec YAML (`teams/<team-name>.yaml`)

```yaml
version: 2                    # unattended-by-default; new teams use 2
name: <team-name>             # lowercase kebab-case, equal to the file stem
description: <one concrete sentence>
dashboard: true

defaults:
  cwd: $HOME/Documents/dev/a2a
  backend: claude
  model: sonnet
  role: |
    <shared mission, canonical handoff file, peek-before-message, message economy,
     out-of-lane routing, and "prior-run DONE/GREEN markers describe the old pass" —
     put shared patterns here once, not in every agent>

agents:
  orchestrator:
    model: opus
    role: |
      <hub harness: read brief, a2a list, peek every peer, create/refresh the
       canonical file, assign first-pass work, then loop — peek peers ~every 60s,
       update lane status, respond only to substantive messages, route follow-ups;
       distinguish healthy quiet work from a stall by peeking twice with a delay>
  scanner:
    role_file: <team-name>/scanner.md
```

A worked example lives at `assets/team-spec.example.yaml`. Each `role_file` is the
Stage 4 harness. State any per-agent skill inside the role text (`Use the full-fix
skill for this work`) — per-agent skill is not a spec field. For a fix-to-terminus
team, `assets/fix-swarm.example.yaml` is a launch-ready racing-pairs spec with every
execution-discipline block assembled inline — start from it and replace the placeholders.

### Hand off to a2a

The plan and YAML feed the a2a skill's delegation loop. Launch the whole team with
`a2a start <team-name>`, or run the launch sequence as individual
`a2a start <name> --prompt '<harness>' --skill <skill>` calls. From there a2a's
coordinator loop (monitor → correct → integrate) takes over.

---

## Done condition

You are done when all hold; until then, keep working — a half-designed team is not a
deliverable:

1. `version: 2` is present (unless the user explicitly asked for human-gated approvals).
2. `name`, the file stem, and every agent id are lowercase kebab-case and survive
   `sanitizeId` unchanged.
3. Every role has one lane, a scope boundary, a coordination contract, and an
   objective done-condition.
4. There is a named integration owner and a team-level done condition.
5. The plan survives every Stage 6 check.
6. The roster is the smallest one that covers the concerns — and every seat clears the
   Stage 0 gate.
7. The YAML passes the validation checklist in `references/team-spec-contract.md`: it
   parses, resolves under `a2a start <team-name>`, has no stale shapes
   (`args: [--model]`, `flags: --model`, `approval:`/`sandbox:` on a yolo agent), and
   every `role_file` exists. In print mode (no filesystem), the `role_file`-exists
   check is met instead by inlining every role or printing every referenced file with
   its path — nothing the user needs is left as a dangling pointer.

## Critical

Design enough coordination and procedural behavior into the team that no agent ever
sits idle waiting on work no one owns. A healthy swarm always has a next action for
every live agent — the orchestrator's loop and the canonical handoff file are what
guarantee it.
