

// Pure flag parser for `a2a start` (and the legacy `a2a start-global` alias).
//
// Lives outside cli.mjs because cli.mjs ends with `main()` at top level —
// importing it for testing would execute the dispatcher. This module mirrors
// the established pattern in src/cli/{session-inventory,reconnect-targets,
// team-agent-args}.mjs.
//
// Parser policy:
//   - Any --flag the parser does not recognize is forwarded to the spawned
//     backend CLI via the returned `backendArgs` array. Unknown values do not
//     throw — that authority belongs to the backend.
//   - `--claude` selects the default Claude backend command. `--claude=PATH`
//     selects Claude while overriding the executable used to launch it. The
//     path never leaks into `backendArgs`.
//   - `--cohort NAME` is an orthogonal tmux-description tag. It does NOT
//     conflict with --team-file: passing both means "load this team spec but
//     tag the spawned sessions as members of cohort NAME". When unset,
//     single-agent spawns get `description = a2a start: <cwd>` (no cohort
//     tag); team/group spawns default to their own name as the cohort.
//   - `--prompt-file PATH` is resolved against `deps.cwd` (default
//     process.cwd()) and read via `deps.readFile` (default fs.readFileSync).
//     The file read happens here because --prompt and --prompt-file merge in
//     source order, so the parser needs the file body inline.
//   - `--global` / `--no-global` are tri-state: when neither is passed the
//     parser returns `global: null` so the caller can fall back to
//     `config.global`. Explicit `--global` returns true; `--no-global`
//     returns false. Both forms are bare booleans (no value).

import { resolve as resolvePath } from "node:path";
import { readFileSync as nodeReadFileSync } from "node:fs";

const BACKEND_FLAGS = new Set(["claude", "gemini", "codex", "cursor-agent"]);

function readRequiredValue(
  args,
  index,
  key,
  eqIdx,
  die,
  { allowFlagLike = false, allowEmpty = false, suffix = "value" } = {},
) {
  const value = eqIdx !== -1 ? args[index].slice(eqIdx + 1) : args[index + 1];
  if (value === undefined || (!allowEmpty && value === "")) {
    die(`--${key} requires a ${suffix}`);
  }
  if (!allowFlagLike && eqIdx === -1 && String(value).startsWith("--")) {
    die(`--${key} requires a ${suffix}`);
  }
  return {
    value,
    nextIndex: eqIdx !== -1 ? index + 1 : index + 2,
  };
}

function rejectValueForBooleanFlag(key, eqIdx, die) {
  if (eqIdx !== -1) die(`--${key} does not take a value`);
}

function consumeUnknownBackendFlag(args, i, arg, eqIdx, backendArgs) {
  backendArgs.push(arg);
  if (eqIdx !== -1) {
    return i + 1;
  }
  const next = args[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    backendArgs.push(next);
    return i + 2;
  }
  return i + 1;
}

function looksLikeCommandPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return (
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("/")
  );
}

function maybeReadClaudeCommand(args, i, eqIdx, die) {
  if (eqIdx !== -1) {
    const value = args[i].slice(eqIdx + 1);
    if (!value) die("--claude requires a path when a value is provided");
    return { value, nextIndex: i + 1 };
  }
  const next = args[i + 1];
  if (
    next !== undefined &&
    !next.startsWith("--") &&
    looksLikeCommandPath(next)
  ) {
    return { value: next, nextIndex: i + 2 };
  }
  return { value: null, nextIndex: i + 1 };
}

/**
 * Parse `a2a start [args...]` argv.
 *
 * Returns:
 *   {
 *     name:        positional NAME or null
 *     backend:     "claude" | "gemini" | "codex" | "cursor-agent"
 *     backendCommand: optional executable override for the selected backend
 *     backendArgs: forwarded argv for the spawned backend CLI
 *     dashboard:   true if --dashboard/--layout was passed, else null
 *     promptText:  merged --prompt / --prompt-file content or null
 *     skills:      array of --skill values (repeatable)
 *     yolo:        true by default; --no-yolo flips to false
 *     teamFile:    explicit --team-file / --team path or null
 *     cohort:      explicit --cohort value (free-form tmux tag) or null
 *     global:      tri-state — true if --global, false if --no-global, null
 *                  when neither flag was passed (caller falls back to config)
 *     url:         remote bridge URL for --global --url mode, or null
 *     port:        local bridge/ngrok port override, or null
 *     insecure:    true iff --insecure was passed
 *   }
 *
 * @param {string[]} args - argv after the `start` subcommand
 * @param {object}   [deps]
 * @param {(msg: string, code?: number) => never} [deps.die] - error sink;
 *        defaults to throwing an Error so callers (and tests) can catch.
 * @param {(absPath: string, encoding: string) => string} [deps.readFile] -
 *        used by --prompt-file. Defaults to fs.readFileSync.
 * @param {string} [deps.cwd] - resolves relative --prompt-file paths.
 *        Defaults to process.cwd().
 */
