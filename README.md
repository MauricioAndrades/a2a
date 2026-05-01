```text
      _        ___        ___ 
     / \      / _ \      / _ \
    / _ \    | | | |    | | | |
   / ___ \   | |_| |    | |_| |
  /_/   \_\   \___/      \___/

        AGENT  ⇄  AGENT   COMMS
```

# a2a

Agent-to-agent bridge for [Claude Code](https://claude.ai/claude-code): multiple Claude instances in **tmux** register with a small **HTTP bridge**, discover each other, and send messages that arri[...]

This repo also ships an optional **MCP channel** (`a2a-channel`) so CI, webhooks, or scripts can **push text into a running Claude Code session** and optionally call **`a2a`** to message registered[...]

## Repository layout

| Path | Role |
|------|------|
| `bin/a2a` | CLI entrypoint |
| `lib/a2a-server.mjs` | Bridge HTTP server |
| `lib/a2a-config.mjs` | `~/.claude/skills/a2a/` config, PID, groups, teams |
| `lib/a2a-channel.mjs` | Claude Code MCP channel (stdio + local HTTP) |
| `lib/README.md` | Full CLI reference, bridge API, env vars, groups |
| `.mcp.json.example` | Sample MCP config for the channel |
| `groups/` | Sample character groups bundled with the skill |
| `teams/` | Sample YAML team specs bundled with the skill |

## Install (recommended)

From the repo root:

```bash
node lib/install
```

That symlinks `a2a`, installs the skill under `~/.claude/skills/a2a/`, sample groups, hooks, and `CLAUDE.md` snippets. See `lib/README.md` for everything the script does.

**Channel dependencies** (if you use `a2a-channel`):

```bash
cd lib && npm install
```

## Quick start (bridge + agents)

```bash
a2a bridge
a2a start alice
a2a start bob
# in alice’s session:
a2a --bob 'hey, can you check if the tests pass?'
```

When you launch peers with `--codex`, `a2a` now defaults Codex to `--dangerously-bypass-approvals-and-sandbox` unless you explicitly pass your own sandbox or approval flags such as `--full-auto`, [...]

Full messaging syntax, `peek`, `attach`, `start-global`, and the HTTP API are documented in **`lib/README.md`**.

`a2a start <name>` now resolves in three sensible layers: a single agent name, a legacy markdown group, or a YAML/JSON team spec. Team specs let each agent choose its own backend, model, approval [...]

If the bridge restarts and forgets its in-memory registry while the tmux workers are still alive, run `a2a reconnect` to re-register live peers. Add `--all --dashboard` to rebuild a detached multi[...]

If you use iTerm2, `a2a` now automatically prefers tmux control-mode attach for interactive sessions it opens outside tmux, which gives the smoother split-pane experience with native terminal scro[...]

## MCP channel (`a2a-channel`)

The channel is an [MCP](https://modelcontextprotocol.io) server: **Claude Code** spawns it over **stdio** and it listens on **localhost HTTP** for inbound POSTs. Events show up in the session as *[...]

### Requirements (Claude Code)

- Claude Code **v2.1.80+** and [channels](https://code.claude.com/docs/en/channels) as documented by Anthropic.
- **claude.ai login** for that session (channels are not supported for API-key-only / “Claude API” auth in the product docs).
- Team/Enterprise: org admin may need to **enable channels** before anything registers.

Custom servers are not on the default channel allowlist; local testing typically uses:

```bash
claude --dangerously-load-development-channels server:a2a-channel
```

The name after `server:` must match the key under `mcpServers` in `.mcp.json` (here: `a2a-channel`).

### Configure MCP

Copy `.mcp.json.example` to **`.mcp.json`** at the project root (or merge into your user MCP config). Set **`args`** to an **absolute** path to `lib/a2a-channel.mjs` if the config file is not next[...]

### Channel environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `A2A_CHANNEL_PORT` | `8788` | HTTP listen port |
| `A2A_CHANNEL_HOST` | `127.0.0.1` | HTTP bind address |
| `A2A_CHANNEL_SENDERS` | `dev` | Comma-separated values allowed in **`X-Sender`** on POST |
| `A2A_CHANNEL_BIN` | `a2a` | `a2a` executable for the **`reply`** tool |

### Push a test event

With Claude Code running and the channel loaded:

```bash
curl -d "build failed on main" -H "X-Sender: dev" "http://127.0.0.1:${A2A_CHANNEL_PORT:-8788}/"
```

Stream outbound lines (tool mirror, permission relay text, etc.):

```bash
curl -N "http://127.0.0.1:${A2A_CHANNEL_PORT:-8788}/events"
```

### `reply` tool

Claude can call **`reply`** with **`peer`** (registered agent id), **`text`**, and optional **`action`** (`message` | `reply` | `ask`). That runs the local **`a2a`** CLI against the bridge. Sta[...]

### Standalone `npm run channel`

Running **`node lib/a2a-channel.mjs`** (or **`npm run channel`** from `lib/`) without Claude Code still starts **HTTP + SSE** for local testing, but **`notifications/claude/channel`** only reach [...]

## License

MIT
