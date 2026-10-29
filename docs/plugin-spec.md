# a2a plugin

The plugin connects Codex and ChatGPT Work running locally on this Mac to the existing [Dot MCP adapter](../src/a2a-dots.mjs). Its source, operating skill, and specification live in this a2a repository.

## Package

| File | Purpose |
| --- | --- |
| [plugins/a2a/plugin.json](../plugins/a2a/plugin.json) | Plugin identity and presentation. |
| [plugins/a2a/mcp.json](../plugins/a2a/mcp.json) | Streamable HTTP connection to http://127.0.0.1:7743/mcp. |
| [plugins/a2a/skills/coordinate-agents/SKILL.md](../plugins/a2a/skills/coordinate-agents/SKILL.md) | Agent discovery, authorized messaging, replies, and lifecycle instructions. |
| [.agents/plugins/marketplace.json](../.agents/plugins/marketplace.json) | Local marketplace entry resolving ./plugins/a2a from the repository root. |

The package connects to an existing server. It contains no credentials, server copy, routing replacement, startup hook, or browser extension. Runtime configuration and team definitions remain owned by a2a.

## Operations

The adapter's tool surface is list_agents, get_agent, send_message, receive_messages, peek_agent, start_agent, start_team, and stop_agent. Their schemas and handlers are defined in [src/dots/tools.mjs](../src/dots/tools.mjs) and wired by [src/a2a-dots.mjs](../src/a2a-dots.mjs); their operational inputs are listed in the [plugin skill](../plugins/a2a/skills/coordinate-agents/SKILL.md). The existing bridge remains the live agent inventory and delivery owner, as described in [docs/dots.md](dots.md).

All clients using one adapter share its configured Dot identity and inbox. The inbox is bounded; whether it clears on restart depends on the adapter's configuration, and with `A2A_DOTS_EVENTS_KEY` set the retained journal window is restored instead of lost. Sending acknowledges delivery; it does not prove the recipient completed work. The plugin itself introduces neither per-chat identities nor storage: the durability is the adapter's, described in [docs/dots.md](dots.md#automatic-message-events).

Incremental reads use the returned opaque cursor and expose `reset` when the adapter changes and `gap` when messages were evicted. Old numeric cursors cause an explicit reset/replay of retained messages. The shared inbox and message log remain the existing state and audit mechanisms. See [the cursor contract](dots.md#incremental-inbox-reads).

Lifecycle calls use the CLI's narrower modes: `start --require-team` requires a real team spec, `start <agent>` launches exactly the named single agent (with optional backend, prompt, skills, cohort, working directory, and `--no-yolo`), `peek <agent>` reads a registered agent's terminal, and `kill --agent` stops one registered agent without team/group expansion. The adapter owns and recovers its callback registration; duplicate or abandoned owners produce degraded readiness until resolved. HTTP health is 200 only for a confirmed owned route, otherwise 503. This confirms the adapter registration, not worker completion or UI visibility.

## Local setup

Run the updated a2a bridge and Dot adapter from this checkout. For an upgrade, stop the old adapter before replacing the bridge, then start the updated adapter from the repository root:

```sh
npm run dots
```

For an authenticated bridge, provide the existing operator key in the adapter process's A2A_KEY environment variable. Keep it out of manifests and this document. The adapter binds the MCP listener to port 7743 and its separate callback listener to loopback port 7744 by default. See [docs/dots.md](dots.md) for supported environment overrides.

Source changes do not reload running processes or update the installed skill cache. Activating a local upgrade requires replacing both running processes and refreshing the locally installed plugin skill, then opening a new client/chat if its tools were already loaded. This package has no automatic startup or activation hook.

Before restarting the adapter, check whether it runs with `A2A_DOTS_EVENTS_KEY` set. Without it, the restart clears the in-memory inbox, so inspect needed replies first. With it, accepted messages are restored from the durable journal, up to `min(A2A_DOTS_EVENTS_MAX_JOURNAL, A2A_DOTS_MAX_INBOX)`; messages past either bound are not restored and no tool reports that they were dropped. Inbox cursors are still per-process, so a client resuming on an old cursor sees `reset=true` and replays the restored window.

Register and install the repository's local marketplace:

```sh
codex plugin marketplace add /Users/op/Documents/dev/a2a
codex plugin add a2a@a2a-local
```

In the local desktop plugin directory, select a2a Local Plugins and use a2a. A new chat may be needed to load its tools. This localhost connection requires local execution; ChatGPT web or mobile would require a separate reachable MCP connection.

## Verification

Check plugin installation with:

```sh
codex plugin list --marketplace a2a-local --json
```

Verify the existing adapter's focused process tests with:

```sh
npm run test:vitest:dots
```

For a live acceptance check, connect an MCP client to the configured endpoint, initialize it, discover the declared tools, and call list_agents and receive_messages. Live sends, team starts, and agent stops require the corresponding user request and are not setup probes.
