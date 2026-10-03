# ChatGPT Dot MCP adapter

`a2a-dots` makes a ChatGPT Dot a first-class peer in the existing a2a runtime.

## Topology

```text
ChatGPT Dot
    |
    | remote MCP (Streamable HTTP)
    v
a2a-dots
    |
    | authenticated bridge HTTP
    v
a2a-server
    |
    +--> Claude / Codex / Gemini / Cursor agents
    |
    +--> configured peer bridges
```

The adapter does not replace a2a routing, identity, teams, transports, or federation. It registers one ordinary a2a peer (default id `dot`) with a callback `bridgeUrl`. Existing agents therefore reply to `dot` through the same `POST /api/a2a/send` remote-delivery path already used by peer bridges.

## MCP tools

- `list_agents()` reads `GET /api/a2a/agents`; it never reads `registry.json`.
- `get_agent({ agent })` resolves one agent from the bridge's live inventory.
- `send_message({ to, text, action? })` posts directly to `/api/a2a/send` as `from="dot"`, `origin="peer"`, `source="chatgpt-dot"`.
- `receive_messages({ after? })` returns messages delivered to the Dot callback. Every message has a monotonically increasing cursor; pass the last cursor back as `after` for incremental reads.
- `start_team({ team })` delegates to `a2a start <team>`, preserving the existing team resolution and launch contract.
- `stop_agent({ agent })` delegates to `a2a kill <agent>`, preserving existing ownership checks. It refuses to stop the adapter's own peer id.

## Run

Start the normal bridge first, then:

```sh
npm run dots
```

Defaults:

```text
A2A_BRIDGE=http://127.0.0.1:7742
A2A_DOTS_HOST=127.0.0.1
A2A_DOTS_PORT=7743
A2A_DOTS_MCP_PATH=/mcp
A2A_DOTS_AGENT_ID=dot
A2A_DOTS_CALLBACK_URL=http://127.0.0.1:7743
A2A_DOTS_MAX_INBOX=1000
```

If the bridge requires its operator key, set `A2A_KEY`. The adapter uses it for bridge registration, inventory, send, and unregister operations.

The MCP endpoint is:

```text
http://127.0.0.1:7743/mcp
```

ChatGPT connects to remote MCP servers rather than directly to localhost. Keep `a2a-dots` loopback-bound and expose only the MCP listener through OpenAI Secure MCP Tunnel or another trusted HTTPS deployment path. Reply ingress is a separate listener hard-bound to `127.0.0.1` (port `7744` by default), so tunneling the MCP port does not expose `/api/a2a/send`. `A2A_DOTS_CALLBACK_URL` exists for bridge registration overrides, but the callback listener itself intentionally remains loopback-only.

## Identity

The adapter never sends as the human operator. Outbound messages are:

```json
{
  "from": "dot",
  "origin": "peer",
  "source": "chatgpt-dot"
}
```

That intentionally follows the existing fail-closed sender identity model.

## Reply path

No second message bus is introduced.

```text
worker
  -> a2a --reply --dot "done"
  -> a2a-server
  -> dot registration.bridgeUrl
  -> POST /api/a2a/send on a2a-dots
  -> cursor inbox
  -> receive_messages({ after })
  -> Dot
```

The inbox is bounded in memory and is runtime state, not durable evidence. Restarting `a2a-dots` clears it. The existing a2a message log remains the audit trail.

## Tests

```sh
npm run test:vitest:dots
```

The process tests verify that the adapter registers itself with a callback bridge, accepts replies addressed to `dot`, advances the inbox cursor, and rejects messages addressed to another peer.
