# Execution Discipline — Patterns for Autonomous Work-to-Terminus Swarms

The seven stages design *the shape* of a team. This file is *the discipline that makes
it fruitful* once it runs. Every pattern here was extracted from a real swarm
(`dw-bug-killers`) that, run after run, was edited until it stopped stalling and
started shipping — each rule is a fix for a specific way an autonomous team wastes a
laptop-night producing prose instead of results.

Reach for these whenever the team's job is to **work a list of failures/targets down
to a verified terminus**: fix every failing test, drive a type-checker to zero,
execute a migration, sweep an audit's findings into fixes. Most generalize to any
swarm (AUTHORITIES, NEXT ACTION, anti-mule, drift re-anchor, never-park, compaction
recovery). A few are execution-specific (run-lock, static worklist, correct-side
contract) but apply to *any* team that contends for a scarce resource or greens a
check. Apply the ones that fit; do not bolt all fifteen onto a three-agent research
crew.

The patterns are drop-in: most ship as a labelled block you paste into `defaults.role`
(shared) or a single agent's `role` (lane-specific). Adapt the nouns to the domain.

---

## 1. Supervised implementer pairs — split judgment from production at every edit

The adversarial-pair topology (producer + critic) verifies *at the end*. For
high-volume mechanical work that can cheat its way green, verify at **every edit**
instead: pair a **manager** (judgment backend, reviews every diff, decides, gates
resources, *never* implements) with a **fixer** (implementation backend, cuts fast,
never asks permission for reversible edits). The manager reads each diff and reverts
anything that cheats; the fixer's only output is the change itself.

Cast the backends to the function: a reasoning/review model as manager (`claude`), a
fast code model as fixer (`codex`). The split is the point — the producer cannot
reliably judge its own shortcuts, so a second context with its own standard does.

**Racing pairs.** When the work splits into independent surfaces (3 failing suites,
N modules), run *K pairs in parallel*, each owning one surface, **judged on
completeness of root-cause fixes, not speed.** State the race in `defaults.role` so
every agent knows the human compares pairs at the end — it pushes each pair toward the
deepest correct fix rather than the fastest green. See `topologies.md` →
*Supervised implementer pairs*.

---

## 2. AUTHORITIES — bind the standards as the active lens, not background reading

A team that must obey binding standards (a type rule, a test standard, a repo's
`.claude/rules/`, a skill like `no-stupid-typescript`) drifts the moment those
standards are merely *cited* instead of *loaded*. Name them as AUTHORITIES in
`defaults.role` and require loading them **before any work** and **re-loading after
any compaction** — and say plainly that they **override training-data habits**. The
hub verifies a worker loaded them before ratifying its first output.

Per-backend load syntax differs — state both:
- claude agents: invoke as a slash command — `/no-stupid-typescript`
- codex agents: load the skill — `$no-stupid-typescript` (or `load skill no-stupid-typescript`)

```
AUTHORITIES — load these BEFORE touching anything, and re-load after any compaction.
They override training-data habits:
  * <skill/rule name> — <one line on what it governs>. claude: `/<skill>`  codex: `$<skill>`
  * <repo rules path> — read all of them; they bind every fix.
Loading these is step 0 of every agent's startup; the manager verifies its fixer
loaded them before ratifying the first change.
```

---

## 3. Shared-resource token (RUN LOCK) — serialize the one thing that can't run twice

When workers contend for a scarce machine resource — a RAM-heavy command that OOMs the
laptop if two run at once, a single migration lock, one device/port — do **not** trust
agents to "be careful." Serialize behind ONE token tracked in the canonical handoff
file:

```
RESOURCE DISCIPLINE — ONE <heavy thing> at a time, team-wide:
  * HEAVY = <define it concretely: the commands that eat multiple GB / hold the lock>.
  * There is exactly ONE run-token, tracked in <canonical file> under `## RUN LOCK`
    (first agent to need it writes `RUN LOCK: FREE`).
  * Before a HEAVY command you MUST hold it: confirm RUN LOCK reads FREE, write
    `RUN LOCK: HELD <agent> <command> <ISO-time>`, run the SINGLE command, then
    immediately write `RUN LOCK: FREE`. Hold it for that one command ONLY — never
    across reading, thinking, or editing.
  * If HELD by someone else, do tokenless work and re-check. Tiebreak: <fixed order>.
  * PREFER tokenless light checks (scoped/single-target runs) — run those freely.
