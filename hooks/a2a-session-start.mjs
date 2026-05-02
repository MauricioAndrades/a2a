#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME || "";

if (process.env.A2A_SESSION !== "1") process.exit(0);

const candidates = [
  process.env.A2A_WELCOME_FILE,
  "/Users/op/Documents/dev/a2a/src/a2a-welcome.md",
  join(home, ".claude", "a2a-welcome.md"),
  join(home, ".claude", "skills", "a2a", "a2a-welcome.md"),
].filter(Boolean);

let ctx = "";
for (const p of candidates) {
  try {
    if (!existsSync(p)) continue;
    ctx = readFileSync(p, "utf8");
    break;
  } catch {
    // Hook output should not fail session startup.
  }
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ctx,
    },
  }),
);
