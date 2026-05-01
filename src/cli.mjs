#!/usr/bin/env node
"use strict";

import { request as _request } from "http";
import { readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { URL, fileURLToPath } from "url";
import { spawnSync, spawn } from "child_process";
import { isFlagSendArgv, parseFlagSendArgv } from "./a2a-argv.mjs";
import { isColonFlagArgv, parseColonFlagArgv, buildRegistry } from "./a2a-tokens.mjs";
import { loadTeamSpec, resolveTeamSpecPath } from "./a2a-team-spec.mjs";
import {
    activeKey, bridgeUrl, readPid, writePid, removePid,
    isGroup, listGroupNames, listGroupMembers, loadConfig, loadRegistry, patchConfig,
    generateKey, configGet, configSet, messageLogPath,
    teamSpecsDir,
} from "./a2a-config.mjs";

const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "a2a-server.mjs");
const REPO_TEAMS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "teams");

const BACKENDS = { claude: "claude", gemini: "gemini", codex: "codex", "cursor-agent": "cursor-agent" };
const BACKEND_FLAGS = new Set(Object.keys(BACKENDS));
const COMMON_APPROVALS = new Set(["default", "plan", "edit", "never"]);
const COMMON_SANDBOXES = new Set(["default", "read-only", "workspace-write", "danger-full-access"]);

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

  colon syntax
  a2a --ask:bob:leah 'where for lunch?'
  a2a --message:darth --mood=angry 'where is padme'

bridge
  a2a bridge [start|stop|status]

sessions
  a2a start [NAME] [--user NAME] [--prompt TEXT] [--prompt-file PATH] [--skill NAME]...
            [--dashboard] [--claude|--gemini|--codex|--cursor-agent] [backend-flags...]
  a2a start-global [NAME] [--user NAME] [--prompt TEXT] [--prompt-file PATH] [--skill NAME]...
            [--dashboard] [--url=<ngrok-url>] [--port=<port>] [backend-flags...]

  --prompt TEXT        persona/system prompt for the spawned CLI session
  --prompt-file PATH   read persona prompt from a file (relative to cwd)
  --skill NAME         append a skill's SKILL.md to the persona prompt; repeatable.
                       resolved from ~/.claude/skills/<name>/SKILL.md, then
                       ./.claude/skills/<name>/SKILL.md

  a2a list
  a2a reconnect [NAME] [--all] [--dashboard]
  a2a peek [NAME] [--lines=N]
  a2a attach [NAME] [--native-scroll|--cc]
  a2a kill [NAME]
  a2a kill --all

log
  a2a log                              show last 50 log entries
  a2a log --lines=N                    show last N entries
  a2a log -f | --follow                tail the log live
  a2a log --path                       print the log file path

auth
  a2a auth add --<peer> --url <url> --key <key>
  a2a auth list
  a2a auth revoke --<peer>

config
  a2a config ls
  a2a config get <key>
  a2a config set <key> <value>

  keys: port, host, key

  a2a gen-key

advanced
  a2a register --id ID --target TARGET [--desc TEXT]
  a2a unregister [ID]
`
    );
    process.exit(code);
}

function die(msg, code = 2) { process.stderr.write(`a2a: ${msg}\n`); process.exit(code); }
function info(msg) { process.stderr.write(`a2a: ${msg}\n`); }

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const KEY = activeKey();
        let base;
        try { base = new URL(bridgeUrl()); }
        catch { reject(new Error(`invalid bridge URL: ${bridgeUrl()}`)); return; }
        const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
        const req = _request({
            method,
            hostname: base.hostname,
            port: base.port || (base.protocol === "https:" ? 443 : 80),
            path: pathname,
            headers: {
                "Accept": "application/json",
                ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
                ...(KEY ? { "Authorization": `Bearer ${KEY}` } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try { resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : null }); }
                catch { reject(new Error(`non-JSON (${res.statusCode}): ${raw.slice(0, 200)}`)); }
            });
        });
        req.on("error", (err) => {
            reject(err.code === "ECONNREFUSED"
                ? new Error(`connection refused at ${bridgeUrl()} -- start with: a2a bridge`)
                : err);
        });
        if (payload) req.write(payload);
        req.end();
    });
}

function parseArgs(args, flagSpec) {
    const flags = {}, kv = {}, positional = [];
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
        if (arg.startsWith("--")) {
            const eqIdx = arg.indexOf("=");
            const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
            const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[i + 1];
            if (flagSpec && !(key in flagSpec)) die(`unknown flag --${key}`);
            if (val === undefined) die(`--${key} requires a value`);
            flags[key] = val; i += eqIdx !== -1 ? 1 : 2; continue;
        }
        const kvm = arg.match(/^([a-zA-Z]+):(.*)$/);
        if (kvm && ["from","to","origin"].includes(kvm[1])) { kv[kvm[1]] = kvm[2]; i++; continue; }
        positional.push(arg); i++;
    }
    return { flags, kv, positional };
}

function parseAuthArgs(args, knownValueFlags = new Set()) {
    let peer = null; const flags = {};
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--") break;
        if (!arg.startsWith("--")) { i++; continue; }
        const eqIdx = arg.indexOf("=");
        const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
        if (knownValueFlags.has(key)) {
            const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[i + 1];
            if (!val || val.startsWith("--")) die(`--${key} requires a value`);
            flags[key] = val; i += eqIdx !== -1 ? 1 : 2;
        } else {
            if (peer) die(`multiple peer names: '${peer}' and '${key}'`);
            peer = key; i++;
        }
    }
    return { peer, flags };
}

function requireBinary(name) {
    if (spawnSync("which", [name], { stdio: ["ignore","pipe","ignore"] }).status !== 0) die(`${name} not found in PATH`, 3);
}

function tmux(args, opts = {}) {
    if (opts.inherit) return spawnSync("tmux", args, { encoding: "utf8", stdio: "inherit" });
    return spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore","pipe","pipe"] });
}

function tmuxSessionExists(id) { return tmux(["has-session", "-t", id]).status === 0; }
function tmuxListSessions() {
    const r = tmux(["list-sessions", "-F", "#S"]);
    if (r.status !== 0) return [];
    return (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
function tmuxPanePath(id) {
    const r = tmux(["display-message", "-p", "-t", id, "#{pane_current_path}"]);
    return r.status === 0 ? ((r.stdout || "").trim() || process.cwd()) : process.cwd();
}
function hasInteractiveTerminal() { return !!(process.stdin.isTTY && process.stdout.isTTY); }
function isIterm2() { return (process.env.TERM_PROGRAM || "").toLowerCase() === "iterm.app"; }
function isDashboardSession(id) { return !!id && (id === "a2a-view" || id.endsWith("-view")); }

function attachTmuxSession(target, opts = {}) {
    const wantNativeScroll = opts.nativeScroll ?? (!process.env.TMUX && hasInteractiveTerminal() && isIterm2());
    if (wantNativeScroll) {
        if (process.env.TMUX) die("native scroll attach must be launched outside an existing tmux session");
        tmux(["-CC", "attach", "-t", target], { inherit: true });
        return;
    }
    tmux(["attach", "-t", target], { inherit: true });
}

function currentTmuxSession() {
    if (!process.env.TMUX) return null;
    const r = tmux(["display-message", "-p", "#S"]);
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
}

function sanitizeId(raw) {
    return (raw || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function validateAgentId(id) {
    if (!id) die("agent name is required");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) die(`agent name '${id}' must match [A-Za-z0-9_-]+`);
}

function shellQuote(arg) {
    if (arg === "") return "''";
    if (/^[A-Za-z0-9_\-./:=]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

function validateEnvMap(env) {
    if (env == null) return {};
    if (typeof env !== "object" || Array.isArray(env)) die("team env must be an object");
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) die(`invalid env key '${key}' in team spec`);
        out[key] = value == null ? "" : String(value);
    }
    return out;
}

function buildEnvExports(env) {
    const vars = validateEnvMap(env);
    return Object.entries(vars).map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ");
}

function applyBackendDefaults(backend, backendArgs) {
    if (backend !== "codex") return backendArgs;

    const hasSandboxOrApprovalOverride = backendArgs.some((arg) =>
        arg === "--dangerously-bypass-approvals-and-sandbox" ||
        arg === "--full-auto" ||
        arg === "--oss" ||
        arg === "-a" ||
        arg.startsWith("--ask-for-approval") ||
        arg === "-s" ||
        arg.startsWith("--sandbox")
    );

    if (hasSandboxOrApprovalOverride) return backendArgs;
    return ["--dangerously-bypass-approvals-and-sandbox", ...backendArgs];
}

function buildAgentLaunchCommand(backend, backendArgs, opts = {}) {
    const cli = BACKENDS[backend] || "claude";
    const effectiveArgs = applyBackendDefaults(backend, backendArgs);
    const quoted = [cli, ...effectiveArgs].map(shellQuote).join(" ");
    const exports = buildEnvExports(opts.env);
    return `export A2A_SESSION=1; ${exports ? `${exports} ` : ""}if command -v caffeinate >/dev/null 2>&1; then exec caffeinate -i -t 3600 ${quoted}; else exec ${quoted}; fi`;
}

function buildRoleLaunchArgs(backend, backendArgs, rolePrompt) {
    if (!rolePrompt) return backendArgs;
    switch (backend) {
        case "claude":
            return [...backendArgs, "--append-system-prompt", rolePrompt];
        case "gemini":
            return [...backendArgs, "--prompt-interactive", rolePrompt];
        case "codex":
        case "cursor-agent":
            return [...backendArgs, rolePrompt];
        default:
            return backendArgs;
    }
}

/**
 * Read a skill's SKILL.md body. User-global (~/.claude/skills/<name>/SKILL.md)
 * is searched first, then project-local (./.claude/skills/<name>/SKILL.md).
 * Dies with a clear message if neither exists.
 */
function readSkillBody(name) {
    const userPath = join(homedir(), ".claude", "skills", name, "SKILL.md");
    const projectPath = join(process.cwd(), ".claude", "skills", name, "SKILL.md");
    try { return { body: readFileSync(userPath, "utf8"), path: userPath }; } catch { /* fall through */ }
    try { return { body: readFileSync(projectPath, "utf8"), path: projectPath }; } catch { /* fall through */ }
    die(`skill '${name}' not found at ${userPath} or ${projectPath}`, 1);
}

/**
 * Compose a single persona text block from an inline prompt and a list of
 * skill names. Skills are appended after the prompt as `## Skill: <name>`
 * sections. Returns "" if both inputs are empty.
 */
