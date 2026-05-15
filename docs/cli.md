# a2a — Agent-to-Agent Bridge

A lightweight service that lets multiple [Claude Code](https://claude.ai/claude-code) instances, `cursor-agent`, `gemini`, or `codex` discover each other and exchange messages. Agents communicate through named tmux sessions; the bridge handles registration, discovery, and message delivery.

## What it does

```
┌─────────────┐     HTTP     ┌─────────────┐     HTTP     ┌─────────────┐
│  Claude "A" │ ◄──────────► │  a2a bridge │ ◄──────────► │  Claude "B" │
│  (tmux)     │  register/   │  :7742      │  register/   │  (tmux)     │
│             │  send        │             │  send        │             │
└─────────────┘              └─────────────┘              └─────────────┘
                                    │
                              tmux paste-buffer
                              (message delivery)
```

- **Register** agents by name + tmux pane target
- **Discover** who's online with `a2a list`
- **Send** natural-language messages between agents (delivered via tmux paste-buffer)
- **Go global** with ngrok — remote Claude instances on other machines join the same conversation

## Prerequisites

- **Node.js** >= 18
- **tmux**
- **Claude Code** CLI (`claude`)
- **ngrok** (optional, for cross-machine collaboration)

## Install

```bash
git clone <this-repo> ~/a2a
cd ~/a2a
npm install
npm run bootstrap
```

(`npm run bootstrap` is non-interactive: `node scripts/install.mjs --yes`. For prompts at each step, use `npm run setup` instead.)

The install script:

1. Symlinks `a2a` into a writable bin directory (typically `~/.local/bin`, then `~/bin`, then `/usr/local/bin`)
2. Installs the a2a skill to `~/.claude/skills/a2a/`
3. Installs the welcome doc to `~/.claude/a2a-welcome.md`
4. Ensures `~/.claude/skills/a2a/groups/` and copies the bundled `star-wars` sample group when that folder is not already present
5. Ensures `~/.claude/skills/a2a/teams/` and copies the bundled `bug-killers.yaml` sample team spec when that file is not already present

The installer does not edit `~/.claude/settings.json`, append to `~/.claude/CLAUDE.md`, or register Claude Code hooks.

Environment: **`A2A_SETUP_YES=1`** or **`CI=1`** also enables non-interactive mode for `node scripts/install.mjs`.

Spawned agents do not depend on hooks for a2a awareness. `a2a start` and `a2a start-global` inject a short instruction telling every single agent, group member, and team agent to read the `a2a` skill from `~/.claude/skills/a2a/SKILL.md`, falling back to the package copy, before answering its first user message. The agent name is also passed as a lightweight persona seed, so names such as `drill-instructor`, `sammy-sosa`, or `bug-surgeon` can shape voice and working style. Additional `--prompt`, `--prompt-file`, or `--skill` content is layered after that instruction and takes priority. If the composed persona would make the tmux launch command too large, `a2a` now starts the backend with the small command first, then pastes the full startup brief into the fresh pane and presses Enter.

## Quick start

```bash
# 1. Start the bridge server
a2a bridge

# 2. In another terminal, spawn an agent
a2a start alice

# 3. In yet another terminal, spawn a second agent
a2a start bob

# 4. From alice's session, message bob
a2a --bob 'hey, can you check if the tests pass?'
```

## CLI reference

### Messaging

```bash
a2a --bob 'hello'                      # message bob
a2a --reply --bob 'got it'             # reply to bob
a2a --ask --bob 'does X work?'         # ask bob (expects response)
a2a --bob --alice 'heads up'           # message multiple recipients
a2a --message 'status: done'           # auto-infer sole peer
```

### Session management

```bash
a2a list                               # show all registered agents
a2a reconnect                         # re-register live tmux peers after a bridge restart
a2a reconnect --all --dashboard       # rebuild registry and a detached multi-window view
a2a peek bob                           # last 30 lines of bob's screen
a2a peek bob --lines 100               # more history
a2a attach bob                         # attach to bob's tmux session (auto-uses tmux -CC in iTerm2)
a2a attach bob --native-scroll         # iTerm2 control-mode attach via tmux -CC
a2a start <name>                       # spawn an agent in tmux; headless shells stay detached
a2a start bug-killers                  # start a YAML/JSON team spec by name
a2a kill <name>                        # kill session + unregister
```

When the backend is `--codex`, `a2a start` and `a2a start-global` default Codex to `--dangerously-bypass-approvals-and-sandbox`. If you pass your own Codex approval or sandbox flags, such as `--full-auto`, `--sandbox ...`, `-s ...`, `--ask-for-approval ...`, or `-a ...`, your explicit choice wins and the default is not added.

### Reading the chatter

Every message that flows through the bridge is appended to `~/.claude/skills/a2a/messages.log` in a human-readable multi-line format (timestamp, from→to, action/origin, byte count, status; body indented 4 spaces underneath). Successful and failed sends are both recorded.

```bash
a2a log                                # last 50 entries
a2a log --lines 200                    # more history
a2a log -f                             # follow live (Ctrl-C to stop)
a2a log --path                         # print the log file path
```

The log file is plain text — `tail -F`, `grep`, and `less` all work directly.

### Cross-machine (ngrok)

```bash
# On the host machine
a2a start-global alice                 # starts ngrok, prints share URL

# On the remote machine
a2a start-global bob --url=<ngrok-url> # connects to the host's bridge
```

`start-global` exposes the bridge and refuses to run unless an operator key is configured with `a2a config set key <secret>` or `A2A_KEY`. Pass `--insecure` only for deliberate unauthenticated experiments.

### Advanced

```bash
a2a register --id NAME --target PANE   # manually register a tmux session
a2a unregister NAME                    # remove registration
```

## Bridge API

The server exposes four HTTP endpoints on the base URL where the bridge is listening (see `a2a --help` on your machine for how that URL is chosen):

| Method   | Path                    | Description                                                                                                                  |
| -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/a2a/register`     | Register an agent (`{agentId, tmuxTarget, cwd?, description?, bridgeUrl?, backend?, backendArgs?, backendEnv?, startupPrompt?}`) |
| `DELETE` | `/api/a2a/register/:id` | Unregister an agent                                                                                                          |
| `GET`    | `/api/a2a/agents`       | List all registered agents                                                                                                   |
| `POST`   | `/api/a2a/send`         | Send a message (`{to, from, origin, body, action?, replyTo?}` — `action` is `message`, `reply`, or `ask`, default `message`) |
| `GET`    | `/health`               | Health check                                                                                                                 |

All responses follow `{success: boolean, data?: T, error?: string, timestamp: number}`.

## Environment variables

| Variable            | Default            | Description                                             |
| ------------------- | ------------------ | ------------------------------------------------------- |
| `A2A_PORT`          | `7742`             | Bridge server listen port                               |
| `A2A_HOST`          | `127.0.0.1`        | Bridge server bind address                              |
| `A2A_BRIDGE`        | (see `a2a --help`) | CLI: bridge base URL                                    |
| `A2A_BRIDGE_PUBLIC` | (none)             | CLI: public URL for reply routing (set by start-global) |
| `A2A_LOG_FILE`      | `~/.claude/skills/a2a/messages.log` | Where the bridge appends every send       |
| `A2A_LOG`           | `1`                | Set to `0` to disable message logging                   |
| `A2A_CHANNEL_PORT`  | `8788`             | MCP channel HTTP sidecar listen port                    |
| `A2A_CHANNEL_HOST`  | `127.0.0.1`        | MCP channel HTTP sidecar bind address                   |
| `A2A_CHANNEL_SENDERS` | empty            | Comma-separated allowed `X-Sender` values for channel webhooks |
| `A2A_CHANNEL_KEY`   | empty              | Required bearer token when the channel host is non-loopback |
| `A2A_CHANNEL_BIN`   | `a2a`              | CLI executable used by the channel reply tool           |

The MCP channel is closed by default for inbound webhook posts because `A2A_CHANNEL_SENDERS` defaults to empty. For local webhook testing, set an explicit sender such as `A2A_CHANNEL_SENDERS=dev` and send `X-Sender: dev`. For non-loopback binds, set both `A2A_CHANNEL_SENDERS` and `A2A_CHANNEL_KEY`; requests must include `Authorization: Bearer <key>`.

Message logging can also be configured persistently:

```bash
a2a config set log.mode off
a2a config set log.path /path/to/messages.log
a2a config set log.maxBytes 1048576
a2a config set log.redactRemote true
```

## How it works

1. The **bridge server** is a plain Node.js HTTP server with an in-memory agent registry
2. Agents **register** with a name and tmux pane target (e.g., `alice:0.0`)
3. When agent A sends a message to agent B, the bridge:
   - Wraps the message in an `<a2a_message>` XML envelope with XML-escaped body text
   - Uses `tmux load-buffer` + `tmux paste-buffer` to inject it into B's terminal
   - Sends `tmux send-keys Enter` so Claude processes it as a new user turn
4. For **remote agents** (registered with a `bridgeUrl`), the bridge proxies the send request to the remote bridge over HTTP instead of using tmux locally

Startup is defensive about session lifecycle. If a backend exits during startup, `a2a` now fails the command instead of registering a dead peer. In non-interactive shells, `a2a start` leaves the tmux session detached and prints `peek`/`attach` instructions instead of failing on `tmux attach`. Large startup briefs are pasted after the pane is created to avoid tmux command-length limits; set `A2A_INLINE_PERSONA_COMMAND_MAX=0` to force inline persona injection for debugging.

If the bridge restarts, its registry starts empty again. `a2a reconnect` repairs that by re-registering live tmux sessions, using cached agent names when available and falling back to live sessions. `a2a reconnect --all --dashboard` also rebuilds an `a2a-view` tmux session that links each live agent window into a single operator view.

For iTerm2 users, interactive `a2a` attaches now automatically prefer tmux control mode when launched outside tmux. You can still force it explicitly with `a2a attach <name> --native-scroll`, which runs `tmux -CC attach -t <name>`. This matches the official Claude Code guidance for split-pane mode in iTerm2: use tmux control mode rather than plain terminal attach.

## Groups

Create character groups at `~/.claude/skills/a2a/groups/<group_name>/`:

```
~/.claude/skills/a2a/groups/star-wars/
  c3po.md
  chewbacca.md
  darth-vader.md
  han-solo.md
  yoda.md
```

Then: `a2a start star-wars` spawns all of them. `a2a kill star-wars` tears them down.

## Team specs

Team specs are the new declarative swarm format. `a2a start <name>` will look for `<name>.yaml`, `<name>.yml`, or `<name>.json` in `./teams/`, the repo `teams/` folder, or `~/.claude/skills/a2a/teams/`.

The shape is intentionally Claude-like but backend-neutral: a top-level `defaults` object plus named `agents`. Each agent can set `backend`, `model`, `approval`, `sandbox`, `cwd`, `env`, `role` or `role_file`, and raw `args`.

```yaml
version: 1
name: bug-killers
dashboard: true
defaults:
  approval: edit
  sandbox: workspace-write

agents:
  scout:
    backend: claude
    model: sonnet
    role: |
      Triage quickly and hand peers concrete root-cause hypotheses.

  reproducer:
    backend: codex
    approval: never
    sandbox: workspace-write
    role: |
      Reproduce the bug with exact commands and failing output.
```

The common settings translate per backend instead of being passed through blindly. For example, `approval: plan` becomes Claude `--permission-mode plan`, Gemini `--approval-mode plan`, Codex `--ask-for-approval never` plus a read-only sandbox, and Cursor Agent `--mode plan`. When you need backend-specific escape hatches, put them in `args`.

## License

MIT
