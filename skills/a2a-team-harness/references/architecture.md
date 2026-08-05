# Multi-Agent Architecture — Design Theory

This is the *why* behind the seven stages. Read it once to internalize the patterns;
the SKILL.md operationalizes them. Grounded in Anthropic's published multi-agent
research-system engineering and the broader practitioner literature (mid-2025).

## Why a team can beat one agent

A single agent has one context window and runs one line of reasoning at a time. For
work that is broad — many sources to read, many files to touch, many angles to
explore — that single window fills up and the sequential pace becomes the bottleneck.
A team breaks that ceiling by giving each worker its own fresh context window and
running them at once. On Anthropic's internal research eval, the multi-agent setup
outperformed a single top-end agent by 90.2%, and the gain was driven largely by
scaling the total tokens spent exploring the problem in parallel. The framing to
carry: search and exploration are compression problems, and parallel workers
compress different slices of the corpus simultaneously before handing condensed
findings back.

The price is real — a multi-agent run can cost on the order of 15x the tokens of a
single chat turn. So the team is the right call when the task's value justifies broad
parallel exploration, and a single agent is the right call when it doesn't. That is a
*fit* judgment, not a prohibition: size the team to the work (SKILL.md Stage 0).

## The default winning shape: orchestrator-worker

One lead agent plans the approach, decomposes the task, spawns specialized workers,
and integrates what they return. The orchestrator does not do the line work itself —
it plans, dispatches, and reconciles. Workers do not talk to each other; every
decision about what happens next lives in the hub. This keeps coordination linear
(N workers = N edges to the hub, not N² peer edges) and lets the lead hold the whole
picture while each worker stays narrowly focused.

This is the pattern behind Claude's Research feature: a lead agent spins up roughly
3–5 parallel subagents, each with a self-contained brief, then synthesizes. Make it
your default and deviate only when the work demands a pipeline, an adversarial pair,
or a fan-out.

## The decision that matters most: the isolation boundary

For any cut, the question that predicts whether the team works is *what does each
agent need to know about what the others are doing?* The orchestrator-worker bet for
research is "almost nothing" — each subagent gets a task, an output format, and a
fresh context, and never learns the others exist. That ignorance is a feature: it is
what permits true parallelism and keeps the lead's context from drowning in
cross-talk.

The counter-case (Cognition's "Don't Build Multi-Agents") is the same principle from
the other side: when parallel agents make *independent decisions about the same
thing*, their outputs conflict and can't be cleanly merged. Both views agree on the
design rule:

- Cut along seams where decisions are **independent** → parallelize freely.
- Where decisions are **interdependent**, keep the work in one agent or serialize it
  behind one owner.

Finding narrow isolation boundaries is the core craft of swarm design.

## Delegation precision

The most common early failure is vague briefs. Anthropic found that telling a
subagent to "research the semiconductor shortage" led to subagents duplicating each
other's searches and leaving gaps — one explored a 2021 chip crisis while two others
redundantly chased current supply chains. The fix was surgical delegation: every
worker brief carries an explicit objective, an output format, tool/scope guidance,
and clear task boundaries. This is exactly the Stage 4 harness contract — the brief
is where the team's quality is won.

## Scale effort to the task

Agents are poor at judging how much effort a task deserves, so the orchestrator must
be taught to scale the roster and the per-worker budget to query complexity: a simple
fact-find wants one agent and a handful of tool calls; a direct comparison wants a few
subagents; a broad open-ended question wants more. Embedding these heuristics is what
stops a team from spawning fifty workers for a one-line question. This is the
positive form of "don't over-staff" — a sizing rule, not a ban (SKILL.md Stage 0).

## Separation of concerns and verification

Splitting *checking* from *producing* raises quality on high-stakes work. Anthropic
runs a dedicated CitationAgent as a separate pass that walks the finished report and
attaches each claim to its source — a job the producing agent can't do reliably on
its own, because a single agent can't separate "confident" from "correct." Generalize
this: when correctness matters and self-review is unreliable, give verification to an
independent agent with its own context (SKILL.md Stage 2, adversarial pair).

Likewise, keep synthesis single-agent. Even in a read-heavy multi-agent system, the
final write-up is best produced by one agent in one unified pass — collaborative
writing stitches fragments and adds coordination cost for no gain. Parallelize the
reading; centralize the writing.

## External memory and condensed returns

Long tasks outrun the context window. The durable pattern is to persist the plan and
key state to a file (the canonical handoff file in SKILL.md Stage 5) so it survives
context truncation, and to have workers return condensed findings rather than dumping
full transcripts back to the hub. The handoff file is the team's shared memory; a2a
messages are notifications, not the payload.

## Think like your agents

Design briefs by simulating what the agent will actually see at runtime — its inputs,
its tools, the moment it has to decide whether a peer is ready. Most harness bugs are
visible the instant you read the brief as the agent rather than as the author. The
Stage 4 test — "could a competent stranger execute this with no other context?" — is
this principle as a checkable bar.

## Sources

- Anthropic Engineering, "How we built our multi-agent research system" (Jun 2025) —
  orchestrator-worker, 90.2% / ~15x token findings, delegation precision, effort
  scaling, CitationAgent, "think like your agents."
- LangChain, "How and when to build multi-agent systems" (Jun 2025) — parallelize
  reading, centralize writing.
- Cognition, "Don't Build Multi-Agents" — the interdependent-decision failure mode;
  reconciled here as the isolation-boundary rule.