function composePersona(promptText, skills) {
    const parts = [];
    if (promptText && promptText.trim()) parts.push(promptText.trim());
    for (const name of skills) {
        const { body } = readSkillBody(name);
        parts.push(`## Skill: ${name}\n\n${body.trim()}`);
    }
    return parts.join("\n\n");
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

function hasAnyFlag(args, names) {
    return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function maybePush(args, ...parts) {
    for (const part of parts) if (part != null && part !== "") args.push(String(part));
}

function translateCommonAgentSettings(agent) {
    const args = Array.isArray(agent.args) ? [...agent.args.map((arg) => String(arg))] : [];
    const approval = agent.approval || "default";
    const sandbox = agent.sandbox || "default";
    const model = agent.model == null ? null : String(agent.model);

    if (!COMMON_APPROVALS.has(approval)) die(`invalid approval '${approval}' for agent '${agent.id}'`);
    if (!COMMON_SANDBOXES.has(sandbox)) die(`invalid sandbox '${sandbox}' for agent '${agent.id}'`);

    switch (agent.backend) {
        case "claude": {
            if (model && !hasAnyFlag(args, ["--model"])) maybePush(args, "--model", model);
            if (!hasAnyFlag(args, ["--permission-mode"])) {
                const mode = {
                    default: null,
                    plan: "plan",
                    edit: "acceptEdits",
                    never: sandbox === "danger-full-access" ? "bypassPermissions" : "dontAsk",
                }[approval];
                if (mode) maybePush(args, "--permission-mode", mode);
            }
            if (approval === "never" && sandbox === "danger-full-access" && !hasAnyFlag(args, ["--dangerously-skip-permissions"])) {
                args.push("--dangerously-skip-permissions");
            }
            break;
        }
        case "codex": {
            if (model && !hasAnyFlag(args, ["--model", "-m"])) maybePush(args, "--model", model);
            if (approval === "plan") {
                if (!hasAnyFlag(args, ["--ask-for-approval", "-a"])) maybePush(args, "--ask-for-approval", "never");
                if (!hasAnyFlag(args, ["--sandbox", "-s"])) maybePush(args, "--sandbox", sandbox === "default" ? "read-only" : sandbox);
            } else if (approval === "edit") {
                if (!hasAnyFlag(args, ["--ask-for-approval", "-a"])) maybePush(args, "--ask-for-approval", "never");
                if (!hasAnyFlag(args, ["--sandbox", "-s"])) maybePush(args, "--sandbox", sandbox === "default" ? "workspace-write" : sandbox);
            } else if (approval === "never") {
                if (sandbox === "danger-full-access" && !hasAnyFlag(args, ["--dangerously-bypass-approvals-and-sandbox"])) {
                    args.push("--dangerously-bypass-approvals-and-sandbox");
                } else {
                    if (!hasAnyFlag(args, ["--ask-for-approval", "-a"])) maybePush(args, "--ask-for-approval", "never");
                    if (sandbox !== "default" && !hasAnyFlag(args, ["--sandbox", "-s"])) maybePush(args, "--sandbox", sandbox);
                }
            } else if (sandbox !== "default" && !hasAnyFlag(args, ["--sandbox", "-s"])) {
                maybePush(args, "--sandbox", sandbox);
            }
            break;
        }
        case "gemini": {
            if (model && !hasAnyFlag(args, ["--model", "-m"])) maybePush(args, "--model", model);
            if (!hasAnyFlag(args, ["--approval-mode"])) {
                const mode = {
                    default: null,
                    plan: "plan",
                    edit: "auto_edit",
                    never: "yolo",
                }[approval];
                if (mode) maybePush(args, "--approval-mode", mode);
            }
            if (!hasAnyFlag(args, ["--sandbox"])) {
                if (sandbox === "danger-full-access") args.push("--sandbox=false");
                else if (sandbox !== "default") args.push("--sandbox=true");
            }
            break;
        }
        case "cursor-agent": {
            if (model && !hasAnyFlag(args, ["--model"])) maybePush(args, "--model", model);
            if (approval === "plan" && !hasAnyFlag(args, ["--mode", "--plan"])) maybePush(args, "--mode", "plan");
            if ((approval === "edit" || approval === "never") && !hasAnyFlag(args, ["--yolo", "--force", "-f"])) {
                args.push("--yolo");
            }
            if (!hasAnyFlag(args, ["--sandbox"])) {
                if (sandbox === "danger-full-access") maybePush(args, "--sandbox", "disabled");
                else if (sandbox !== "default") maybePush(args, "--sandbox", "enabled");
            }
            break;
        }
        default:
            break;
    }
    return args;
}

function sessionStartupError(name, backend) {
    return `${backend} session '${name}' exited during startup`;
}

function ensureSessionSurvivedStart(name, backend) {
    if (!tmuxSessionExists(name)) die(sessionStartupError(name, backend), 1);
}

function explainDetachedStart(name) {
    info(`'${name}' is running in tmux; this shell is not interactive, so auto-attach was skipped`);
    info(`  peek:   a2a peek ${name}`);
    info(`  attach: a2a attach ${name}`);
    info(`  iTerm2 native scroll: a2a attach ${name} --native-scroll`);
}

function inferCohortDescription(agentId) {
    for (const groupName of listGroupNames()) {
        if (listGroupMembers(groupName).some((m) => m.name === agentId)) return `group:${groupName}`;
    }
    return "";
}

function parseStartArgs(args) {
    let name = null;
    let backend = "claude";
    let dashboard = null;
    let promptText = null;
    const skills = [];
    const backendArgs = [];
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--") { backendArgs.push(...args.slice(i + 1)); break; }
        if (!arg.startsWith("--")) {
            if (!name) name = arg;
            else backendArgs.push(arg);
            i++; continue;
        }
        const eqIdx = arg.indexOf("=");
        const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
        if (key === "user") {
            name = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[++i];
            if (name === undefined) die(`--user requires a value`);
            i++; continue;
        }
        if (key === "prompt") {
            const v = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[++i];
            if (v === undefined) die(`--prompt requires a value`);
            promptText = (promptText ? promptText + "\n\n" : "") + v;
            i++; continue;
        }
        if (key === "prompt-file") {
            const path = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[++i];
            if (path === undefined) die(`--prompt-file requires a value`);
            const abs = resolve(process.cwd(), path);
            let body;
            try { body = readFileSync(abs, "utf8"); }
            catch (err) { die(`--prompt-file '${path}': ${err.message}`); }
            promptText = (promptText ? promptText + "\n\n" : "") + body;
            i++; continue;
        }
        if (key === "skill") {
            const v = eqIdx !== -1 ? arg.slice(eqIdx + 1) : args[++i];
            if (v === undefined) die(`--skill requires a value`);
            skills.push(v);
            i++; continue;
        }
        if (key === "layout" || key === "dashboard") { dashboard = true; i++; continue; }
        if (BACKEND_FLAGS.has(key)) { backend = key; i++; continue; }
        backendArgs.push(arg); i++;
    }
    return { name, backend, backendArgs, dashboard, promptText, skills };
}

function resolveTeamRef(ref) {
    if (!ref) return null;
    return resolveTeamSpecPath(ref, process.cwd(), REPO_TEAMS_DIR, teamSpecsDir());
}

function loadRoleText(baseDir, roleFile) {
    const path = resolve(baseDir, roleFile);
    return readFileSync(path, "utf8").trim();
}

function combinedRolePrompt(defaults, raw, baseDir, agentId) {
    if (raw.role != null && raw.role_file != null) die(`agent '${agentId}' cannot set both role and role_file`);
    if (defaults.role != null && defaults.role_file != null) die(`team defaults cannot set both role and role_file`);

    const parts = [];
    if (defaults.role_file != null) parts.push(loadRoleText(baseDir, String(defaults.role_file)));
    else if (defaults.role != null) parts.push(String(defaults.role).trim());

    if (raw.role_file != null) parts.push(loadRoleText(baseDir, String(raw.role_file)));
    else if (raw.role != null) parts.push(String(raw.role).trim());

    return parts.filter(Boolean).join("\n\n");
}

function normalizeTeamAgent(id, raw, defaults, baseDir) {
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) die(`team agent '${id}' must be an object`);
    const merged = {
        ...defaults,
        ...raw,
        env: { ...(defaults.env || {}), ...(raw.env || {}) },
        args: [
            ...((defaults.args || []).map((arg) => String(arg))),
            ...((raw.args || []).map((arg) => String(arg))),
        ],
    };
    const agentId = sanitizeId(raw.id || id);
    const backend = String(merged.backend || "claude");
    if (!BACKEND_FLAGS.has(backend)) die(`agent '${agentId}' uses unsupported backend '${backend}'`);
    const rolePrompt = combinedRolePrompt(defaults, raw, baseDir, agentId);
    return {
        id: agentId,
        backend,
        cwd: merged.cwd ? resolve(baseDir, String(merged.cwd)) : process.cwd(),
        env: merged.env || {},
        model: merged.model == null ? null : String(merged.model),
        approval: merged.approval == null ? "default" : String(merged.approval),
        sandbox: merged.sandbox == null ? "default" : String(merged.sandbox),
        rolePrompt,
        args: Array.isArray(merged.args) ? merged.args : [],
    };
}