export function parseStartArgs(args, deps = {}) {
  const die =
    deps.die ||
    ((msg) => {
      throw new Error(msg);
    });
  const readFile = deps.readFile || nodeReadFileSync;
  const cwd = deps.cwd || process.cwd();

  let name = null;
  let backend = "claude";
  let backendCommand = null;
  let dashboard = null;
  let promptText = null;
  let yolo = true; // a2a agents act without user input by default
  let teamFile = null;
  let cohort = null;
  let url = null;
  let port = null;
  let insecure = false;
  /** @type {boolean | null} - tri-state; null means "defer to config.global" */
  let global = null;
  const skills = [];
  const backendArgs = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      backendArgs.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      if (!name) name = arg;
      else backendArgs.push(arg);
      i++;
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    if (key === "user") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      name = read.value;
      i = read.nextIndex;
      continue;
    }
    if (key === "prompt") {
      const read = readRequiredValue(args, i, key, eqIdx, die, {
        allowFlagLike: true,
        allowEmpty: true,
      });
      promptText = (promptText ? `${promptText  }\n\n` : "") + read.value;
      i = read.nextIndex;
      continue;
    }
    if (key === "prompt-file") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      const path = read.value;
      const abs = resolvePath(cwd, path);
      let body;
      try {
        body = readFile(abs, "utf8");
      } catch (err) {
        die(`--prompt-file '${path}': ${err.message}`);
      }
      promptText = (promptText ? `${promptText  }\n\n` : "") + body;
      i = read.nextIndex;
      continue;
    }
    if (key === "skill") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      skills.push(read.value);
      i = read.nextIndex;
      continue;
    }
    if (key === "team-file" || key === "team") {
      const read = readRequiredValue(args, i, key, eqIdx, die, {
        suffix: "path",
      });
      teamFile = read.value;
      i = read.nextIndex;
      continue;
    }
    if (key === "cohort") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      cohort = read.value;
      i = read.nextIndex;
      continue;
    }
    if (key === "url") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      url = read.value;
      i = read.nextIndex;
      continue;
    }
    if (key === "port") {
      const read = readRequiredValue(args, i, key, eqIdx, die);
      const v = read.value;
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
        die(`--port must be an integer between 1 and 65535`);
      }
      port = v;
      i = read.nextIndex;
      continue;
    }
    if (key === "insecure") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      insecure = true;
      i++;
      continue;
    }
    if (key === "layout" || key === "dashboard") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      dashboard = true;
      i++;
      continue;
    }
    if (key === "yolo") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      yolo = true;
      i++;
      continue;
    } // explicit opt-in (already default)
    if (key === "no-yolo") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      yolo = false;
      i++;
      continue;
    } // opt back into interactive prompts
    if (key === "global") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      global = true;
      i++;
      continue;
    } // expose bridge via ngrok and tag the swarm for peer fan-out
    if (key === "no-global") {
      rejectValueForBooleanFlag(key, eqIdx, die);
      global = false;
      i++;
      continue;
    } // override `config set global true` for a one-off local-only start
    if (BACKEND_FLAGS.has(key)) {
      if (key === "claude") {
        const command = maybeReadClaudeCommand(args, i, eqIdx, die);
        backend = key;
        backendCommand = command.value;
        i = command.nextIndex;
        continue;
      }
      rejectValueForBooleanFlag(key, eqIdx, die);
      backend = key;
      backendCommand = null;
      i++;
      continue;
    }
    i = consumeUnknownBackendFlag(args, i, arg, eqIdx, backendArgs);
  }
  return {
    name,
    backend,
    backendCommand,
    backendArgs,
    dashboard,
    promptText,
    skills,
    yolo,
    teamFile,
    cohort,
    global,
    url,
    port,
    insecure,
  };
}

export { BACKEND_FLAGS };
