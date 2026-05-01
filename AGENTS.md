# AGENTS.md — working in this repository

Load this file when you open this project. It tells you what **a2a** is and exactly how to **set up a fresh clone** so you or your user can run the CLI and (when relevant) integrate with Claude Code.

## What this project is

**a2a-bridge** is an agent-to-agent bridge for Claude Code: tmux-hosted Claude (and other backends) register with a small HTTP bridge, discover peers, and exchange messages delivered as `<a2a_message>` envelopes. Optional MCP channel code lives at `src/a2a-channel.mjs`.

Canonical CLI reference: **`docs/cli.md`**. Top-level **`README.md`** is the short product overview.

## Setup you should run (repository root)

Run these from the directory that contains **`package.json`** (the repo root). Use a network-capable shell so `npm install` can fetch packages.

### 1. Dependencies

```bash
npm install
```

Use **`A2A_SILENT_POSTINSTALL=1 npm install`** if you must suppress the short post-install hint (CI or noisy logs).

### 2. Choose one path

**Path A — Full Claude Code integration (skill, hooks, symlinks into a user-writable bin dir, usually `~/.local/bin`):**

```bash
npm run bootstrap
```

This is **`scripts/install.mjs --yes`** (non-interactive). It writes under **`~/.claude/`** (skill, hooks, welcome doc, settings hooks, `CLAUDE.md` snippet). Do **not** run this if the user explicitly forbids touching `~/.claude`.

If `bootstrap` warns that the install bin dir is not on `PATH`, apply the **`export PATH=...`** line it prints (often `~/.local/bin`) and re-run your shell or open a new terminal.

**Path B — CLI only in this workspace (no `~/.claude` changes):**

```bash
npx a2a help
```

Optional global **`a2a` on PATH** without bootstrap:

```bash
npm link
a2a help
```

**Path C — Interactive installer (prompt before each step):**

```bash
npm run setup
```

Use when the user wants to confirm each step manually.

### 3. Smoke check

After Path A or B, confirm the CLI responds:

```bash
npx a2a help
```

If **`bootstrap`** was used and **`~/.local/bin`** (or the printed bin dir) is on `PATH`:

```bash
a2a help
```

## MCP channel (optional)

If the user needs the **`a2a-channel`** MCP server in Claude Code:

- Ensure **`npm install`** has been run (channel depends on `package.json` dependencies).
- Configure MCP so Claude Code runs **`node`** with **`args`** pointing at this repo’s **`src/a2a-channel.mjs`**. The repo’s **`.mcp.json`** uses a relative path; if the MCP config file lives elsewhere, use an **absolute** path to **`src/a2a-channel.mjs`**.
- Requirements and env vars are in **`README.md`** (MCP channel section) and **`docs/cli.md`**.

## Runtime prerequisites (human / machine)

- **Node.js** >= 18 (see **`package.json`** `engines`).
- **tmux** on the machine where agents run (the bridge drives tmux sessions).
- **`claude`** CLI when spawning Claude Code backends (see **`docs/cli.md`**).

The bootstrap script prints a prerequisite summary; treat missing **tmux** as a hard requirement for normal bridge usage.

## What not to do

- Do not tell the user to “run setup yourself” if your environment allows you to run the commands above; **execute** them unless blocked (no network, sandbox forbids `~/.claude`, or explicit user refusal).
- Do not invent paths: CLI entry is **`bin/a2a.mjs`** (wired via **`package.json`** `bin`), implementation under **`src/`**, installer **`scripts/install.mjs`**.
- Avoid editing **`~/.claude/`** unless the user asked for Claude integration or you ran **`npm run bootstrap`** with their consent.

## Quick reference

| Goal | Command |
|------|---------|
| Dependencies | `npm install` |
| Claude skill + hooks + PATH symlinks | `npm run bootstrap` |
| CLI only (no home-dir integration) | `npx a2a help` or `npm link` then `a2a help` |
| Long-form docs | `docs/cli.md` |