function normalizeTeamSpec(ref, specPath, rawSpec) {
    const defaults = rawSpec.defaults || {};
    if (defaults && (typeof defaults !== "object" || Array.isArray(defaults))) die(`team spec '${ref}' has invalid defaults`);
    const sourceAgents = rawSpec.agents;
    if (!sourceAgents || typeof sourceAgents !== "object") die(`team spec '${ref}' must define agents`);
    const entries = Array.isArray(sourceAgents)
        ? sourceAgents.map((agent, idx) => [agent?.id || `agent-${idx + 1}`, agent])
        : Object.entries(sourceAgents);
    const baseDir = dirname(specPath);
    const agents = entries.map(([id, agent]) => normalizeTeamAgent(id, agent, defaults, baseDir));
    if (agents.length === 0) die(`team spec '${ref}' has no agents`);
    const name = sanitizeId(rawSpec.name || basename(specPath).replace(/\.(json|ya?ml)$/i, ""));
    return {
        name,
        path: specPath,
        description: rawSpec.description ? String(rawSpec.description) : "",
        dashboard: rawSpec.dashboard === true,
        agents,
    };
}

function loadResolvedTeamSpec(ref) {
    const specPath = resolveTeamRef(ref);
    if (!specPath) return null;
    return normalizeTeamSpec(ref, specPath, loadTeamSpec(specPath));
}

