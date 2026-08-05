# Topologies — Worked Harness Sets

One worked roster per topology. Each shows the cut, why it clears Stage 0, and the
shape of the harnesses. Adapt; don't copy verbatim.

---

## Orchestrator / star — audit-and-fix

**Cut:** auditing and fixing are distinct concerns with a narrow boundary — the
auditor emits a list, the fixer consumes it. Clears verification-separation (a fixer
can't reliably judge its own fixes) and specialization.

```
orchestrator (opus) — hub: decomposes, relays the issue list, owns the verify loop
scanner       (sonnet, deep-research) — enumerate issues in src/auth/, read-only
surgeon       (sonnet, full-fix)      — fix each listed issue, does not touch tests/
```

Flow: `scanner → orchestrator → surgeon → orchestrator → scanner (verify)`
Integration owner: orchestrator — done when scanner's re-verify finds zero open issues.
Collision guard: only surgeon writes source; scanner is read-only.

---

## Pipeline — research → draft → edit

**Cut:** three sequential stages, each genuinely different expertise. Clears
specialization. No parallelism (latency stacks) — accept that, or this isn't a
pipeline.

```
researcher (sonnet, deep-research) — gather sources, emit a findings file
drafter    (sonnet)                — turn findings into a draft, one coherent voice
editor     (sonnet)                — tighten the draft, fix structure and claims
```

Flow: `researcher → drafter → editor`
Canonical file: each stage writes the artifact the next stage reads.
Risk: a weak early stage poisons everything downstream — give the researcher the
tightest brief.

---

## Adversarial pair — producer + critic

**Cut:** correctness matters more than speed; self-review is unreliable. Clears
verification-separation. The critic must have a *separate* context or it's theater.

```
builder (sonnet, full-fix)       — implement the feature against the spec
critic  (sonnet, bullshit-detector) — red-team the implementation, separate context
```

Flow: `builder → critic → builder (until critic signs off)`
Integration owner: critic owns the sign-off gate; done when the critic finds nothing.

---

## Supervised implementer pairs / racing pairs — fix a surface to a verified terminus

**Cut:** high-volume mechanical work that can cheat its way green (fix every failing
test, drive a type-checker to zero). The adversarial pair verifies at the end; here you
verify at *every edit*. Clears verification-separation at the finest grain. When the
work splits into independent surfaces, run K pairs in parallel — judged on
**completeness, not speed.**

```
alpha-mgr (claude) — judgment: clusters the worklist, reviews every diff, decides
                     correct-side, gates the run-lock; NEVER implements
alpha-fix (codex)  — implementation: cuts fast, fixes the wrong side, never asks
                     permission for reversible edits; output is the diff
beta-mgr  (claude) — same, owning the second surface
beta-fix  (codex)  — same
```

Flow: within a pair `mgr → fix → mgr (reviews diff) → fix`; pairs run in parallel and
share only the run-lock + a one-line cross-lane handoff in the canonical file.
Collision guard: each fixer edits only its own surface; a cross-lane fix is a handoff to
that lane's owner, never a direct edit (one fixer spraying across lanes un-greens a
finished lane — the move that gets a pair pulled).
Integration owner: each manager owns its lane's correct-side review; the team is done
only when *all* surfaces are green and idle pairs have pulled from the most-behind lane.
This roster is built in full at `assets/fix-swarm.example.yaml`; the discipline blocks
(authorities, run-lock, static worklist, correct-side, never-park, drift re-anchor) are
in `references/execution-discipline.md`.

---

## Fan-out / map-reduce — summarize N docs

**Cut:** homogeneous, embarrassingly parallel work. Clears parallelism. The reducer is
mandatory — name it.

```
orchestrator (opus) — shard the docs, assign one shard per worker, hand shards to reducer
worker-1..N  (sonnet) — summarize assigned shard into the canonical file
reducer      (opus)   — merge shard summaries into one coherent synthesis
```

Flow: `orchestrator → worker-1..N → reducer`
Collision guard: each worker writes only its own shard's section.
Integration owner: reducer — done when every shard section is present and merged.

---

## Composed — star with an adversarial seam

A star whose fix step is itself a producer/critic pair. Count the edges: hub→scanner,
hub→builder, builder↔critic, hub→reducer. Still linear at the hub; the only peer edge
is the deliberate builder↔critic adversarial one. Compose freely as long as each
added edge is load-bearing.
