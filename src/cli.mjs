

import { request as _request } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { URL, fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import {
  isFlagSendArgv,
  isSequenceFlagArgv,
  parseFlagSendArgv,
  parseSequenceFlagArgv,
} from "./a2a-argv.mjs";
import { compileSequence } from "./key-sequence.mjs";
import { deliverSequenceViaActiveProtocol } from "./sequence-delivery.mjs";
import {
  isColonFlagArgv,
  parseColonFlagArgv,
  buildRegistry,
} from "./a2a-tokens.mjs";
import {
  loadTeamSpec,
  mergeTeamArgs,
  resolveExplicitTeamSpecPath,
  resolveTeamSpecPath,
  teamSpecDefaultsToYolo,
} from "./a2a-team-spec.mjs";
import {
  submitKeysForBackend,
} from "./backend-delivery.mjs";
import { shouldReviveAgentInTmux, isAgentSessionAlive } from "./agent-transport.mjs";
import { activeProtocol, deliverViaActiveProtocol } from "./transport-router.mjs";
import { viableItermGuid } from "./transport-select.mjs";
import {
  closeITerm2Session,
  configureITerm2Session,
  deliverITerm2Input,
  focusITerm2Session,
  screenITerm2Session,
  spawnITerm2Window,
} from "./iterm2-delivery.mjs";
import {
  bridgeReachable as probeBridgeReachable,
  invalidateITermSessionCache,
  itermGuidByName,
  itermSessionNameMatches,
  listITermSessionsWithOwnership,
  tmuxSessionAlive as probeTmuxSessionAlive,
} from "./transport-probes.mjs";
import { resolveLiveItermTarget } from "./iterm-agent-resolve.mjs";
import { resolveReconnectTargets as resolveReconnectTargetsPure } from "./cli/reconnect-targets.mjs";
import { resolveItermRestartSession } from "./cli/iterm-restart-plan.mjs";
import {
  buildStatusSnapshot,
  formatHumanStatus,
  formatStatusSegment,
} from "./cli/status-snapshot.mjs";
import {
  buildAttentionStack,
  buildDoctorSnapshot,
  buildItermAttachScript,
  buildLayoutPlan,
  buildPmWorkerSpec,
  buildReloadPlan,
  buildRuntimeEvents,
  dumpTeamSpec,
  formatAttentionStack,
  formatDoctorSnapshot,
  formatLayoutPlan,
  formatReloadPlan,
  formatRuntimeEvents,
} from "./cli/redesign-runtime.mjs";
import {
  translateCommonAgentSettings,
} from "./agent-backend-args.mjs";
import {
  findOwnedItermSessionByName,
} from "./cli/session-inventory.mjs";
import { buildRuntimeSnapshotFromState } from "./runtime/runtime-snapshot.mjs";
import {
  teamAgentEffectiveYolo,
  translateTeamAgentArgs,
} from "./cli/team-agent-args.mjs";
import { parseStartArgs } from "./cli/parse-start-args.mjs";
import { resolveSenderIdentity, selfExclusionId } from "./cli/sender-identity.mjs";
import {
  hasUnescapedGlob,
  expandGlobRecipientSelectors,
} from "./recipient-selectors.mjs";
import {
  activeKey,
  activeUrl,
  bridgeUrl,
  readPid,
  removePid,
  isGroup,
  listGroupNames,
  listGroupMembers,
  loadConfig,
  loadRegistry,
  saveRegistry,
  patchConfig,
  generateKey,
  configGet,
  configSet,
  messageLogPath,
  teamSpecsDir,
  listTeamSpecNames,
  installToken,
  activePort,
} from "./a2a-config.mjs";

const SERVER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "a2a-server.mjs",
);
const DASHBOARD_BUBBLE_TEA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cmd",
  "a2a-dashboard",
);
const DASHBOARD_BUBBLE_TEA_BIN = process.env.A2A_DASHBOARD_BIN || "a2a-dashboard";
const DASHBOARD_TUI_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "cli",
  "dashboard-tui.mjs",
);
const REPO_TEAMS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "teams",
);
const COMPLETIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "completions",
);
const PACKAGE_A2A_SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skill",
  "a2a",
  "SKILL.md",
);
const INSTALLED_A2A_SKILL_PATH = join(
  homedir(),
  ".claude",
  "skills",
  "a2a",
  "SKILL.md",
);

const BACKENDS = { claude: "claude", gemini: "gemini", codex: "codex", "cursor-agent": "cursor-agent", };
const BACKEND_FLAGS = new Set(Object.keys(BACKENDS));
const AUTO_SKILL = "a2a";
const DEFAULT_INLINE_PERSONA_COMMAND_MAX = 1800;
const STARTUP_PASTE_SETTLE_FLOOR_MS = 500;
const STARTUP_PASTE_SETTLE_PER_KB_MS = 60;
const STARTUP_PASTE_SETTLE_CEILING_MS = 1500;
const STARTUP_PASTE_VERIFY_RETRY_DELAY_MS = 200;
const STARTUP_PASTE_MAX_ENTER_RETRIES = 5;
const STARTUP_PASTE_VERIFY =
  process.env.A2A_STARTUP_PASTE_VERIFY !== "0" &&
  process.env.A2A_PASTE_VERIFY !== "0";
const STARTUP_PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #\d+/;
const PEER_REQUEST_TIMEOUT_MS = 5000;
const LOCAL_REQUEST_TIMEOUT_MS = 5000;
const PEER_AGENT_ID_SEPARATOR = "/";
const OUTBOUND_ENVELOPE_RESERVED = new Set([
  "to",
  "from",
  "origin",
  "body",
  "action",
  "replyTo",
]);

const A2A_SKILL_LOAD_PROMPT = [
  "Before answering the first user message in this session, use your file-reading tool to read the a2a skill.",
  `First read ${INSTALLED_A2A_SKILL_PATH}. If that file is unavailable, read ${PACKAGE_A2A_SKILL_PATH}.`,
  "After reading it, acknowledge briefly that the a2a skill is loaded, then answer the user's message.",
  "Follow that skill whenever you receive <a2a> tags or need to send/reply through a2a.",
].join(" ");

function usage(code = 2) {
  process.stderr.write(
    `usage: a2a <command> [args]

messaging
  a2a --bob 'hello'
  a2a --reply --bob 'got it'
  a2a --ask --bob 'does X work?'
  a2a --bob --mike 'heads up'
  a2a --message 'done'
  a2a --write 'broadcast to all'
  a2a '--write:*managers' 'status update?'

  colon syntax
  a2a --ask:bob:leah 'where for lunch?'
  a2a --message:darth --mood=angry 'where is padme'

raw input
  a2a raw --bob '/clear'
  a2a raw --to bob --content '@src/cli.mjs explain this file'
  a2a raw --target '*review*' 'run tests and report failures'
  a2a raw --open --bob '/model sonnet'
  a2a raw --no-submit --bob '@src/cli.mjs'

command sequence (local key/text DSL — see docs/command-dsl.md)
  a2a --bob --command ENTER --write 'hello i just hit enter'
  a2a --bob --command 'ESC|ENTER|/clear|ENTER|$write' --write 'replan'
  a2a --bob --command 'C-c|SLEEP(150)|ENTER'
  a2a --bob --command 'BSPACE*5'
  a2a --bob --command '/model sonnet|ENTER'
  a2a --bob --command '$write|ENTER' --stdin   # read body from stdin
  a2a command --bob --command 'ESC|ENTER'      # explicit subcommand form

bridge
  a2a bridge [start|stop|status]         a2a HTTP bridge (registry + envelope router)
  a2a bridge iterm [start|stop|status|restart|foreground]
                                         iTerm2 Python bridge (required for
                                         iTerm-backed agents under
                                         protocol=iterm)
  a2a bridge all [start|stop|status|restart]
                                         both at once

shell completion
  a2a completion bash > ~/.local/share/bash-completion/completions/a2a
  a2a completion zsh  > "\${fpath[1]}/_a2a"
  # or (zsh / bash 4+ only): source <(a2a completion zsh)

sessions
  a2a start [NAME] [--team-file PATH] [--cohort NAME] [--user NAME] [--prompt TEXT] [--prompt-file PATH] [--skill NAME]...
            [--dashboard] [--no-yolo] [--global|--no-global] [--url URL] [--port PORT] [--insecure]
            [--claude[=PATH]|--gemini|--codex|--cursor-agent] [backend-flags...]
  a2a start-global [NAME] ...   (legacy alias for "a2a start --global ...")

  --team-file PATH     launch a team from an explicit YAML/JSON spec at PATH.
                       PATH may be absolute or relative to the cwd, or a
                       directory containing <dir>/<dir>.yaml, <dir>/team.yaml,
                       or a single spec file. Missing PATH is a hard error
                       (no fallback to single-agent mode). When combined with
                       a positional NAME, NAME overrides the team's runtime
                       name (used for kill / dashboard / bridge tagging);
                       per-agent ids inside the spec are untouched. Cannot be
                       combined with --prompt/--prompt-file/--skill.
                       --team is accepted as an alias.
  --prompt TEXT        persona/system prompt for the spawned CLI session
  --prompt-file PATH   read persona prompt from a file (relative to cwd)
  --skill NAME         append a skill's SKILL.md to the persona prompt; repeatable.
                       resolved from ~/.claude/skills/<name>/SKILL.md, then
                       ./.claude/skills/<name>/SKILL.md
                       Spawned agents are instructed to read the a2a skill automatically.
  --claude[=PATH]      use the Claude backend. With PATH, launch that Claude
                       executable instead of resolving 'claude' from PATH.
  --no-yolo            opt OUT of unattended (yolo) mode. By default a2a spawns
                       every backend with full bypass flags so agents act
                       without user input. Pass --no-yolo to keep approvals
                       and the sandbox active. Per-backend translation:
                       claude --dangerously-skip-permissions; codex
                       --dangerously-bypass-approvals-and-sandbox; cursor-agent
                       --yolo --sandbox disabled --approve-mcps; gemini
                       --approval-mode yolo --skip-trust.
  --global             expose the bridge through ngrok so configured peers can
                       see this swarm via 'a2a list'. Requires
                       'a2a config set key <secret>' unless --insecure is
                       passed. With --url URL, route replies through
                       that remote bridge instead of starting a local tunnel.
  --no-global          override 'a2a config set global true' for a one-off
                       local-only start (no ngrok, no peer exposure).

  a2a list                             include configured peers' swarms
  a2a list --no-peers                  skip peer fan-out (local + tmux only)
  a2a list --json                      machine-readable output incl. peers
  a2a reconnect [NAME] [--all] [--dashboard]
  a2a ui [NAME] [--rebuild]            open the dashboard TUI; attaches if the
                                       view session exists, rebuilds from live
                                       agents otherwise (--rebuild forces it).
  a2a peek [NAME] [--lines=N]
  a2a attach [NAME] [--dashboard]      agent pane; team name or --dashboard opens view
                                       (--rebuild to force dashboard recreate)
  a2a kill [NAME]
  a2a kill --all

log
  a2a log                              show last 50 log entries
  a2a log --lines=N                    show last N entries
  a2a log -f | --follow                tail the log live
  a2a log --path                       print the log file path

status
  a2a status                           local runtime status summary
  a2a status --json                    machine-readable local status snapshot
  a2a status --segment                 compact tmux status segment
  a2a status --peers                   include configured peer bridges
  a2a events [--json] [--peers]        event stream projection from status
  a2a attention [--json] [--peers]     stacked attention queue
  a2a doctor [--json] [--bundle DIR]   diagnostics and support bundle
  a2a reload TEAM [--dry-run] [--json] planned safe team reload
  a2a layout TEAM [--json]             validate/preview nested team layout
  a2a iterm NAME [--print]             open native-scroll attach in iTerm2
  a2a pm NAME [--workers N] [--write]  generate a PM/worker team spec

auth
  a2a auth add --<peer> --url <url> --key <key>
  a2a auth list
  a2a auth revoke --<peer>

config
  a2a config ls
  a2a config get <key>
  a2a config set <key> <value>

  keys: port, host, url, key, global, log.mode, log.path, log.maxBytes, log.redactRemote

  a2a gen-key

advanced
  a2a register --id ID --target TARGET [--desc TEXT]
  a2a unregister [ID]
`,
  );
  process.exit(code);
}

function die(msg, code = 2) {
  process.stderr.write(`a2a: ${msg}\n`);
  process.exit(code);
}
function info(msg) {
  process.stderr.write(`a2a: ${msg}\n`);
}

function transportForUrl(url) {
  if (url.protocol === "https:") return httpsRequest;
  if (url.protocol === "http:") return _request;
  throw new Error(`unsupported URL protocol: ${url.protocol}`);
}

function requestPort(url) {
  return url.port || (url.protocol === "https:" ? 443 : 80);
}

function joinedUrlPath(base, pathname) {
  const prefix = base.pathname.replace(/\/+$/, "");
  const suffix = String(pathname || "/").startsWith("/")
    ? String(pathname || "/")
    : `/${pathname}`;
  return `${prefix}${suffix}${base.search || ""}`;
}

function sanitizeEnvelopeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return out;
  for (const [key, value] of Object.entries(meta)) {
    if (OUTBOUND_ENVELOPE_RESERVED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function uniqueAgentsById(agents) {
  const out = [];
  const seen = new Set();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || typeof agent.agentId !== "string") continue;
    if (seen.has(agent.agentId)) continue;
    seen.add(agent.agentId);
    out.push(agent);
  }
  return out;
}

function requestOnce(method, pathname, body) {
  return new Promise((fulfill, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const KEY = activeKey();
    let base;
    try {
      base = new URL(bridgeUrl());
    } catch {
      done(reject, new Error(`invalid bridge URL: ${bridgeUrl()}`));
      return;
    }
    const payload =
      body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    let transport;
    try {
      transport = transportForUrl(base);
    } catch (err) {
      done(reject, err);
      return;
    }
    const req = transport(
      {
        method,
        hostname: base.hostname,
        port: requestPort(base),
        path: joinedUrlPath(base, pathname),
        timeout: LOCAL_REQUEST_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            done(fulfill, {
              status: res.statusCode || 0,
              body: raw ? JSON.parse(raw) : null,
            });
          } catch {
            done(
              reject,
              new Error(`non-JSON (${res.statusCode}): ${raw.slice(0, 200)}`),
            );
          }
        });
      },
    );
    req.on("error", (err) => done(reject, err));
    req.on("timeout", () => {
      done(reject, new Error(`timed out after ${LOCAL_REQUEST_TIMEOUT_MS}ms`));
      req.destroy();
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureBridgeRunning() {
  if (await bridgeHealthy()) return;
  const stale = readPid();
  if (stale && pidLooksLikeBridge(stale)) {
    try {
      process.kill(stale, "SIGTERM");
      spawnSync("sleep", ["0.5"]);
    } catch {
      /* best effort */
    }
  }
  const KEY = activeKey();
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...(KEY ? { A2A_KEY: KEY } : {}) },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((fulfill) => setTimeout(fulfill, 250));
    if (await bridgeHealthy()) return;
  }
  throw new Error("bridge failed to start within 5s");
}