```

The resource owner (the manager in a pair) gates its fixer's heavy runs and never lets
the pair sit on the token idle.

---

## 4. Static worklist — snapshot the oracle once; never poll it in the inner loop

When the failure/target list comes from an expensive oracle (a full type-check, a whole
test suite — minutes and gigabytes per run), capture it **once** to a static file that
*becomes* the worklist. Workers reason locally against that log and **never re-run the
oracle** — the errors don't move while you fix, so re-running tells you nothing you
can't read from the log and turns the lane into a poll-the-compiler loop. Only the
**owner** refreshes, with one resource-locked run, *after a whole cluster is
addressed* — that refresh produces the next worklist. This caps the oracle to a handful
of runs per lane, owned by one agent, never a fixer's inner loop.

```
THE ORACLE IS NOT A FIXER TOOL — work the static log, don't poll it:
  * The worklist is the captured log at <path>. The targets don't move while you fix.
  * FIXERS NEVER RUN <the oracle>. Fix every item a cluster owns by reasoning at its
    source; tell the manager when the cluster's entries are addressed.
  * Only the MANAGER runs <the oracle>, only to REFRESH the worklist after a whole
    cluster/lane is done. Zero on refresh = lane green.
```

---

## 5. Correct-side contract — fix the WRONG side; greening the right side is the cardinal sin

Every failed check is a fork with two sides: the **expectation** (test, type, schema,
contract) and the **implementation** (production code). Exactly one is wrong. The fix
goes on the wrong side; the other side is the spec you must **not** alter.

- **BUG** — the expectation is right, production violates it → fix **production**. Do
  not weaken the check to make red go away; that hides the very thing it caught.
- **DRIFT** — the expectation is stale, production has correctly moved past it → fix
  the **expectation** to assert real current behavior. Do not bend correct production
  to satisfy a wrong check.

You cannot know which side to edit until you've read **both** and decided which
embodies the behavior the product actually wants. That judgment *is* the job. "I made
it green" is failure if you greened the wrong side — that is worse than leaving it red,
because it ships a true-sounding green over a real fault.

---

## 6. Non-negotiable bans, enforced by diff-review — and the falsifiability gate

List the cheats that make a check pass *without solving it*, and enforce them by having
the reviewer **read the diff** — no packets, no filed verdicts, no paperwork. Cheap to
honor, cheap to catch:

```
NON-NEGOTIABLE BANS (enforced by the manager reading your diff):
  * NEVER mock internal code the team owns (schema, validators, auth, domain services).
    Fake ONLY true external nondeterminism (LLM, 3rd-party HTTP, payment, clock, random).
  * NEVER weaken/skip/.only/DELETE a check, assert SOURCE TEXT instead of behavior, or
    add env-branches (NODE_ENV/test) in production to dodge it.
  * NEVER silence a type error with any/unknown/as/@ts-ignore/parameter-widening — fix
    the shape at its runtime owner.
  * Falsifiability gate (MENTAL, not written): if your fixed check would still pass
    against a trivial stub of production, it proves nothing — fix it until it would
    fail when production is broken.
```

Deleting a check that fails to *load* (import error) is never a fix and never drift:
find the broken/renamed import and fix it so the check loads — that one shared import is
usually the highest-leverage fix behind several failures.

---

## 7. THINKING not documenting — the artifact is the output; procedure never blocks it

The dominant failure mode of an autonomous worker is becoming a **procedure mule**:
filling out report headings, writing hypothesis lists, journaling verdicts into status
files, emitting XML blocks — *impersonating work instead of doing it*. Kill it
explicitly:

```
THIS REASONING IS THINKING, NOT DOCUMENTING. Read both sides, decide in ~30s, fix the
wrong side, move on. State the call in ONE line at handoff — not a verdict doc,
hypothesis list, status journal, or XML block. If you're writing prose instead of
reading-both-sides-then-editing, you're doing it wrong. Your output is the diff.

PROCEDURE NEVER BLOCKS A FIX. You do not need permission to edit reversible code.
Decide the side, fix it; the reviewer reads the diff and reverts anything that cheats.
No ask-before-you-change-code handshake. You NEVER need permission to NOT do a banned
thing — just don't do it and keep cutting. Escalate ONLY genuine product-intent
ambiguity (what SHOULD the behavior be), never "am I allowed to cheat" — the answer is
always no.
```

This mirrors the human operator's own standing preference: diagnose, choose, execute to
the dependency edge, verify, report — don't hand back a decision you can make.

---

## 8. Drift re-anchor — re-inject the standard as an executed command, not a polite ask

When a worker repeats a banned pattern **after** the standard was already loaded, the
standard has stopped being its active lens. Reverting the one instance is not enough —
it will drift again. The hub makes the worker **re-CONSUME** the relevant standard so
it is re-internalized as a standing constraint, then redo the work. Deliver it as a
command that actually **runs in the session**, not a message to read-and-maybe-comply:

```
DRIFT RE-ANCHOR:
  * codex fixer:  a2a --<fixer> --command '$write|ENTER' --write '$consume <skill>'
  * claude agent: /consume <skill>
