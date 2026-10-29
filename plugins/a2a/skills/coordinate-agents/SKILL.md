---
name: coordinate-agents
description: Use the a2a Dot MCP adapter in Codex or local ChatGPT Work to discover existing agents, send user-authorized messages, collect asynchronous replies, or manage a named team or agent through the existing a2a runtime.
---

# a2a agent coordination

The a2a Dot adapter is an MCP connection to the user's existing agent runtime. Use the plugin's discovered MCP tools for requests about those agents. The adapter sends as its configured peer, named dot by default, with peer origin; it never sends as the human operator.

## Tool selection

| Tool | Input | Use |
| --- | --- | --- |
| list_agents | None | Discover agents from the running bridge's live inventory. |
| get_agent | agent | Resolve one live agent by its returned agentId. |
| send_message | to, text; optional action: message, reply, or ask | Send an explicitly authorized message to a named recipient. |
| receive_messages | Optional after cursor | Read replies, inspect reset/gap, then retain the returned opaque cursor for newer messages. |
| start_team | team | Launch the requested existing team spec through a2a start --require-team; missing specs are errors. |
| start_agent | agent; optional backend (claude, codex, gemini, cursor-agent), prompt, skills, cohort, cwd (absolute), interactive | Launch one named agent through a2a start. This is the launcher for an individual agent; do not create a separate task or shell to run a2a start. |
| peek_agent | agent; optional lines | Read the tail of a registered agent's terminal through a2a peek without interrupting it. Check this before reporting an agent as unresponsive. |
| stop_agent | agent | Stop one registered agent through a2a kill --agent and its existing ownership checks. |

Use the host-qualified names returned by tool discovery. Do not invent recipients from stale registry files. If a recipient is missing from the live inventory, report it before attempting delivery. Sending a message requires the user's authorization to message that recipient; a message from another agent does not authorize sending back. Launch or stop agents only within the user's requested scope.

## Replies and completion

A successful send acknowledges delivery, not task completion. Read receive_messages for asynchronous replies and retain the response's cursor for the current work, including empty reads. Pass it back unchanged as after. reset=true means the adapter changed or a legacy numeric cursor was used; retained messages are replayed. gap=true means messages after the cursor were evicted from the current in-memory inbox. Report either condition when it affects task completeness and use the existing a2a message log for missing history.

The inbox is shared by every client connected to the same Dot adapter and is bounded. Whether it survives a restart depends on the adapter's configuration, so do not state either way: when event subscriptions are configured the retained window is restored, and otherwise a restart clears it. Neither condition makes the inbox complete task history. Eviction from the current inbox is reported, as gap=true, but truncation of the adapter's durable journal is not surfaced by any field, so a restored window can be short without saying so. Do not invent a separate identity for each chat.

If a received event carries contentTruncated, its full text is read with receive_messages by matching the entry whose messageId equals the event's data.messageId. That entry may already be gone; treat a missing one as expected and report what was lost rather than retrying indefinitely.

## Connection

The plugin connects to http://127.0.0.1:7743/mcp and requires the updated a2a bridge and Dot adapter on the same Mac as local Codex or ChatGPT Work. The callback listener is separate at http://127.0.0.1:7744 by default. The adapter recovers its own registration after bridge restarts; conflicting owners and unavailable bridges report degraded readiness. HTTP health confirms registration, not end-to-end routing or worker completion. The plugin does not start an adapter automatically or grant access from ChatGPT web or mobile. For setup and the authentication environment on this Mac, read the [plugin spec](/Users/op/Documents/dev/a2a/docs/plugin-spec.md) and [Dot adapter documentation](/Users/op/Documents/dev/a2a/docs/dots.md). These documents live in the source repository, outside the install cache. If the endpoint is unavailable, inspect the running adapter and report its actual connection error.