async function request(method, pathname, body, opts = {}) {
  try {
    return await requestOnce(method, pathname, body);
  } catch (err) {
    if (opts.autoStartBridge !== false && err?.code === "ECONNREFUSED") {
      await ensureBridgeRunning();
      return await requestOnce(method, pathname, body);
    }
    if (err?.code === "ECONNREFUSED") {
      throw new Error(
        `connection refused at ${bridgeUrl()} -- bridge auto-start failed`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Issue an HTTP request to a configured peer's bridge URL using that peer's
 * bearer key from config.json. Mirrors `request()` but targets a remote
 * ngrok-exposed bridge rather than the local bridge.
 *
 * Resolves with { status, body } on any non-network error (including 4xx/5xx)
 * so the caller can render error rows. Rejects only when the connection
 * itself fails or the response body isn't JSON.
 *
 * @param {string} method  HTTP method (GET, POST, DELETE).
 * @param {string} peerUrl Peer's bridge URL, e.g. "https://dylan.ngrok-free.dev".
 * @param {string|null} peerKey Bearer token the peer authorized us with.
 * @param {string} pathname API path beginning with "/".
 * @param {*} [body] Optional JSON body for POST/PUT.
 * @returns {Promise<{ status: number, body: any }>}
 */
function peerRequest(method, peerUrl, peerKey, pathname, body) {
  return new Promise((fulfill, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let base;
    try {
      base = new URL(peerUrl);
    } catch {
      done(reject, new Error(`invalid peer URL: ${peerUrl}`));
      return;
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      done(reject, new Error(`peer URL must be http(s): ${peerUrl}`));
      return;
    }
    const isHttps = base.protocol === "https:";
    // Defer requiring the https transport to call time so the import stays
    // colocated with the only branch that needs it.
    const transport = isHttps ? httpsRequest : _request;
    const payload =
      body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = transport(
      {
        method,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: joinedUrlPath(base, pathname),
        timeout: PEER_REQUEST_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...(peerKey ? { Authorization: `Bearer ${peerKey}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            done(fulfill, {
              status: res.statusCode || 0,
              body: raw ? JSON.parse(raw) : null,
            });
          } catch {
            done(
              reject,
              new Error(`non-JSON (${res.statusCode}): ${raw.slice(0, 200)}`),
            );
          }
        });
      },
    );
    req.on("timeout", () => {
      done(reject, new Error(`timed out after ${PEER_REQUEST_TIMEOUT_MS}ms`));
      req.destroy();
    });
    req.on("error", (err) => done(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseArgs(args, flagSpec) {
  const flags = {},
    kv = {},
    positional = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
      const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[i + 1];
      // Object.hasOwn, not `in`: flagSpec is a plain-object lookup table and
      // `in` walks the prototype chain (`--toString` would pass as known).
      if (flagSpec && !Object.hasOwn(flagSpec, key))
        die(`unknown flag --${key}`);
      if (
        val === undefined ||
        val === "" ||
        (eqIdx === -1 && String(val).startsWith("--"))
      )
        die(`--${key} requires a value`);
      flags[key] = val;
      i += eqIdx !== -1 ? 1 : 2;
      continue;
    }
    const kvm = arg.match(/^([a-zA-Z]+):(.*)$/);
    if (kvm && ["from", "to", "origin"].includes(kvm[1])) {
      kv[kvm[1]] = kvm[2];
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  return { flags, kv, positional };
}

function parseAuthArgs(args, knownValueFlags = new Set()) {
  let peer = null;
  const flags = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") break;
    if (!arg.startsWith("--")) {
      die(`unexpected positional argument '${arg}'`);
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    if (knownValueFlags.has(key)) {
      const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[i + 1];
      if (!val || val.startsWith("--")) die(`--${key} requires a value`);
      flags[key] = val;
      i += eqIdx !== -1 ? 1 : 2;
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) die(`invalid peer name '${key}'`);
    if (peer) die(`multiple peer names: '${peer}' and '${key}'`);
    peer = key;
    i++;
  }
  return { peer, flags };
}

function requireBinary(name) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
    die(`invalid binary name '${name}'`, 3);
  }
  const r = spawnSync(
    "sh",
    ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  if (r.status !== 0)
    die(`${name} not found in PATH`, 3);
}

function isCommandPath(command) {
  return (
    command === "~" ||
    command.startsWith("~/") ||
    command.startsWith("./") ||
    command.startsWith("../") ||
    command.startsWith("/") ||
    command.includes("/")
  );
}

function expandTildeCommand(command) {
  if (command === "~") return homedir();
  if (command.startsWith("~/")) return join(homedir(), command.slice(2));
  return command;
}

function normalizeBackendCommand(command, cwd = process.cwd()) {
  if (command == null || command === "") return null;
  const expanded = expandTildeCommand(String(command));
  if (!isCommandPath(expanded)) return expanded;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function defaultBackendCommand(backend) {
  return BACKENDS[backend] || "claude";
}

function backendCommandOverrideFor(backend, opts = {}) {
  if (opts.backendCommands && Object.hasOwn(opts.backendCommands, backend)) {
    return opts.backendCommands[backend] || null;
  }
  return opts.backendCommand || null;
}

function resolvedBackendCommand(backend, opts = {}) {
  return (
    backendCommandOverrideFor(backend, opts) || defaultBackendCommand(backend)
  );
}

function requireExecutableCommand(command) {
  if (!isCommandPath(command)) {
    requireBinary(command);
    return;
  }
  try {
    const stat = statSync(command);
    if (!stat.isFile()) {
      die(`${command} is not an executable file`, 3);
    }
    accessSync(command, constants.X_OK);
  } catch {
    die(`${command} is not found or not executable`, 3);
  }
}

function requireBackendCommand(backend, opts = {}) {
  requireExecutableCommand(resolvedBackendCommand(backend, opts));
}

function backendCommandPayload(backendCommand) {
  return backendCommand ? { backendCommand } : {};
}

function tmux(args, opts = {}) {
  if (opts.inherit)
    return spawnSync("tmux", args, { encoding: "utf8", stdio: "inherit" });
  return spawnSync("tmux", args, {
    encoding: "utf8",
    input: opts.input,
    stdio:
      opts.input == null
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
  });
}

function tmuxSessionExists(id) {
  return tmux(["has-session", "-t", id]).status === 0;
}
// @a2a-install-token: per-install marker pinned on every a2a-spawned tmux
// session so orphan-detection can prove the session came from this install
// before nuking it. Without the marker, `a2a kill --all` would only have the
// (stale-prone) registry.json cache to distinguish a2a sessions from
// unrelated user tmux sessions that happen to share a name.
const A2A_INSTALL_TOKEN_OPTION = "@a2a-install-token";
function emptyTmuxSessionOwnership() {
  return { sessions: [], ownedSessionIds: new Set(), tokenBySession: new Map() };
}
function tmuxListSessionOwnership(expectedToken = null) {
  const r = tmux([
    "list-sessions",
    "-F",
    `#{session_name}\t#{${A2A_INSTALL_TOKEN_OPTION}}`,
  ]);
  if (r.status !== 0) return emptyTmuxSessionOwnership();
  const ownership = emptyTmuxSessionOwnership();
  for (const rawLine of (r.stdout || "").split("\n")) {
    if (!rawLine.trim()) continue;
    const sep = rawLine.indexOf("\t");
    const id = (sep === -1 ? rawLine : rawLine.slice(0, sep)).trim();
    if (!id) continue;
    const token = sep === -1 ? "" : rawLine.slice(sep + 1).trim();
    ownership.sessions.push(id);
    if (token) ownership.tokenBySession.set(id, token);
    if (expectedToken && token === expectedToken) {
      ownership.ownedSessionIds.add(id);
    }
  }
  return ownership;
}
function tmuxListSessions() {
  return tmuxListSessionOwnership().sessions;
}
// window_id is tmux's global window identifier (e.g. `@5`). It is stable
// across sessions: link-window keeps the same id in every session referencing
// it. We use it to nuke a pane's process even when the source session is
// already gone but a *-view dashboard still holds a link.
function tmuxWindowIdOf(target) {
  const r = tmux(["display-message", "-p", "-t", target, "#{window_id}"]);
  if (r.status !== 0) return null;
  const id = (r.stdout || "").trim();
  return id || null;
}
function tmuxWindowIdsInSession(target) {
  if (!target || !tmuxSessionExists(target)) return [];
  const r = tmux(["list-windows", "-t", target, "-F", "#{window_id}"]);
  if (r.status !== 0) return [];
  return [
    ...new Set(
      (r.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
function tmuxWindowIdByName(name, expectedToken) {
  if (typeof name !== "string" || name.length === 0 || !expectedToken) {
    return null;
  }
  const r = tmux([
    "list-windows",
    "-a",
    "-F",
    `#{window_id}\t#{session_name}\t#{window_name}\t#{${A2A_INSTALL_TOKEN_OPTION}}`,
  ]);
  if (r.status !== 0) return null;
  const matches = new Set();
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [id, sessionName, windowName, windowInstallToken] = parts;
    if (!id || !sessionName || windowName !== name) continue;
    if (windowInstallToken !== expectedToken) continue;
    matches.add(id.trim());
  }
  return matches.size === 1 ? [...matches][0] : null;
}
function tmuxWindowExists(windowId) {
  if (!windowId) return false;
  const r = tmux(["list-windows", "-a", "-F", "#{window_id}"]);
  if (r.status !== 0) return false;
  return (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .includes(windowId);
}
function tmuxKillSession(target) {
  if (!tmuxSessionExists(target)) return { skipped: true };
  const r = tmux(["kill-session", "-t", target]);
  return { ok: r.status === 0, stderr: (r.stderr || "").trim() };
}
function tmuxKillSessionDeep(target) {
  const windowIds = tmuxWindowIdsInSession(target);
  const result = tmuxKillSession(target);
  for (const windowId of windowIds) {
    if (!tmuxWindowExists(windowId)) continue;
    const r = tmux(["kill-window", "-t", windowId]);
    if (r.status !== 0)
      return {
        ok: false,
        stderr: (r.stderr || "").trim() || "kill-window failed",
      };
  }
  return result;
}
function tmuxSetInstallToken(target, token) {
  if (!token) return { ok: true, skipped: true };
  // `-q` suppresses "no current session" warning; `set-option -t name`
  // pins the value at session scope so child windows inherit nothing —
  // we only need to prove ownership of the session itself.
  const r = tmux([
    "set-option",
    "-t",
    target,
    "-q",
    A2A_INSTALL_TOKEN_OPTION,
    token,
  ]);
  return { ok: r.status === 0, stderr: (r.stderr || "").trim() };
}
function tmuxPanePath(id) {
  const r = tmux(["display-message", "-p", "-t", id, "#{pane_current_path}"]);
  return r.status === 0
    ? (r.stdout || "").trim() || process.cwd()
    : process.cwd();
}
function hasInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
function isIterm2() {
  return (process.env.TERM_PROGRAM || "").toLowerCase() === "iterm.app";
}
function isDashboardSession(id) {
  return Boolean(id) && (id === "a2a-view" || id.endsWith("-view"));
}

function attachTmuxSession(target, opts = {}) {
  const wantNativeScroll = opts.nativeScroll ?? !process.env.TMUX;
  if (wantNativeScroll) {
    if (process.env.TMUX)
      die(
        "native scroll attach must be launched outside an existing tmux session",
      );
    tmux(["-CC", "attach", "-t", target], { inherit: true });
    return;
  }
  tmux(["attach", "-t", target], { inherit: true });
}

function switchTmuxClient(target) {
  const r = tmux(["switch-client", "-t", target], { inherit: true });
  if (r.status !== 0) die(`failed to switch tmux client to '${target}'`, 1);
}

function currentTmuxSession() {
  if (!process.env.TMUX) return null;
  const r = tmux(["display-message", "-p", "#S"]);
  return r.status === 0 ? (r.stdout || "").trim() || null : null;
}

function sanitizeId(raw) {
  return (
    (raw || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "agent"
  );
}

function validateAgentId(id) {
  if (!id) die("agent name is required");
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    die(`agent name '${id}' must match [A-Za-z0-9_-]+`);
}

function normalizeDeclaredAgentId(raw, fallback, label) {
  const source = raw == null || raw === "" ? fallback : raw;
  const value = String(source);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    die(`${label} '${value}' must match [A-Za-z0-9_-]+`);
  }
  return value;
}

function normalizePeerUrlForConfig(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    die("--url must be a valid http:// or https:// URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    die("--url must be a valid http:// or https:// URL");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function validateSkillName(name) {
  if (
    typeof name !== "string" ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    die(`skill '${name}' must be a single safe path segment`, 1);
  }
}

function validateTmuxTarget(target) {
  if (typeof target !== "string" || target.trim() === "") {
    die("target must be a non-empty tmux target");
  }
  if (/[\r\n\0]/.test(target)) {
    die("target must not contain control characters");
  }
}

function maskSecret(value) {
  const s = String(value || "");
  if (s.length <= 8) return "********";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function assertUniqueIds(ids, label) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) die(`${label} contains duplicate agent id '${id}'`);
    seen.add(id);
  }
}

function shellQuote(arg) {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_\-./:=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function validateEnvMap(env) {
  if (env == null) return {};
  if (typeof env !== "object" || Array.isArray(env))
    die("team env must be an object");
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      die(`invalid env key '${key}' in team spec`);
    out[key] = value == null ? "" : String(value);
  }
  return out;
}

function buildEnvExports(env) {
  const vars = validateEnvMap(env);
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(" ");
}

function agentEnv(agentId, env = {}) {
  return { ...env, A2A_AGENT_ID: agentId };
}

/**
 * Session-scoped env markers inherited from a PARENT agent session. They
 * describe the parent, not the agent being launched, so they must not leak
 * into the child:
 *
 * - CLAUDE_TUI_FIX_ACTIVE: the claude-tui-fix wrapper exits 127 ("refusing
 *   to recursively launch") when it sees this set, so any agent spawned from
 *   inside a wrapped claude session dies during startup.
 * - CLAUDECODE / CLAUDE_CODE_*: stale parent-session identity; a fresh
 *   backend sets its own.
 */
const STALE_PARENT_SESSION_ENV_VARS = [
  "CLAUDE_TUI_FIX_ACTIVE",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
];

function buildAgentLaunchCommand(backend, backendArgs, opts = {}) {
  const cli = resolvedBackendCommand(backend, opts);
  const quoted = [cli, ...backendArgs].map(shellQuote).join(" ");
  const exports = buildEnvExports(opts.env);
  const unsets = `unset ${STALE_PARENT_SESSION_ENV_VARS.join(" ")};`;
  return `${unsets} export A2A_SESSION=1; ${exports ? `${exports} ` : ""}if command -v caffeinate >/dev/null 2>&1; then exec caffeinate -i -t 3600 ${quoted}; else exec ${quoted}; fi`;
}

/**
 * Spawn a new agent session using the active protocol preference. iTerm is
 * picked when the protocol setting is `iterm` AND the bridge is reachable;
 * otherwise the spawn falls back to tmux. The fall-back is transparent so a
 * user who set `protocol=iterm` but hasn't started the bridge yet still gets
 * a working agent (just in tmux).
 *
 * Returns the registry-shaped target on success:
 *   { ok: true, transport: 'tmux',  tmuxTarget: 'name:0.0' }
 *   { ok: true, transport: 'iterm', itermGuid: '<guid>',  tmuxTarget: null }
 *
 * @param {object} opts
 * @param {string} opts.name           Agent id.
 * @param {string} opts.cwd            Working directory.
 * @param {string} opts.command        Shell pipeline (output of buildAgentLaunchCommand).
 * @param {string} [opts.backend]      Used for error messages only.
 * @returns {Promise<{ok:boolean,transport:"tmux"|"iterm",tmuxTarget?:string,itermGuid?:string,error?:string}>}
 */
async function spawnAgentInPlace({
  name,
  cwd,
  command,
  backend = "",
  parentItermGuid,
}) {
  const preference = activeProtocol();
  if (preference === "iterm" && (await probeBridgeReachable())) {
    // Make sure we aren't doubling up — if an iTerm session is already named
    // `name`, surface the existing guid rather than launching a duplicate.
    const existingGuid = await itermGuidByName(name);
    if (existingGuid) {
      info(`iterm session '${name}' already exists, reusing`);
      await configureITerm2Session({ guid: existingGuid, nativeScroll: true });
      invalidateITermSessionCache();
      return { ok: true, transport: "iterm", itermGuid: existingGuid };
    }
    // First agent of a team opens a new window; siblings open as tabs in
    // that window via parent_guid. The user's complaint: each agent
    // spawning into its own window made teams unmanageable.
    const result = await spawnITerm2Window({
      name,
      cwd,
      command,
      installToken: installToken(),
      where: parentItermGuid ? "tab" : "window",
      parentGuid: parentItermGuid,
    });
    if (result.ok) {
      // Disable wheel-as-arrows so scrolling the spawned iTerm window
      // scrolls iTerm's buffer instead of driving Claude Code's input
      // cursor through prior commands. Best-effort: a config-set failure
      // doesn't abort the spawn.
      await configureITerm2Session({
        guid: result.guid,
        nativeScroll: true,
      });
      return { ok: true, transport: "iterm", itermGuid: result.guid };
    }
    invalidateITermSessionCache();
    // Bridge replied but the spawn op failed — likely a stale bridge running
    // pre-op_spawn code. Tell the user exactly which command fixes it; fall
    // back to tmux so they still get a working agent in the meantime.
    info(
      `iterm spawn failed (${result.error || "unknown"}); falling back to tmux. Run: a2a bridge iterm restart`,
    );
  } else if (preference === "iterm") {
    // Constraint 6: never silent. Tell the user the exact fix command, then
    // gracefully fall through to tmux so the work still proceeds.
    info(
      "protocol=iterm but bridge unreachable; spawning via tmux. Run: a2a bridge iterm start",
    );
  }
  // tmux path
  const r = tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-n",
    name,
    "-c",
    cwd,
    command,
  ]);
  if (r.status !== 0) {
    return {
      ok: false,
      transport: "tmux",
      error: `tmux new-session for '${name}' (${backend || "?"}) failed: ${(r.stderr || "").trim() || "unknown"}`,
    };
  }
  return { ok: true, transport: "tmux", tmuxTarget: `${name}:0.0` };
}

/**
 * Probe whether a name is "already alive" under the active protocol — used by
 * the spawn idempotency check. For tmux, this is `tmuxSessionExists`. For
 * iTerm, this is "an iTerm session named `name` exists" via the bridge.
 *
 * Returns { alive, transport, itermGuid? }.
 *
 * @param {string} name
 * @returns {Promise<{alive:boolean, transport:"tmux"|"iterm"|null, itermGuid?:string, tmuxTarget?:string}>}
 */
async function probeAgentAlive(name) {
  if (await probeBridgeReachable()) {
    if (activeProtocol() === "iterm") {
      const guid = await itermGuidByName(name);
      if (guid) {
        return {
          alive: true,
          transport: "iterm",
          itermGuid: guid,
        };
      }
    } else {
      // protocol=tmux: only adopt an iTerm session when it is provably ours
      // (install-token match), mirroring spawnAgentInPlace's gating. A bare
      // name collision with an unrelated user iTerm window must not hijack
      // the agent onto the wrong surface.
      let sessions = [];
      try {
        sessions = await listITermSessionsWithOwnership();
      } catch {
        /* bridge flaked between probes; fall through to tmux */
      }
      const owned = findOwnedItermSessionByName(
        sessions,
        name,
        installToken(),
      );
      if (owned) {
        return { alive: true, transport: "iterm", itermGuid: owned.guid };
      }
    }
  }
  if (tmuxSessionExists(name)) {
    return { alive: true, transport: "tmux", tmuxTarget: `${name}:0.0` };
  }
  return { alive: false, transport: null };
}

function agentSessionAlive(agent) {
  return isAgentSessionAlive(agent, {
    bridgeReachable: probeBridgeReachable,
    listITermSessions: listITermSessionsWithOwnership,
    itermSessionNameMatches,
    tmuxSessionAlive: probeTmuxSessionAlive,
  });
}

/**
 * Paste a startup prompt into a freshly-spawned agent, picking the transport
 * by registry shape. Returns { ok, error? }.
 *
 * @param {object} opts
 * @param {string} [opts.tmuxTarget]
 * @param {string} [opts.itermGuid]
 * @param {string} opts.content
 * @param {string} [opts.backend]
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function pasteStartupPromptToAgent({
  tmuxTarget,
  itermGuid,
  content,
  backend = "",
}) {
  if (itermGuid) {
    const r = await deliverITerm2Input({
      target: itermGuid,
      content,
      backend,
      submit: true,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (tmuxTarget) {
    return pasteStartupPrompt(tmuxTarget, content, { backend });
  }
  return { ok: false, error: "no tmuxTarget or itermGuid given" };
}

/**
 * Apply yolo to single-session/group backend argv by routing them through the
 * canonical translator with `yolo: true`. yolo is the default; pass false
 * (via `--no-yolo`) to opt out and leave backendArgs untouched. a2a agents
 * are expected to act without user input.
 */
function applyCliYolo(backend, backendArgs, yolo, agentId) {
  if (!yolo) return backendArgs;
  try {
    return translateCommonAgentSettings({
      id: agentId,
      backend,
      yolo: true,
      args: backendArgs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`agent '${agentId}': ${msg}`, 1);
    return backendArgs; // unreachable — die() exits; satisfies consistent-return
  }
}

function parseNonNegativeIntegerEnv(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

function inlinePersonaCommandMax() {
  return parseNonNegativeIntegerEnv(
    process.env.A2A_INLINE_PERSONA_COMMAND_MAX,
    DEFAULT_INLINE_PERSONA_COMMAND_MAX,
  );
}

/**
 * Read a skill's SKILL.md body. User-global (~/.claude/skills/<name>/SKILL.md)
 * is searched first, then project-local (./.claude/skills/<name>/SKILL.md).
 * Dies with a clear message if neither exists.
 */
function readSkillBody(name) {
  validateSkillName(name);
  const userPath = join(homedir(), ".claude", "skills", name, "SKILL.md");
  const projectPath = join(
    process.cwd(),
    ".claude",
    "skills",
    name,
    "SKILL.md",
  );
  try {
    return { body: readFileSync(userPath, "utf8"), path: userPath };
  } catch {
    /* fall through */
  }
  try {
    return { body: readFileSync(projectPath, "utf8"), path: projectPath };
  } catch {
    /* fall through */
  }
  die(`skill '${name}' not found at ${userPath} or ${projectPath}`, 1);
  return undefined; // unreachable — die() exits; satisfies consistent-return
}

/**
 * Compose a single persona text block from an agent name, inline prompt, and
 * skill list. Skills are appended after the prompt as `## Skill: <name>`
 * sections. A compact instruction to read the a2a skill is always prepended.
 */
function composePersona(agentName, promptText, skills) {
  const parts = [
    `## Skill: ${AUTO_SKILL}\n\n${A2A_SKILL_LOAD_PROMPT}`,
    `## Agent Name\n\nYour a2a agent name is ${agentName}. Let this name inform your personality, voice, and working style. Keep the persona lightweight and useful; explicit prompts, group files, team roles, and user instructions take priority.`,
  ];
  if (promptText && promptText.trim()) parts.push(promptText.trim());
  for (const name of skills) {
    if (name === AUTO_SKILL) continue;
    const { body } = readSkillBody(name);
    parts.push(`## Skill: ${name}\n\n${body.trim()}`);
  }
  return parts.join("\n\n");
}

function describePersona(promptText, skills) {
  const bits = [AUTO_SKILL];
  if (promptText) bits.push(`prompt (${promptText.length} chars)`);
  if (skills.length) bits.push(`skills: ${skills.join(", ")}`);
  return bits.join("; ");
}

/**
 * Inject a persona text block into backendArgs in the form each backend CLI
 * expects:
 *   - claude:       --append-system-prompt <text>  (layered on top of Claude
 *                   Code's default system prompt; tools/MCP/hooks intact)
 *   - gemini:       --prompt-interactive <wrapped> (no system-prompt flag;
 *                   wrapped with adoption preamble so the seeded user message
 *                   reads as a persona instruction)
 *   - codex:        trailing [PROMPT] positional, wrapped (no system-prompt
 *                   flag; codex treats the positional as the initial user
 *                   message)
 *   - cursor-agent: trailing [prompt...] positional, wrapped (same reason as
 *                   codex)
 *
 * If `personaText` is empty, backendArgs is returned unchanged.
 */
function applyPersonaToBackendArgs(backend, backendArgs, personaText) {
  if (!personaText) return backendArgs;
  const wrapped = `You are operating with the following persona and skills for this entire session. Adopt them now and maintain them for every response.\n\n${personaText}`;
  switch (backend) {
    case "claude":
      return [...backendArgs, "--append-system-prompt", personaText];
    case "gemini":
      return [...backendArgs, "--prompt-interactive", wrapped];
    case "codex":
    case "cursor-agent":
      return [...backendArgs, wrapped];
    default:
      return backendArgs;
  }
}

function buildPersonaStartupMessage(personaText) {
  return `You are starting an a2a agent session. Treat the following text as your startup persona, skills, and task brief for this entire session. Adopt it now, then begin the requested work.\n\n${personaText}`;
}

function preparePersonaDelivery(backend, backendArgs, personaText, opts = {}) {
  const inlineArgs = applyPersonaToBackendArgs(
    backend,
    backendArgs,
    personaText,
  );
  if (!personaText)
    return { backendArgs: inlineArgs, startupPrompt: null, deferred: false };

  const max = inlinePersonaCommandMax();
  if (max <= 0)
    return { backendArgs: inlineArgs, startupPrompt: null, deferred: false };

  const inlineCommand = buildAgentLaunchCommand(backend, inlineArgs, {
    env: opts.env || {},
    backendCommand: opts.backendCommand || null,
  });
  if (inlineCommand.length <= max)
    return { backendArgs: inlineArgs, startupPrompt: null, deferred: false };

  return {
    backendArgs,
    startupPrompt: buildPersonaStartupMessage(personaText),
    deferred: true,
  };
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function computeStartupPasteSettleMs(byteLength) {
  const kib = byteLength <= 0 ? 0 : Math.ceil(byteLength / 1024);
  const scaled =
    STARTUP_PASTE_SETTLE_FLOOR_MS + kib * STARTUP_PASTE_SETTLE_PER_KB_MS;
  return Math.max(0, Math.min(STARTUP_PASTE_SETTLE_CEILING_MS, scaled));
}

function startupPastePlaceholderStillPresent(target) {
  const r = tmux(["capture-pane", "-t", target, "-p", "-S", "-10"]);
  if (r.status !== 0) return false;
  return STARTUP_PASTE_PLACEHOLDER_PATTERN.test(r.stdout || "");
}

function pasteStartupPrompt(target, content, opts = {}) {
  const buf = `a2a-start-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const load = tmux(["load-buffer", "-b", buf, "-"], { input: content });
  if (load.status !== 0)
    return {
      ok: false,
      error: `tmux load-buffer failed: ${(load.stderr || "").trim() || "unknown"}`,
    };

  const paste = tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
  if (paste.status !== 0) {
    tmux(["delete-buffer", "-b", buf]);
    return {
      ok: false,
      error: `tmux paste-buffer failed: ${(paste.stderr || "").trim() || "unknown"}`,
    };
  }

  sleepSync(computeStartupPasteSettleMs(Buffer.byteLength(content, "utf8")));
  const submitKeys = submitKeysForBackend(opts.backend);
  let submitted = false;
  for (let attempt = 0; attempt < Math.max(1, STARTUP_PASTE_MAX_ENTER_RETRIES); attempt++) {
    const enter = tmux(["send-keys", "-t", target, ...submitKeys]);
    if (enter.status !== 0)
      return {
        ok: false,
        error: `tmux send-keys failed: ${(enter.stderr || "").trim() || "unknown"}`,
      };

    if (!STARTUP_PASTE_VERIFY) return { ok: true };

    const delay = Math.floor(
      STARTUP_PASTE_VERIFY_RETRY_DELAY_MS * 1.5**attempt,
    );
    sleepSync(delay);
    if (!startupPastePlaceholderStillPresent(target)) {
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    return {
      ok: true,
      warning: "tmux paste submit could not be verified; leaving session alive",
    };
  }
  return { ok: true };
}

function sessionStartupError(name, backend) {
  return `${backend} session '${name}' exited during startup`;
}

function ensureSessionSurvivedStart(name, backend) {
  if (!tmuxSessionExists(name)) die(sessionStartupError(name, backend), 1);
}

function explainDetachedStart(name) {
  info(
    `'${name}' is running in tmux; this shell is not interactive, so auto-attach was skipped`,
  );
  info(`  peek:   a2a peek ${name}`);
  info(`  attach: a2a attach ${name}`);
}

function inferCohortDescription(agentId) {
  for (const groupName of listGroupNames()) {
    if (listGroupMembers(groupName).some((m) => m.name === agentId))
      return `group:${groupName}`;
  }
  return "";
}

function expandGroupRecipientSelectors(selectors) {
  const out = [];
  for (const selector of selectors) {
    if (!isGroup(selector)) {
      out.push(selector);
      continue;
    }
    const members = listGroupMembers(selector).map((m) => m.name);
    if (members.length === 0) {
      die(`group '${selector}' has no members`, 1);
    }
    out.push(...members);
  }
  return [...new Set(out)];
}

// parseStartArgs is imported from ./cli/parse-start-args.mjs (pure, testable).
// The dispatcher in this module supplies a die() that exits the process and
// uses fs/readFileSync via the default; tests pass injected versions.
function parseStartArgsForCli(args) {
  return parseStartArgs(args, { die, cwd: process.cwd() });
}

function resolveTeamRef(ref, launchCwd = process.cwd()) {
  if (!ref) return null;
  return resolveTeamSpecPath(
    ref,
    launchCwd,
    REPO_TEAMS_DIR,
    teamSpecsDir(),
  );
}

function loadRoleText(baseDir, roleFile) {
  const path = resolve(baseDir, String(roleFile));
  return readFileSync(path, "utf8").trim();
}

function combinedRolePrompt(defaults, raw, baseDir, agentId) {
  if (raw.role != null && raw.role_file != null)
    die(`agent '${agentId}' cannot set both role and role_file`);
  if (defaults.role != null && defaults.role_file != null)
    die(`team defaults cannot set both role and role_file`);

  const parts = [];
  if (defaults.role_file != null)
    parts.push(loadRoleText(baseDir, String(defaults.role_file)));
  else if (defaults.role != null) parts.push(String(defaults.role).trim());

  if (raw.role_file != null)
    parts.push(loadRoleText(baseDir, String(raw.role_file)));
  else if (raw.role != null) parts.push(String(raw.role).trim());

  return parts.filter(Boolean).join("\n\n");
}

function normalizeTeamAgent(
  id,
  raw,
  defaults,
  baseDir,
  launchCwd,
  schemaYoloDefault,
) {
  if (typeof raw !== "object" || raw == null || Array.isArray(raw))
    die(`team agent '${id}' must be an object`);
  let args;
  try {
    args = mergeTeamArgs(defaults, raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`team agent '${id}': ${msg}`);
  }
  const merged = {
    ...defaults,
    ...raw,
    env: { ...(defaults.env || {}), ...(raw.env || {}) },
    args,
  };
  const agentId = normalizeDeclaredAgentId(raw.id, id, "team agent id");
  const backend = String(merged.backend || "claude");
  if (!BACKEND_FLAGS.has(backend))
    die(`agent '${agentId}' uses unsupported backend '${backend}'`);
  const rolePrompt = combinedRolePrompt(defaults, raw, baseDir, agentId);
  // yolo resolution order: explicit per-agent → explicit team default →
  // schema-version gate. Explicit booleans (true or false) always win,
  // even false against schema_version >= 2.
  let yolo;
  if (typeof raw.yolo === "boolean") yolo = raw.yolo;
  else if (typeof defaults.yolo === "boolean") yolo = defaults.yolo;
  else yolo = schemaYoloDefault === true;
  return {
    id: agentId,
    backend,
    // Agent cwd may legitimately live outside the launch directory (e.g.
    // running a2a from one repo while pointing agents at sibling repos).
    // Resolve relative paths against launchCwd but allow absolute escapes.
    cwd: merged.cwd ? resolve(launchCwd, String(merged.cwd)) : launchCwd,
    env: merged.env || {},
    model: merged.model == null ? null : String(merged.model),
    approval: merged.approval == null ? "default" : String(merged.approval),
    sandbox: merged.sandbox == null ? "default" : String(merged.sandbox),
    yolo,
    rolePrompt,
    args: Array.isArray(merged.args) ? merged.args : [],
  };
}

function normalizeTeamSpec(ref, specPath, rawSpec, launchCwd) {
  const defaults = rawSpec.defaults || {};
  if (defaults && (typeof defaults !== "object" || Array.isArray(defaults)))
    die(`team spec '${ref}' has invalid defaults`);
  const sourceAgents = rawSpec.agents;
  if (!sourceAgents || typeof sourceAgents !== "object")
    die(`team spec '${ref}' must define agents`);
  const entries = Array.isArray(sourceAgents)
    ? sourceAgents.map((agent, idx) => [agent?.id || `agent-${idx + 1}`, agent])
    : Object.entries(sourceAgents);
  const baseDir = dirname(specPath);
  const schemaYoloDefault = teamSpecDefaultsToYolo(rawSpec);
  const agents = entries.map(([id, agent]) =>
    normalizeTeamAgent(
      id,
      agent,
      defaults,
      baseDir,
      launchCwd,
      schemaYoloDefault,
    ),
  );
  if (agents.length === 0) die(`team spec '${ref}' has no agents`);
  assertUniqueIds(
    agents.map((agent) => agent.id),
    `team spec '${ref}'`,
  );
  const name = normalizeDeclaredAgentId(
    rawSpec.name,
    basename(specPath).replace(/\.(json|ya?ml)$/i, ""),
    "team name",
  );
  return {
    name,
    path: specPath,
    description: rawSpec.description ? String(rawSpec.description) : "",
    dashboard: rawSpec.dashboard === true,
    agents,
  };
}

function loadResolvedTeamSpec(ref, launchCwd) {
  const specPath = resolveTeamRef(ref, launchCwd);
  if (!specPath) return null;
  return normalizeTeamSpec(ref, specPath, loadTeamSpec(specPath), launchCwd);
}

/**
 * Load a team spec from a user-supplied `--team-file` path. Unlike
 * `loadResolvedTeamSpec`, a missing file is a hard error — the user named
 * an exact file, so we must not silently fall through to single-agent mode
 * or to the discovery search dirs.
 *
 * If `nameOverride` is provided (the optional positional NAME on
 * `a2a start NAME --team-file=...`), it replaces the team's runtime name
 * (used for tmux session naming on the dashboard view, the kill target,
 * and the bridge `description` tag) while leaving per-agent ids untouched.
 */
function loadTeamSpecFromFile(teamFile, launchCwd, nameOverride) {
  let specPath;
  try {
    specPath = resolveExplicitTeamSpecPath(teamFile, launchCwd);
  } catch (err) {
    die(err.message, 1);
  }
  if (!specPath)
    die(
      `--team-file '${teamFile}' not found (looked relative to ${launchCwd})`,
    );
  const spec = normalizeTeamSpec(
    teamFile,
    specPath,
    loadTeamSpec(specPath),
    launchCwd,
  );
  if (nameOverride) {
    spec.name = normalizeDeclaredAgentId(
      nameOverride,
      nameOverride,
      "team name override",
    );
  }
  return spec;
}

function ngrokTunnelMatchesPort(tunnel, expectedPort) {
  if (tunnel.proto !== "https") return false;
  if (expectedPort == null) return true;
  const raw = String(tunnel.config?.addr || "").replace(/\/+$/, "");
  if (raw === expectedPort) return true;
  if (raw.endsWith(`:${expectedPort}`)) return true;
  try {
    return new URL(raw).port === expectedPort;
  } catch {
    return false;
  }
}

function getNgrokUrl(port = null) {
  return new Promise((fulfill, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = _request(
      {
        hostname: "localhost",
        port: 4040,
        path: "/api/tunnels",
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const tunnels =
              JSON.parse(Buffer.concat(chunks).toString()).tunnels || [];
            const expected = port == null ? null : String(port);
            const tunnel = tunnels.find((t) =>
              ngrokTunnelMatchesPort(t, expected),
            );
            if (tunnel) {
              done(fulfill, tunnel.public_url);
            } else {
              done(
                reject,
                new Error(
                  expected
                    ? `no https tunnel found for port ${expected}`
                    : "no https tunnel found",
                ),
              );
            }
          } catch {
            done(reject, new Error("failed to parse ngrok response"));
          }
        });
      },
    );
    req.on("timeout", () => {
      done(reject, new Error("ngrok API timed out"));
      req.destroy();
    });
    req.on("error", (err) =>
      done(reject, new Error(`ngrok unreachable: ${err.message}`)),
    );
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startNgrok(port) {
  return new Promise((fulfill, reject) => {
    const proc = spawn("ngrok", ["http", String(port)], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      // The child is detached and unref'd, but its piped stderr stream keeps
      // flowing and holds the event loop open, so `a2a start --global` never
      // exits while ngrok lives. Once the outcome is decided, drop the
      // listener and destroy the stream; ngrok itself keeps running.
      proc.stderr?.removeAllListeners("data");
      proc.stderr?.destroy();
      fn(value);
    };
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) =>
      done(reject, new Error(`failed to spawn ngrok: ${err.message}`)),
    );
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        done(
          reject,
          new Error(
            `ngrok exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    proc.unref();
    const start = Date.now();
    (async () => {
      while (Date.now() - start < 10000) {
        await sleep(500);
        try {
          await getNgrokUrl(port);
          done(fulfill);
          return;
        } catch {
          /* not ready */
        }
      }
      done(
        reject,
        new Error(
          `ngrok did not start within 10s${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    })().catch((err) => done(reject, err));
  });
}

async function listAgents() {
  const { status, body } = await request("GET", "/api/a2a/agents");
  if (status !== 200 || !body?.success)
    throw new Error(`list failed: ${body?.error || `HTTP ${status}`}`);
  return body.data?.agents || [];
}

/**
 * Resolve the existing membership of a cohort tag against the live bridge.
 *
 * A "cohort" is the free-form string written into an agent's bridge
 * `description` field by `--cohort NAME` (always prefixed `team:`) or by a
 * group/team spawn (`team:<name>` or `group:<name>`). This helper looks up
 * both prefixes so joining `--cohort foo` into a group-started cohort works
 * symmetrically with joining a team-started one.
 *
 * Returns:
 *   {
 *     cohort:  string,
 *     kind:    "team" | "group",          // matches existing membership
 *     members: AgentSnapshot[],           // currently registered members
 *     isJoin:  boolean                    // true iff members.length > 0
 *   }
 *
 * When both team: and group: prefixes have members for the same cohort name
 * (shouldn't happen in practice, but possible if an operator manually
 * registered both), team: wins because `--cohort` itself defaults to team:.
 *
 * Never throws: a missing or unreachable bridge collapses to an empty seed
 * result so callers can render the "starting new cohort" branch.
 *
 * @param {string} cohort
 * @returns {Promise<{ cohort: string, kind: "team" | "group", members: any[], isJoin: boolean }>}
 */
async function resolveCohortJoin(cohort) {
  /** @type {any[]} */
  let agents = [];
  try {
    agents = await listAgents();
  } catch {
    // Bridge unreachable — caller will surface its own register error
    // when the spawn tries to POST. Treat as a seed.
  }
  const teamMembers = agents.filter((a) => a.description === `team:${cohort}`);
  const groupMembers = agents.filter(
    (a) => a.description === `group:${cohort}`,
  );
  if (teamMembers.length > 0) {
    return { cohort, kind: "team", members: teamMembers, isJoin: true };
  }
  if (groupMembers.length > 0) {
    return { cohort, kind: "group", members: groupMembers, isJoin: true };
  }
  return { cohort, kind: "team", members: [], isJoin: false };
}

/**
 * Linked-window dashboard session name convention. Both `startTeam` and
 * `startGroup` build their dashboards as `<cohort>-view`; joiners use the
 * same name to attach to the existing layout.
 *
 * @param {string} cohort
 * @returns {string}
 */
function cohortViewSession(cohort) {
  return `${cohort}-view`;
}

/**
 * Link a freshly-spawned single agent's window into the cohort's existing
 * dashboard view session if one exists. Silent no-op when no dashboard is
 * running. Failures are surfaced as warnings, not errors — the agent is
 * already registered and usable; missing dashboard linkage is a UX issue,
 * not a correctness one.
 *
 * @param {string} agentName
 * @param {string} cohort
 */
function joinCohortDashboard(agentName, cohort) {
  const view = cohortViewSession(cohort);
  if (!tmuxSessionExists(view)) return;
  const r = tmux(["link-window", "-s", `${agentName}:0`, "-t", `${view}:`]);
  if (r.status === 0) {
    info(`  linked into dashboard '${view}'`);
  } else {
    info(
      `  warning: could not link into dashboard '${view}': ${(r.stderr || "").trim() || "unknown"}`,
    );
  }
}

/**
 * Fetch the agent registry from a single configured peer's bridge.
 *
 * Returns the resolved snapshot in a uniform shape regardless of success or
 * failure so the caller can render an error row without crashing the list.
 * Never throws: a missing url/key, network error, auth failure, or non-200
 * response all turn into `{ error: ... , agents: [] }`.
 *
 * @param {string} peerName Local name for the peer (e.g. "dylan").
 * @param {{ url?: string, key?: string }} peerCfg Entry from config.peers.
 * @returns {Promise<{ peer: string, url: string|null, agents: any[], error: string|null }>}
 */
async function listPeerAgents(peerName, peerCfg) {
  const url =
    typeof peerCfg?.url === "string" && peerCfg.url
      ? peerCfg.url.replace(/\/$/, "")
      : null;
  const key = typeof peerCfg?.key === "string" ? peerCfg.key : null;
  if (!url) {
    return {
      peer: peerName,
      url: null,
      agents: [],
      error: "peer is missing 'url' in config",
    };
  }
  if (!key) {
    return {
      peer: peerName,
      url,
      agents: [],
      error: "peer is missing 'key' in config",
    };
  }
  try {
    const { status, body } = await peerRequest(
      "GET",
      url,
      key,
      "/api/a2a/agents",
    );
    if (status === 401 || status === 403) {
      return {
        peer: peerName,
        url,
        agents: [],
        error: `unauthorized (HTTP ${status}) -- check that the key matches what '${peerName}' added on their side as peers.<you>.key`,
      };
    }
    if (status !== 200 || !body?.success) {
      return {
        peer: peerName,
        url,
        agents: [],
        error: `peer responded HTTP ${status}: ${body?.error || "unknown"}`,
      };
    }
    const agents = uniqueAgentsById(body.data?.agents);
    return { peer: peerName, url, agents, error: null };
  } catch (err) {
    return {
      peer: peerName,
      url,
      agents: [],
      error: `unreachable: ${err.message || String(err)}`,
    };
  }
}

/**
 * Fan out to every peer in `config.peers` in parallel. Order of the returned
 * array follows insertion order in config.json so the rendered list is stable.
 *
 * @returns {Promise<Array<{ peer: string, url: string|null, agents: any[], error: string|null }>>}
 */
function gatherPeerAgents() {
  const peers = loadConfig().peers || {};
  const entries = Object.entries(peers);
  if (entries.length === 0) return Promise.resolve([]);
  return Promise.all(entries.map(([name, p]) => listPeerAgents(name, p)));
}

function inferPeer(agents, selfId) {
  const others = agents.filter((a) => a.agentId !== selfId);
  if (others.length === 0)
    return {
      error: "no peers registered -- use 'a2a start <n>' to create one",
    };
  if (others.length === 1) return { peer: others[0] };
  return {
    error: `multiple peers (${others.map((a) => a.agentId).join(", ")}) -- specify one`,
  };
}

async function getRegistry() {
  // Constraint 6: heal orphans before validating recipients. After a bridge
  // restart the in-memory registry is empty until reconnect re-registers
  // owned tmux + iTerm sessions; without this, `a2a --bob 'hi'` returned
  // "unknown flag --bob" because the parser checked the post-restart-empty
  // registry before the send pipeline got a chance to reconnect.
  try {
    await reconnectOwnedTmuxAgents();
  } catch {
    // reconnect is best-effort — never fatal to getRegistry.
  }
  try {
    const agentIds = (await listAgents()).map((a) => a.agentId);
    return buildRegistry(agentIds);
  } catch {
    return buildRegistry(null);
  }
}

function normalizeOutboundAction(action) {
  const value = action || "message";
  if (value !== "message" && value !== "reply" && value !== "ask") {
    die(`invalid action '${value}'`, 1);
  }
  return value;
}

// Process-scoped guard: reconnect runs at most once per CLI invocation,
// mirroring the probes cache. All three call sites (getRegistry,
// sendNormalizedEnvelope, resolveRawInputTargets) flow through here, so the
// guard saves N-1 round-trips per invocation when N callers depend on the
// post-reconnect registry state.
let _reconnectInFlight = null;
let _reconnectDone = false;

function reconnectOwnedTmuxAgents() {
  if (_reconnectDone) return Promise.resolve();
  if (_reconnectInFlight) return _reconnectInFlight;
  _reconnectInFlight = _reconnectOwnedAgentsImpl().finally(() => {
    _reconnectDone = true;
    _reconnectInFlight = null;
  });
  return _reconnectInFlight;
}

async function _reconnectOwnedAgentsImpl() {
  await ensureBridgeRunning();
  let existingAgents;
  try {
    existingAgents = await listAgents();
  } catch {
    existingAgents = [];
  }
  const registered = new Set(
    existingAgents
      .map((agent) => agent?.agentId)
      .filter((id) => typeof id === "string" && id.length > 0),
  );
  const token = installToken();
  const tmuxOwnership = tmuxListSessionOwnership(token);
  for (const id of tmuxOwnership.sessions) {
    if (!id || isDashboardSession(id)) continue;
    if (registered.has(id)) continue;
    if (!tmuxOwnership.ownedSessionIds.has(id)) continue;
    const cwd = tmuxPanePath(id);
    const description = inferCohortDescription(id) || `a2a reconnect: ${cwd}`;
    try {
      const { status, body } = await request("POST", "/api/a2a/register", {
        agentId: id,
        tmuxTarget: `${id}:0.0`,
        cwd,
        description,
        installToken: token,
      });
      if (status === 200 && body?.success) {
        info(`${id}: auto-reconnected`);
      } else {
        info(`${id}: auto-reconnect failed: ${body?.error || `HTTP ${status}`}`);
      }
    } catch (err) {
      info(`${id}: auto-reconnect failed: ${err.message}`);
    }
  }
  // Constraint 6 — iTerm-spawned agents need the same reconnect path so they
  // survive a bridge restart. Ownership lives in the bridge's
  // iterm2-bridge.ownership.json; we filter by installToken match so a
  // different a2a install can't accidentally adopt our sessions.
  await reconnectOwnedItermAgents(registered, token);
}

async function reconnectOwnedItermAgents(registered, token) {
  if (!(await probeBridgeReachable())) return;
  let sessions;
  try {
    sessions = await listITermSessionsWithOwnership();
  } catch {
    return;
  }
  for (const s of sessions) {
    if (!s.name || !s.guid) continue;
    if (s.installToken !== token) continue; // only adopt sessions we spawned
    // iTerm decorates the session name with " — <pwd>"; strip the suffix to
    // recover the agent id we set via async_set_name at spawn.
    const agentId = parseItermAgentId(s.name);
    if (!agentId) continue;
    if (registered.has(agentId)) continue;
    const description = `a2a reconnect (iterm): ${agentId}`;
    try {
      const { status, body } = await request("POST", "/api/a2a/register", {
        agentId,
        tmuxTarget: `${agentId}:0.0`, // placeholder; iterm-backed agents
                                       // still satisfy the server-side
                                       // "agentId and tmuxTarget required"
                                       // contract
        itermGuid: s.guid,
        description,
        installToken: token,
      });
      if (status === 200 && body?.success) {
        info(`${agentId}: auto-reconnected (iterm)`);
      } else {
        info(
          `${agentId}: iterm auto-reconnect failed: ${body?.error || `HTTP ${status}`}`,
        );
      }
    } catch (err) {
      info(`${agentId}: iterm auto-reconnect failed: ${err.message}`);
    }
  }
}

/**
 * Strip iTerm's `<name><sep><pwd>` decoration from a session name and return
 * the raw agent id we set via async_set_name. iTerm uses U+00A0 NO-BREAK
 * SPACE on both sides of the em-dash (not ASCII space). We split on any
 * em-dash, en-dash, or ASCII hyphen-minus surrounded by whitespace and take
 * the head. Returns null when the value cannot be a valid agent id.
 *
 * @param {string} sessionName
 * @returns {string|null}
 */
function parseItermAgentId(sessionName) {
  if (typeof sessionName !== "string" || !sessionName) return null;
  // \s in JS regex includes U+00A0 NBSP. Split on whitespace + dash +
  // whitespace; dash can be em-dash, en-dash, or hyphen-minus.
  const split = sessionName.split(/\s+[-\u2013\u2014]\s+/);
  let head = split[0] || sessionName;
  head = head.trim();
  if (!head) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(head)) return null;
  return head;
}

async function restartRegisteredAgentSession(agent) {
  if (!agent || agent.bridgeUrl) {
    return { ok: true, restarted: false };
  }
  const backend = agent.backend || "claude";
  const backendCommand =
    typeof agent.backendCommand === "string" && agent.backendCommand
      ? agent.backendCommand
      : null;
  const backendArgs = Array.isArray(agent.backendArgs) ? agent.backendArgs : [];

  // Constraint 13: iTerm-registered agents take the iTerm restart path.
  // tmux-registered agents take the tmux path. Picking the wrong path here
  // corrupts the registry (an iTerm agent would end up with a stray tmux
  // session). We trust the recorded transport over fuzzy probes.
  if (viableItermGuid(agent.itermGuid)) {
    return await restartViaIterm({ agent, backend, backendCommand, backendArgs });
  }

  if (tmuxSessionExists(agent.agentId)) {
    return { ok: true, restarted: false };
  }
  return await restartViaTmux({ agent, backend, backendCommand, backendArgs });
}

/**
 * Iterm restart: if the recorded guid still resolves on the bridge, treat it
 * as alive (noop). Otherwise spawn a fresh iTerm window, capture the new
 * guid, and re-register the agent with the updated guid so future deliveries
 * land in the right window. iTerm GUIDs are session-lifetime — reusing a
 * stale one is not an option.
 */
async function restartViaIterm({ agent, backend, backendCommand, backendArgs }) {
  // Bridge unreachable → cannot probe, cannot spawn. Surface structured
  // error so callers don't silently swallow it.
  if (!(await probeBridgeReachable())) {
    return {
      ok: false,
      restarted: false,
      error:
        "iterm bridge unreachable — start it with: a2a bridge iterm start",
    };
  }
  const sessions = await listITermSessionsWithOwnership();
  const { storedGuidLive, liveGuid } = resolveItermRestartSession(
    agent,
    sessions,
  );
  if (storedGuidLive) {
    return { ok: true, restarted: false };
  }
  // If a session with this name is alive on the bridge, the guid will
  // resolve and we treat the agent as live.
  if (liveGuid && liveGuid === agent.itermGuid) {
    return { ok: true, restarted: false };
  }
  if (liveGuid && liveGuid !== agent.itermGuid) {
    // Stale guid on record but a session by the same name now exists.
    // Re-register against the live guid; do NOT respawn a duplicate.
    return await reregisterItermAgent(agent, liveGuid);
  }
  // No live session for this name → respawn.
  const cwd = agent.cwd || process.cwd();
  const command = buildAgentLaunchCommand(backend, backendArgs, {
    env: agentEnv(agent.agentId, agent.backendEnv || {}),
    backendCommand,
  });
  const spawned = await spawnITerm2Window({
    name: agent.agentId,
    cwd,
    command,
    installToken: installToken(),
  });
  if (!spawned.ok) {
    return {
      ok: false,
      restarted: false,
      error: `iterm respawn failed: ${spawned.error || "unknown"}`,
    };
  }
  await sleep(1500); // shell start (no -l) is fast; 1.5s covers backend init
  const newGuid = spawned.guid || null;
  if (!newGuid) {
    return {
      ok: false,
      restarted: true,
      error: "iterm spawn returned no guid",
    };
  }
  await configureITerm2Session({ guid: newGuid, nativeScroll: true });
  if (agent.startupPrompt) {
    const pasted = await pasteStartupPromptToAgent({
      itermGuid: newGuid,
      content: agent.startupPrompt,
      backend,
    });
    if (!pasted.ok) {
      // Best-effort close so we don't leave an unprompted window behind.
      await closeITerm2Session(newGuid);
      return {
        ok: false,
        restarted: true,
        error: `iterm startup prompt paste failed: ${pasted.error}`,
      };
    }
  }
  invalidateITermSessionCache();
  return await reregisterItermAgent(agent, newGuid);
}

async function reregisterItermAgent(agent, newGuid) {
  try {
    const { status, body } = await request("POST", "/api/a2a/register", {
      agentId: agent.agentId,
      tmuxTarget: agent.tmuxTarget || `${agent.agentId}:0.0`,
      itermGuid: newGuid,
      description: agent.description,
      cwd: agent.cwd,
      backend: agent.backend,
      backendArgs: agent.backendArgs,
      ...(typeof agent.backendCommand === "string" && agent.backendCommand
        ? { backendCommand: agent.backendCommand }
        : {}),
      backendEnv: agent.backendEnv,
      installToken: installToken(),
      ...(typeof agent.yolo === "boolean" ? { yolo: agent.yolo } : {}),
      ...(agent.startupPrompt
        ? { startupPrompt: agent.startupPrompt }
        : {}),
    });
    if (status !== 200 || !body?.success) {
      return {
        ok: false,
        restarted: true,
        error: `re-register failed: ${body?.error || `HTTP ${status}`}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      restarted: true,
      error: `re-register failed: ${err.message}`,
    };
  }
  invalidateITermSessionCache();
  return { ok: true, restarted: true };
}

function resolveLiveItermTargetForAgent(agent) {
  return resolveLiveItermTarget(agent, {
    probeBridgeReachable,
    itermGuidByName,
    reregisterItermAgent,
  });
}

async function restartViaTmux({ agent, backend, backendCommand, backendArgs }) {
  const r = tmux([
    "new-session",
    "-d",
    "-s",
    agent.agentId,
    "-n",
    agent.agentId,
    "-c",
    agent.cwd || process.cwd(),
    buildAgentLaunchCommand(backend, backendArgs, {
      env: agentEnv(agent.agentId, agent.backendEnv || {}),
      backendCommand,
    }),
  ]);
  if (r.status !== 0) {
    return {
      ok: false,
      restarted: false,
      error: (r.stderr || "").trim() || "tmux new-session failed",
    };
  }
  await sleep(500);
  if (!tmuxSessionExists(agent.agentId)) {
    return {
      ok: false,
      restarted: true,
      error: sessionStartupError(agent.agentId, backend),
    };
  }
  tmuxSetInstallToken(agent.agentId, installToken());
  if (agent.startupPrompt) {
    const pasted = pasteStartupPrompt(`${agent.agentId}:0.0`, agent.startupPrompt, {
      backend,
    });
    if (!pasted.ok) {
      return {
        ok: false,
        restarted: true,
        error: `startup prompt paste failed: ${pasted.error}`,
      };
    }
  }
  return { ok: true, restarted: true };
}

async function sendNormalizedEnvelope(envelope) {
  if (!envelope.content) die("message body is required");
  await ensureBridgeRunning();
  await reconnectOwnedTmuxAgents();
  const action = normalizeOutboundAction(envelope.action);
  const rawSelfId = currentTmuxSession();
  const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
  // Self-exclusion must also work for iTerm-backed agents: they have no TMUX
  // env, so currentTmuxSession() is null and selfId alone would never match.
  // Fall back to the launched-agent id (A2A_AGENT_ID) so an agent's own
  // broadcast / auto-inferred send is never routed back to itself.
  const excludeId = selfExclusionId({
    selfId,
    agentId: process.env.A2A_AGENT_ID,
  });
  const selectors = [...new Set((envelope.recipients || []).filter(Boolean))];
  const recipients = [];
  let agents = [];
  if (selectors.length === 0) {
    agents = await listAgents();
    if (envelope.broadcast) {
      const others = agents.filter((a) => a.agentId !== excludeId);
      if (others.length === 0)
        die("no peers registered -- use 'a2a start <n>' to create one", 1);
      recipients.push(...others.map((a) => a.agentId));
    } else {
      const result = inferPeer(agents, excludeId);
      if (result.error) die(result.error, 1);
      recipients.push(result.peer.agentId);
    }
  } else {
    const hasGlobSelector = selectors.some((selector) =>
      hasUnescapedGlob(selector),
    );
    try {
      agents = await listAgents();
    } catch {
      if (hasGlobSelector) {
        die(
          "glob recipient selectors require a reachable bridge so a2a can list agents",
          1,
        );
      }
    }
    const { recipients: expanded, unmatchedSelectors } =
      expandGlobRecipientSelectors(
        selectors,
        [...agents.map((a) => a.agentId), ...listGroupNames()],
      );
    if (unmatchedSelectors.length > 0) {
      die(
        `recipient selector '${unmatchedSelectors[0]}' matched no live agents`,
        1,
      );
    }
    recipients.push(...expandGroupRecipientSelectors(expanded));
    if (recipients.length === 0) {
      die("no recipients resolved", 1);
    }
  }
  const agentMap = new Map();
  for (const agent of agents) agentMap.set(agent.agentId, agent);
  const { fromId, origin, source: resolvedSource } = resolveSenderIdentity({
    explicitFrom: envelope.from,
    explicitOrigin: envelope.origin,
    selfId,
    agentId: process.env.A2A_AGENT_ID,
    interactiveTTY: hasInteractiveTerminal(),
    operatorSource: process.env.A2A_OPERATOR_SOURCE,
    warn: info,
  });
  const replyTo = process.env.A2A_BRIDGE_PUBLIC || null;
  const extras = sanitizeEnvelopeMeta(envelope.meta);
  const source =
    typeof extras.source === "string" && extras.source.trim()
      ? extras.source.trim()
      : resolvedSource;
  let sentCount = 0;
  let failedCount = 0;
  for (const toId of recipients) {
    const targetAgent = agentMap.get(toId);
    if (
      targetAgent &&
      !targetAgent.bridgeUrl &&
      !(await agentSessionAlive(targetAgent))
    ) {
      info(`${toId} session dead, attempting restart...`);
      const restarted = await restartRegisteredAgentSession(targetAgent);
      if (restarted.ok && restarted.restarted) info(`${toId} restarted`);
      else if (!restarted.ok)
        info(`restart failed for ${toId}: ${restarted.error}`);
    }
    const { status, body } = await request("POST", "/api/a2a/send", {
      to: toId,
      from: fromId,
      origin,
      body: envelope.content,
      action,
      ...(source ? { source } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...extras,
    });
    if (status !== 200 || !body?.success) {
      // A single wedged recipient (e.g. a backend stuck on a provider error
      // that leaves the paste placeholder un-submitted) must NOT abort the
      // whole fan-out. Skip it and keep delivering to the rest of the queue.
      failedCount++;
      info(`send failed: ${body?.error || `HTTP ${status}`} (skipped ${toId})`);
      continue;
    }
    sentCount++;
    info(
      `${fromId} -> ${toId} [${origin}/${action}] (${body.data?.bytes ?? "?"} bytes)`,
    );
  }
  // Only fail the command when nothing was delivered at all. A single-recipient
  // send that fails still reports a non-zero exit, while a broadcast that
  // reached at least one recipient succeeds despite skipped agents.
  if (failedCount > 0 && sentCount === 0) {
    die(`send failed: all ${failedCount} recipient(s) unreachable`, 1);
  }
}

async function doSend({ flags, kv, positional }, action = "message") {
  const bodyText = positional.join(" ").trim();
  if (!bodyText) die("message body is required");
  const to = kv.to || flags.to || null;
  await sendNormalizedEnvelope({
    action,
    recipients: to ? [to] : [],
    broadcast: false,
    content: bodyText,
    from: kv.from || flags.from || null,
    origin: kv.origin || flags.origin || null,
    meta: {},
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a canonical path when the path exists, falling back to resolve().
 *
 * @param {string} value - Candidate path from ps output.
 * @returns {string} Canonicalized filesystem path.
 * @example
 *   canonicalExistingPath("/usr/local/bin/../bin/a2a-server.mjs");
 */
function canonicalExistingPath(value) {
  try {
    return realpathSync(resolve(value));
  } catch {
    return resolve(value);
  }
}
/**
 * Strips simple surrounding quotes from a shell argument.
 *
 * @param {string} value - Raw ps argument.
 * @returns {string} Unquoted argument when wrapped in matching quotes.
 * @example
 *   stripShellishQuotes("'a2a-server.mjs'");
 */
function stripShellishQuotes(value) {
  const text = String(value || "");
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
/**
 * Checks whether one ps argument looks like the a2a bridge server script.
 *
 * @param {string} arg - One token from the process argument string.
 * @returns {boolean} True when the token identifies a plausible a2a-server.mjs.
 * @example
 *   psArgLooksLikeServerScript("/opt/a2a/src/a2a-server.mjs");
 */
function psArgLooksLikeServerScript(arg) {
  const cleaned = stripShellishQuotes(arg);
  if (!cleaned) return false;
  const serverBase = basename(SERVER_SCRIPT);
  if (basename(cleaned) !== serverBase) return false;
  const expected = canonicalExistingPath(SERVER_SCRIPT);
  const actual = canonicalExistingPath(cleaned);
  return actual === expected || cleaned.endsWith(`/${serverBase}`) || cleaned === serverBase;
}
/**
 * Checks whether a live pid appears to be an a2a bridge process.
 *
 * @param {number|string|null} pid - Process id to inspect.
 * @returns {boolean} True when ps output matches the bridge title or server script.
 * @example
 *   pidLooksLikeBridge(4576);
 */
function pidLooksLikeBridge(pid) {
  if (!pid || !isProcessAlive(pid)) return false;
  const r = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  const args = (r.stdout || "").trim();
  if (!args) return false;
  if (args.includes("a2a-bridge")) return true;
  const parts = args.split(/\s+/).filter(Boolean);
  return parts.some((part) => psArgLooksLikeServerScript(part));
}
/**
 * Finds process ids listening on the configured bridge port.
 *
 * @returns {number[]} Candidate listener pids from lsof.
 * @example
 *   bridgeListenerPids();
 */
function bridgeListenerPids() {
  let base;
  try {
    base = new URL(bridgeUrl());
  } catch {
    return [];
  }
  const port = requestPort(base);
  const r = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return [];
  return [
    ...new Set(
      (r.stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}
/**
 * Resolves the running bridge pid from the configured listener port.
 *
 * @returns {number|null} A verified bridge pid, or null when none can be proven.
 * @example
 *   const pid = bridgeListenerPid();
 */
function bridgeListenerPid() {
  for (const pid of bridgeListenerPids()) {
    if (pidLooksLikeBridge(pid)) return pid;
  }
  return null;
}
/**
 * Sends SIGTERM to a bridge process and removes the pid file only when it
 * references that same process or no expected pid was supplied.
 *
 * @param {number} pid - Process id to terminate.
 * @param {number|null} expectedPidFilePid - Pid currently recorded in bridge.pid.
 * @returns {void}
 * @example
 *   stopBridgePid(4576, readPid());
 */
function stopBridgePid(pid, expectedPidFilePid = null) {
  process.kill(pid, "SIGTERM");
  info(`sent SIGTERM to bridge (pid ${pid})`);
  if (expectedPidFilePid == null || expectedPidFilePid === pid) {
    removePid(pid);
  }
}

function bridgeHealthy() {
  return new Promise((fulfill) => {
    let base;
    try {
      base = new URL(bridgeUrl());
    } catch {
      fulfill(false);
      return;
    }
    let transport;
    try {
      transport = transportForUrl(base);
    } catch {
      fulfill(false);
      return;
    }
    const req = transport(
      {
        method: "GET",
        hostname: base.hostname,
        port: requestPort(base),
        path: joinedUrlPath(base, "/health"),
        timeout: 2000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          try {
            fulfill(
              res.statusCode >= 200 &&
                res.statusCode < 300 &&
                JSON.parse(raw).success === true,
            );
          } catch {
            fulfill(false);
          }
        });
      },
    );
    req.on("error", () => fulfill(false));
    req.on("timeout", () => {
      req.destroy();
      fulfill(false);
    });
    req.end();
  });
}

/**
 * Handles `a2a bridge [start|stop|status]`.
 *
 * @param {string[]} args - Bridge subcommand arguments.
 * @returns {Promise<void>} Resolves after the subcommand completes.
 * @example
 *   await cmdBridge(["stop"]);
 */
/**
 * Prints a shell completion script.
 *
 * @param {string[]} args - Subcommand args (`bash` or `zsh`).
 * @returns {void}
 * @example
 *   cmdCompletion(["bash"]);
 */
function cmdCompletion(args) {
  const shell = (args[0] || "").toLowerCase();
  if (shell !== "bash" && shell !== "zsh") {
    die(
      "usage: a2a completion <bash|zsh>\n" +
        "  bash (file): a2a completion bash > ~/.local/share/bash-completion/completions/a2a\n" +
        '  zsh  (file): a2a completion zsh  > "$' +
        '{fpath[1]}/_a2a"\n' +
        "  zsh  (one-shot): source <(a2a completion zsh)",
      2,
    );
  }
  const path = join(COMPLETIONS_DIR, `a2a.${shell}`);
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    die(`could not read completion script at ${path}: ${err.message}`, 1);
  }
  // process substitution (`source <(a2a completion zsh)`) closes the read
  // end early after the shell finishes interpreting, which raises EPIPE on
  // node's default stdout handler. Swallow it: the script has already been
  // delivered to the consumer by the time the pipe is torn down.
  process.stdout.on("error", (err) => {
    if (err && err.code === "EPIPE") process.exit(0);
  });
  process.stdout.write(content);
}
/**
 * Reads a raw command flag value.
 *
 * @param {string[]} args - Raw command argv.
 * @param {number} index - Current argv index.
 * @param {string} key - Flag key without leading dashes.
 * @param {number} eqIdx - Index of "=" in the current arg, or -1.
 * @returns {{ value: string; nextIndex: number }}
 * @example
 *   readRawFlagValue(["--to", "bob"], 0, "to", -1);
 */
function readRawFlagValue(args, index, key, eqIdx) {
  const value = eqIdx !== -1 ? args[index].slice(eqIdx + 1) : args[index + 1];
  if (value === undefined || (eqIdx === -1 && String(value).startsWith("--"))) {
    die(`--${key} requires a value`, 1);
  }
  return {
    value,
    nextIndex: eqIdx !== -1 ? index + 1 : index + 2,
  };
}
/**
 * Parses `a2a raw` arguments.
 *
 * @param {string[]} args - Args after the raw subcommand.
 * @returns {{ selectors: string[]; content: string; submit: boolean; open: boolean }}
 * @example
 *   parseRawCommandArgs(["--bob", "/clear"]);
 */
function parseRawCommandArgs(args) {
  const selectors = [];
  const positional = [];
  let content = null;
  let submit = true;
  let open = false;
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      i++;
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    if (key === "open") {
      if (eqIdx !== -1) die("--open does not take a value", 1);
      open = true;
      i++;
      continue;
    }
    if (key === "submit") {
      if (eqIdx !== -1) die("--submit does not take a value", 1);
      submit = true;
      i++;
      continue;
    }
    if (key === "no-submit") {
      if (eqIdx !== -1) die("--no-submit does not take a value", 1);
      submit = false;
      i++;
      continue;
    }
    if (key === "to" || key === "target") {
      const read = readRawFlagValue(args, i, key, eqIdx);
      selectors.push(read.value);
      i = read.nextIndex;
      continue;
    }
    if (key === "content") {
      const read = readRawFlagValue(args, i, key, eqIdx);
      if (content !== null) die("raw content specified more than once", 1);
      content = read.value;
      i = read.nextIndex;
      continue;
    }
    if (eqIdx !== -1) {
      die(`unknown raw flag --${key}`, 1);
    }
    selectors.push(key);
    i++;
  }
  const positionalContent = positional.join(" ").trim();
  if (content !== null && positionalContent) {
    die("raw content specified more than once", 1);
  }
  return {
    selectors,
    content: content !== null ? content : positionalContent,
    submit,
    open,
  };
}
/**
 * Resolves raw input target selectors to registered local agents.
 *
 * @param {string[]} selectors - Agent, group, or glob selectors.
 * @returns {Promise<Array<{ id: string; agent: any | null }>>}
 * @example
 *   const targets = await resolveRawInputTargets(["bob"]);
 */
async function resolveRawInputTargets(selectors) {
  await ensureBridgeRunning();
  await reconnectOwnedTmuxAgents();
  const agents = await listAgents();
  const selfId = isDashboardSession(currentTmuxSession())
    ? null
    : currentTmuxSession();
  const resolved = [];
  if (selectors.length === 0) {
    const inferred = inferPeer(agents, selfId);
    if (inferred.error) die(inferred.error, 1);
    resolved.push(inferred.peer.agentId);
  } else {
    const { recipients, unmatchedSelectors } = expandGlobRecipientSelectors(
      selectors,
      [...agents.map((agent) => agent.agentId), ...listGroupNames()],
    );
    if (unmatchedSelectors.length > 0) {
      die(
        `recipient selector '${unmatchedSelectors[0]}' matched no live agents`,
        1,
      );
    }
    resolved.push(...expandGroupRecipientSelectors(recipients));
  }
  const agentMap = new Map(agents.map((agent) => [agent.agentId, agent]));
  return [...new Set(resolved)].map((id) => ({
    id,
    agent: agentMap.get(id) || null,
  }));
}
/**
 * Attempts to restart a local registered agent before raw input delivery.
 *
 * @param {any} agent - Agent registration payload.
 * @returns {Promise<void>}
 * @example
 *   await ensureRawInputAgentLive(agent);
 */
async function ensureRawInputAgentLive(agent) {
  if (!shouldReviveAgentInTmux(agent)) return;
  if (tmuxSessionExists(agent.agentId)) return;
  const backend = agent.backend || "claude";
  const backendCommand =
    typeof agent.backendCommand === "string" && agent.backendCommand
      ? agent.backendCommand
      : null;
  const backendArgs = Array.isArray(agent.backendArgs) ? agent.backendArgs : [];
  const cmd = buildAgentLaunchCommand(backend, backendArgs, {
    env: agentEnv(agent.agentId, agent.backendEnv || {}),
    backendCommand,
  });
  const r = tmux([
    "new-session",
    "-d",
    "-s",
    agent.agentId,
    "-n",
    agent.agentId,
    "-c",
    agent.cwd || process.cwd(),
    cmd,
  ]);
  if (r.status !== 0) {
    die(
      `raw target '${agent.agentId}' is dead and restart failed: ${(r.stderr || "").trim() || "unknown"}`,
      1,
    );
  }
  await sleep(500);
  if (!tmuxSessionExists(agent.agentId)) {
    die(`raw target '${agent.agentId}' exited during restart`, 1);
  }
  tmuxSetInstallToken(agent.agentId, installToken());
  if (agent.startupPrompt) {
    const pasted = pasteStartupPrompt(`${agent.agentId}:0.0`, agent.startupPrompt, {
      backend,
    });
    if (!pasted.ok) {
      die(
        `raw target '${agent.agentId}' restarted but startup prompt paste failed: ${pasted.error}`,
        1,
      );
    }
  }
}
/**
 * Opens an agent session after raw input delivery.
 *
 * @param {string} id - Agent id/session name.
 * @returns {void}
 * @example
 *   openRawInputTarget("bob");
 */
function openRawInputTarget(id) {
  if (process.env.TMUX) {
    switchTmuxClient(id);
    return;
  }
  attachTmuxSession(id);
}
/**
 * Sends raw text directly to one or more backend CLI panes.
 *
 * @param {string[]} args - Args after the raw subcommand.
 * @returns {Promise<void>}
 * @example
 *   await cmdRaw(["--bob", "/clear"]);
 */
async function cmdRaw(args) {
  const parsed = parseRawCommandArgs(args);
  if (!parsed.content) die("raw input body is required", 1);
  const targets = await resolveRawInputTargets(parsed.selectors);
  if (targets.length === 0) die("no raw input targets resolved", 1);
  let firstLocalTarget = null;
  for (const target of targets) {
    const { agent } = target;
    if (agent?.bridgeUrl) {
      die(
        `raw input cannot target remote agent '${target.id}'; raw input requires a local pane`,
        1,
      );
    }
    if (agent) {
      await ensureRawInputAgentLive(agent);
    }
    const tmuxTarget = agent?.tmuxTarget || `${target.id}:0.0`;
    const sessionName = tmuxTarget.split(":")[0];
    // No global tmux preflight — per-recipient autodetect handles the case
    // where this agent is iTerm-backed even if protocol=tmux is the
    // preference. The delivery call will produce a structured error if
    // neither transport is viable.
    const delivery = await deliverViaActiveProtocol({
      agentName: target.id,
      tmuxTarget,
      itermGuid: agent?.itermGuid,
      agent,
      content: parsed.content,
      backend: agent?.backend || "",
      submit: parsed.submit,
    });
    if (!delivery.ok) {
      die(
        `raw input to '${target.id}' via ${delivery.transport} failed: ${delivery.error}`,
        1,
      );
    }
    if (delivery.warning) {
      info(`${target.id}: ${delivery.warning}`);
    }
    info(
      `raw -> ${target.id} via ${delivery.transport}${parsed.submit ? "" : " (not submitted)"} (${delivery.bytes ?? "?"} bytes)`,
    );
    if (firstLocalTarget === null) firstLocalTarget = sessionName;
  }
  if (parsed.open && firstLocalTarget) {
    // Honour --open for tmux targets only; iTerm sessions are foregrounded
    // by the bridge spawn path itself.
    if (tmuxSessionExists(firstLocalTarget)) openRawInputTarget(firstLocalTarget);
  }
}

/**
 * Reads the entirety of stdin into a string. Used only when --stdin or
 * --write - is requested.
 *
 * @returns {Promise<string>}
 */
function readStdinFully() {
  return new Promise((settle, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error("no stdin available (stdin is a TTY)"));
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.once("end", () =>
      settle(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.once("error", (err) => reject(err));
  });
}

/**
 * Resolve targets for a --command sequence (broadcast or explicit selectors).
 *
 * @param {ReturnType<typeof parseSequenceFlagArgv>} parsed
 * @returns {Promise<Array<{id:string, agent:object|null}>>}
 */
async function resolveSequenceTargets(parsed) {
  if (parsed.broadcast) {
    await ensureBridgeRunning();
    const agents = await listAgents();
    const selfId = isDashboardSession(currentTmuxSession())
      ? null
      : currentTmuxSession();
    const excludeId = selfExclusionId({
      selfId,
      agentId: process.env.A2A_AGENT_ID,
    });
    const others = agents.filter((a) => a.agentId !== excludeId);
    if (others.length === 0) {
      die("no peers registered -- use 'a2a start <n>' to create one", 1);
    }
    return others.map((a) => ({ id: a.agentId, agent: a }));
  }
  return resolveRawInputTargets(parsed.recipients);
}

/**
 * Executes a parsed sequence envelope: resolves recipients (reusing the raw
 * input target resolver), compiles the DSL once per recipient (so vars like
 * ${target} expand correctly), then dispatches via the active transport.
 *
 * @param {ReturnType<typeof parseSequenceFlagArgv>} parsed
 * @returns {Promise<void>}
 */
async function runSequenceCommand(parsed) {
  let writeBody = parsed.write;
  if (parsed.stdin || parsed.write === "-") {
    try {
      writeBody = await readStdinFully();
    } catch (err) {
      die(err.message, 1);
    }
  }

  const targets = await resolveSequenceTargets(parsed);
  if (targets.length === 0) die("no command targets resolved", 1);

  const selfId = isDashboardSession(currentTmuxSession())
    ? null
    : currentTmuxSession();

  for (const target of targets) {
    const { agent } = target;
    if (agent?.bridgeUrl) {
      die(
        `command sequences cannot target remote agent '${target.id}'; sequence delivery requires a local pane`,
        1,
      );
    }
    if (agent) {
      await ensureRawInputAgentLive(agent);
    }
    const tmuxTarget = agent?.tmuxTarget || `${target.id}:0.0`;
    // No global tmux preflight — transport-router picks per-recipient.

    /** @type {ReturnType<typeof compileSequence>} */
    let compiled;
    try {
      compiled = compileSequence(parsed.command, {
        vars: {
          write: typeof writeBody === "string" ? writeBody : undefined,
          stdin: typeof writeBody === "string" ? writeBody : undefined,
          target: target.id,
          self: selfId || "",
          now: new Date().toISOString(),
          env: process.env,
        },
        submit: parsed.submit,
        backend: agent?.backend || "",
      });
    } catch (err) {
      die(`--command parse error: ${err.message}`, 1);
    }

    const delivery = await deliverSequenceViaActiveProtocol({
      agentName: target.id,
      tmuxTarget,
      itermGuid: agent?.itermGuid,
      agent,
      ops: compiled.ops,
      backend: agent?.backend || "",
    });
    if (!delivery.ok) {
      die(
        `command sequence to '${target.id}' via ${delivery.transport} failed: ${delivery.error}`,
        1,
      );
    }
    if (delivery.warning) {
      info(`${target.id}: ${delivery.warning}`);
    }
    const { pastes, types, keys, sleeps } = compiled.summary;
    info(
      `command -> ${target.id} via ${delivery.transport} (${pastes}p/${types}t/${keys}k/${sleeps}s, ${delivery.bytes ?? "?"} bytes)`,
    );
  }
}

async function cmdCommand(args) {
  const parsed = parseSequenceFlagArgv(args, await getRegistry());
  await runSequenceCommand(parsed);
}

/**
 * Path to the iTerm2 bridge launcher. Sits next to bridge.py in the repo so
 * the existing pid/log/socket layout (~/.local/state/a2a/iterm2-bridge.*)
 * keeps working — `a2a bridge iterm` is a thin wrapper that lets users
 * manage both daemons from one command.
 */
const ITERM2_BRIDGE_LAUNCH_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cmd",
  "a2a-iterm2-bridge",
  "launch.sh",
);

const ITERM2_BRIDGE_ACTIONS = new Set([
  "start",
  "stop",
  "status",
  "restart",
  "foreground",
]);

/**
 * Invoke the iTerm2 bridge launcher synchronously and stream its stdio.
 *
 * @param {string} action  start|stop|status|restart|foreground
 * @returns {number} exit code from the launcher
 */
function runIterm2BridgeLauncher(action) {
  if (!ITERM2_BRIDGE_ACTIONS.has(action)) {
    die(
      `unknown iterm bridge action '${action}' (expected: ${[...ITERM2_BRIDGE_ACTIONS].join(", ")})`,
    );
  }
  try {
    accessSync(ITERM2_BRIDGE_LAUNCH_SCRIPT, constants.X_OK);
  } catch {
    die(
      `iterm bridge launcher missing or not executable: ${ITERM2_BRIDGE_LAUNCH_SCRIPT}`,
      1,
    );
  }
  const r = spawnSync(ITERM2_BRIDGE_LAUNCH_SCRIPT, [action], {
    stdio: "inherit",
  });
  return r.status ?? 1;
}

async function cmdBridge(args) {
  // First peel off the target selector: `a2a bridge iterm <action>` or
  // `a2a bridge all <action>`. Without a target, the action defaults to the
  // HTTP bridge for back-compat with the pre-iterm syntax.
  const target = (args[0] || "").toLowerCase();
  if (target === "iterm" || target === "iterm2") {
    const action = (args[1] || "status").toLowerCase();
    process.exit(runIterm2BridgeLauncher(action));
  }
  if (target === "all") {
    const action = (args[1] || "status").toLowerCase();
    if (action === "start") {
      await cmdBridge(["start"]);
      runIterm2BridgeLauncher("start");
      return;
    }
    if (action === "stop") {
      await cmdBridge(["stop"]);
      runIterm2BridgeLauncher("stop");
      return;
    }
    if (action === "restart") {
      // The HTTP dispatcher below has no native restart; compose stop+start
      // the same way the other `all` actions compose per-surface commands.
      await cmdBridge(["stop"]);
      await cmdBridge(["start"]);
      runIterm2BridgeLauncher("restart");
      return;
    }
    if (action === "status") {
      await cmdBridge(["status"]);
      runIterm2BridgeLauncher("status");
      return;
    }
    die(`unknown bridge action '${action}' for 'all'`);
  }

  const sub = (args[0] || "start").toLowerCase();
  if (sub === "status") {
    const pid = readPid();
    const alive = pid && isProcessAlive(pid);
    const healthy = await bridgeHealthy();
    if (healthy) {
      const listenerPid = pid || bridgeListenerPid();
      info(
        `bridge running${listenerPid ? ` (pid ${listenerPid})` : ""} at ${bridgeUrl()}`,
      );
    } else if (alive) {
      info(`bridge pid file points at live pid ${pid}, but /health is not responding`);
    } else {
      info("bridge is not running");
      if (pid) removePid(pid);
    }
    return;
  }
  if (sub === "stop") {
    const pid = readPid();
    if (pid && pidLooksLikeBridge(pid)) {
      stopBridgePid(pid, pid);
      return;
    }
    if (pid && isProcessAlive(pid)) {
      info(
        `pid ${pid} is not recognized as this a2a bridge; leaving pid file intact`,
      );
    } else if (pid) {
      info(`removing stale bridge pid file for dead pid ${pid}`);
      removePid(pid);
    }
    if (await bridgeHealthy()) {
      const listenerPid = bridgeListenerPid();
      if (listenerPid) {
        stopBridgePid(listenerPid, pid || null);
        if (pid && pid !== listenerPid) {
          info(
            `bridge.pid still points at unmanaged pid ${pid}; leaving it intact`,
          );
        }
        return;
      }
      info(
        `bridge is healthy at ${bridgeUrl()}, but its pid is unmanaged; stop the listener manually or restore bridge.pid`,
      );
      return;
    }
    info("bridge is not running");
    return;
  }
  if (sub === "start" || sub === "bridge") {
    if (await bridgeHealthy()) {
      const listenerPid = readPid() || bridgeListenerPid();
      info(
        `bridge already running${listenerPid ? ` (pid ${listenerPid})` : ""} at ${bridgeUrl()}`,
      );
      return;
    }
    const stale = readPid();
    if (stale && pidLooksLikeBridge(stale)) {
      info(`killing stale bridge (pid ${stale})`);
      process.kill(stale, "SIGTERM");
      spawnSync("sleep", ["0.5"]);
    } else if (stale && isProcessAlive(stale)) {
      info(`stale pid ${stale} is not an a2a bridge; leaving it alone`);
    } else if (stale) {
      removePid(stale);
    }
    const KEY = activeKey();
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...(KEY ? { A2A_KEY: KEY } : {}) },
    });
    child.unref();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await bridgeHealthy()) {
        info(
          `bridge started (pid ${readPid() || child.pid}) at ${bridgeUrl()}`,
        );
        return;
      }
    }
    die("bridge failed to start within 5s", 1);
  }
  die(`unknown bridge subcommand '${sub}' (expected: start, stop, status)`);
}

async function startSingle(name, backend, backendArgs, opts = {}) {
  validateAgentId(name);
  const backendCommand = backendCommandOverrideFor(backend, opts);
  const displayBackendCommand = resolvedBackendCommand(backend, opts);
  requireBackendCommand(backend, { backendCommand });

  let createdSession = false;
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || {};
  /** @type {string|null} */
  let tmuxTarget;
  /** @type {string|null} */
  let itermGuid;
  /** @type {"tmux"|"iterm"} */
  let transport;

  const alive = await probeAgentAlive(name);
  if (alive.alive) {
    transport = alive.transport;
    tmuxTarget = alive.tmuxTarget || null;
    itermGuid = alive.itermGuid || null;
    info(
      `session '${name}' already exists (${transport}), re-registering (running ${displayBackendCommand} is unchanged)`,
    );
    // Adopt: stamp this install's token so the session is provably ours
    // and a future `a2a kill --all` can sweep it as an orphan. Without
    // this, sessions spawned by an older install (or before registry.json
    // was reset) survive every kill cycle because the ownership scan
    // refuses to nuke un-tokened sessions. Only meaningful for tmux —
    // iTerm session ownership is identified by guid not tmux options.
    if (transport === "tmux") {
      tmuxSetInstallToken(name, installToken());
    }
    if (backendArgs.length || backendCommand) {
      info(
        `  warning: backend command/args will be recorded but won't apply to the running process`,
      );
      info(
        `  to apply, restart: a2a kill ${name} && a2a start ${name} ${backendArgs.map(shellQuote).join(" ")}`,
      );
    }
    if (opts.startupPrompt) {
      // Paste the new prompt into the running process so the agent
      // actually receives the role/skills the caller asked for. If the
      // backend died in-pane, the paste lands in the shell — surfaced
      // via the error branch and discoverable via `a2a peek`.
      const pasted = await pasteStartupPromptToAgent({
        tmuxTarget,
        itermGuid,
        content: opts.startupPrompt,
        backend,
      });
      if (pasted.ok) info(`  startup prompt pasted into the running process`);
      else info(`  warning: startup prompt paste failed: ${pasted.error}`);
    }
  } else {
    const command = buildAgentLaunchCommand(backend, backendArgs, {
      env: agentEnv(name, env),
      backendCommand,
    });
    const spawned = await spawnAgentInPlace({ name, cwd, command, backend });
    if (!spawned.ok) die(spawned.error || "spawn failed", 1);
    createdSession = true;
    transport = spawned.transport;
    tmuxTarget = spawned.tmuxTarget || null;
    itermGuid = spawned.itermGuid || null;
    // The freshly-spawned session needs a moment to start the backend before
    // we paste anything into it. The pre-existing tmux path slept 1s — keep
    // the same budget for iTerm (window creation is comparable).
    if (transport === "tmux") {
      // Pin install token onto the session so list/kill can prove this
      // session is a2a-owned even if the bridge / cache later drift.
      tmuxSetInstallToken(name, installToken());
      spawnSync("sleep", ["1"]);
      ensureSessionSurvivedStart(name, backend);
    } else {
      // Plain $SHELL (no -l) starts fast; 1s parity with tmux is enough.
      spawnSync("sleep", ["1"]);
    }
    if (opts.startupPrompt) {
      const pasted = await pasteStartupPromptToAgent({
        tmuxTarget,
        itermGuid,
        content: opts.startupPrompt,
        backend,
      });
      if (!pasted.ok) {
        info(`startup prompt paste failed: ${pasted.error}`);
        info(`killing orphan '${name}'`);
        if (transport === "iterm" && itermGuid) {
          await closeITerm2Session(itermGuid);
        } else if (transport === "tmux") {
          tmux(["kill-session", "-t", name]);
        }
        die(`startup prompt paste failed: ${pasted.error}`, 1);
      }
    }
  }

  // cohort wins over a passed-through description: --cohort is the canonical
  // a2a-side knob for the `a2a list` COHORT column. parseCohortDescription
  // recognises `team:<name>` and `group:<name>` prefixes. By default --cohort
  // emits the team: form, but cmdStart can override via opts.cohortKind when
  // resolveCohortJoin detected the existing cohort is group-style — that's
  // what keeps `a2a kill <cohort>` reaping the joiner (killGroup filters by
  // `description === group:<name>`, killTeam by `team:<name>`; a tag mismatch
  // would leave the joiner orphaned in cohort kill).
  const cohortKind = opts.cohortKind === "group" ? "group" : "team";
  const description = opts.cohort
    ? `${cohortKind}:${opts.cohort}`
    : opts.description || `a2a start: ${cwd}`;
  // Register at least one delivery target so the bridge can route messages.
  // For tmux-backed agents this is tmuxTarget; for iTerm-backed agents the
  // server now also accepts itermGuid (the bridge picks the active transport
  // per recipient at delivery time).
  if (!tmuxTarget && !itermGuid) {
    die(`internal: agent '${name}' has no tmuxTarget and no itermGuid`, 1);
  }
  const registerTarget = tmuxTarget || `${name}:0.0`;
  try {
    const { status, body } = await request("POST", "/api/a2a/register", {
      agentId: name,
      tmuxTarget: registerTarget,
      ...(itermGuid ? { itermGuid } : {}),
      description,
      cwd,
      backend,
      backendArgs,
      ...backendCommandPayload(backendCommand),
      backendEnv: agentEnv(name, env),
      installToken: installToken(),
      ...(typeof opts.yolo === "boolean" ? { yolo: opts.yolo } : {}),
      ...(opts.startupPrompt ? { startupPrompt: opts.startupPrompt } : {}),
      ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
    });
    if (status !== 200 || !body?.success)
      throw new Error(body?.error || `HTTP ${status}`);
  } catch (err) {
    const msg = err.message;
    if (createdSession) {
      info(`register failed: ${msg}`);
      info(`killing orphan '${name}'`);
      if (transport === "iterm" && itermGuid) {
        await closeITerm2Session(itermGuid);
      } else {
        tmux(["kill-session", "-t", name]);
      }
    }
    die(`register failed: ${msg}`, 1);
  }

  const where =
    transport === "iterm"
      ? `iterm session ${itermGuid?.slice(0, 8) || "?"}…`
      : registerTarget;
  info(
    `'${name}' registered at ${where}${opts.bridgeUrl ? ` (replies via ${opts.bridgeUrl})` : ""}`,
  );
  // If the caller said this is joining an existing cohort, attempt to link
  // the new window into that cohort's *-view dashboard. Only fires when the
  // dashboard session exists — a no-op for ad-hoc cohorts that never had
  // a layout. Done before attach so the operator sees the linked window
  // when their attach lands. Dashboards are tmux-only; iTerm-spawned agents
  // skip the linked-window step.
  if (opts.cohort && opts.joinExistingCohort && transport === "tmux") {
    joinCohortDashboard(name, opts.cohort);
  }
  if (opts.dashboard && transport === "tmux") {
    createDashboardView(`${name}-view`, [name], cwd);
    return;
  }
  if (transport === "iterm") {
    if (itermGuid) {
      await focusITerm2Session(itermGuid);
    }
    return;
  }
  if (!process.env.TMUX) {
    if (hasInteractiveTerminal()) attachTmuxSession(name);
    else explainDetachedStart(name);
  } else switchTmuxClient(name);
}

/**
 * Returns true when a binary exists on PATH.
 *
 * @param {string} name - Binary name to check.
 * @returns {boolean} True when the binary is available.
 * @example
 *   hasBinary("a2a-dashboard");
 */
function hasBinary(name) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  const r = spawnSync(
    "sh",
    ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return r.status === 0;
}
/**
 * Builds the dashboard command-center argv.
 *
 * @param {string} viewSession - Tmux dashboard session name.
 * @param {string[]} members - Agent ids linked into the dashboard.
 * @returns {string[]} Command argv for the Bubble Tea dashboard.
 * @example
 *   const argv = buildDashboardControlArgv("team-view", ["alice", "bob"]);
 */
function buildDashboardControlArgv(viewSession, members) {
  const args = [
    "--session",
    viewSession,
    ...members.flatMap((member, index) => [
      "--member",
      `${member}:${index + 1}`,
    ]),
  ];
  if (process.env.A2A_DASHBOARD_BIN || hasBinary(DASHBOARD_BUBBLE_TEA_BIN)) {
    return [DASHBOARD_BUBBLE_TEA_BIN, ...args];
  }
  if (hasBinary("go")) {
    return ["go", "-C", DASHBOARD_BUBBLE_TEA_DIR, "run", ".", ...args];
  }
  // No Bubble Tea binary and no Go toolchain: exec'ing `go run` would kill
  // window 0 instantly and fail the whole dashboard build. Fall back to the
  // built-in Node command center, which speaks the same --session/--member
  // contract.
  return [process.execPath, DASHBOARD_TUI_SCRIPT, ...args];
}
/**
 * Builds the tmux command used for dashboard window 0.
 *
 * @param {string} viewSession - Tmux dashboard session name.
 * @param {string[]} members - Agent ids linked into the dashboard.
 * @returns {string} Shell command executed in the dashboard command window.
 * @example
 *   const command = buildDashboardControlCommand("team-view", ["alice", "bob"]);
 */
function buildDashboardControlCommand(viewSession, members) {
  return `exec ${buildDashboardControlArgv(viewSession, members).map(shellQuote).join(" ")}`;
}

function pinDashboardCommandWindow(viewSession) {
  const current = tmux([
    "display-message",
    "-p",
    "-t",
    `${viewSession}:command`,
    "#{window_index}",
  ]);
  if (current.status !== 0) {
    // The command window can die before we pin it (dashboard process
    // crashed). The member windows are still linked below, so warn and keep
    // the view alive instead of failing the whole build.
    info(
      `  warning: dashboard '${viewSession}' command window lookup failed: ${(current.stderr || "").trim() || "unknown"}`,
    );
    return;
  }
  if ((current.stdout || "").trim() === "0") return;
  const moved = tmux([
    "move-window",
    "-s",
    `${viewSession}:command`,
    "-t",
    `${viewSession}:0`,
  ]);
  if (moved.status !== 0) {
    info(
      `  warning: dashboard '${viewSession}' command window pin failed: ${(moved.stderr || "").trim() || "unknown"}`,
    );
  }
}

/**
 * Selects the command-center window for a dashboard session. A missing
 * window 0 (e.g. the dashboard process died) is downgraded to a warning: the
 * member windows are still valid, so the view must survive.
 *
 * @param {string} viewSession - Dashboard tmux session name.
 * @returns {boolean} True when window 0 was selected.
 * @example
 *   selectDashboardCommandWindow("credit-team-view");
 */
function selectDashboardCommandWindow(viewSession) {
  const selected = tmux(["select-window", "-t", `${viewSession}:0`]);
  if (selected.status !== 0) {
    info(
      `  warning: dashboard '${viewSession}' command window select failed: ${(selected.stderr || "").trim() || "unknown"}`,
    );
    return false;
  }
  return true;
}

function openExistingDashboardView(viewSession) {
  const target = selectDashboardCommandWindow(viewSession)
    ? `${viewSession}:0`
    : viewSession;
  if (process.env.TMUX) {
    switchTmuxClient(target);
    return;
  }
  if (hasInteractiveTerminal()) {
    attachTmuxSession(target);
    return;
  }
  info(`dashboard '${viewSession}' is already running`);
  info(
    "  detached dashboard: this shell is not interactive, so auto-attach was skipped",
  );
  info(`  attach later: a2a attach ${viewSession}`);
}

/**
 * Creates the linked-window dashboard view and attaches to the command center.
 *
 * @param {string} viewSession - Dashboard tmux session name.
 * @param {string[]} members - Agent session names to link into the dashboard.
 * @param {string} cwd - Working directory for the command-center window.
 * @returns {void}
 * @example
 *   createDashboardView("team-view", ["alice", "bob"], process.cwd());
 */
function createDashboardView(viewSession, members, cwd) {
  if (!Array.isArray(members) || members.length === 0) {
    die(`dashboard '${viewSession}' needs at least one member`, 1);
  }
  if (tmuxSessionExists(viewSession)) {
    const killed = tmux(["kill-session", "-t", viewSession]);
    if (killed.status !== 0) {
      die(
        `dashboard '${viewSession}' replace failed: ${(killed.stderr || "").trim() || "unknown"}`,
        1,
      );
    }
  }
  const created = tmux([
    "new-session",
    "-d",
    "-s",
    viewSession,
    "-n",
    "command",
    "-c",
    cwd,
    buildDashboardControlCommand(viewSession, members),
  ]);
  if (created.status !== 0) {
    die(
      `dashboard '${viewSession}' create failed: ${(created.stderr || "").trim() || "unknown"}`,
      1,
    );
  }
  tmuxSetInstallToken(viewSession, installToken());
  pinDashboardCommandWindow(viewSession);
  for (const [index, member] of members.entries()) {
    const windowIndex = index + 1;
    const linked = tmux([
      "link-window",
      "-d",
      "-s",
      `${member}:0`,
      "-t",
      `${viewSession}:${windowIndex}`,
    ]);
    if (linked.status !== 0) {
      tmux(["kill-session", "-t", viewSession]);
      die(
        `failed to link ${member} into '${viewSession}:${windowIndex}': ${(linked.stderr || "").trim() || "unknown"}`,
        1,
      );
    }
    const renamed = tmux([
      "rename-window",
      "-t",
      `${viewSession}:${windowIndex}`,
      member,
    ]);
    if (renamed.status !== 0) {
      info(
        `  warning: failed to name window ${windowIndex}: ${(renamed.stderr || "").trim() || "unknown"}`,
      );
    }
    info(`  window ${windowIndex}: ${member}`);
  }
  const commandWindowSelected = selectDashboardCommandWindow(viewSession);
  const attachTarget = commandWindowSelected ? `${viewSession}:0` : viewSession;
  if (commandWindowSelected) info("  window 0: command");
  info(
    "  command center: 1-9 quick jump, Enter open, ! attention, ? help, : commands, m message, a ask",
  );
  if (process.env.TMUX) {
    switchTmuxClient(attachTarget);
  } else if (hasInteractiveTerminal()) {
    attachTmuxSession(attachTarget);
  } else {
    info(
      "  detached dashboard: this shell is not interactive, so auto-attach was skipped",
    );
    info(`  attach later: a2a attach ${viewSession}`);
  }
}

function warnExistingGroupMemberArgs(agentId, groupName) {
  info(
    `  ${agentId}: warning: backend args will be recorded but won't apply to the running process`,
  );
  info(
    `  to apply, restart the group: a2a kill ${groupName} && a2a start ${groupName}`,
  );
}

function warnExistingTeamAgentArgs(agentId, restartTarget) {
  info(
    `  ${agentId}: warning: backend args will be recorded but won't apply to the running process`,
  );
  info(
    `  to apply, restart the runtime group: a2a kill ${restartTarget} && a2a start ${restartTarget}`,
  );
}

async function startGroup(groupName, backend, backendArgs, opts = {}) {
  const backendCommand = backendCommandOverrideFor(backend, opts);
  const displayBackendCommand = resolvedBackendCommand(backend, opts);
  requireBackendCommand(backend, { backendCommand });

  const members = listGroupMembers(groupName);
  if (members.length === 0) die(`group '${groupName}' has no .md files`);
  assertUniqueIds(
    members.map((member) => member.name),
    `group '${groupName}' members`,
  );
  const cohortName = opts.cohort || groupName;
  const cohortKind = opts.cohort
    ? opts.cohortKind === "team"
      ? "team"
      : "group"
    : "group";
  info(`starting group '${groupName}' (${members.length} characters)`);

  const spawned = [];
  /** @type {Map<string,"tmux"|"iterm">} */
  const spawnedTransport = new Map();
  /** @type {string|null} */
  let groupWindowGuid = null;
  for (const char of members) {
    validateAgentId(char.name);
    const prompt = readFileSync(char.fullPath, "utf8").trim();
    const delivery = preparePersonaDelivery(
      backend,
      backendArgs,
      composePersona(char.name, prompt, []),
      { backendCommand },
    );
    const memberArgs = delivery.backendArgs;
    let createdSessionForThisAgent = false;
    /** @type {"tmux"|"iterm"} */
    let agentTransport;
    /** @type {string|null} */
    let agentTmuxTarget;
    /** @type {string|null} */
    let agentItermGuid;
    const alive = await probeAgentAlive(char.name);
    if (!alive.alive) {
      createdSessionForThisAgent = true;
      const command = buildAgentLaunchCommand(backend, memberArgs, {
        env: agentEnv(char.name),
        backendCommand,
      });
      const spawnedChar = await spawnAgentInPlace({
        name: char.name,
        cwd: process.cwd(),
        command,
        backend,
        parentItermGuid: groupWindowGuid,
      });
      if (!spawnedChar.ok) {
        info(`  ${char.name}: FAILED: ${spawnedChar.error || "spawn failed"}`);
        continue;
      }
      agentTransport = spawnedChar.transport;
      agentTmuxTarget = spawnedChar.tmuxTarget || null;
      agentItermGuid = spawnedChar.itermGuid || null;
      if (agentTransport === "iterm" && !groupWindowGuid) {
        groupWindowGuid = agentItermGuid;
      }
      if (agentTransport === "tmux") {
        tmuxSetInstallToken(char.name, installToken());
        spawnSync("sleep", ["1"]);
        if (!tmuxSessionExists(char.name)) {
          info(
            `  ${char.name}: FAILED: ${sessionStartupError(char.name, backend)}`,
          );
          continue;
        }
      } else {
        spawnSync("sleep", ["1"]);
      }
      if (delivery.startupPrompt) {
        const pasted = await pasteStartupPromptToAgent({
          tmuxTarget: agentTmuxTarget,
          itermGuid: agentItermGuid,
          content: delivery.startupPrompt,
          backend,
        });
        if (!pasted.ok) {
          info(`  ${char.name}: FAILED startup prompt paste: ${pasted.error}`);
          if (agentTransport === "iterm" && agentItermGuid) {
            await closeITerm2Session(agentItermGuid);
          } else {
            tmux(["kill-session", "-t", char.name]);
          }
          continue;
        }
        if (pasted.warning) info(`  ${char.name}: warning: ${pasted.warning}`);
      }
      info(`  ${char.name}: spawned (${agentTransport})`);
    } else {
      agentTransport = alive.transport;
      agentTmuxTarget = alive.tmuxTarget || null;
      agentItermGuid = alive.itermGuid || null;
      info(
        `  ${char.name}: exists (${agentTransport}), re-registering (running ${displayBackendCommand} is unchanged)`,
      );
      if (memberArgs.length || backendCommand) {
        warnExistingGroupMemberArgs(char.name, groupName);
      }
      if (agentTransport === "tmux") {
        tmuxSetInstallToken(char.name, installToken());
      }
      if (delivery.startupPrompt) {
        const pasted = await pasteStartupPromptToAgent({
          tmuxTarget: agentTmuxTarget,
          itermGuid: agentItermGuid,
          content: delivery.startupPrompt,
          backend,
        });
        if (pasted.ok)
          info(
            pasted.warning
              ? `  ${char.name}: warning: ${pasted.warning}`
              : `  ${char.name}: startup prompt pasted into the running process`,
          );
        else
          info(
            `  ${char.name}: warning: startup prompt paste failed: ${pasted.error}`,
          );
      }
    }
    if (!agentTmuxTarget && !agentItermGuid) {
      info(`  ${char.name}: FAILED: no delivery target after spawn`);
      continue;
    }
    const agentRegisterTarget = agentTmuxTarget || `${char.name}:0.0`;
    try {
      const { status, body } = await request("POST", "/api/a2a/register", {
        agentId: char.name,
        tmuxTarget: agentRegisterTarget,
        ...(agentItermGuid ? { itermGuid: agentItermGuid } : {}),
        description: `${cohortKind}:${cohortName}`,
        cwd: process.cwd(),
        backend,
        backendArgs: memberArgs,
        ...backendCommandPayload(backendCommand),
        backendEnv: agentEnv(char.name),
        installToken: installToken(),
        ...(typeof opts.yolo === "boolean" ? { yolo: opts.yolo } : {}),
        ...(delivery.startupPrompt
          ? { startupPrompt: delivery.startupPrompt }
          : {}),
        ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
      });
      if (status !== 200 || !body?.success) {
        info(
          `  ${char.name}: FAILED register: ${body?.error || `HTTP ${status}`}`,
        );
        if (createdSessionForThisAgent) {
          if (agentTransport === "iterm" && agentItermGuid) {
            await closeITerm2Session(agentItermGuid);
          } else {
            tmux(["kill-session", "-t", char.name]);
          }
        }
        continue;
      }
      spawned.push(char.name);
      spawnedTransport.set(char.name, agentTransport);
    } catch (e) {
      info(`  ${char.name}: FAILED register: ${e.message}`);
      if (createdSessionForThisAgent) {
        if (agentTransport === "iterm" && agentItermGuid) {
          await closeITerm2Session(agentItermGuid);
        } else {
          tmux(["kill-session", "-t", char.name]);
        }
      }
    }
  }

  spawnSync("sleep", ["2"]);
  info("");
  if (spawned.length === 0) {
    die(`group '${groupName}' failed to start any members`, 1);
  }
  info(`group '${groupName}' ready: ${spawned.join(", ")}`);

  const tmuxSpawned = spawned.filter(
    (id) => spawnedTransport.get(id) === "tmux",
  );
  const itermSpawned = spawned.filter(
    (id) => spawnedTransport.get(id) === "iterm",
  );
  if (opts.dashboard && tmuxSpawned.length >= 1) {
    createDashboardView(`${cohortName}-view`, tmuxSpawned, process.cwd());
    if (itermSpawned.length > 0) {
      info(
        `  note: ${itermSpawned.join(", ")} spawned via iTerm — open via 'a2a attach <name>'`,
      );
    }
  } else {
    if (opts.dashboard && tmuxSpawned.length === 0) {
      info(
        `  dashboard skipped: all members spawned via iTerm (link-window is tmux-only)`,
      );
    }
    info("  peek:    a2a peek <n>");
    info("  message: a2a --<n> 'hello'");
    info(`  kill:    a2a kill ${cohortName}`);
    if (!process.env.TMUX && spawned.length > 0) {
      if (hasInteractiveTerminal()) {
        const firstTmuxId = tmuxSpawned[0];
        if (firstTmuxId) attachTmuxSession(firstTmuxId);
        else info(`  iterm: members live in their own windows`);
      } else {
        info(
          "  detached start: this shell is not interactive, so auto-attach was skipped",
        );
        info(`  attach later: a2a attach ${spawned[0]}`);
      }
    }
  }
}

async function startTeam(teamSpec, opts = {}) {
  const spawned = [];
  // Track per-agent transport so the post-spawn dashboard step skips
  // iTerm-backed agents (tmux link-window only handles tmux sessions).
  /** @type {Map<string,"tmux"|"iterm">} */
  const spawnedTransport = new Map();
  // First iTerm-spawned agent of the team opens a new window; subsequent
  // agents open as tabs in that same window via parent_guid.
  /** @type {string|null} */
  let teamWindowGuid = null;
  const cohortName = opts.cohort || teamSpec.name;
  info(`starting team '${teamSpec.name}' (${teamSpec.agents.length} agents)`);

  for (const agent of teamSpec.agents) {
    validateAgentId(agent.id);
    const backendCommand = backendCommandOverrideFor(agent.backend, opts);
    const displayBackendCommand = resolvedBackendCommand(agent.backend, {
      backendCommand,
    });
    requireBackendCommand(agent.backend, { backendCommand });
    // Effective yolo per agent: the CLI-level opt-out (--no-yolo, surfaced
    // as `opts.yolo === false`) forces off; otherwise honor agent.yolo.
    // translateTeamAgentArgs already encodes this for the argv; we mirror
    // the same logic here so the bridge sees the same authority state.
    const effectiveYolo = teamAgentEffectiveYolo(agent, opts.yolo);
    const baseArgs = translateTeamAgentArgs(agent, opts.yolo);
    const delivery = preparePersonaDelivery(
      agent.backend,
      baseArgs,
      composePersona(agent.id, agent.rolePrompt, []),
      { env: agent.env, backendCommand },
    );
    const launchArgs = delivery.backendArgs;
    let createdSessionForThisAgent = false;
    /** @type {"tmux"|"iterm"} */
    let agentTransport;
    /** @type {string|null} */
    let agentTmuxTarget;
    /** @type {string|null} */
    let agentItermGuid;
    const cohortKind = opts.cohortKind || "team";
    const alive = await probeAgentAlive(agent.id);
    if (!alive.alive) {
      createdSessionForThisAgent = true;
      const command = buildAgentLaunchCommand(agent.backend, launchArgs, {
        env: agentEnv(agent.id, agent.env),
        backendCommand,
      });
      const spawnedAgent = await spawnAgentInPlace({
        name: agent.id,
        cwd: agent.cwd,
        command,
        backend: agent.backend,
        parentItermGuid: teamWindowGuid,
      });
      if (!spawnedAgent.ok) {
        info(`  ${agent.id}: FAILED: ${spawnedAgent.error || "spawn failed"}`);
        continue;
      }
      if (spawnedAgent.transport === "iterm" && !teamWindowGuid) {
        teamWindowGuid = spawnedAgent.itermGuid || null;
      }
      agentTransport = spawnedAgent.transport;
      agentTmuxTarget = spawnedAgent.tmuxTarget || null;
      agentItermGuid = spawnedAgent.itermGuid || null;
      if (agentTransport === "tmux") {
        tmuxSetInstallToken(agent.id, installToken());
        spawnSync("sleep", ["1"]);
        if (!tmuxSessionExists(agent.id)) {
          info(
            `  ${agent.id}: FAILED: ${sessionStartupError(agent.id, agent.backend)}`,
          );
          continue;
        }
      } else {
        spawnSync("sleep", ["1"]);
      }
      if (delivery.startupPrompt) {
        const pasted = await pasteStartupPromptToAgent({
          tmuxTarget: agentTmuxTarget,
          itermGuid: agentItermGuid,
          content: delivery.startupPrompt,
          backend: agent.backend,
        });
        if (!pasted.ok) {
          info(`  ${agent.id}: FAILED startup prompt paste: ${pasted.error}`);
          if (agentTransport === "iterm" && agentItermGuid) {
            await closeITerm2Session(agentItermGuid);
          } else {
            tmux(["kill-session", "-t", agent.id]);
          }
          continue;
        }
        if (pasted.warning) info(`  ${agent.id}: warning: ${pasted.warning}`);
      }
      info(`  ${agent.id}: spawned (${agent.backend}, ${agentTransport})`);
    } else {
      agentTransport = alive.transport;
      agentTmuxTarget = alive.tmuxTarget || null;
      agentItermGuid = alive.itermGuid || null;
      info(
        `  ${agent.id}: exists (${agentTransport}), re-registering (running ${displayBackendCommand} is unchanged)`,
      );
      if (launchArgs.length || backendCommand) {
        warnExistingTeamAgentArgs(agent.id, cohortName);
      }
      if (agentTransport === "tmux") {
        tmuxSetInstallToken(agent.id, installToken());
      }
      if (delivery.startupPrompt) {
        const pasted = await pasteStartupPromptToAgent({
          tmuxTarget: agentTmuxTarget,
          itermGuid: agentItermGuid,
          content: delivery.startupPrompt,
          backend: agent.backend,
        });
        if (pasted.ok)
          info(
            pasted.warning
              ? `  ${agent.id}: warning: ${pasted.warning}`
              : `  ${agent.id}: startup prompt pasted into the running process`,
          );
        else
          info(
            `  ${agent.id}: warning: startup prompt paste failed: ${pasted.error}`,
          );
      }
    }
    if (!agentTmuxTarget && !agentItermGuid) {
      info(`  ${agent.id}: FAILED: no delivery target after spawn`);
      continue;
    }
    const agentRegisterTarget = agentTmuxTarget || `${agent.id}:0.0`;
    try {
      const { status, body } = await request("POST", "/api/a2a/register", {
        agentId: agent.id,
        tmuxTarget: agentRegisterTarget,
        ...(agentItermGuid ? { itermGuid: agentItermGuid } : {}),
        description: `${cohortKind}:${cohortName}`,
        cwd: agent.cwd,
        backend: agent.backend,
        backendArgs: launchArgs,
        ...backendCommandPayload(backendCommand),
        backendEnv: agentEnv(agent.id, agent.env),
        installToken: installToken(),
        yolo: effectiveYolo,
        ...(delivery.startupPrompt
          ? { startupPrompt: delivery.startupPrompt }
          : {}),
        ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
      });
      if (status !== 200 || !body?.success) {
        info(
          `  ${agent.id}: FAILED register: ${body?.error || `HTTP ${status}`}`,
        );
        if (createdSessionForThisAgent) {
          if (agentTransport === "iterm" && agentItermGuid) {
            await closeITerm2Session(agentItermGuid);
          } else {
            tmux(["kill-session", "-t", agent.id]);
          }
        }
        continue;
      }
      spawned.push(agent.id);
      spawnedTransport.set(agent.id, agentTransport);
    } catch (err) {
      info(`  ${agent.id}: FAILED register: ${err.message}`);
      if (createdSessionForThisAgent) {
        if (agentTransport === "iterm" && agentItermGuid) {
          await closeITerm2Session(agentItermGuid);
        } else {
          tmux(["kill-session", "-t", agent.id]);
        }
      }
    }
  }

  spawnSync("sleep", ["2"]);
  info("");
  if (spawned.length === 0) {
    die(`team '${teamSpec.name}' failed to start any agents`, 1);
  }
  info(
    opts.cohort
      ? `team '${teamSpec.name}' ready in cohort '${cohortName}': ${spawned.join(", ")}`
      : `team '${teamSpec.name}' ready: ${spawned.join(", ")}`,
  );

  // Linked-window dashboards are tmux-only. iTerm-spawned agents can't be
  // link-window'd into a tmux view, so filter them out before building the
  // dashboard; skip the view entirely if no tmux members remain.
  const tmuxSpawned = spawned.filter(
    (id) => spawnedTransport.get(id) === "tmux",
  );
  const itermSpawned = spawned.filter(
    (id) => spawnedTransport.get(id) === "iterm",
  );
  const wantDashboard = opts.dashboard ?? teamSpec.dashboard;
  if (wantDashboard && tmuxSpawned.length >= 1) {
    createDashboardView(
      `${cohortName}-view`,
      tmuxSpawned,
      teamSpec.agents[0]?.cwd || process.cwd(),
    );
    if (itermSpawned.length > 0) {
      info(
        `  note: ${itermSpawned.join(", ")} spawned via iTerm — open via 'a2a attach <name>'`,
      );
    }
  } else {
    if (wantDashboard && tmuxSpawned.length === 0) {
      info(
        `  dashboard skipped: all agents spawned via iTerm (link-window is tmux-only)`,
      );
    }
    info("  peek:    a2a peek <n>");
    info("  message: a2a --<n> 'hello'");
    info(`  kill:    a2a kill ${cohortName}`);
    if (!process.env.TMUX && spawned.length > 0) {
      if (hasInteractiveTerminal()) {
        // For iterm-spawned agents bring iTerm forward via the bridge focus
        // op; for tmux-spawned agents attach the tmux session in-place.
        const firstTmuxId = tmuxSpawned[0];
        const firstItermId = itermSpawned[0];
        if (firstTmuxId) attachTmuxSession(firstTmuxId);
        else if (firstItermId) {
          // The iTerm window already came to the front during spawn; nothing
          // to do here. Log a hint so the user knows the agents are live.
          info(`  iterm: agents live in their own windows`);
        }
      } else {
        info(
          "  detached start: this shell is not interactive, so auto-attach was skipped",
        );
        info(`  attach later: a2a attach ${spawned[0]}`);
      }
    }
  }
}

/**
 * Resolve the effective "global mode" boolean for a start invocation.
 *
 *   CLI flag (--global / --no-global)  → wins
 *   config.json `global`               → fallback
 *   defaults                           → false
 *
 * Kept as a separate function so the resolution order is auditable and so
 * `cmdStartGlobal` (the legacy alias) can short-circuit to true without
 * re-deriving the precedence rules.
 *
 * @param {boolean | null} cliGlobal - tri-state from parseStartArgs
 * @returns {boolean}
 */
function resolveGlobalMode(cliGlobal) {
  if (cliGlobal === true || cliGlobal === false) return cliGlobal;
  const cfg = loadConfig();
  return cfg.global === true;
}

function resolveGlobalTunnelPort(portFlag) {
  return portFlag || String(activePort());
}

async function cmdStart(args) {
  const parsed = parseStartArgsForCli(args);
  const {
    name: rawName,
    backend,
    backendCommand: rawBackendCommand,
    backendArgs,
    dashboard,
    promptText,
    skills,
    yolo,
    teamFile,
    cohort,
  } = parsed;
  const isGlobal = resolveGlobalMode(parsed.global);
  const hasPersona = Boolean(promptText || skills.length);
  const backendCommand = normalizeBackendCommand(
    rawBackendCommand,
    process.cwd(),
  );
  const backendCommands = backendCommand ? { [backend]: backendCommand } : {};

  // Explicit --team-file wins over name-based discovery and errors loudly
  // on a missing path so a typo can't silently fall through to single-agent.
  const explicitTeamSpec = teamFile
    ? loadTeamSpecFromFile(teamFile, process.cwd(), rawName)
    : null;
  const teamSpec =
    explicitTeamSpec ||
    (rawName ? loadResolvedTeamSpec(rawName, process.cwd()) : null);
  if (teamSpec && hasPersona)
    die(
      `--prompt/--prompt-file/--skill cannot be combined with team spec '${teamFile || rawName}'; configure agents in the team file (role/role_file)`,
    );

  const name = rawName
    ? normalizeDeclaredAgentId(rawName, rawName, "agent name")
    : sanitizeId(basename(process.cwd()));
  if (!teamSpec && isGroup(name) && hasPersona)
    die(
      `--prompt/--prompt-file/--skill cannot be combined with group '${name}'; group members already inject their own prompts from the group's .md files`,
    );

  // --insecure / --url= / --port= are global-mode-only flags. Keep parsing
  // and filtering even in local mode so a stray flag doesn't leak into the
  // backend's argv (claude doesn't recognise --insecure). In local mode,
  // setting any of these is a user error worth surfacing.
  const {insecure} = parsed;
  const urlFlag = parsed.url;
  const portFlag = parsed.port;
  const filteredBackendArgs = backendArgs;
  if (!isGlobal && (insecure || urlFlag || portFlag)) {
    die(
      "--insecure, --url=, and --port= require global mode; pass --global or `a2a config set global true`",
    );
  }
  if (!isGlobal && dashboard === true) {
    const dashboardRef = teamSpec
      ? cohort || teamSpec.name
      : isGroup(name)
        ? cohort || name
        : null;
    const viewSession = dashboardRef ? `${dashboardRef}-view` : null;
    if (viewSession && tmuxSessionExists(viewSession)) {
      openExistingDashboardView(viewSession);
      return;
    }
  }

  const effectiveBackendArgs = applyCliYolo(
    backend,
    filteredBackendArgs,
    yolo,
    name,
  );
  // Persona/delivery only apply to the single-agent path. Team and group
  // starts discard the cmdStart-level persona (members compose their own
  // from role/role_file or the group's .md files), so computing it there
  // would only log a misleading `persona:` line — composePersona always
  // returns non-empty text.
  const singleAgentStart = !teamSpec && !isGroup(name);
  const personaText = singleAgentStart
    ? composePersona(name, promptText, skills)
    : "";
  if (personaText) info(`persona: ${describePersona(promptText, skills)}`);
  const delivery = preparePersonaDelivery(
    backend,
    effectiveBackendArgs,
    personaText,
    { backendCommand },
  );

  // Resolve cohort membership BEFORE the spawn so we can:
  //   (a) tell the operator whether this is joining N existing members vs
  //       seeding a brand-new cohort (typo guard — silent creation hides
  //       fat-finger mistakes like `credit-implementor` vs `-implementer`);
  //   (b) choose the right description prefix (`group:` if the existing
  //       cohort is group-style) so `a2a kill <cohort>` reaps the joiner;
  //   (c) gate the post-spawn dashboard `link-window` to the join case.
  const cohortJoin = cohort ? await resolveCohortJoin(cohort) : null;
  if (cohortJoin) {
    if (cohortJoin.isJoin) {
      const n = cohortJoin.members.length;
      info(
        `joining ${cohortJoin.kind} cohort '${cohort}' (${n} existing member${n === 1 ? "" : "s"})`,
      );
    } else {
      info(`starting new cohort '${cohort}' (no existing members)`);
    }
  }
  const cohortKind = cohortJoin?.kind || "team";
  const joinExistingCohort = Boolean(cohortJoin?.isJoin);

  if (!isGlobal) {
    // ── local mode ────────────────────────────────────────────────────────
    if (teamSpec) {
      await startTeam(teamSpec, {
        dashboard,
        yolo,
        cohort,
        cohortKind,
        backendCommands,
      });
      return;
    }
    if (isGroup(name)) {
      await startGroup(name, backend, effectiveBackendArgs, {
        dashboard,
        yolo,
        cohort,
        cohortKind,
        backendCommand,
      });
      return;
    }
    await startSingle(name, backend, delivery.backendArgs, {
      startupPrompt: delivery.startupPrompt,
      yolo,
      cohort,
      cohortKind,
      joinExistingCohort,
      dashboard,
      backendCommand,
    });
    return;
  }

  // ── global mode ─────────────────────────────────────────────────────────
  if (!activeKey() && !insecure) {
    die(
      "global start exposes the bridge and requires an operator key; run `a2a config set key <secret>` or pass --insecure",
      1,
    );
  }
  if (insecure)
    info(
      "warning: exposing bridge without an operator key because --insecure was supplied",
    );

  async function resolveNgrok(localPort) {
    try {
      const u = await getNgrokUrl(localPort);
      info("ngrok already running");
      return u;
    } catch {
      info(`starting ngrok on port ${localPort}...`);
      await startNgrok(localPort);
      return getNgrokUrl(localPort);
    }
  }

  function persistPublicUrl(url) {
    if (!url) return;
    const normalized = normalizePeerUrlForConfig(url);
    try {
      if (activeUrl() === normalized) return;
      configSet("url", normalized);
      info(`saved public url to config: ${normalized}`);
    } catch (err) {
      info(`could not save public url to config: ${err.message}`);
    }
  }

  // Non-cohort global single-agent starts get a distinct description
  // (`a2a start --global: <cwd>` instead of `a2a start: <cwd>`) so the
  // bridge log makes the global mode visible. Cohort starts let startSingle
  // do the formatting from opts.cohort + opts.cohortKind so the join +
  // dashboard-link path stays unified with local mode.
  const nonCohortDescription = `a2a start --global: ${process.cwd()}`;

  if (urlFlag) {
    const remoteUrl = normalizePeerUrlForConfig(urlFlag);
    const localPort = resolveGlobalTunnelPort(portFlag);
    process.env.A2A_BRIDGE = remoteUrl;
    requireBinary("ngrok");
    const publicUrl = await resolveNgrok(localPort);
    // eslint-disable-next-line require-atomic-updates -- publicUrl is a local const, not stale state
    process.env.A2A_BRIDGE_PUBLIC = publicUrl;
    info(`remote bridge: ${remoteUrl}`);
    info(`replies route via: ${publicUrl}`);
    if (teamSpec) {
      await startTeam(teamSpec, {
        bridgeUrl: publicUrl,
        dashboard,
        yolo,
        cohort,
        cohortKind,
        backendCommands,
      });
      return;
    }
    if (isGroup(name)) {
      await startGroup(name, backend, effectiveBackendArgs, {
        bridgeUrl: publicUrl,
        dashboard,
        yolo,
        cohort,
        cohortKind,
        backendCommand,
      });
      return;
    }
    await startSingle(name, backend, delivery.backendArgs, {
      ...(cohort
        ? { cohort, cohortKind, joinExistingCohort }
        : { description: nonCohortDescription }),
      bridgeUrl: publicUrl,
      startupPrompt: delivery.startupPrompt,
      yolo,
      dashboard,
      backendCommand,
    });
    return;
  }

  requireBinary("ngrok");
  const port = resolveGlobalTunnelPort(portFlag);
  const storedUrl = activeUrl();
  const publicUrl = await resolveNgrok(port);
  persistPublicUrl(publicUrl);
  if (storedUrl && storedUrl !== publicUrl) {
    info(
      `note: stored url (${storedUrl}) differs from live ngrok tunnel (${publicUrl}); using live tunnel`,
    );
  }
  info(`bridge exposed at: ${publicUrl}`);
  info("");
  info("share with peers:");
  info(`  a2a start --global --url=${publicUrl}`);
  info("");
  if (teamSpec) {
    await startTeam(teamSpec, {
      bridgeUrl: publicUrl,
      dashboard,
      yolo,
      cohort,
      cohortKind,
      backendCommands,
    });
    return;
  }
  if (isGroup(name)) {
    await startGroup(name, backend, effectiveBackendArgs, {
      bridgeUrl: publicUrl,
      dashboard,
      yolo,
      cohort,
      cohortKind,
      backendCommand,
    });
    return;
  }
  await startSingle(name, backend, delivery.backendArgs, {
    ...(cohort
      ? { cohort, cohortKind, joinExistingCohort }
      : { description: nonCohortDescription }),
    bridgeUrl: publicUrl,
    startupPrompt: delivery.startupPrompt,
    yolo,
    dashboard,
    backendCommand,
  });
}

/**
 * Legacy alias for `a2a start --global`. Forwards through cmdStart with
 * `--global` injected so the two code paths share one implementation. Kept
 * for backwards compatibility with scripts and muscle memory; the canonical
 * surface is now `a2a start --global` (or `a2a config set global true`).
 */
async function cmdStartGlobal(rawArgs) {
  const args =
    !rawArgs.includes("--global") && !rawArgs.includes("--no-global")
      ? ["--global", ...rawArgs]
      : rawArgs;
  await cmdStart(args);
}

/**
 * Pattern bank for "the thing we're cleaning up is already gone" errors. The
 * iTerm bridge returns "unknown session: <guid>" when the GUID has been
 * invalidated (window closed, iTerm restarted). For a kill/close consumer
 * that is exactly the desired terminal state, not a failure.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isBenignSessionGoneError(err) {
  if (typeof err !== "string" || !err) return false;
  return (
    /unknown session/i.test(err) ||
    /no such session/i.test(err) ||
    /session not found/i.test(err) ||
    /already closed/i.test(err)
  );
}

async function killOne(id, knownAgent = undefined) {
  // Per-transport kill: if the registered agent has an itermGuid we close
  // the iTerm session via the bridge; otherwise we follow the tmux
  // kill-session + unlink path.
  let agent = knownAgent === undefined ? null : knownAgent;
  if (knownAgent === undefined) {
    try {
      const agents = await listAgents();
      agent = agents.find((a) => a.agentId === id) || null;
    } catch {
      /* bridge may be unreachable; fall back to tmux-only kill */
    }
  }

  let tmuxMsg = "no session";
  let tmuxOk = true;
  if (agent?.itermGuid && !(await probeBridgeReachable())) {
    // iTerm-backed agent but the iTerm bridge is down: the window may still
    // be running and we cannot reach it. Falling through to the tmux path
    // would "succeed" with no session, unregister the agent, and orphan the
    // live iTerm window. Refuse and tell the operator the fix instead.
    return {
      ok: false,
      tmuxMsg: "iterm bridge unreachable; cannot close the iTerm window",
      regMsg:
        "skipped (run 'a2a bridge iterm start' and retry, or close the window manually)",
    };
  }
  if (agent?.itermGuid) {
    const r = await closeITerm2Session(agent.itermGuid);
    if (r.ok) {
      tmuxMsg = "iterm session closed";
      invalidateITermSessionCache();
    } else if (isBenignSessionGoneError(r.error)) {
      // The window was already closed (user cmd-W, iTerm restart, parent
      // window closed). The goal of kill is "agent is gone" — it already
      // is. Constraint 9: structured benign cleanup is ok.
      tmuxMsg = "iterm session already gone";
    } else {
      tmuxOk = false;
      tmuxMsg = `iterm close failed: ${r.error || "unknown"}`;
    }
  } else {
    // Capture the window_id of the agent's window 0 BEFORE killing the source
    // session. `tmux kill-session` only unlinks the window from that session;
    // any *-view dashboard (or user's inline-attach tmux session per
    // createDashboardView's self-link branch) keeps the window — and its
    // child process — alive. After kill-session we revisit window_id and
    // kill the window everywhere it's still linked.
    const token = installToken();
    const sessionExists = tmuxSessionExists(id);
    const windowId = sessionExists
      ? tmuxWindowIdOf(`${id}:0`)
      : tmuxWindowIdByName(id, token);

    if (sessionExists) {
      const r = tmux(["kill-session", "-t", id]);
      tmuxOk = r.status === 0;
      tmuxMsg = tmuxOk
        ? "killed"
        : `kill failed: ${(r.stderr || "").trim() || "unknown"}`;
    }

    if (windowId && tmuxWindowExists(windowId)) {
      const r = tmux(["kill-window", "-t", windowId]);
      const linkOk = r.status === 0;
      if (linkOk) tmuxMsg = `${tmuxMsg} + unlinked from view`;
      else {
        tmuxOk = false;
        tmuxMsg = `${tmuxMsg}; window unlink failed: ${(r.stderr || "").trim() || "unknown"}`;
      }
    }
  }

  let regMsg, regOk;
  try {
    const { status, body } = await request(
      "DELETE",
      `/api/a2a/register/${encodeURIComponent(id)}`,
    );
    regOk = status === 200 && Boolean(body?.success);
    regMsg = regOk
      ? body.data?.removed
        ? "unregistered"
        : "not registered"
      : `unreg failed: ${body?.error || `HTTP ${status}`}`;
  } catch (e) {
    regOk = false;
    regMsg = `unreg failed: ${e.message}`;
  }
  // Prune the killed agent from the cached registry so registry.json doesn't
  // accumulate stale IDs. Do this regardless of whether the bridge DELETE
  // succeeded — the process is gone either way.
  try {
    const cached = loadRegistry();
    const agents = Array.isArray(cached.agents)
      ? cached.agents.filter((a) => a !== id)
      : [];
    saveRegistry({ ...cached, agents });
  } catch {
    /* non-fatal — registry will self-heal on next getRegistry() call */
  }

  return { ok: tmuxOk && regOk, tmuxMsg, regMsg };
}

async function safeListAgentsForKill() {
  try {
    return await listAgents();
  } catch {
    return [];
  }
}

async function killGroup(groupName) {
  const registeredMembers = (await safeListAgentsForKill()).filter(
    (a) => a.description === `group:${groupName}`,
  );
  const registeredById = new Map(
    registeredMembers.map((agent) => [agent.agentId, agent]),
  );
  const fileMembers = listGroupMembers(groupName).map((m) => ({
    agentId: m.name,
  }));
  const seen = new Set();
  const members = [...registeredMembers, ...fileMembers].filter((m) => {
    if (!m.agentId || seen.has(m.agentId)) return false;
    seen.add(m.agentId);
    return true;
  });
  const viewSession = `${groupName}-view`;
  if (members.length === 0 && !tmuxSessionExists(viewSession)) {
    info(`no registered members for group '${groupName}'`);
    return;
  }
  info(`killing group '${groupName}' (${members.length} members)`);
  let allOk = true;
  for (const m of members) {
    const r = await killOne(m.agentId, registeredById.get(m.agentId) || null);
    process.stdout.write(
      `  ${m.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`,
    );
    if (!r.ok) allOk = false;
  }
  if (tmuxSessionExists(viewSession)) {
    const r = tmux(["kill-session", "-t", viewSession]);
    const ok = r.status === 0;
    process.stdout.write(
      `  ${viewSession}: tmux ${ok ? "killed" : `kill failed: ${(r.stderr || "").trim() || "unknown"}`}, bridge not registered\n`,
    );
    if (!ok) allOk = false;
  }
  if (!allOk) process.exit(1);
}

async function killTeam(teamRef) {
  const spec = loadResolvedTeamSpec(teamRef, process.cwd());
  const teamName = spec?.name || sanitizeId(teamRef);
  const registeredMembers = (await safeListAgentsForKill()).filter(
    (a) => a.description === `team:${teamName}`,
  );
  const registeredById = new Map(
    registeredMembers.map((agent) => [agent.agentId, agent]),
  );
  const specMembers = (spec?.agents || []).map((a) => ({
    agentId: a.id,
  }));
  const seen = new Set();
  const members = [...registeredMembers, ...specMembers].filter((m) => {
    if (!m.agentId || seen.has(m.agentId)) return false;
    seen.add(m.agentId);
    return true;
  });
  const viewSession = `${teamName}-view`;
  if (members.length === 0 && !tmuxSessionExists(viewSession)) {
    info(`no registered members for team '${teamName}'`);
    return;
  }
  info(`killing team '${teamName}' (${members.length} members)`);
  let allOk = true;
  for (const m of members) {
    const r = await killOne(m.agentId, registeredById.get(m.agentId) || null);
    process.stdout.write(
      `  ${m.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`,
    );
    if (!r.ok) allOk = false;
  }
  if (tmuxSessionExists(viewSession)) {
    const r = tmux(["kill-session", "-t", viewSession]);
    const ok = r.status === 0;
    process.stdout.write(
      `  ${viewSession}: tmux ${ok ? "killed" : `kill failed: ${(r.stderr || "").trim() || "unknown"}`}, bridge not registered\n`,
    );
    if (!ok) allOk = false;
  }
  if (!allOk) process.exit(1);
}

async function cmdKill(args) {
  const hasAll = args.includes("--all");
  const filtered = args.filter((a) => a !== "--all");
  let [name] = parseArgs(filtered, {}).positional;
  if (hasAll && name) {
    die("kill --all cannot be combined with a target name", 1);
  }

  if (hasAll || (!name && !currentTmuxSession())) {
    const {
      registeredAgents,
      inventory: inv,
    } = await collectRuntimeSnapshot({ fresh: true });
    const viewsToKill = inv.views.filter((v) => v.existsInTmux);

    if (
      registeredAgents.length === 0 &&
      viewsToKill.length === 0 &&
      inv.orphans.length === 0 &&
      inv.itermOrphans.length === 0
    ) {
      info("no agents registered");
      return;
    }
    info(
      `killing all (${registeredAgents.length} agents, ${viewsToKill.length} views, ${inv.orphans.length} tmux orphans, ${inv.itermOrphans.length} iterm orphans)`,
    );
    let allOk = true;
    for (const agent of registeredAgents) {
      const r = await killOne(agent.agentId, agent);
      process.stdout.write(
        `  ${agent.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`,
      );
      if (!r.ok) allOk = false;
    }
    for (const v of viewsToKill) {
      const r = tmuxKillSession(v.session);
      if (r.skipped) continue;
      const label = v.known ? "view" : "view (unknown cohort)";
      process.stdout.write(
        `  ${v.session}: tmux ${r.ok ? `killed (${label})` : `kill failed: ${r.stderr || "unknown"}`}\n`,
      );
      if (!r.ok) allOk = false;
    }
    for (const orphan of inv.orphans) {
      const r = tmuxKillSessionDeep(orphan);
      if (r.skipped) continue;
      process.stdout.write(
        `  ${orphan}: tmux ${r.ok ? "killed (orphan)" : `kill failed: ${r.stderr || "unknown"}`}\n`,
      );
      if (!r.ok) allOk = false;
    }
    for (const orphan of inv.itermOrphans) {
      const r = await closeITerm2Session(orphan.guid);
      const label = orphan.name || orphan.guid;
      process.stdout.write(
        `  ${label}: iterm ${r.ok ? "killed (orphan)" : `close failed: ${r.error || "unknown"}`}\n`,
      );
      if (!r.ok) allOk = false;
    }
    invalidateITermSessionCache();
    if (!allOk) process.exit(1);
    return;
  }

  if (!name) {
    name = currentTmuxSession();
    if (!name) die("kill needs a name");
  }
  if (loadResolvedTeamSpec(name, process.cwd())) {
    await killTeam(name);
    return;
  }
  if (isGroup(name)) {
    await killGroup(name);
    return;
  }
  try {
    const agents = await listAgents();
    if (agents.filter((a) => a.description === `group:${name}`).length > 0) {
      await killGroup(name);
      return;
    }
    if (agents.filter((a) => a.description === `team:${name}`).length > 0) {
      await killTeam(name);
      return;
    }
    const agent = agents.find((a) => a.agentId === name) || null;
    validateAgentId(name);
    const r = await killOne(name, agent);
    process.stdout.write(`${name}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
    if (!r.ok) process.exit(1);
    return;
  } catch {
    /* fall through */
  }
  validateAgentId(name);
  const r = await killOne(name);
  process.stdout.write(`${name}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
  if (!r.ok) process.exit(1);
}

async function cmdAttach(args) {
  const explicitNativeScroll =
    args.includes("--native-scroll") || args.includes("--cc");
  const wantDashboard =
    args.includes("--dashboard") || args.includes("--layout");
  const wantRebuild = args.includes("--rebuild");
  const filtered = args.filter(
    (a) =>
      a !== "--native-scroll" &&
      a !== "--cc" &&
      a !== "--dashboard" &&
      a !== "--layout" &&
      a !== "--rebuild",
  );
  let [id] = parseArgs(filtered, {}).positional;
  let agents = null;
  if (!id) {
    agents = await listAgents();
    const r = inferPeer(agents, currentTmuxSession());
    if (r.error) die(r.error, 1);
    // eslint-disable-next-line require-atomic-updates -- local var, no concurrent writers
    id = r.peer.agentId;
  }
  validateAgentId(id);

  if (!agents) agents = await listAgents();
  const agent = agents.find((a) => a.agentId === id) || null;
  const baseRef = cohortOrTeamRefBase(id);
  const teamLike = await isCohortOrTeamRef(id, agents);
  if (wantDashboard || teamLike) {
    const dashboardRef = teamLike ? baseRef : cohortRefForAgent(agent, id);
    if (!dashboardRef) {
      die(
        wantDashboard
          ? `'${id}' has no team/cohort dashboard (agent is not on a team)`
          : await attachMissingTargetMessage(id),
        1,
      );
    }
    cmdUi(wantRebuild ? [dashboardRef, "--rebuild"] : [dashboardRef]);
    return;
  }

  // iTerm-backed agents: ask the bridge to bring the session to the front.
  // Falls through to tmux when the agent has no iterm guid (or the bridge is
  // unreachable).
  const attachIterm = agent ? await resolveLiveItermTargetForAgent(agent) : null;
  if (attachIterm?.guid && attachIterm.bridgeReachable) {
    const r = await focusITerm2Session(attachIterm.guid);
    if (!r.ok) {
      if (isBenignSessionGoneError(r.error)) {
        die(`no live iterm session for '${id}'`, 1);
      }
      die(`iterm attach failed: ${r.error}`, 1);
    }
    return;
  }

  if (!tmuxSessionExists(id)) {
    const viewId = id.endsWith("-view") ? null : `${id}-view`;
    if (viewId && tmuxSessionExists(viewId)) {
      id = viewId;
    } else if (agent && !agent.bridgeUrl) {
      // Attach bootstraps: the agent is registered locally but has no live
      // surface, so bring the session back up on its recorded transport,
      // then attach to it.
      info(`'${id}' is registered but not running — restarting it`);
      const restart = await restartRegisteredAgentSession(agent);
      if (!restart.ok) {
        die(`attach could not restart '${id}': ${restart.error}`, 1);
      }
      if (!tmuxSessionExists(id)) {
        // iTerm restart path: the respawned window is already up; focus it.
        const refreshed =
          (await listAgents()).find((a) => a.agentId === id) || null;
        const target = refreshed
          ? await resolveLiveItermTargetForAgent(refreshed)
          : null;
        if (target?.guid && target.bridgeReachable) {
          const focus = await focusITerm2Session(target.guid);
          if (focus.ok) return;
        }
        die(await attachMissingTargetMessage(id), 1);
      }
    } else if (!agent && !isDashboardSession(id)) {
      // Attach bootstraps: nothing is registered under this name, so create
      // the agent the same way `a2a start <name>` would, which also attaches
      // when running interactively. View names are excluded — a dashboard
      // that doesn't exist must never be respawned as an *agent*.
      info(`no session '${id}' — bootstrapping a new agent via 'a2a start ${id}'`);
      await cmdStart([id]);
      return;
    } else {
      die(await attachMissingTargetMessage(id), 1);
    }
  }
  if (process.env.TMUX) {
    switchTmuxClient(id);
    return;
  }
  const wantNativeScroll = explicitNativeScroll || !process.env.TMUX;
  if (wantNativeScroll && !isIterm2()) {
    info("native scroll attach works best from iTerm2 via tmux control mode");
  }
  attachTmuxSession(id, {
    nativeScroll: explicitNativeScroll ? true : undefined,
  });
}

function cohortOrTeamRefBase(ref) {
  return ref.endsWith("-view") ? ref.slice(0, -"-view".length) : ref;
}

function cohortRefFromDescription(description) {
  if (typeof description !== "string") return null;
  if (description.startsWith("team:")) return description.slice("team:".length);
  if (description.startsWith("group:")) return description.slice("group:".length);
  return null;
}

function cohortRefForAgent(agent, agentId) {
  const fromDesc = cohortRefFromDescription(agent?.description);
  if (fromDesc) return fromDesc;
  for (const groupName of listGroupNames()) {
    if (listGroupMembers(groupName).some((m) => m.name === agentId)) {
      return groupName;
    }
  }
  for (const teamName of listTeamSpecNames()) {
    const spec = loadResolvedTeamSpec(teamName, process.cwd());
    if (spec?.agents.some((a) => a.id === agentId)) return spec.name;
  }
  return null;
}

async function isCohortOrTeamRef(ref, knownAgents = null) {
  const baseRef = cohortOrTeamRefBase(ref);
  if (isGroup(baseRef)) return true;
  if (loadResolvedTeamSpec(baseRef, process.cwd())) return true;
  if (collectKnownMembersForRef(baseRef).size > 0) return true;
  if (Array.isArray(knownAgents)) {
    return knownAgents.some(
      (agent) =>
        agent.description === `team:${baseRef}` ||
        agent.description === `group:${baseRef}`,
    );
  }
  try {
    const agents = await listAgents();
    return agents.some(
      (agent) =>
        agent.description === `team:${baseRef}` ||
        agent.description === `group:${baseRef}`,
    );
  } catch {
    return false;
  }
}

function collectKnownMembersForRef(ref) {
  const members = new Set();
  const teamSpec = loadResolvedTeamSpec(ref, process.cwd());
  if (teamSpec) {
    for (const agent of teamSpec.agents) members.add(agent.id);
  }
  if (isGroup(ref)) {
    for (const member of listGroupMembers(ref)) members.add(member.name);
  }
  return members;
}

async function attachMissingTargetMessage(id) {
  const baseRef = cohortOrTeamRefBase(id);
  const members = collectKnownMembersForRef(baseRef);
  try {
    const agents = await listAgents();
    for (const agent of agents) {
      if (
        agent.description === `team:${baseRef}` ||
        agent.description === `group:${baseRef}`
      ) {
        members.add(agent.agentId);
      }
    }
  } catch {
    /* bridge may be down; local team/group specs are enough for guidance */
  }
  if (members.size === 0) return `no tmux session '${id}'`;

  const live = [...members].filter((member) => tmuxSessionExists(member));
  const memberText = live.length > 0 ? live.join(", ") : [...members].join(", ");
  const viewHint = baseRef === id ? ` or '${baseRef}-view'` : "";
  return [
    `no tmux session '${id}'${viewHint}`,
    `'${baseRef}' is a team/cohort label, not an agent session`,
    `open its dashboard with 'a2a attach ${baseRef}' or 'a2a ui ${baseRef} --rebuild'`,
    `or attach one of: ${memberText}`,
  ].join("; ");
}

function parsePositiveIntegerOption(raw, fallback, label) {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) die(`${label} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    die(`${label} must be a positive integer`);
  }
  return n;
}

async function cmdPeek(args) {
  const parsed = parseArgs(args, { lines: true });
  let [id] = parsed.positional;
  let agents = null;
  if (!id) {
    agents = await listAgents();
    const r = inferPeer(agents, currentTmuxSession());
    if (r.error) die(r.error, 1);
    // eslint-disable-next-line require-atomic-updates -- local var, no concurrent writers
    id = r.peer.agentId;
  }
  validateAgentId(id);
  const lines = parsePositiveIntegerOption(parsed.flags.lines, 30, "--lines");

  // Look up the registered agent so we can pick the right transport.
  if (!agents) agents = await listAgents();
  const agent = agents.find((a) => a.agentId === id) || null;
  const iterm = agent ? await resolveLiveItermTargetForAgent(agent) : null;

  // Prefer iTerm screen op when the agent is iTerm-backed and the bridge is
  // reachable; otherwise fall back to tmux capture-pane.
  if (iterm?.guid && iterm.bridgeReachable) {
    const r = await screenITerm2Session(iterm.guid, lines);
    if (!r.ok) {
      if (isBenignSessionGoneError(r.error)) {
        die(`no live iterm session for '${id}'`, 1);
      }
      die(`iterm screen failed: ${r.error}`, 1);
    }
    const text = (r.lines || []).join("\n");
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    return;
  }

  if (!tmuxSessionExists(id)) die(`no tmux session '${id}'`, 1);
  // -S -<lines> pulls scrollback history; without it capture-pane returns
  // only the visible pane height, silently capping --lines at ~40.
  const r = tmux(["capture-pane", "-t", id, "-p", "-S", `-${lines}`]);
  if (r.status !== 0) die(`capture-pane failed`, 1);
  const text = (r.stdout || "").split("\n").slice(-lines).join("\n");
  process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
}

function resolveReconnectTargets(name, hasAll, launchCwd, opts = {}) {
  const listTmuxSessions =
    Array.isArray(opts.tmuxSessions) ? () => opts.tmuxSessions : tmuxListSessions;
  return resolveReconnectTargetsPure({
    name,
    hasAll,
    isGroup,
    listGroupMembers,
    loadResolvedTeamSpec,
    tmuxListSessions: listTmuxSessions,
    loadRegistry,
    launchCwd,
  });
}

/**
 * Rebuilds a dashboard view from existing live agent sessions.
 *
 * @param {string} viewSession - Dashboard tmux session name.
 * @param {string[]} members - Agent session names to link into the dashboard.
 * @returns {void}
 * @example
 *   buildReconnectView("a2a-view", ["alice", "bob"]);
 */
function buildReconnectView(viewSession, members) {
  if (!viewSession || members.length === 0) return;
  if (tmuxSessionExists(viewSession)) {
    const killed = tmux(["kill-session", "-t", viewSession]);
    if (killed.status !== 0) {
      die(
        `failed to replace view session '${viewSession}': ${(killed.stderr || "").trim() || "unknown"}`,
        1,
      );
    }
  }
  const created = tmux([
    "new-session",
    "-d",
    "-s",
    viewSession,
    "-n",
    "command",
    "-c",
    process.cwd(),
    buildDashboardControlCommand(viewSession, members),
  ]);
  if (created.status !== 0) {
    die(
      `failed to create view session '${viewSession}': ${(created.stderr || "").trim() || "unknown"}`,
      1,
    );
  }
  tmuxSetInstallToken(viewSession, installToken());
  pinDashboardCommandWindow(viewSession);
  for (const [index, member] of members.entries()) {
    const windowIndex = index + 1;
    const linked = tmux([
      "link-window",
      "-d",
      "-s",
      `${member}:0`,
      "-t",
      `${viewSession}:${windowIndex}`,
    ]);
    if (linked.status !== 0) {
      tmux(["kill-session", "-t", viewSession]);
      die(
        `failed to link ${member} into '${viewSession}:${windowIndex}': ${(linked.stderr || "").trim() || "unknown"}`,
        1,
      );
    }
    const renamed = tmux([
      "rename-window",
      "-t",
      `${viewSession}:${windowIndex}`,
      member,
    ]);
    if (renamed.status !== 0) {
      info(
        `  warning: failed to name window ${windowIndex}: ${(renamed.stderr || "").trim() || "unknown"}`,
      );
    }
    info(`  window ${windowIndex}: ${member}`);
  }
  const commandWindowSelected = selectDashboardCommandWindow(viewSession);
  const attachTarget = commandWindowSelected ? `${viewSession}:0` : viewSession;
  if (commandWindowSelected) info("  window 0: command");
  info(
    "  command center: 1-9 quick jump, Enter open, ! attention, ? help, : commands, m message, a ask",
  );
  if (currentTmuxSession()) {
    switchTmuxClient(attachTarget);
  } else if (hasInteractiveTerminal()) {
    attachTmuxSession(attachTarget);
  } else {
    info(`view session '${viewSession}' rebuilt`);
    info(`  attach later: a2a attach ${viewSession}`);
  }
}

async function cmdReconnect(args) {
  requireBinary("tmux");
  const hasAll = args.includes("--all");
  const wantDashboard =
    args.includes("--dashboard") || args.includes("--layout");
  const filtered = args.filter(
    (a) => a !== "--all" && a !== "--layout" && a !== "--dashboard",
  );
  const [name] = parseArgs(filtered, {}).positional;
  if (hasAll && name) {
    die("reconnect --all cannot be combined with a target name", 1);
  }
  const explicitTarget = Boolean(name);

  const token = installToken();
  const tmuxOwnership = (() => {
    try {
      return tmuxListSessionOwnership(token);
    } catch {
      return emptyTmuxSessionOwnership();
    }
  })();
  const liveAgents = new Set(tmuxOwnership.sessions);
  const existing = (() => {
    try {
      return new Map();
    } catch {
      return new Map();
    }
  })();
  try {
    for (const agent of await listAgents()) existing.set(agent.agentId, agent);
  } catch {
    /* best effort */
  }

  // iTerm-backed agents have no tmux session, so tmux liveness alone would
  // report them as "no live session". Mirror reconnectOwnedItermAgents:
  // treat an iTerm session we spawned (install-token match) whose name
  // parses back to an agent id as live, keyed to its guid.
  const itermLive = new Map(); // agentId -> guid
  if (await probeBridgeReachable()) {
    try {
      for (const s of await listITermSessionsWithOwnership()) {
        if (!s.name || !s.guid) continue;
        if (s.installToken !== token) continue;
        const agentId = parseItermAgentId(s.name);
        if (!agentId || itermLive.has(agentId)) continue;
        itermLive.set(agentId, s.guid);
      }
    } catch {
      /* bridge flaked between probes; tmux liveness still applies */
    }
  }

  const {
    targets,
    viewSession,
    description: explicitDescription,
  } = resolveReconnectTargets(name, hasAll, process.cwd(), {
    tmuxSessions: tmuxOwnership.sessions,
  });
  if (targets.length === 0) {
    info("no reconnect targets found");
    return;
  }

  const uniqueTargets = [...new Set(targets)].filter(
    (id) => !id.endsWith("-view"),
  );
  const connected = [];
  let allOk = true;
  for (const id of uniqueTargets) {
    validateAgentId(id);
    const itermGuid = itermLive.get(id) || null;
    const tmuxLive = liveAgents.has(id);
    if (!tmuxLive && !itermGuid) {
      if (!explicitTarget) continue;
      process.stdout.write(`${id}: no live tmux or iterm session\n`);
      allOk = false;
      continue;
    }
    if (
      !existing.has(id) &&
      !itermGuid &&
      !tmuxOwnership.ownedSessionIds.has(id) &&
      !explicitTarget
    ) {
      process.stdout.write(`${id}: skipped unowned tmux session\n`);
      continue;
    }
    const current = existing.get(id);
    const cwd = current?.cwd || (tmuxLive ? tmuxPanePath(id) : "");
    const description =
      current?.description ||
      explicitDescription ||
      inferCohortDescription(id) ||
      (itermGuid && !tmuxLive
        ? `a2a reconnect (iterm): ${id}`
        : `a2a reconnect: ${cwd}`);
    // Round-trip yolo + installToken so the bridge keeps the authority
    // claim and ownership marker after a re-register. Reconnect must not
    // silently downgrade a yolo agent to interactive, and it must not
    // drop the install-token that proves the session is a2a-owned.
    // When the prior registration didn't carry a token (legacy), fall
    // back to whatever the live tmux session currently advertises, then
    // finally to this install's token.
    const tmuxToken = tmuxLive ? tmuxOwnership.tokenBySession.get(id) || null : null;
    const tokenForPayload =
      typeof current?.installToken === "string" && current.installToken
        ? current.installToken
        : tmuxToken || token;
    const payload = {
      agentId: id,
      tmuxTarget: `${id}:0.0`,
      cwd,
      description,
      installToken: tokenForPayload,
      ...(itermGuid ? { itermGuid } : {}),
      ...(current?.bridgeUrl ? { bridgeUrl: current.bridgeUrl } : {}),
      ...(current?.backend ? { backend: current.backend } : {}),
      ...(typeof current?.backendCommand === "string" && current.backendCommand
        ? { backendCommand: current.backendCommand }
        : {}),
      ...(Array.isArray(current?.backendArgs)
        ? { backendArgs: current.backendArgs }
        : {}),
      ...(current?.backendEnv && typeof current.backendEnv === "object"
        ? { backendEnv: agentEnv(id, current.backendEnv) }
        : {}),
      ...(typeof current?.startupPrompt === "string"
        ? { startupPrompt: current.startupPrompt }
        : {}),
      ...(typeof current?.yolo === "boolean" ? { yolo: current.yolo } : {}),
    };
    // Make sure the session itself carries the token now (handles legacy
    // sessions that pre-date the marker, and harmlessly re-sets it on
    // sessions that already have it). iTerm-only agents have no tmux
    // session to stamp; their ownership lives in the bridge's map.
    if (tmuxLive) tmuxSetInstallToken(id, tokenForPayload);
    try {
      const { status, body } = await request(
        "POST",
        "/api/a2a/register",
        payload,
      );
      if (status !== 200 || !body?.success)
        throw new Error(body?.error || `HTTP ${status}`);
      process.stdout.write(`${id}: reconnected\n`);
      connected.push(id);
    } catch (err) {
      process.stdout.write(`${id}: reconnect failed: ${err.message}\n`);
      allOk = false;
    }
  }

  if (wantDashboard && connected.length > 0)
    buildReconnectView(viewSession || "a2a-view", connected);
  if (!allOk) process.exit(1);
}

// `a2a ui <ref> [--rebuild]` — open the dashboard TUI for an existing cohort
// or team without touching the bridge. When the view session is already up
// this just attaches (or switches the current tmux client). When it is gone,
// the live agents are looked up via the same resolution `a2a reconnect`
// uses (cohorts, team specs, group members) and a fresh view session is
// built around them. --rebuild forces a teardown + rebuild even when the
// view session already exists. Once attached, the in-TUI Enter / 1-9 / quick
// jump paths self-heal any individually broken windows by relinking from
// `<agent>:0` on demand (see jumpToAgent in dashboard-tui.mjs).
function cmdUi(args) {
  requireBinary("tmux");
  const wantRebuild = args.includes("--rebuild");
  const filtered = args.filter((a) => a !== "--rebuild");
  const [name] = parseArgs(filtered, {}).positional;
  if (!name) die("usage: a2a ui <name> [--rebuild]", 1);

  // Accept either a base ref (team / cohort) or a literal view-session
  // name. Normalize both directions so the same command works for both.
  const baseRef = name.endsWith("-view")
    ? name.slice(0, -"-view".length)
    : name;
  const directView = name.endsWith("-view") ? name : `${baseRef}-view`;

  // Fast path: the named view session already exists. Attach without
  // recomputing membership. The in-TUI jumpToAgent flow handles any stale
  // links lazily on the user's first Enter.
  if (!wantRebuild && tmuxSessionExists(directView)) {
    openExistingDashboardView(directView);
    return;
  }

  // Slow path: resolve membership and build (or rebuild) the view session.
  // Reuse reconnect's resolver so this works uniformly for cohorts, teams,
  // and group references.
  const resolved = resolveReconnectTargets(baseRef, false, process.cwd());
  const viewSession = resolved.viewSession || directView;

  // If --rebuild was not requested but the resolver picked a different
  // canonical view name that is already up, attach to that one.
  if (
    !wantRebuild &&
    viewSession !== directView &&
    tmuxSessionExists(viewSession)
  ) {
    openExistingDashboardView(viewSession);
    return;
  }

  const liveAgents = (() => {
    try {
      return new Set(tmuxListSessions());
    } catch {
      return new Set();
    }
  })();
  const members = [...new Set(resolved.targets)]
    .filter((id) => !id.endsWith("-view"))
    .filter((id) => liveAgents.has(id));
  if (members.length === 0) {
    die(
      `no live agent sessions found for '${baseRef}' — start them with 'a2a start' or reconnect first`,
      1,
    );
  }

  // createDashboardView kills any existing session of the same name before
  // rebuilding, then attaches/switches at the end.
  createDashboardView(viewSession, members, process.cwd());
}

function validateLogArgs(args) {
  const allowedBoolean = new Set(["--path", "-f", "--follow"]);
  for (const arg of args) {
    if (allowedBoolean.has(arg)) continue;
    if (arg.startsWith("--lines=")) continue;
    if (arg === "--lines") continue;
    if (arg.startsWith("-")) die(`unknown log flag ${arg}`, 1);
  }
}

function cmdLog(args) {
  validateLogArgs(args);
  // parseArgs requires every recognised flag to have a value. Strip the boolean flags
  // (--path, -f/--follow) up front so the value-only parser can handle the rest.
  const wantPath = args.includes("--path");
  const wantFollow = args.includes("-f") || args.includes("--follow");
  const filtered = args.filter(
    (a) => a !== "--path" && a !== "-f" && a !== "--follow",
  );
  const parsed = parseArgs(filtered, { lines: true });
  const path = messageLogPath();

  if (wantPath) {
    process.stdout.write(`${path  }\n`);
    return;
  }

  if (wantFollow) {
    // Defer to `tail -F` (capital F: re-open on rotation/recreation). stdio inherit so the
    // tail child writes straight to the user's terminal and Ctrl-C terminates it cleanly.
    requireBinary("tail");
    const lines = String(parsePositiveIntegerOption(parsed.flags.lines, 50, "--lines"));
    const r = spawnSync("tail", ["-n", lines, "-F", "--", path], {
      stdio: "inherit",
    });
    if (r.status === null && r.signal) process.exit(0);
    process.exit(r.status ?? 0);
  }

  const lines = parsePositiveIntegerOption(parsed.flags.lines, 50, "--lines");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      info(`no log yet at ${path} (start the bridge and send a message)`);
      return;
    }
    die(`failed to read log: ${e.message}`, 1);
  }
  // The log is multi-line per entry: a header line followed by 4-space-indented body lines.
  // Splitting by header line keeps each entry intact when slicing the tail.
  const all = content.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/);
  const tail = all.slice(-lines).join("\n");
  process.stdout.write(tail + (tail.endsWith("\n") ? "" : "\n"));
}

function validateStatusArgs(args) {
  const allowed = new Set(["--json", "--segment", "--peers", "--no-peers"]);
  for (const arg of args) {
    if (!allowed.has(arg)) die(`unknown status flag ${arg}`, 1);
  }
  if (args.includes("--json") && args.includes("--segment")) {
    die("status accepts only one output mode: --json or --segment", 1);
  }
  if (args.includes("--peers") && args.includes("--no-peers")) {
    die("status accepts only one peer mode: --peers or --no-peers", 1);
  }
}

async function collectRuntimeSnapshot({ peers = false, fresh = false } = {}) {
  const self = currentTmuxSession();
  const peerSnapshotsPromise = peers ? gatherPeerAgents() : Promise.resolve([]);
  try {
    const params = new URLSearchParams();
    if (self) params.set("self", self);
    params.set("cwd", process.cwd());
    if (fresh) params.set("fresh", "1");
    const { status, body } = await request(
      "GET",
      `/api/a2a/runtime-snapshot?${params.toString()}`,
      null,
    );
    if (status === 200 && body?.success && body.data?.inventory) {
      const peerSnapshots = await peerSnapshotsPromise;
      if (peerSnapshots.length > 0) {
        const snapshot = buildStatusSnapshot({
          inventory: body.data.inventory,
          peerSnapshots,
          self,
          bridgeError: body.data.snapshot?.health === "error"
            ? body.data.snapshot.attention?.find((a) => a.kind === "bridge-error")?.message
            : null,
        });
        return {
          ...body.data,
          snapshot,
          peerSnapshots,
        };
      }
      return {
        ...body.data,
        peerSnapshots: [],
      };
    }
  } catch {
    // Fall through to the legacy collector. This keeps new CLIs compatible
    // with older/down bridges and preserves the prior diagnostic behavior.
  }

  let registeredAgents = [];
  let bridgeError = null;
  try {
    registeredAgents = await listAgents();
  } catch (err) {
    bridgeError = err.message || String(err);
  }
  const peerSnapshots = await peerSnapshotsPromise;
  return await buildRuntimeSnapshotFromState({
    registeredAgents,
    peerSnapshots,
    self,
    bridgeError,
    launchCwd: process.cwd(),
  });
}

async function cmdStatus(args = []) {
  validateStatusArgs(args);
  const wantJson = args.includes("--json");
  const wantSegment = args.includes("--segment");
  const wantPeers = args.includes("--peers");
  const { snapshot } = await collectRuntimeSnapshot({ peers: wantPeers });

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)  }\n`);
    return;
  }
  if (wantSegment) {
    const segment = formatStatusSegment(snapshot);
    if (segment) process.stdout.write(`${segment}\n`);
    return;
  }
  process.stdout.write(formatHumanStatus(snapshot));
}

function parseSimpleCommandArgs(args, { booleans = [], values = [] } = {}) {
  const booleanSet = new Set(booleans);
  const valueSet = new Set(values);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
    if (booleanSet.has(key)) {
      if (eqIdx !== -1) die(`--${key} does not take a value`, 1);
      flags[key] = true;
      continue;
    }
    if (!valueSet.has(key)) die(`unknown flag --${key}`, 1);
    const value = eqIdx === -1 ? args[++i] : arg.slice(eqIdx + 1);
    if (!value || String(value).startsWith("--")) die(`--${key} requires a value`, 1);
    flags[key] = value;
  }
  return { flags, positional };
}

async function cmdEvents(args = []) {
  const { flags } = parseSimpleCommandArgs(args, {
    booleans: ["json", "peers", "no-peers"],
  });
  if (flags.peers && flags["no-peers"])
    die("events accepts only one peer mode: --peers or --no-peers", 1);
  const { snapshot } = await collectRuntimeSnapshot({ peers: flags.peers === true });
  const events = buildRuntimeEvents(snapshot);
  if (flags.json) process.stdout.write(`${JSON.stringify(events, null, 2)  }\n`);
  else process.stdout.write(formatRuntimeEvents(events));
}

async function cmdAttention(args = []) {
  const { flags } = parseSimpleCommandArgs(args, {
    booleans: ["json", "peers", "no-peers"],
  });
  if (flags.peers && flags["no-peers"])
    die("attention accepts only one peer mode: --peers or --no-peers", 1);
  const { snapshot } = await collectRuntimeSnapshot({ peers: flags.peers === true });
  const stack = buildAttentionStack(snapshot);
  if (flags.json) process.stdout.write(`${JSON.stringify(stack, null, 2)  }\n`);
  else process.stdout.write(formatAttentionStack(stack));
}

async function cmdDoctor(args = []) {
  const { flags } = parseSimpleCommandArgs(args, {
    booleans: ["json", "peers", "no-peers"],
    values: ["bundle"],
  });
  if (flags.peers && flags["no-peers"])
    die("doctor accepts only one peer mode: --peers or --no-peers", 1);
  const { snapshot, registry } = await collectRuntimeSnapshot({
    peers: flags.peers === true,
  });
  const events = buildRuntimeEvents(snapshot);
  const doctor = buildDoctorSnapshot({
    status: snapshot,
    events,
    config: loadConfig(),
    registry,
    tmuxSessions: tmuxListSessions(),
    paths: {
      cwd: process.cwd(),
      messageLog: messageLogPath(),
      teams: REPO_TEAMS_DIR,
      bridge: bridgeUrl(),
    },
    versions: {
      node: process.version,
      platform: process.platform,
      a2a: "1.1.0",
    },
  });
  if (flags.bundle) {
    const dir = resolve(process.cwd(), flags.bundle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "doctor.json"), `${JSON.stringify(doctor, null, 2)}\n`);
    writeFileSync(join(dir, "status.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeFileSync(join(dir, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
    process.stdout.write(`${dir}\n`);
    return;
  }
  if (flags.json) process.stdout.write(`${JSON.stringify(doctor, null, 2)  }\n`);
  else process.stdout.write(formatDoctorSnapshot(doctor));
}

async function cmdReload(args = []) {
  const { flags, positional } = parseSimpleCommandArgs(args, {
    booleans: ["dry-run", "json"],
  });
  const [teamRef] = positional;
  if (!teamRef) die("reload requires a team name", 1);
  const teamSpec = loadResolvedTeamSpec(teamRef, process.cwd());
  if (!teamSpec) die(`team '${teamRef}' not found`, 1);
  let registeredAgents;
  try {
    registeredAgents = await listAgents();
  } catch (err) {
    die(`reload cannot inspect bridge registry: ${err.message}`, 1);
  }
  const plan = buildReloadPlan(teamSpec, registeredAgents);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)  }\n`);
    return;
  }
  process.stdout.write(formatReloadPlan(plan));
  if (flags["dry-run"]) return;
  if (!plan.safeToApply) {
    die("reload refused unsafe changes; restart the team explicitly", 1);
  }
  if (plan.safeAdds.length === 0) {
    process.stdout.write("reload: no safe changes to apply\n");
    return;
  }
  await ensureBridgeRunning();
  const safeAddIds = new Set(plan.safeAdds.map((change) => change.agent));
  await startTeam(
    {
      ...teamSpec,
      agents: teamSpec.agents.filter((agent) => safeAddIds.has(agent.id)),
    },
    { dashboard: false },
  );
}

function cmdLayout(args = []) {
  const { flags, positional } = parseSimpleCommandArgs(args, {
    booleans: ["json"],
  });
  const [teamRef] = positional;
  if (!teamRef) die("layout requires a team name", 1);
  const specPath = resolveTeamRef(teamRef, process.cwd());
  if (!specPath) die(`team '${teamRef}' not found`, 1);
  const raw = loadTeamSpec(specPath);
  const teamSpec = loadResolvedTeamSpec(teamRef, process.cwd());
  const plan = buildLayoutPlan(teamSpec, raw.layout || null);
  if (flags.json) process.stdout.write(`${JSON.stringify(plan, null, 2)  }\n`);
  else process.stdout.write(formatLayoutPlan(plan));
}

function cmdIterm(args = []) {
  const { flags, positional } = parseSimpleCommandArgs(args, {
    booleans: ["print"],
  });
  const [target] = positional;
  if (!target) die("iterm requires an agent or session name", 1);
  validateAgentId(target);
  const script = buildItermAttachScript(target);
  if (flags.print) {
    process.stdout.write(script);
    return;
  }
  requireBinary("osascript");
  const result = spawnSync("osascript", [], {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0)
    die(`iterm bridge failed: ${(result.stderr || "").trim() || "osascript failed"}`, 1);
}

async function cmdPm(args = []) {
  const { flags, positional } = parseSimpleCommandArgs(args, {
    booleans: ["write", "start"],
    values: ["workers", "backend", "worker-backend"],
  });
  const [name] = positional;
  if (!name) die("pm requires a team name", 1);
  validateAgentId(name);
  const spec = buildPmWorkerSpec({
    name,
    workers: flags.workers || 2,
    backend: flags.backend || "claude",
    workerBackend: flags["worker-backend"] || flags.backend || "claude",
  });
  const body = dumpTeamSpec(spec);
  if (!flags.write && !flags.start) {
    process.stdout.write(body);
    return;
  }
  const path = join(teamSpecsDir(), `${name}.yaml`);
  try {
    statSync(path);
    if (flags.write || flags.start) die(`team spec already exists: ${path}`, 1);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    writeFileSync(path, body);
    process.stdout.write(`${path}\n`);
  }
  if (flags.start) {
    const teamSpec = loadResolvedTeamSpec(name, process.cwd());
    await ensureBridgeRunning();
    await startTeam(teamSpec, { dashboard: true });
  }
}

function validateListArgs(args) {
  const allowed = new Set(["--json", "--no-peers"]);
  for (const arg of args) {
    if (!allowed.has(arg)) die(`unknown list flag ${arg}`, 1);
  }
}

async function cmdList(args = []) {
  validateListArgs(args);
  const wantJson = Array.isArray(args) && args.includes("--json");
  const wantNoPeers = Array.isArray(args) && args.includes("--no-peers");
  const {
    snapshot,
    inventory: inv,
    peerSnapshots,
  } = await collectRuntimeSnapshot({ peers: !wantNoPeers });
  const bridgeError = snapshot.attention.find((a) => a.kind === "bridge-error")
    ?.message || null;
  const self = currentTmuxSession();
  const viewsToShow = inv.views.filter((v) => v.existsInTmux);

  if (wantJson) {
    // Stable machine-readable shape. Scripts must parse THIS instead of
    // grepping the textual table — the table is allowed to change
    // (column order, padding, decorative banners) without notice.
    const payload = {
      self: self || null,
      bridgeError,
      registered: inv.registered.map((a) => ({
        agentId: a.agentId,
        tmuxTarget: a.tmuxTarget,
        cwd: a.cwd,
        description: a.description,
        cohort: a.cohort,
        status: a.status,
        yolo: a.yolo,
        backend: a.backend,
      })),
      views: viewsToShow.map((v) => ({
        session: v.session,
        baseName: v.baseName,
        known: v.known,
        sources: v.sources,
      })),
      orphans: inv.orphans.slice(),
      itermOrphans: inv.itermOrphans.slice(),
      peers: peerSnapshots.map((snap) => ({
        peer: snap.peer,
        url: snap.url,
        error: snap.error,
        agents: snap.agents.map((a) => ({
          agentId: a.agentId,
          tmuxTarget: a.tmuxTarget || null,
          cwd: a.cwd || null,
          description: a.description || null,
          status: a.status || null,
          yolo: typeof a.yolo === "boolean" ? a.yolo : null,
        })),
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)  }\n`);
    return;
  }

  const hasAnyPeerRow = peerSnapshots.some(
    (s) => s.error || s.agents.length > 0,
  );
  if (
    inv.registered.length === 0 &&
    viewsToShow.length === 0 &&
    inv.orphans.length === 0 &&
    inv.itermOrphans.length === 0 &&
    !hasAnyPeerRow
  ) {
    if (bridgeError)
      process.stdout.write(`(bridge unreachable: ${bridgeError})\n`);
    else process.stdout.write("(no agents registered)\n");
    return;
  }

  const formatYolo = (y) =>
    y === true ? "yolo" : y === false ? "interactive" : "";

  // Bucket every row by cohort so we can hoist fields that every row in a
  // cohort shares (cwd, mode, status) onto a single header line and let
  // the per-agent lines carry only their identity. The previous flat table
  // re-emitted cohort, cwd, and "live yolo" on every row, which buried the
  // signal in repetition. Cohort key conventions:
  //   "<name>"        — normal cohort registered via team specs
  //   ""              — lone agents and tmux-only orphans
  //   "peer:<name>"   — remote agents fetched from a configured peer
  const groups = new Map();
  const bucket = (cohort) => {
    let g = groups.get(cohort);
    if (!g) {
      g = { agents: [], views: [], peerUrl: "" };
      groups.set(cohort, g);
    }
    return g;
  };

  for (const a of inv.registered) {
    bucket(a.cohort || "").agents.push({
      id: a.agentId + (a.agentId === self ? " (self)" : ""),
      status: a.status,
      mode: formatYolo(a.yolo),
      cwd: a.cwd || "",
    });
  }
  for (const orphan of inv.orphans) {
    bucket("").agents.push({
      id: orphan + (orphan === self ? " (self)" : ""),
      status: "tmux-only",
      mode: "",
      cwd: "",
    });
  }
  for (const orphan of inv.itermOrphans) {
    // Orphaned iTerm windows we spawned (install-token match) whose agent is
    // no longer registered — `a2a kill --all` sweeps these.
    bucket("").agents.push({
      id: orphan.name || orphan.guid,
      status: "iterm-only",
      mode: "",
      cwd: "",
    });
  }
  for (const v of viewsToShow) {
    // Views attach to their cohort header inline ("view <session>") instead
    // of getting a redundant row with the same baseName in the cohort col.
    bucket(v.baseName || "").views.push(
      v.session + (v.session === self ? " (self)" : ""),
    );
  }
  for (const snap of peerSnapshots) {
    const cohort = `peer:${snap.peer}`;
    bucket(cohort).peerUrl = snap.url || "";
    if (snap.error) {
      bucket(cohort).agents.push({
        id: snap.peer,
        status: "peer-down",
        mode: "",
        cwd: snap.error,
      });
      continue;
    }
    if (snap.agents.length === 0) {
      bucket(cohort).agents.push({
        id: snap.peer,
        status: "peer-empty",
        mode: "",
        cwd: "(no agents registered on peer)",
      });
      continue;
    }
    for (const agent of snap.agents) {
      bucket(cohort).agents.push({
        id: `${snap.peer}${PEER_AGENT_ID_SEPARATOR}${agent.agentId}`,
        status: "peer",
        mode: formatYolo(typeof agent.yolo === "boolean" ? agent.yolo : null),
        cwd: agent.cwd || "",
      });
    }
  }

  if (bridgeError)
    process.stdout.write(
      `(bridge unreachable: ${bridgeError}; showing tmux state only)\n`,
    );

  // Return the value shared by every row in a group, else null. Empty-string
  // values are treated as "no value" so we don't hoist a blank header cell.
  const sharedField = (rows, key) => {
    if (rows.length === 0) return null;
    const first = rows[0][key];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][key] !== first) return null;
    }
    return first || null;
  };

  // "live" agents and "peer" agents are the default state for their bucket;
  // hoisting those into the header just adds a label nobody learns from.
  // Any other shared status (bridge-only, tmux-only, peer-down, peer-empty)
  // is anomalous and worth surfacing on the header.
  const boringStatuses = new Set(["live", "peer"]);

  // Stable render order: real cohorts alphabetically, then ungrouped, then
  // peers alphabetically. Matches the original mental model (local first,
  // remote last).
  const realCohorts = [...groups.keys()]
    .filter((k) => k && !k.startsWith("peer:"))
    .sort();
  const peerCohortKeys = [...groups.keys()]
    .filter((k) => k.startsWith("peer:"))
    .sort();
  const ungroupedKey = groups.has("") ? [""] : [];
  const order = [...realCohorts, ...ungroupedKey, ...peerCohortKeys];

  // When the entire output is one ungrouped bucket the "(ungrouped)" label
  // is pure noise — there is nothing to disambiguate it from.
  const suppressOnlyUngroupedLabel = order.length === 1 && order[0] === "";
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));

  let firstGroup = true;
  for (const cohort of order) {
    const group = groups.get(cohort);
    const sharedMode = sharedField(group.agents, "mode");
    const sharedStatusRaw = sharedField(group.agents, "status");
    const sharedStatus =
      sharedStatusRaw && !boringStatuses.has(sharedStatusRaw)
        ? sharedStatusRaw
        : null;
    const hoistStatusForRows = sharedStatusRaw != null;

    const headerParts = [];
    if (!(suppressOnlyUngroupedLabel && cohort === "")) {
      headerParts.push(cohort === "" ? "(ungrouped)" : cohort);
    }
    if (group.peerUrl) headerParts.push(group.peerUrl);
    if (sharedStatus) headerParts.push(sharedStatus);
    if (sharedMode) headerParts.push(sharedMode);
    for (const v of group.views) headerParts.push(`view ${v}`);

    if (!firstGroup) process.stdout.write("\n");
    firstGroup = false;
    if (headerParts.length > 0)
      process.stdout.write(`${headerParts.join("  ")}\n`);

    const idW = Math.max(0, ...group.agents.map((r) => r.id.length));
    for (const r of group.agents) {
      const cells = [pad(r.id, idW)];
      if (!hoistStatusForRows) cells.push(r.status);
      if (sharedMode == null && r.mode) cells.push(r.mode);
      process.stdout.write(`  ${cells.join("  ")}\n`);
    }
  }
}

async function cmdRegister(args) {
  const { flags } = parseArgs(args, { id: true, target: true, desc: true });
  if (!flags.id || !flags.target) die("register requires --id and --target");
  validateAgentId(flags.id);
  validateTmuxTarget(flags.target);
  // Stamp the install token on the target session if it's a live tmux
  // session — manual registers should benefit from the same ownership
  // proof as start-spawned sessions so `kill --all` doesn't refuse to
  // touch them. Best effort: a non-tmux target (e.g. remote) is fine.
  const token = installToken();
  const targetSession = String(flags.target).split(":")[0];
  if (targetSession && tmuxSessionExists(targetSession))
    tmuxSetInstallToken(targetSession, token);
  const { status, body } = await request("POST", "/api/a2a/register", {
    agentId: flags.id,
    tmuxTarget: flags.target,
    description: flags.desc || "",
    cwd: process.cwd(),
    installToken: token,
  });
  if (status !== 200 || !body?.success)
    die(`register failed: ${body?.error || `HTTP ${status}`}`, 1);
  process.stdout.write(`${JSON.stringify(body.data, null, 2)  }\n`);
}

async function cmdUnregister(args) {
  let [id] = parseArgs(args, {}).positional;
  if (!id) {
    id = currentTmuxSession();
    if (!id) die("unregister needs a name");
  }
  const { status, body } = await request(
    "DELETE",
    `/api/a2a/register/${encodeURIComponent(id)}`,
  );
  if (status !== 200 || !body?.success)
    die(`unregister failed: ${body?.error || `HTTP ${status}`}`, 1);
  process.stdout.write(`${JSON.stringify(body.data, null, 2)  }\n`);
}

function cmdConfig(args) {
  const [sub, key, val] = args;
  switch (sub) {
    case "ls":
    case undefined: {
      const s = configGet();
      for (const [k, v] of Object.entries(s))
        process.stdout.write(`${k} = ${v ?? "(not set)"}\n`);
      break;
    }
    case "get": {
      if (!key) die("config get requires a key");
      try {
        process.stdout.write(`${configGet(key) ?? "(not set)"}\n`);
      } catch (e) {
        die(e.message);
      }
      break;
    }
    case "set": {
      if (!key) die("config set requires a key and value");
      if (val === undefined) die(`config set ${key} requires a value`);
      try {
        const stored = configSet(key, val);
        process.stdout.write(`${key} = ${stored ?? "(not set)"}\n`);
      } catch (e) {
        die(e.message);
      }
      break;
    }
    default:
      die(`unknown config subcommand '${sub}' (expected: ls, get, set)`);
  }
}

async function cmdAuth(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      await authAdd(rest);
      break;
    case "list":
      await authList();
      break;
    case "revoke":
      await authRevoke(rest);
      break;
    case undefined:
      await authList();
      break;
    default:
      die(`unknown auth subcommand '${sub}' (expected: add, list, revoke)`);
  }
}