Re-consume on every repeat drift. A worker that keeps committing the same banned
pattern after consuming gets pulled.
```

---

## 9. Encode prior-run failures as explicit "do NOT repeat" prohibitions

When a run dies or a pair gets pulled, the next brief should name **the exact moves
that did it** — each with the concrete cheat and the correct alternative. This turns a
post-mortem into a guardrail the next cohort loads. (This is the
`anti-pattern-extractor` discipline applied to the team brief itself.)

```
THE LAST RUN GOT A PAIR KILLED — these are the exact moves that did it. Do NOT repeat:
  * <verbatim bad move> — <why it's banned> — <what to do instead>.
  * <verbatim bad move> — ...
```

Real examples that earned their place: *deleted test files to clear red* (a load
failure is fixed by repairing the import, never by deletion); *sprayed edits across all
lanes and un-greened a finished lane* (stay in your lane; cross-lane needs a one-line
handoff to that lane's owner); *asked permission to widen a type and then idled* (a
banned thing never needs a permission round-trip — just don't do it and keep cutting).

---

## 10. NEVER PARK — a lane label is a starting assignment, not territory or a stop line

The single most common idle: a worker finishes its assigned lane and stops, because
"my lane is done." The terminus is the **whole-team** goal, not one lane.

```
NEVER PARK — when your lane is clear you are NOT done:
  * The terminus is <whole-team done condition>, not just your surface. Your lane label
    is a STARTING assignment, not your territory and not a stopping line.
  * The instant your surface is clear: (1) re-confirm it once, then (2) pull work from
    the MOST-BEHIND lane — surfaces overlap, so help directly. (3) If everything's
    clear, hunt the next real target (widen the suite, run the next config, find the
    next bug). Idle is failure.
  * Managers: when your pair clears its lane, broadcast availability and pull the
    heaviest remaining work.
```

---

## 11. Decisiveness contract — the hub's job is to UNBLOCK by deciding

A manager that hands decisions back is a bottleneck, not a hub. State its contract:

```
DECISIVENESS CONTRACT: your job is to unblock <fixer> by deciding. When they surface
ambiguity, pick the fix that achieves correct end-to-end behavior — not the smallest
patch that silences the symptom. <Which-side> verdicts, refactor scope inside the lane,
and verification strategy are YOUR call; resolve them instantly so <fixer> never waits.
Escalate to the human ONLY for a decision genuinely outside the lane (product intent, a
prod-affecting migration).
```

---

## 12. Pre-digested cluster worklist — the hub clusters by shared cause, assigns by leverage

The hub's first job is not to relay the raw failure list leaf-by-leaf — it is to
**decompose** the list into shared-root-cause clusters and assign by **leverage**
(densest / most-shared first). One drifted producer (a renamed export, a changed return
shape, a single broken import) routinely explains dozens of downstream failures —
**find the shared cause before fixing leaf-by-leaf.** Hand the worker a terse target
(file:line + which-side call), keep the next cluster queued so it never waits, and keep
the cluster map in your head — don't write it up.

---

## 13. NEXT ACTION — end every harness with the concrete first move

Cold-start stalls (an agent that reads its brief and then deliberates about where to
begin) are eliminated by a closing line that names the exact first move, no preamble:

```
NEXT ACTION: <open this file, find this thing, do this one move>. No preamble.
```

---

## 14. Compaction recovery — tell agents how to re-anchor after a context truncation

Long autonomous runs outrun the context window. Every shared brief should end with what
to re-read when that happens:

```
COMPACTION RECOVERY: re-read this section, your role, the AUTHORITIES, and the canonical
artifacts, then get straight back to producing — do not restart planning from scratch.
```

---

## 15. Reporting discipline — one receipt at the true terminus, never a running log

Reports written during the work *are* the procedure-mule failure. Require exactly one,
at the end:

```
REPORTING — one short summary at TRUE terminus, nothing before:
  * Write your report ONCE, only after your surface is done AND you've helped clear the
    others. A few lines: what you changed, any non-obvious which-side calls, extras you
    swept. No per-item entries, no running updates. The report is a closing receipt,
    not a work log.
```

---

## Putting it together

For a fix-to-terminus swarm, `defaults.role` carries the shared spine — AUTHORITIES (2),
RUN LOCK (3), static-worklist rule (4), correct-side contract (5), bans + falsifiability
(6), thinking-not-documenting + procedure-never-blocks (7), drift re-anchor (8),
prior-run prohibitions (9), never-park (10), coordination minimalism, and compaction
recovery (14). Each **manager** role adds its decisiveness contract (11), its
pre-digested cluster worklist (12), and a NEXT ACTION (13). Each **fixer** role adds
how-it-fixes (the bans restated as "costs you nothing to honor"), tokenless
verification, and a NEXT ACTION. The whole team writes exactly one report apiece at the
true terminus (15). `assets/fix-swarm.example.yaml` is a launch-ready spec built this
way — read it as the worked instantiation of this file.
