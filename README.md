# a2a

Agent-to-agent bridge for [Claude Code](https://claude.ai/claude-code): multiple Claude instances in **tmux** register with a small **HTTP bridge**, discover each other, and send messages that arrive as **`<a2a_message>`** envelopes pasted into the peer’s terminal.

This repo also ships an optional **MCP channel** (`a2a-channel`) so CI, webhooks, or scripts can **push text into a running Claude Code session** and optionally call **`a2a`** to message registered peers.

## Install and use

From a clone of this repo:

```bash
cd a2a
npm install
npm run bootstrap
```

`bootstrap` runs the installer **without prompts** (`scripts/install.mjs --yes`): puts `a2a` and `a2a-server` on your PATH (usually `~/.local/bin`), copies the skill into `~/.claude/skills/a2a/`, sample groups/teams, SessionStart hook, and updates `~/.claude/CLAUDE.md`. If that directory is not on your `PATH` yet, the installer prints a line to add to your shell profile.

**Try the CLI immediately (no Claude files touched):**

```bash
npm install
npx a2a help
```

**Global CLI via npm (alternative to bootstrap symlinks):**

```bash
npm install
npm link
a2a help
```

Use **`npm run bootstrap`** when you want the full Claude Code integration; use **`npx a2a`** or **`npm link`** when you only need the `a2a` command on this machine.

Interactive installer (prompts before each step): **`npm run setup`** (same script without `--yes`).

Details: **`docs/cli.md`**.

Silent dependency installs (no post-install hint): **`A2A_SILENT_POSTINSTALL=1 npm install`**.

## Repository layout

| Path | Role |
|------|------|
| `package.json` | npm manifest (`a2a-bridge`), dependencies, `bin` entries |
| `bin/a2a.mjs` | CLI entrypoint (thin wrapper; implementation in `src/`) |
| `src/a2a-server.mjs` | Bridge HTTP server |
| `src/a2a-config.mjs` | `~/.claude/skills/a2a/` config, PID, groups, teams |
| `src/a2a-channel.mjs` | Claude Code MCP channel (stdio + local HTTP) |
| `docs/cli.md` | Full CLI reference, bridge API, env vars, groups |
| `groups/` | Sample character groups bundled with the skill |
| `teams/` | Sample YAML team specs bundled with the skill |

## Quick start (bridge + agents)

```bash
a2a bridge
a2a start alice
a2a start bob
# in alice’s session:
a2a --bob 'hey, can you check if the tests pass?'
```

When you launch peers with `--codex`, `a2a` now defaults Codex to `--dangerously-bypass-approvals-and-sandbox` unless you explicitly pass your own sandbox or approval flags such as `--full-auto`, `--sandbox ...`, or `--ask-for-approval ...`.

Full messaging syntax, `peek`, `attach`, `start-global`, and the HTTP API are documented in **`docs/cli.md`**.

`a2a start <name>` now resolves in three sensible layers: a single agent name, a legacy markdown group, or a YAML/JSON team spec. Team specs let each agent choose its own backend, model, approval mode, sandbox mode, `cwd`, env vars, and raw backend-specific args.

If the bridge restarts and forgets its in-memory registry while the tmux workers are still alive, run `a2a reconnect` to re-register live peers. Add `--all --dashboard` to rebuild a detached multi-window operator view session.

If you use iTerm2, `a2a` now automatically prefers tmux control-mode attach for interactive sessions it opens outside tmux, which gives the smoother split-pane experience with native terminal scrolling. You can still force that path manually with `a2a attach <name> --native-scroll`. This mirrors the `tmux -CC` approach Claude’s official agent-teams docs recommend for iTerm2.

## MCP channel (`a2a-channel`)

The channel is an [MCP](https://modelcontextprotocol.io) server: **Claude Code** spawns it over **stdio** and it listens on **localhost HTTP** for inbound POSTs. Events show up in the session as **`<channel source="a2a-channel" …>`**. The server’s **`instructions`** explain how that relates to the **a2a bridge** and the **`reply`** tool.

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

Create or merge **`.mcp.json`** at the project root (or into your user MCP config). Set **`args`** to an **absolute** path to `src/a2a-channel.mjs` if the config file is not next to this repo.

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

Claude can call **`reply`** with **`peer`** (registered agent id), **`text`**, and optional **`action`** (`message` \| `reply` \| `ask`). That runs the local **`a2a`** CLI against the bridge. Start **`a2a bridge`** and register agents before relying on it.

### Standalone `npm run channel`

Running **`node src/a2a-channel.mjs`** (or **`npm run channel`** from the repo root) without Claude Code still starts **HTTP + SSE** for local testing, but **`notifications/claude/channel`** only reach a model when **Claude Code** spawns the same script via **`.mcp.json`**.

## License

MIT
