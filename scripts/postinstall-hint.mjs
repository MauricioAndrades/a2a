#!/usr/bin/env node
import process from "node:process";

if (process.env.A2A_SILENT_POSTINSTALL === "1" || process.env.CI === "1") {
  process.exit(0);
}

process.stdout.write(`
  a2a-bridge installed dependencies.

  Next (pick one):
    npm run bootstrap     Claude skill + hooks + symlinks (non-interactive)
    npm link              put a2a on PATH only (no ~/.claude changes)

  Docs: docs/cli.md
`);