function authAdd(args) {
  const { peer, flags } = parseAuthArgs(args, new Set(["url", "key"]));
  if (!peer)
    die("specify a peer: a2a auth add --<peer> --url <url> --key <key>");
  validateAgentId(peer);
  if (!flags.url) die("--url is required");
  const key = String(flags.key || "").trim();
  if (!key) die("--key is required");
  const url = normalizePeerUrlForConfig(flags.url);
  const cfg = loadConfig();
  patchConfig({
    peers: { ...(cfg.peers || {}), [peer]: { url, key } },
  });
  process.stdout.write(
    `\n  added peer '${peer}'\n\n  url   ${url}\n  key   ${maskSecret(key)}\n\n`,
  );
}

function authList() {
  const peers = loadConfig().peers || {};
  if (!Object.keys(peers).length) {
    process.stdout.write("(no peers configured)\n");
    return;
  }
  process.stdout.write("\npeers\n\n");
  for (const [name, p] of Object.entries(peers)) {
    const url = typeof p?.url === "string" && p.url ? p.url : "(no url)";
    const keyMark =
      typeof p?.key === "string" && p.key ? "key set" : "key MISSING";
    process.stdout.write(`  ${name.padEnd(16)}  ${url.padEnd(40)}  ${keyMark}\n`);
  }
  process.stdout.write("\n");
}