function getNgrokUrl() {
    return new Promise((resolve, reject) => {
        const req = _request({ hostname: "localhost", port: 4040, path: "/api/tunnels", method: "GET" }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                try {
                    const tunnel = JSON.parse(Buffer.concat(chunks).toString()).tunnels?.find((t) => t.proto === "https");
                    tunnel ? resolve(tunnel.public_url) : reject(new Error("no https tunnel found"));
                } catch { reject(new Error("failed to parse ngrok response")); }
            });
        });
        req.on("error", (err) => reject(new Error(`ngrok unreachable: ${err.message}`)));
        req.end();
    });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startNgrok(port) {
    return new Promise((resolve, reject) => {
        const proc = spawn("ngrok", ["http", String(port)], { detached: true, stdio: ["ignore","ignore","pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("error", (err) => reject(new Error(`failed to spawn ngrok: ${err.message}`)));
        proc.on("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`ngrok exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)); });
        proc.unref();
        const start = Date.now();
        (async () => {
            while (Date.now() - start < 10000) {
                await sleep(500);
                try { await getNgrokUrl(); resolve(); return; } catch { /* not ready */ }
            }
            reject(new Error(`ngrok did not start within 10s${stderr ? `: ${stderr.trim()}` : ""}`));
        })().catch(reject);
    });
}

async function listAgents() {
    const { status, body } = await request("GET", "/api/a2a/agents");
    if (status !== 200 || !body?.success) throw new Error(`list failed: ${body?.error || `HTTP ${status}`}`);
    return body.data?.agents || [];
}

function inferPeer(agents, selfId) {
    const others = agents.filter((a) => a.agentId !== selfId);
    if (others.length === 0) return { error: "no peers registered -- use 'a2a start <n>' to create one" };
    if (others.length === 1) return { peer: others[0] };
    return { error: `multiple peers (${others.map((a) => a.agentId).join(", ")}) -- specify one` };
}

async function getRegistry() {
    let agentIds = [];
    try { agentIds = (await listAgents()).map((a) => a.agentId); } catch { /* use cached */ }
    return buildRegistry(agentIds);
}

async function sendNormalizedEnvelope(envelope) {
    const rawSelfId = currentTmuxSession();
    const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
    const recipients = [...envelope.to];
    let agents = [];
    if (recipients.length === 0) {
        agents = await listAgents();
        const result = inferPeer(agents, selfId);
        if (result.error) die(result.error, 1);
        recipients.push(result.peer.agentId);
    } else {
        try { agents = await listAgents(); } catch { }
    }
    const agentMap = {};
    for (const agent of agents) agentMap[agent.agentId] = agent;
    const fromId = envelope.from || selfId || "cli";
    const origin = envelope.origin || (selfId ? "peer" : "user");
    if (!["user","peer","self"].includes(origin)) die(`invalid origin '${origin}'`);
    const replyTo = process.env.A2A_BRIDGE_PUBLIC || null;
    const { message, from: _f, to: _t, action, origin: _o, ...extras } = envelope;
    for (const toId of recipients) {
        const targetAgent = agentMap[toId];
        if (targetAgent && !targetAgent.bridgeUrl && !tmuxSessionExists(toId)) {
            info(`${toId} session dead, attempting restart...`);
            try {
                const restartBackend = targetAgent.backend || "claude";
                const restartArgs = Array.isArray(targetAgent.backendArgs) ? targetAgent.backendArgs : [];
                const cmd = buildAgentLaunchCommand(restartBackend, restartArgs, { env: targetAgent.backendEnv || {} });
                const r = tmux(["new-session", "-d", "-s", toId, "-c", targetAgent.cwd || process.cwd(), cmd]);
                if (r.status === 0) {
                    info(`${toId} restarted`);
                    await new Promise((r) => setTimeout(r, 500));
                    if (!tmuxSessionExists(toId)) info(`restart exited immediately for ${toId}, will attempt to send anyway`);
                } else {
                    info(`restart failed for ${toId}, will attempt to send anyway`);
                }
            } catch (err) {
                info(`restart error: ${err.message}`);
            }
        }
        const { status, body } = await request("POST", "/api/a2a/send", {
            to: toId, from: fromId, origin, body: message, action,
            ...(replyTo ? { replyTo } : {}), ...extras,
        });
        if (status !== 200 || !body?.success) die(`send failed: ${body?.error || `HTTP ${status}`}`, 1);
        info(`${fromId} -> ${toId} [${origin}/${action}] (${body.data?.bytes ?? "?"} bytes)`);
    }
}

async function doSend({ flags, kv, positional }, action = "message") {
    const bodyText = positional.join(" ").trim();
    if (!bodyText) die("message body is required");
    const rawSelfId = currentTmuxSession();
    const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
    const toId = kv.to || flags.to || await (async () => {
        const result = inferPeer(await listAgents(), selfId);
        if (result.error) die(result.error, 1);
        return result.peer.agentId;
    })();
    const fromId = kv.from || flags.from || selfId || "cli";
    const origin = kv.origin || flags.origin || (selfId ? "peer" : "user");
    if (!["user","peer","self"].includes(origin)) die(`invalid origin '${origin}'`);
    const replyTo = process.env.A2A_BRIDGE_PUBLIC || process.env.MOD_BRIDGE_PUBLIC || null;
    const { status, body } = await request("POST", "/api/a2a/send", {
        to: toId, from: fromId, origin, body: bodyText, action,
        ...(replyTo ? { replyTo } : {}),
    });
    if (status !== 200 || !body?.success) die(`send failed: ${body?.error || `HTTP ${status}`}`, 1);
    info(`${fromId} -> ${toId} [${origin}/${action}] (${body.data?.bytes ?? "?"} bytes)`);
}

async function doParsedFlagSend(parsed) {
    const rawSelfId = currentTmuxSession();
    const selfId = isDashboardSession(rawSelfId) ? null : rawSelfId;
    const fromId = parsed.from || selfId || "cli";
    const origin = parsed.origin || (selfId ? "peer" : "user");
    if (!["user","peer","self"].includes(origin)) die(`invalid origin '${origin}'`);
    const recipients = [...new Set([...(parsed.to ? [parsed.to] : []), ...(parsed.recipients||[])].filter(Boolean))];
    let agents = [];
    if (recipients.length === 0) {
        agents = await listAgents();
        const others = agents.filter((a) => a.agentId !== selfId);
        if (others.length === 0) die("no peers registered -- use 'a2a start <n>' to create one", 1);
        recipients.push(...others.map((a) => a.agentId));
    } else {
        try { agents = await listAgents(); } catch { }
    }
    const agentMap = {};
    for (const agent of agents) agentMap[agent.agentId] = agent;
    const replyTo = process.env.A2A_BRIDGE_PUBLIC || null;
    for (const toId of recipients) {
        if (!parsed.content) die("message body is required");
        const targetAgent = agentMap[toId];
        if (targetAgent && !targetAgent.bridgeUrl && !tmuxSessionExists(toId)) {
            info(`${toId} session dead, attempting restart...`);
            try {
                const restartBackend = targetAgent.backend || "claude";
                const restartArgs = Array.isArray(targetAgent.backendArgs) ? targetAgent.backendArgs : [];
                const cmd = buildAgentLaunchCommand(restartBackend, restartArgs, { env: targetAgent.backendEnv || {} });
                const r = tmux(["new-session", "-d", "-s", toId, "-c", targetAgent.cwd || process.cwd(), cmd]);
                if (r.status === 0) {
                    info(`${toId} restarted`);
                    await new Promise((r) => setTimeout(r, 500));
                    if (!tmuxSessionExists(toId)) info(`restart exited immediately for ${toId}, will attempt to send anyway`);
                } else {
                    info(`restart failed for ${toId}, will attempt to send anyway`);
                }
            } catch (err) {
                info(`restart error: ${err.message}`);
            }
        }
        const { status, body } = await request("POST", "/api/a2a/send", {
            to: toId, from: fromId, origin, body: parsed.content, action: parsed.action || "message",
            ...(replyTo ? { replyTo } : {}),
        });
        if (status !== 200 || !body?.success) die(`send failed: ${body?.error || `HTTP ${status}`}`, 1);
        info(`${fromId} -> ${toId} [${origin}/${parsed.action||"message"}] (${body.data?.bytes ?? "?"} bytes)`);
    }
}

function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function bridgeHealthy() {
    return new Promise((resolve) => {
        let base;
        try { base = new URL(bridgeUrl()); } catch { resolve(false); return; }
        const req = _request(
            { method: "GET", hostname: base.hostname, port: base.port, path: "/health", timeout: 2000 },
            (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve(JSON.parse(raw).success === true); } catch { resolve(false); } }); }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function cmdBridge(args) {
    const sub = (args[0] || "start").toLowerCase();

    if (sub === "status") {
        const pid = readPid();
        const alive = pid && isProcessAlive(pid);
        const healthy = await bridgeHealthy();
        if (healthy)    info(`bridge running${alive ? ` (pid ${pid})` : ""} at ${bridgeUrl()}`);
        else if (alive) info(`bridge process ${pid} exists but not responding`);
        else            info("bridge is not running");
        return;
    }

    if (sub === "stop") {
        const pid = readPid();
        if (pid && isProcessAlive(pid)) {
            process.kill(pid, "SIGTERM");
            info(`sent SIGTERM to bridge (pid ${pid})`);
            removePid();
        } else {
            info("bridge is not running");
            removePid();
        }
        return;
    }

    if (sub === "start" || sub === "bridge") {
        if (await bridgeHealthy()) { info(`bridge already running${readPid() ? ` (pid ${readPid()})` : ""} at ${bridgeUrl()}`); return; }
        const stale = readPid();
        if (stale && isProcessAlive(stale)) { info(`killing stale bridge (pid ${stale})`); process.kill(stale, "SIGTERM"); spawnSync("sleep", ["0.5"]); }
        const KEY = activeKey();
        const child = spawn("node", [SERVER_SCRIPT], {
            detached: true, stdio: ["ignore","ignore","ignore"],
            env: { ...process.env, ...(KEY ? { A2A_KEY: KEY } : {}) },
        });
        child.unref();
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 250));
            if (await bridgeHealthy()) { info(`bridge started (pid ${readPid() || child.pid}) at ${bridgeUrl()}`); return; }
        }
        die("bridge failed to start within 5s", 1);
    }

    die(`unknown bridge subcommand '${sub}' (expected: start, stop, status)`);
}

async function startSingle(name, backend, backendArgs, opts = {}) {
    validateAgentId(name);
    requireBinary("tmux");
    requireBinary(BACKENDS[backend] || "claude");

    const target = `${name}:0.0`;
    let createdSession = false;
    const cwd = opts.cwd || process.cwd();
    const env = opts.env || {};

    if (tmuxSessionExists(name)) {
        info(`session '${name}' already exists, re-registering (running ${BACKENDS[backend] || "claude"} is unchanged)`);
        if (backendArgs.length) {
            info(`  warning: backend args will be recorded but won't apply to the running process`);
            info(`  to apply, restart: a2a kill ${name} && a2a start ${name} ${backendArgs.map(shellQuote).join(" ")}`);
        }
    } else {
        const r = tmux(["new-session", "-d", "-s", name, "-c", cwd, buildAgentLaunchCommand(backend, backendArgs, { env })]);
        if (r.status !== 0) die(`tmux new-session failed: ${(r.stderr||"").trim()||"unknown"}`, 1);
        createdSession = true;
        spawnSync("sleep", ["1"]);
        ensureSessionSurvivedStart(name, backend);
    }

    try {
        const { status, body } = await request("POST", "/api/a2a/register", {
            agentId: name, tmuxTarget: target,
            description: opts.description || `a2a start: ${cwd}`,
            cwd,
            backend,
            backendArgs,
            backendEnv: env,
            ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
        });
        if (status !== 200 || !body?.success) throw new Error(body?.error || `HTTP ${status}`);
    } catch (err) {
        const msg = err.message;
        if (createdSession) { info(`register failed: ${msg}`); info(`killing orphan '${name}'`); tmux(["kill-session", "-t", name]); }
        die(`register failed: ${msg}`, 1);
    }

    info(`'${name}' registered at ${target}${opts.bridgeUrl ? ` (replies via ${opts.bridgeUrl})` : ""}`);
    if (!process.env.TMUX) {
        if (hasInteractiveTerminal()) attachTmuxSession(name);
        else explainDetachedStart(name);
    }
    else info(`switch with: tmux switch-client -t '${name}'`);
}

function createDashboardView(viewSession, members, cwd) {
    const self = currentTmuxSession();
    if (self) {
        for (const member of members) tmux(["link-window", "-s", `${member}:0`, "-t", `${self}:`]);
        info("  linked windows added to current session");
        info("  switch: Prefix-n / Prefix-p");
        return;
    }
    tmux(["new-session", "-d", "-s", viewSession, "-c", cwd]);
    for (const member of members) tmux(["link-window", "-s", `${member}:0`, "-t", `${viewSession}:`]);
    tmux(["kill-window", "-t", `${viewSession}:0`]);
    members.forEach((m, i) => info(`  window ${i + 1}: ${m}`));
    info("  switch: Prefix-n / Prefix-p");
    if (hasInteractiveTerminal()) attachTmuxSession(`${viewSession}:`);
    else {
        info("  detached dashboard: this shell is not interactive, so auto-attach was skipped");
        info(`  attach later: a2a attach ${viewSession}`);
    }
}

async function startGroup(groupName, backend, backendArgs, opts = {}) {
    requireBinary("tmux");
    requireBinary(BACKENDS[backend] || "claude");

    const members = listGroupMembers(groupName);
    if (members.length === 0) die(`group '${groupName}' has no .md files`);
    info(`starting group '${groupName}' (${members.length} characters)`);

    const spawned = [];
    for (const char of members) {
        validateAgentId(char.name);
        const target = `${char.name}:0.0`;
        const prompt = readFileSync(char.fullPath, "utf8").trim();
        const memberArgs = buildRoleLaunchArgs(backend, backendArgs, prompt);
        if (!tmuxSessionExists(char.name)) {
            const r = tmux(["new-session", "-d", "-s", char.name, "-c", process.cwd(), buildAgentLaunchCommand(backend, memberArgs)]);
            if (r.status !== 0) { info(`  ${char.name}: FAILED: ${(r.stderr||"").trim()}`); continue; }
            spawnSync("sleep", ["1"]);
            if (!tmuxSessionExists(char.name)) { info(`  ${char.name}: FAILED: ${sessionStartupError(char.name, backend)}`); continue; }
            info(`  ${char.name}: spawned`);
        } else {
            info(`  ${char.name}: exists, re-registering`);
        }
        try {
            const { status, body } = await request("POST", "/api/a2a/register", {
                agentId: char.name, tmuxTarget: target,
                description: `group:${groupName}`, cwd: process.cwd(),
                backend,
                backendArgs: memberArgs,
                ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
            });
            if (status !== 200 || !body?.success) { info(`  ${char.name}: FAILED register: ${body?.error||`HTTP ${status}`}`); continue; }
            spawned.push(char.name);
        } catch (e) { info(`  ${char.name}: FAILED register: ${e.message}`); }
    }

    spawnSync("sleep", ["2"]);
    info(""); info(`group '${groupName}' ready: ${spawned.join(", ")}`);

    if (opts.dashboard && spawned.length >= 2) {
        createDashboardView(`${groupName}-view`, spawned, process.cwd());
    } else {
        info("  peek:    a2a peek <n>"); info("  message: a2a --<n> 'hello'"); info(`  kill:    a2a kill ${groupName}`);
        if (!process.env.TMUX && spawned.length > 0) {
            if (hasInteractiveTerminal()) attachTmuxSession(spawned[0]);
            else {
                info("  detached start: this shell is not interactive, so auto-attach was skipped");
                info(`  attach later: a2a attach ${spawned[0]}`);
            }
        }
    }
}

async function startTeam(teamSpec, opts = {}) {
    requireBinary("tmux");
    const spawned = [];
    info(`starting team '${teamSpec.name}' (${teamSpec.agents.length} agents)`);

    for (const agent of teamSpec.agents) {
        validateAgentId(agent.id);
        requireBinary(BACKENDS[agent.backend] || "claude");
        const launchArgs = buildRoleLaunchArgs(agent.backend, translateCommonAgentSettings(agent), agent.rolePrompt);
        const target = `${agent.id}:0.0`;
        if (!tmuxSessionExists(agent.id)) {
            const r = tmux(["new-session", "-d", "-s", agent.id, "-c", agent.cwd, buildAgentLaunchCommand(agent.backend, launchArgs, { env: agent.env })]);
            if (r.status !== 0) { info(`  ${agent.id}: FAILED: ${(r.stderr||"").trim() || "tmux new-session failed"}`); continue; }
            spawnSync("sleep", ["1"]);
            if (!tmuxSessionExists(agent.id)) { info(`  ${agent.id}: FAILED: ${sessionStartupError(agent.id, agent.backend)}`); continue; }
            info(`  ${agent.id}: spawned (${agent.backend})`);
        } else {
            info(`  ${agent.id}: exists, re-registering`);
        }
        try {
            const { status, body } = await request("POST", "/api/a2a/register", {
                agentId: agent.id,
                tmuxTarget: target,
                description: `team:${teamSpec.name}`,
                cwd: agent.cwd,
                backend: agent.backend,
                backendArgs: launchArgs,
                backendEnv: agent.env,
                ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
            });
            if (status !== 200 || !body?.success) { info(`  ${agent.id}: FAILED register: ${body?.error || `HTTP ${status}`}`); continue; }
            spawned.push(agent.id);
        } catch (err) {
            info(`  ${agent.id}: FAILED register: ${err.message}`);
        }
    }

    spawnSync("sleep", ["2"]);
    info("");
    info(`team '${teamSpec.name}' ready: ${spawned.join(", ")}`);

    const wantDashboard = opts.dashboard ?? teamSpec.dashboard;
    if (wantDashboard && spawned.length >= 2) {
        createDashboardView(`${teamSpec.name}-view`, spawned, teamSpec.agents[0]?.cwd || process.cwd());
    } else {
        info("  peek:    a2a peek <n>");
        info("  message: a2a --<n> 'hello'");
        info(`  kill:    a2a kill ${teamSpec.name}`);
        if (!process.env.TMUX && spawned.length > 0) {
            if (hasInteractiveTerminal()) attachTmuxSession(spawned[0]);
            else {
                info("  detached start: this shell is not interactive, so auto-attach was skipped");
                info(`  attach later: a2a attach ${spawned[0]}`);
            }
        }
    }
}

async function cmdStart(args) {
    const { name: rawName, backend, backendArgs, dashboard, promptText, skills } = parseStartArgs(args);
    const hasPersona = !!(promptText || skills.length);
    const teamSpec = rawName ? loadResolvedTeamSpec(rawName) : null;
    if (teamSpec) {
        if (hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with team spec '${rawName}'; configure agents in the team file (role/role_file)`);
        await startTeam(teamSpec, { dashboard });
        return;
    }
    const name = rawName ? sanitizeId(rawName) : sanitizeId(basename(process.cwd()));
    if (isGroup(name)) {
        if (hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with group '${name}'; group members already inject their own prompts from the group's .md files`);
        await startGroup(name, backend, backendArgs, { dashboard });
        return;
    }
    const personaText = composePersona(promptText, skills);
    if (personaText) {
        const bits = [];
        if (promptText) bits.push(`prompt (${promptText.length} chars)`);
        if (skills.length) bits.push(`skills: ${skills.join(", ")}`);
        info(`persona: ${bits.join("; ")}`);
    }
    const finalArgs = applyPersonaToBackendArgs(backend, backendArgs, personaText);
    await startSingle(name, backend, finalArgs);
}

async function cmdStartGlobal(args) {
    const { name: rawName, backend, backendArgs, dashboard, promptText, skills } = parseStartArgs(args);
    const hasPersona = !!(promptText || skills.length);
    const teamSpec = rawName ? loadResolvedTeamSpec(rawName) : null;
    if (teamSpec && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with team spec '${rawName}'; configure agents in the team file (role/role_file)`);
    const name = rawName ? sanitizeId(rawName) : sanitizeId(basename(process.cwd()));
    if (!teamSpec && isGroup(name) && hasPersona) die(`--prompt/--prompt-file/--skill cannot be combined with group '${name}'; group members already inject their own prompts from the group's .md files`);

    const urlFlag = args.find((a) => a.startsWith("--url="))?.slice(6);
    const portFlag = args.find((a) => a.startsWith("--port="))?.slice(7);
    const filteredBackendArgs = backendArgs.filter((a) => !a.startsWith("--url=") && !a.startsWith("--port="));

    const personaText = composePersona(promptText, skills);
    if (personaText) {
        const bits = [];
        if (promptText) bits.push(`prompt (${promptText.length} chars)`);
        if (skills.length) bits.push(`skills: ${skills.join(", ")}`);
        info(`persona: ${bits.join("; ")}`);
    }
    const filteredArgsWithPersona = applyPersonaToBackendArgs(backend, filteredBackendArgs, personaText);

    async function resolveNgrok(localPort) {
        try { const u = await getNgrokUrl(); info("ngrok already running"); return u; }
        catch {
            info(`starting ngrok on port ${localPort}...`);
            await startNgrok(localPort);
            return getNgrokUrl();
        }
    }

    if (urlFlag) {
        const remoteUrl = urlFlag.replace(/\/$/, "");
        process.env.A2A_BRIDGE = remoteUrl;
        requireBinary("ngrok");
        const localPort = portFlag || new URL(bridgeUrl()).port || "7742";
        const publicUrl = await resolveNgrok(localPort);
        process.env.A2A_BRIDGE_PUBLIC = publicUrl;
        info(`remote bridge: ${remoteUrl}`); info(`replies route via: ${publicUrl}`);
        if (teamSpec) { await startTeam(teamSpec, { bridgeUrl: publicUrl, dashboard }); return; }
        if (isGroup(name)) { await startGroup(name, backend, filteredBackendArgs, { bridgeUrl: publicUrl, dashboard }); return; }
        await startSingle(name, backend, filteredArgsWithPersona, { description: `a2a start-global: ${process.cwd()}`, bridgeUrl: publicUrl });
        return;
    }

    requireBinary("ngrok");
    const port = portFlag || new URL(bridgeUrl()).port || "7742";
    const publicUrl = await resolveNgrok(port);
    info(`bridge exposed at: ${publicUrl}`); info(""); info("share with peers:"); info(`  a2a start-global --url=${publicUrl}`); info("");
    if (teamSpec) { await startTeam(teamSpec, { bridgeUrl: publicUrl, dashboard }); return; }
    if (isGroup(name)) { await startGroup(name, backend, filteredBackendArgs, { bridgeUrl: publicUrl, dashboard }); return; }
    await startSingle(name, backend, filteredArgsWithPersona);
}

async function killOne(id) {
    let tmuxMsg, tmuxOk = true;
    if (tmuxSessionExists(id)) {
        const r = tmux(["kill-session", "-t", id]);
        tmuxOk = r.status === 0; tmuxMsg = tmuxOk ? "killed" : `kill failed: ${(r.stderr||"").trim()||"unknown"}`;
    } else { tmuxMsg = "no session"; }
    let regMsg, regOk = true;
    try {
        const { status, body } = await request("DELETE", `/api/a2a/register/${encodeURIComponent(id)}`);
        regOk = status === 200 && !!body?.success;
        regMsg = regOk ? (body.data?.removed ? "unregistered" : "not registered") : `unreg failed: ${body?.error||`HTTP ${status}`}`;
    } catch (e) { regOk = false; regMsg = `unreg failed: ${e.message}`; }
    return { ok: tmuxOk && regOk, tmuxMsg, regMsg };
}

async function killGroup(groupName) {
    const members = (await listAgents()).filter((a) => a.description === `group:${groupName}`);
    const viewSession = `${groupName}-view`;
    if (members.length === 0 && !tmuxSessionExists(viewSession)) { info(`no registered members for group '${groupName}'`); return; }
    info(`killing group '${groupName}' (${members.length} members)`);
    let allOk = true;
    for (const m of members) {
        const r = await killOne(m.agentId);
        process.stdout.write(`  ${m.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
        if (!r.ok) allOk = false;
    }
    if (tmuxSessionExists(viewSession)) {
        const r = tmux(["kill-session", "-t", viewSession]);
        const ok = r.status === 0;
        process.stdout.write(`  ${viewSession}: tmux ${ok ? "killed" : `kill failed: ${(r.stderr||"").trim()||"unknown"}`}, bridge not registered\n`);
        if (!ok) allOk = false;
    }
    if (!allOk) process.exit(1);
}

async function killTeam(teamRef) {
    const spec = loadResolvedTeamSpec(teamRef);
    const teamName = spec?.name || sanitizeId(teamRef);
    const members = (await listAgents()).filter((a) => a.description === `team:${teamName}`);
    const viewSession = `${teamName}-view`;
    if (members.length === 0 && !tmuxSessionExists(viewSession)) { info(`no registered members for team '${teamName}'`); return; }
    info(`killing team '${teamName}' (${members.length} members)`);
    let allOk = true;
    for (const m of members) {
        const r = await killOne(m.agentId);
        process.stdout.write(`  ${m.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
        if (!r.ok) allOk = false;
    }
    if (tmuxSessionExists(viewSession)) {
        const r = tmux(["kill-session", "-t", viewSession]);
        const ok = r.status === 0;
        process.stdout.write(`  ${viewSession}: tmux ${ok ? "killed" : `kill failed: ${(r.stderr||"").trim()||"unknown"}`}, bridge not registered\n`);
        if (!ok) allOk = false;
    }
    if (!allOk) process.exit(1);
}

async function cmdKill(args) {
    const hasAll = args.includes("--all");
    const filtered = args.filter((a) => a !== "--all");
    let [name] = parseArgs(filtered, {}).positional;

    if (hasAll || (!name && !currentTmuxSession())) {
        const agents = await listAgents();
        if (agents.length === 0) { info("no agents registered"); return; }
        info(`killing all agents (${agents.length})`);
        let allOk = true;
        for (const agent of agents) {
            const r = await killOne(agent.agentId);
            process.stdout.write(`  ${agent.agentId}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
            if (!r.ok) allOk = false;
        }
        if (!allOk) process.exit(1);
        return;
    }

    if (!name) { name = currentTmuxSession(); if (!name) die("kill needs a name"); }
    if (loadResolvedTeamSpec(name)) { await killTeam(name); return; }
    if (isGroup(name)) { await killGroup(name); return; }
    try {
        const agents = await listAgents();
        if (agents.filter((a) => a.description === `group:${name}`).length > 0) { await killGroup(name); return; }
        if (agents.filter((a) => a.description === `team:${name}`).length > 0) { await killTeam(name); return; }
    } catch { /* fall through */ }
    validateAgentId(name);
    const r = await killOne(name);
    process.stdout.write(`${name}: tmux ${r.tmuxMsg}, bridge ${r.regMsg}\n`);
    if (!r.ok) process.exit(1);
}

async function cmdAttach(args) {
    const wantNativeScroll = args.includes("--native-scroll") || args.includes("--cc");
    const filtered = args.filter((a) => a !== "--native-scroll" && a !== "--cc");
    let [id] = parseArgs(filtered, {}).positional;
    if (!id) { const r = inferPeer(await listAgents(), currentTmuxSession()); if (r.error) die(r.error, 1); id = r.peer.agentId; }
    validateAgentId(id); requireBinary("tmux");
    if (!tmuxSessionExists(id)) die(`no tmux session '${id}'`, 1);
    if (wantNativeScroll) {
        if (!isIterm2()) info("native scroll attach works best from iTerm2 via tmux control mode");
        attachTmuxSession(id, { nativeScroll: true });
        return;
    }
    if (process.env.TMUX) { info(`switch with: tmux switch-client -t '${id}'`); return; }
    attachTmuxSession(id, { nativeScroll: false });
}

async function cmdPeek(args) {
    const parsed = parseArgs(args, { lines: true });
    let [id] = parsed.positional;
    if (!id) { const r = inferPeer(await listAgents(), currentTmuxSession()); if (r.error) die(r.error, 1); id = r.peer.agentId; }
    validateAgentId(id); requireBinary("tmux");
    if (!tmuxSessionExists(id)) die(`no tmux session '${id}'`, 1);
    const lines = Math.max(1, parseInt(parsed.flags.lines || "30", 10) || 30);
    const r = tmux(["capture-pane", "-t", id, "-p"]);
    if (r.status !== 0) die(`capture-pane failed`, 1);
    const text = (r.stdout || "").split("\n").slice(-lines).join("\n");
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
}

function resolveReconnectTargets(name, hasAll) {
    if (name && isGroup(name)) return { targets: listGroupMembers(name).map((m) => m.name), viewSession: `${name}-view` };
    if (name) {
        const teamSpec = loadResolvedTeamSpec(name);
        if (teamSpec) return { targets: teamSpec.agents.map((a) => a.id), viewSession: `${teamSpec.name}-view`, description: `team:${teamSpec.name}` };
    }
    if (name) return { targets: [name], viewSession: null };
    const live = tmuxListSessions().filter((id) => !id.endsWith("-view"));
    if (hasAll) return { targets: live, viewSession: "a2a-view" };

    const cached = loadRegistry().agents || [];
    const cachedLive = cached.filter((id) => live.includes(id));
    if (cachedLive.length > 0) return { targets: cachedLive, viewSession: null };
    return { targets: live, viewSession: null };
}

function buildReconnectView(viewSession, members) {
    if (!viewSession || members.length === 0) return;
    if (tmuxSessionExists(viewSession)) tmux(["kill-session", "-t", viewSession]);
    tmux(["new-session", "-d", "-s", viewSession, "-c", process.cwd()]);
    for (const member of members) tmux(["link-window", "-s", `${member}:0`, "-t", `${viewSession}:`]);
    tmux(["kill-window", "-t", `${viewSession}:0`]);
    if (currentTmuxSession()) info(`switch with: tmux switch-client -t '${viewSession}'`);
    else if (hasInteractiveTerminal()) attachTmuxSession(`${viewSession}:`);
    else {
        info(`view session '${viewSession}' rebuilt`);
        info(`  attach later: a2a attach ${viewSession}`);
    }
}

async function cmdReconnect(args) {
    requireBinary("tmux");
    const hasAll = args.includes("--all");
    const wantDashboard = args.includes("--dashboard") || args.includes("--layout");
    const filtered = args.filter((a) => a !== "--all" && a !== "--layout" && a !== "--dashboard");
    let [name] = parseArgs(filtered, {}).positional;
    const explicitTarget = !!name || hasAll;

    const liveAgents = (() => {
        try { return new Set(tmuxListSessions()); } catch { return new Set(); }
    })();
    const existing = (() => {
        try { return new Map(); } catch { return new Map(); }
    })();
    try {
        for (const agent of await listAgents()) existing.set(agent.agentId, agent);
    } catch { /* best effort */ }

    const { targets, viewSession, description: explicitDescription } = resolveReconnectTargets(name, hasAll);
    if (targets.length === 0) { info("no reconnect targets found"); return; }

    const uniqueTargets = [...new Set(targets)].filter((id) => !id.endsWith("-view"));
    const connected = [];
    let allOk = true;
    for (const id of uniqueTargets) {
        validateAgentId(id);
        if (!liveAgents.has(id)) {
            if (!explicitTarget) continue;
            process.stdout.write(`${id}: no live tmux session\n`);
            allOk = false;
            continue;
        }
        const current = existing.get(id);
        const cwd = current?.cwd || tmuxPanePath(id);
        const description = current?.description || explicitDescription || inferCohortDescription(id) || `a2a reconnect: ${cwd}`;
        const payload = {
            agentId: id,
            tmuxTarget: `${id}:0.0`,
            cwd,
            description,
            ...(current?.bridgeUrl ? { bridgeUrl: current.bridgeUrl } : {}),
            ...(current?.backend ? { backend: current.backend } : {}),
            ...(Array.isArray(current?.backendArgs) ? { backendArgs: current.backendArgs } : {}),
            ...(current?.backendEnv && typeof current.backendEnv === "object" ? { backendEnv: current.backendEnv } : {}),
        };
        try {
            const { status, body } = await request("POST", "/api/a2a/register", payload);
            if (status !== 200 || !body?.success) throw new Error(body?.error || `HTTP ${status}`);
            process.stdout.write(`${id}: reconnected\n`);
            connected.push(id);
        } catch (err) {
            process.stdout.write(`${id}: reconnect failed: ${err.message}\n`);
            allOk = false;
        }
    }

    if (wantDashboard && connected.length > 0) buildReconnectView(viewSession || "a2a-view", connected);
    if (!allOk) process.exit(1);
}

async function cmdLog(args) {
    // parseArgs requires every recognised flag to have a value. Strip the boolean flags
    // (--path, -f/--follow) up front so the value-only parser can handle the rest.
    const wantPath = args.includes("--path");
    const wantFollow = args.includes("-f") || args.includes("--follow");
    const filtered = args.filter((a) => a !== "--path" && a !== "-f" && a !== "--follow");
    const parsed = parseArgs(filtered, { lines: true });
    const path = messageLogPath();

    if (wantPath) { process.stdout.write(path + "\n"); return; }

    if (wantFollow) {
        // Defer to `tail -F` (capital F: re-open on rotation/recreation). stdio inherit so the
        // tail child writes straight to the user's terminal and Ctrl-C terminates it cleanly.
        requireBinary("tail");
        const lines = String(Math.max(1, parseInt(parsed.flags.lines || "50", 10) || 50));
        const r = spawnSync("tail", ["-n", lines, "-F", path], { stdio: "inherit" });
        if (r.status === null && r.signal) process.exit(0);
        process.exit(r.status ?? 0);
    }

    const lines = Math.max(1, parseInt(parsed.flags.lines || "50", 10) || 50);
    let content = "";
    try { content = readFileSync(path, "utf8"); }
    catch (e) {
        if (e.code === "ENOENT") { info(`no log yet at ${path} (start the bridge and send a message)`); return; }
        die(`failed to read log: ${e.message}`, 1);
    }
    // The log is multi-line per entry: a header line followed by 4-space-indented body lines.
    // Splitting by header line keeps each entry intact when slicing the tail.
    const all = content.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/);
    const tail = all.slice(-lines).join("\n");
    process.stdout.write(tail + (tail.endsWith("\n") ? "" : "\n"));
}

async function cmdList() {
    const agents = await listAgents();
    if (agents.length === 0) { process.stdout.write("(no agents registered)\n"); return; }
    const self = currentTmuxSession();
    const rows = agents.map((a) => ({
        id: a.agentId + (a.agentId === self ? " (self)" : ""),
        target: a.tmuxTarget,
        alive: tmuxSessionExists(a.agentId) ? "yes" : "no",
        cohort: (a.description||"").match(/^(group|team):(.+)$/)?.[2] || "",
        cwd: a.cwd || "",
    }));
    const w = {
        id:     Math.max(4, ...rows.map((r) => r.id.length)),
        target: Math.max(6, ...rows.map((r) => r.target.length)),
        cohort: Math.max(6, ...rows.map((r) => r.cohort.length)),
    };
    const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
    process.stdout.write(`${pad("NAME",w.id)}  ${pad("TARGET",w.target)}  ALIVE  ${pad("COHORT",w.cohort)}  CWD\n`);
    for (const r of rows) process.stdout.write(`${pad(r.id,w.id)}  ${pad(r.target,w.target)}  ${r.alive.padEnd(5)}  ${pad(r.cohort,w.cohort)}  ${r.cwd}\n`);
}

async function cmdRegister(args) {
    const { flags } = parseArgs(args, { id: true, target: true, desc: true });
    if (!flags.id || !flags.target) die("register requires --id and --target");
    validateAgentId(flags.id);
    const { status, body } = await request("POST", "/api/a2a/register", { agentId: flags.id, tmuxTarget: flags.target, description: flags.desc||"", cwd: process.cwd() });
    if (status !== 200 || !body?.success) die(`register failed: ${body?.error||`HTTP ${status}`}`, 1);
    process.stdout.write(JSON.stringify(body.data, null, 2) + "\n");
}

async function cmdUnregister(args) {
    let [id] = parseArgs(args, {}).positional;
    if (!id) { id = currentTmuxSession(); if (!id) die("unregister needs a name"); }
    const { status, body } = await request("DELETE", `/api/a2a/register/${encodeURIComponent(id)}`);
    if (status !== 200 || !body?.success) die(`unregister failed: ${body?.error||`HTTP ${status}`}`, 1);
    process.stdout.write(JSON.stringify(body.data, null, 2) + "\n");
}

async function cmdConfig(args) {
    const [sub, key, val] = args;
    switch (sub) {
        case "ls":
        case undefined: {
            const s = configGet();
            for (const [k, v] of Object.entries(s)) process.stdout.write(`${k} = ${v ?? "(not set)"}\n`);
            break;
        }
        case "get": {
            if (!key) die("config get requires a key");
            try { process.stdout.write(`${configGet(key) ?? "(not set)"}\n`); } catch (e) { die(e.message); }
            break;
        }
        case "set": {
            if (!key) die("config set requires a key and value");
            if (val === undefined) die(`config set ${key} requires a value`);
            try { configSet(key, val); process.stdout.write(`${key} = ${val}\n`); } catch (e) { die(e.message); }
            break;
        }
        default: die(`unknown config subcommand '${sub}' (expected: ls, get, set)`);
    }
}

async function cmdAuth(args) {
    const [sub, ...rest] = args;
    switch (sub) {
        case "add":    await authAdd(rest);    break;
        case "list":   await authList();       break;
        case "revoke": await authRevoke(rest); break;
        case undefined: await authList();      break;
        default: die(`unknown auth subcommand '${sub}' (expected: add, list, revoke)`);
    }
}

async function authAdd(args) {
    const { peer, flags } = parseAuthArgs(args, new Set(["url", "key"]));
    if (!peer) die("specify a peer: a2a auth add --<peer> --url <url> --key <key>");
    if (!flags.url) die("--url is required");
    if (!flags.key) die("--key is required");
    const url = flags.url.replace(/\/$/, "");
    const cfg = loadConfig();
    patchConfig({ peers: { ...(cfg.peers||{}), [peer]: { url, key: flags.key } } });
    process.stdout.write(`\n  added peer '${peer}'\n\n  url   ${url}\n  key   ${flags.key}\n\n`);
}

async function authList() {
    const peers = loadConfig().peers || {};
    if (!Object.keys(peers).length) { process.stdout.write("(no peers configured)\n"); return; }
    process.stdout.write("\npeers\n\n");
    for (const [name, p] of Object.entries(peers)) process.stdout.write(`  ${name.padEnd(16)}  ${p.url}\n`);
    process.stdout.write("\n");
}

async function authRevoke(args) {
    const { peer } = parseAuthArgs(args);
    if (!peer) die("specify a peer: a2a auth revoke --<peer>");
    const cfg = loadConfig();
    const peers = { ...(cfg.peers||{}) };
    if (!peers[peer]) die(`no peer '${peer}'`);
    delete peers[peer];
    patchConfig({ peers });
    process.stdout.write(`  removed peer '${peer}'\n`);
}

const LEGACY_ACTION_CMD = { say: "message", ask: "ask", reply: "reply" };

async function main() {
    const [,,...argv] = process.argv;
    if (argv.length === 0 || ["help", "-h", "--help"].includes(argv[0])) usage(0);

    const lead = argv[0];

    if (lead in LEGACY_ACTION_CMD && argv.length >= 2 && argv.slice(1).some((a) => /^(from|to|origin):/.test(a))) {
        try { await doSend(parseArgs(argv.slice(1), { to: true, from: true, origin: true }), LEGACY_ACTION_CMD[lead]); return; }
        catch (err) { die(err.message, 1); }
    }

    if (isColonFlagArgv(argv)) {
        try { await sendNormalizedEnvelope(parseColonFlagArgv(argv, await getRegistry())); return; }
        catch (err) { die(err.message, 1); }
    }

    if (isFlagSendArgv(argv)) {
        try {
            const parsed = parseFlagSendArgv(argv);
            if (!parsed) die("could not parse send arguments", 1);
            await doParsedFlagSend(parsed); return;
        } catch (err) { die(err.message, 1); }
    }

    if (argv.some((a) => /^(from|to|origin):/.test(a))) {
        try { await doSend(parseArgs(argv, { to: true, from: true, origin: true })); return; }
        catch (err) { die(err.message, 1); }
    }

    const [cmd, ...rest] = argv;
    try {
        switch (cmd) {
            case "bridge":       await cmdBridge(rest);   break;
            case "say":          await doSend(parseArgs(rest, { to: true, from: true, origin: true }), "message"); break;
            case "ask":          await doSend(parseArgs(rest, { to: true, from: true, origin: true }), "ask");     break;
            case "reply":        await doSend(parseArgs(rest, { to: true, from: true, origin: true }), "reply");   break;
            case "start":        await cmdStart(rest);    break;
            case "start-global": await cmdStartGlobal(rest); break;
            case "kill":         await cmdKill(rest);     break;
            case "reconnect":    await cmdReconnect(rest); break;
            case "attach":       await cmdAttach(rest);   break;
            case "peek":         await cmdPeek(rest);     break;
            case "log":          await cmdLog(rest);      break;
            case "list":         await cmdList();         break;
            case "auth":         await cmdAuth(rest);     break;
            case "config":       await cmdConfig(rest);   break;
            case "gen-key":      process.stdout.write(generateKey() + "\n"); break;
            case "register":     await cmdRegister(rest); break;
            case "unregister":   await cmdUnregister(rest); break;
            default:             die(`unknown command '${cmd}' -- run 'a2a help' for usage`);
        }
    } catch (err) { die(err.message, 1); }
}

main();