function authRevoke(args) {
  const { peer } = parseAuthArgs(args);
  if (!peer) die("specify a peer: a2a auth revoke --<peer>");
  const cfg = loadConfig();
  const peers = { ...(cfg.peers || {}) };
  if (!peers[peer]) die(`no peer '${peer}'`);
  delete peers[peer];
  patchConfig({ peers });
  process.stdout.write(`  removed peer '${peer}'\n`);
}

const LEGACY_ACTION_CMD = { say: "message", ask: "ask", reply: "reply" };

async function main() {
  const [, , ...argv] = process.argv;
  if (argv.length === 0 || ["help", "-h", "--help"].includes(argv[0])) usage(0);

  const lead = argv[0];

  if (
    Object.hasOwn(LEGACY_ACTION_CMD, lead) &&
    argv.length >= 2 &&
    argv.slice(1).some((a) => /^(from|to|origin):/.test(a))
  ) {
    try {
      await doSend(
        parseArgs(argv.slice(1), { to: true, from: true, origin: true }),
        LEGACY_ACTION_CMD[lead],
      );
      return;
    } catch (err) {
      die(err.message, 1);
    }
  }

  if (isSequenceFlagArgv(argv)) {
    try {
      const parsed = parseSequenceFlagArgv(argv, await getRegistry());
      await runSequenceCommand(parsed);
      return;
    } catch (err) {
      die(err.message, 1);
    }
  }

  if (isColonFlagArgv(argv)) {
    try {
      await sendNormalizedEnvelope(
        parseColonFlagArgv(argv, await getRegistry()),
      );
      return;
    } catch (err) {
      die(err.message, 1);
    }
  }

  if (isFlagSendArgv(argv)) {
    try {
      const parsed = parseFlagSendArgv(argv, await getRegistry());
      if (!parsed) die("could not parse send arguments", 1);
      await sendNormalizedEnvelope(parsed);
      return;
    } catch (err) {
      die(err.message, 1);
    }
  }

  if (argv.some((a) => /^(from|to|origin):/.test(a))) {
    try {
      await doSend(parseArgs(argv, { to: true, from: true, origin: true }));
      return;
    } catch (err) {
      die(err.message, 1);
    }
  }

  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "bridge":
        await cmdBridge(rest);
        break;
      case "raw":
        await cmdRaw(rest);
        break;
      case "command":
        await cmdCommand(rest);
        break;
      case "completion":
        cmdCompletion(rest);
        break;
      case "say":
        await doSend(
          parseArgs(rest, { to: true, from: true, origin: true }),
          "message",
        );
        break;
      case "ask":
        await doSend(
          parseArgs(rest, { to: true, from: true, origin: true }),
          "ask",
        );
        break;
      case "reply":
        await doSend(
          parseArgs(rest, { to: true, from: true, origin: true }),
          "reply",
        );
        break;
      case "start":
        await cmdStart(rest);
        break;
      case "start-global":
        await cmdStartGlobal(rest);
        break;
      case "kill":
        await cmdKill(rest);
        break;
      case "reconnect":
        await cmdReconnect(rest);
        break;
      case "ui":
        await cmdUi(rest);
        break;
      case "attach":
        await cmdAttach(rest);
        break;
      case "peek":
        await cmdPeek(rest);
        break;
      case "log":
        await cmdLog(rest);
        break;
      case "status":
        await cmdStatus(rest);
        break;
      case "events":
        await cmdEvents(rest);
        break;
      case "attention":
        await cmdAttention(rest);
        break;
      case "doctor":
        await cmdDoctor(rest);
        break;
      case "reload":
        await cmdReload(rest);
        break;
      case "layout":
        cmdLayout(rest);
        break;
      case "iterm":
        cmdIterm(rest);
        break;
      case "pm":
        await cmdPm(rest);
        break;
      case "list":
        await cmdList(rest);
        break;
      case "auth":
        await cmdAuth(rest);
        break;
      case "config":
        await cmdConfig(rest);
        break;
      case "gen-key":
        process.stdout.write(`${generateKey()  }\n`);
        break;
      case "register":
        await cmdRegister(rest);
        break;
      case "unregister":
        await cmdUnregister(rest);
        break;
      default:
        die(`unknown command '${cmd}' -- run 'a2a help' for usage`);
    }
  } catch (err) {
    die(err.message, 1);
  }
}

main();
