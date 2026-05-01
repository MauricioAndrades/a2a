#!/usr/bin/env node
// The full implementation, ready to paste into source.
/**
 * Install the a2a bridge into the user's Claude environment with explicit
 * per-step confirmation and no forced deletion or replacement of user files.
 *
 * @param {string[]} argv
 * @example
 *   node ./scripts/install.mjs --yes
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ARGV = process.argv.slice(2);

/**
 * @returns {{ autoYes: boolean, showHelp: boolean }}
 */
function parseInstallArgv(argv) {
  let autoYes = false;
  let showHelp = false;
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") autoYes = true;
    if (arg === "--help" || arg === "-h") showHelp = true;
  }
  if (process.env.A2A_SETUP_YES === "1" || process.env.CI === "1") autoYes = true;
  return { autoYes, showHelp };
}

const { autoYes: AUTO_YES, showHelp: SHOW_HELP } = parseInstallArgv(INSTALL_ARGV);

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const SKILL_DIR = path.join(CLAUDE_DIR, "skills", "a2a");
const HOOKS_DIR = path.join(CLAUDE_DIR, "hooks");
const GROUPS_DIR = path.join(CLAUDE_DIR, "skills", "a2a", "groups");
const TEAMS_DIR = path.join(CLAUDE_DIR, "skills", "a2a", "teams");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const CLAUDE_MD_PATH = path.join(CLAUDE_DIR, "CLAUDE.md");
const WELCOME_DOC_PATH = path.join(CLAUDE_DIR, "a2a-welcome.md");

const A2A_MARKER = "a2a-capable agent";
const A2A_INSTRUCTION =
  'You are an a2a-capable agent. The `a2a` CLI is available on PATH. When you receive a message wrapped in `<a2a_message>` tags, load the `a2a` skill immediately and follow its protocol. Reply to peer messages via `a2a --reply --<n> "..."`, never into your own pane. Run `a2a list` to discover peers. Run `a2a peek <n>` to check on a peer without interrupting them.';

const TOTAL_STEPS = 9;
let STEP = 0;
let WARNINGS = 0;
const START_EPOCH = Date.now();

let INSTALL_BIN_DIR = "";
let INSTALLED_A2A_PATH = "";
let INSTALLED_A2A_SERVER_PATH = "";
let PATH_WARNING = false;
let CURRENT_STEP_LABEL = "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * @param {string} message
 */
function println(message = "") {
  process.stdout.write(`${message}\n`);
}

function printHeader() {
  println(`\n${BOLD}a2a bridge${RESET}  installer\n`);
}

function stepStart(label) {
  STEP += 1;
  CURRENT_STEP_LABEL = label;
  process.stdout.write(`  [${STEP}/${TOTAL_STEPS}]  ${padRight(label, 24)}`);
}

function stepOk() {
  println(`${GREEN}ok${RESET}`);
}

function stepSkip(message = "skipped") {
  println(`${DIM}${message}${RESET}`);
}

function stepWarn(message) {
  println(`${YELLOW}${message}${RESET}`);
  WARNINGS += 1;
}

function stepFail(message) {
  println(`${RED}failed${RESET}`);
  println(`\n         ${DIM}${message}${RESET}\n`);
  process.exit(1);
}

/**
 * @param {unknown} error
 */
function onError(error) {
  println(`\n${RED}installer failed${RESET}`);
  println(`  ${DIM}step:${RESET} ${CURRENT_STEP_LABEL || "unknown"}`);
  if (error instanceof Error) {
    println(`  ${DIM}error:${RESET} ${error.message}\n`);
  } else {
    println(`  ${DIM}error:${RESET} ${String(error)}\n`);
  }
  process.exit(1);
}

process.on("uncaughtException", onError);
process.on("unhandledRejection", onError);

/**
 * @param {string} value
 * @param {number} width
 * @returns {string}
 */
function padRight(value, width) {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

/**
 * @param {string} bin
 * @returns {boolean}
 */
function commandExists(bin) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(bin)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * @param {string} input
 * @returns {string}
 */
function shellQuote(input) {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isWritableDir(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} filePath
 */
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  if (!fs.statSync(filePath).isFile()) return;
  fs.copyFileSync(filePath, `${filePath}.bak`);
}

/**
 * @param {string} dest
 * @param {string|Buffer} contents
 */
function writeFileAtomic(dest, contents) {
  ensureDir(path.dirname(dest));
  const temp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, dest);
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
function filesDiffer(src, dest) {
  if (!fs.existsSync(dest)) return true;
  const srcBuf = fs.readFileSync(src);
  const destBuf = fs.readFileSync(dest);
  return Buffer.compare(srcBuf, destBuf) !== 0;
}

/**
 * @returns {string}
 */
function elapsedHuman() {
  const elapsedSeconds = Math.floor((Date.now() - START_EPOCH) / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
}

/**
 * @param {string} bin
 * @param {number|null} minMajor
 */
function checkVersion(bin, minMajor = null) {
  if (!commandExists(bin)) {
    println(`  ${padRight(bin, 10)} ${RED}not found${RESET}`);
    return;
  }

  let ver = "ok";
  if (bin === "node") {
    ver = process.version.replace(/^v/, "");
  } else if (bin === "tmux") {
    try {
      const output = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
      ver = output.split(/\s+/)[1] || "unknown";
    } catch {
      ver = "unknown";
    }
  }

  const major = Number(String(ver).split(".")[0]);
  if (minMajor != null && Number.isFinite(major) && major < minMajor) {
    println(`  ${padRight(bin, 10)} ${padRight(ver, 12)} ${YELLOW}needs ${minMajor}+${RESET}`);
    WARNINGS += 1;
  } else {
    println(`  ${padRight(bin, 10)} ${DIM}${ver}${RESET}`);
  }
}

/**
 * @returns {boolean}
 */
function canUsePasswordlessSudo() {
  if (!commandExists("sudo")) return false;
  const result = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * @returns {string}
 */
function detectInstallBinDir() {
  const candidates = [path.join(HOME, ".local", "bin"), path.join(HOME, "bin"), "/usr/local/bin"];

  for (const dir of candidates) {
    try {
      ensureDir(dir);
    } catch {
      continue;
    }
    if (isWritableDir(dir)) return dir;
  }

  if (fs.existsSync("/usr/local/bin") && canUsePasswordlessSudo()) {
    return "/usr/local/bin";
  }

  throw new Error(
    "could not find a writable install directory for binaries; create ~/.local/bin and ensure it is writable",
  );
}

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  if (AUTO_YES) return true;
  const answer = await rl.question(`${question} ${DIM}[y/N]${RESET} `);
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * @param {string} title
 * @param {string[]} lines
 */
function explain(title, lines) {
  if (AUTO_YES) return;
  println(`\n${BOLD}${title}${RESET}`);
  for (const line of lines) {
    println(`  ${line}`);
  }
  println("");
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {{status:"ok"|"skip"|"conflict", message:string}}
 */
function ensureSymlinkWithoutReplacing(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.symlinkSync(src, dest);
    return { status: "ok", message: `created symlink ${dest} -> ${src}` };
  }

  const stat = fs.lstatSync(dest);
  if (stat.isSymbolicLink()) {
    const current = fs.readlinkSync(dest);
    if (current === src) {
      return { status: "skip", message: `${dest} already points to the correct source` };
    }
    return {
      status: "conflict",
      message: `${dest} already exists as a symlink to ${current}; not replacing it`,
    };
  }

  return {
    status: "conflict",
    message: `${dest} already exists and is not a matching symlink; not replacing it`,
  };
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {{status:"ok"|"skip", message:string}}
 */
function copyFileWithBackup(src, dest) {
  if (!fs.existsSync(dest)) {
    writeFileAtomic(dest, fs.readFileSync(src));
    return { status: "ok", message: `created ${dest}` };
  }

  if (!filesDiffer(src, dest)) {
    return { status: "skip", message: `${dest} is already up to date` };
  }

  backupFile(dest);
  writeFileAtomic(dest, fs.readFileSync(src));
  return { status: "ok", message: `updated ${dest} and saved ${dest}.bak` };
}

async function installBinaries() {
  INSTALL_BIN_DIR = detectInstallBinDir();

  const useSudo = INSTALL_BIN_DIR === "/usr/local/bin" && !isWritableDir(INSTALL_BIN_DIR);
  if (useSudo && !canUsePasswordlessSudo()) {
    stepFail("install dir is /usr/local/bin but sudo is required. Re-run with sudo, or create ~/.local/bin and retry.");
  }

  const a2aSrc = path.join(SCRIPT_DIR, "bin", "a2a.mjs");
  const a2aServerSrc = path.join(SCRIPT_DIR, "src", "a2a-server.mjs");

  INSTALLED_A2A_PATH = path.join(INSTALL_BIN_DIR, "a2a");
  INSTALLED_A2A_SERVER_PATH = path.join(INSTALL_BIN_DIR, "a2a-server");

  explain("binaries", [
    `This step makes the CLI available on your PATH by creating symlinks in ${INSTALL_BIN_DIR}.`,
    `It will attempt to create:`,
    `  ${INSTALLED_A2A_PATH} -> ${a2aSrc}`,
    `  ${INSTALLED_A2A_SERVER_PATH} -> ${a2aServerSrc}`,
    `It will not delete or replace any existing file.`,
  ]);

  if (!(await confirm("Proceed with binary setup?"))) {
    return { kind: "skip", reason: "user skipped binary setup" };
  }

  fs.chmodSync(a2aSrc, 0o755);
  fs.chmodSync(a2aServerSrc, 0o755);

  if (useSudo) {
    stepWarn("sudo-managed install dir detected; safe interactive mode does not modify existing files in /usr/local/bin");
    return { kind: "warn", reason: "manual setup recommended for /usr/local/bin" };
  }

  ensureDir(INSTALL_BIN_DIR);

  const a2aResult = ensureSymlinkWithoutReplacing(a2aSrc, INSTALLED_A2A_PATH);
  const serverResult = ensureSymlinkWithoutReplacing(a2aServerSrc, INSTALLED_A2A_SERVER_PATH);

  if (a2aResult.status === "conflict") {
    stepWarn(a2aResult.message);
  }
  if (serverResult.status === "conflict") {
    stepWarn(serverResult.message);
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  if (!pathEntries.includes(INSTALL_BIN_DIR)) {
    PATH_WARNING = true;
    WARNINGS += 1;
  }

  if (a2aResult.status === "conflict" || serverResult.status === "conflict") {
    return { kind: "warn", reason: "one or more binary destinations already existed" };
  }

  if (a2aResult.status === "skip" && serverResult.status === "skip") {
    return { kind: "skip", reason: "binary symlinks already correct" };
  }

  return { kind: "ok" };
}

async function installSkill() {
  const src = path.join(SCRIPT_DIR, "skill", "SKILL.md");
  const dest = path.join(SKILL_DIR, "SKILL.md");

  explain("skill", [
    "This step installs the a2a skill markdown into Claude's skill directory.",
    `Source: ${src}`,
    `Destination: ${dest}`,
    "If the destination exists and differs, it will be backed up to .bak before update.",
  ]);

  if (!(await confirm("Proceed with skill install?"))) {
    return { kind: "skip", reason: "user skipped skill install" };
  }

  ensureDir(SKILL_DIR);
  const result = copyFileWithBackup(src, dest);
  return result.status === "skip" ? { kind: "skip", reason: result.message } : { kind: "ok" };
}

async function installWelcomeDoc() {
  const src = path.join(SCRIPT_DIR, "src", "a2a-welcome.md");

  explain("welcome doc", [
    "This step installs the session welcome document used by the session start hook.",
    `Source: ${src}`,
    `Destination: ${WELCOME_DOC_PATH}`,
    "If the destination exists and differs, it will be backed up to .bak before update.",
  ]);

  if (!(await confirm("Proceed with welcome doc install?"))) {
    return { kind: "skip", reason: "user skipped welcome doc install" };
  }

  ensureDir(CLAUDE_DIR);
  const result = copyFileWithBackup(src, WELCOME_DOC_PATH);
  return result.status === "skip" ? { kind: "skip", reason: result.message } : { kind: "ok" };
}

async function installGroups() {
  const src = path.join(SCRIPT_DIR, "groups", "star-wars");
  const dest = path.join(GROUPS_DIR, "star-wars");

  explain("groups dir", [
    "This step copies the default star-wars example group into the a2a groups folder.",
    `Source: ${src}`,
    `Destination: ${dest}`,
    "It only creates the group if it does not already exist.",
  ]);

  if (!(await confirm("Proceed with group install?"))) {
    return { kind: "skip", reason: "user skipped group install" };
  }

  ensureDir(GROUPS_DIR);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { kind: "skip", reason: "source group template not found" };
  }

  if (fs.existsSync(dest)) {
    return { kind: "skip", reason: "group already exists" };
  }

  fs.cpSync(src, dest, { recursive: true });
  return { kind: "ok" };
}

async function installTeams() {
  const src = path.join(SCRIPT_DIR, "teams", "bug-killers.yaml");
  const dest = path.join(TEAMS_DIR, "bug-killers.yaml");

  explain("teams dir", [
    "This step copies the default bug-killers team spec into the a2a teams folder.",
    `Source: ${src}`,
    `Destination: ${dest}`,
    "It only creates the team spec if it does not already exist.",
  ]);

  if (!(await confirm("Proceed with team spec install?"))) {
    return { kind: "skip", reason: "user skipped team spec install" };
  }

  ensureDir(TEAMS_DIR);

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return { kind: "skip", reason: "source team spec not found" };
  }

  if (fs.existsSync(dest)) {
    return { kind: "skip", reason: "team spec already exists" };
  }

  fs.copyFileSync(src, dest);
  return { kind: "ok" };
}

async function installHook() {
  const hookPath = path.join(HOOKS_DIR, "a2a-session-start.sh");
  const hookContents = `#!/usr/bin/env bash
set -euo pipefail

[ "\${A2A_SESSION:-0}" = "1" ] || exit 0

WELCOME_FILE="\${HOME}/.claude/a2a-welcome.md"

command -v node >/dev/null 2>&1 || exit 0

A2A_WELCOME_FILE="$WELCOME_FILE" node <<'NODE'
const fs = require('fs');
const path = require('path');

const home = process.env.HOME || '';
const welcomeCandidates = [
  process.env.A2A_WELCOME_FILE,
  path.join(home, '.claude', 'a2a-welcome.md'),
  path.join(home, '.claude', 'skills', 'a2a', 'a2a-welcome.md')
].filter(Boolean);

let ctx = '';
for (const welcomePath of welcomeCandidates) {
  try {
    if (!fs.existsSync(welcomePath)) continue;
    ctx = fs.readFileSync(welcomePath, 'utf8');
    break;
  } catch {
    // Keep going: hook output should not fail session startup.
  }
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: ctx
  }
}));
NODE
`;

  explain("session hook", [
    "This step creates the SessionStart hook script Claude will call for a2a sessions.",
    `Destination: ${hookPath}`,
    "If the file exists and differs, it will be backed up to .bak before update.",
  ]);

  if (!(await confirm("Proceed with hook install?"))) {
    return { kind: "skip", reason: "user skipped hook install" };
  }

  ensureDir(HOOKS_DIR);

  if (!fs.existsSync(hookPath)) {
    writeFileAtomic(hookPath, hookContents);
    fs.chmodSync(hookPath, 0o755);
    return { kind: "ok" };
  }

  const existing = fs.readFileSync(hookPath, "utf8");
  if (existing === hookContents) {
    return { kind: "skip", reason: "hook already up to date" };
  }

  backupFile(hookPath);
  writeFileAtomic(hookPath, hookContents);
  fs.chmodSync(hookPath, 0o755);
  return { kind: "ok" };
}

async function updateSettingsJson() {
  const hookCommand = "bash ~/.claude/hooks/a2a-session-start.sh";

  explain("settings.json", [
    "This step updates Claude settings to register the a2a SessionStart hook.",
    `File: ${SETTINGS_PATH}`,
    "It only adds the hook entry if missing.",
    "If the file exists, it will be backed up to settings.json.bak before writing changes.",
  ]);

  if (!(await confirm("Proceed with settings update?"))) {
    return { kind: "skip", reason: "user skipped settings update" };
  }

  ensureDir(CLAUDE_DIR);

  /** @type {Record<string, any>} */
  let data = {};

  if (fs.existsSync(SETTINGS_PATH)) {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8").trim();
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw new Error(`settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (typeof data !== "object" || data == null || Array.isArray(data)) {
    throw new Error("settings.json must contain a JSON object at the top level");
  }

  if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) {
    data.hooks = {};
  }

  if (!Array.isArray(data.hooks.SessionStart)) {
    data.hooks.SessionStart = [];
  }

  const exists = data.hooks.SessionStart.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.type === "command" &&
      entry.command === hookCommand,
  );

  if (exists) {
    return { kind: "skip", reason: "hook entry already present in settings.json" };
  }

  data.hooks.SessionStart.push({
    type: "command",
    command: hookCommand,
  });

  if (fs.existsSync(SETTINGS_PATH)) {
    backupFile(SETTINGS_PATH);
  }

  writeFileAtomic(SETTINGS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return { kind: "ok" };
}

async function updateClaudeMd() {
  explain("CLAUDE.md", [
    "This step appends the a2a instruction block to ~/.claude/CLAUDE.md if it is not already present.",
    `File: ${CLAUDE_MD_PATH}`,
    "It does not remove or rewrite existing content.",
  ]);

  if (!(await confirm("Proceed with CLAUDE.md update?"))) {
    return { kind: "skip", reason: "user skipped CLAUDE.md update" };
  }

  ensureDir(CLAUDE_DIR);

  if (fs.existsSync(CLAUDE_MD_PATH)) {
    const current = fs.readFileSync(CLAUDE_MD_PATH, "utf8");
    if (current.includes(A2A_MARKER)) {
      return { kind: "skip", reason: "instruction already present" };
    }
  }

  if (fs.existsSync(CLAUDE_MD_PATH) && fs.statSync(CLAUDE_MD_PATH).size > 0) {
    fs.appendFileSync(CLAUDE_MD_PATH, `\n${A2A_INSTRUCTION}\n`);
  } else {
    writeFileAtomic(CLAUDE_MD_PATH, `${A2A_INSTRUCTION}\n`);
  }

  return { kind: "ok" };
}

function printPrereqs() {
  println("prerequisites\n");
  checkVersion("node", 18);
  checkVersion("tmux", null);
  if (commandExists("ngrok")) {
    println(`  ${padRight("ngrok", 10)} ${DIM}installed${RESET}`);
  } else {
    println(`  ${padRight("ngrok", 10)} ${DIM}optional -- needed for cross-machine sessions${RESET}`);
  }
  println("");
}

function printSummary() {
  const elapsed = elapsedHuman();

  println("");
  if (WARNINGS > 0) {
    println(`installed in ${elapsed}  ${YELLOW}(${WARNINGS} warning(s) above)${RESET}`);
  } else {
    println(`installed in ${elapsed}`);
  }

  println("\nlocations\n");
  println(`  ${DIM}bin dir${RESET}        ${INSTALL_BIN_DIR || "(not set)"}`);
  println(`  ${DIM}skill${RESET}          ${path.join(SKILL_DIR, "SKILL.md")}`);
  println(`  ${DIM}hook${RESET}           ${path.join(HOOKS_DIR, "a2a-session-start.sh")}`);
  println(`  ${DIM}settings${RESET}       ${SETTINGS_PATH}`);
  println(`  ${DIM}welcome${RESET}        ${WELCOME_DOC_PATH}`);
  println("");

  if (PATH_WARNING && INSTALL_BIN_DIR) {
    println(`${YELLOW}your PATH does not include ${INSTALL_BIN_DIR}${RESET}`);
    println("add this to your shell profile:\n");
    println(`  export PATH="${INSTALL_BIN_DIR}:$PATH"\n`);
  }

  println("quick start\n");
  println(`  ${DIM}a2a bridge${RESET}                 start the bridge`);
  println(`  ${DIM}a2a start --user bob${RESET}      spawn an agent named bob`);
  println(`  ${DIM}a2a --bob 'hello'${RESET}         send bob a message`);
  println(`  ${DIM}a2a gen-key${RESET}               generate a key for your bridge`);
  println("");
  println(`  ${DIM}a2a help${RESET} for full reference\n`);
}

function printInstallHelp() {
  println(`
${BOLD}a2a bridge installer${RESET}

usage:
  node scripts/install.mjs [options]

options:
  -y, --yes     run all steps without prompts (same as A2A_SETUP_YES=1 or CI=1)
  -h, --help    show this message

npm:
  npm run bootstrap    non-interactive setup (skill, hooks, PATH symlinks)
`);
}

function verifyInstall() {
  if (!INSTALLED_A2A_PATH) {
    stepWarn("binary install was skipped");
    return;
  }

  if (!fs.existsSync(INSTALLED_A2A_PATH)) {
    stepWarn("a2a binary path does not exist");
    return;
  }

  const stat = fs.lstatSync(INSTALLED_A2A_PATH);
  if (!stat.isSymbolicLink() && (stat.mode & 0o111) === 0) {
    stepWarn("a2a path exists but is not executable");
    return;
  }
}

async function runStep(label, fn) {
  stepStart(label);
  const result = await fn();

  if (!result || result.kind === "ok") {
    stepOk();
    return;
  }

  if (result.kind === "skip") {
    stepSkip(result.reason);
    return;
  }

  if (result.kind === "warn") {
    stepWarn(result.reason);
    return;
  }

  stepOk();
}

async function main() {
  if (SHOW_HELP) {
    printInstallHelp();
    await rl.close();
    return;
  }

  if (!AUTO_YES) {
    printHeader();
    printPrereqs();
    println("installing\n");
  } else {
    println(`${BOLD}a2a bridge${RESET}  setup ${DIM}(--yes)${RESET}\n`);
    printPrereqs();
    println("");
  }

  await runStep("binaries", installBinaries);
  await runStep("skill", installSkill);
  await runStep("welcome doc", installWelcomeDoc);
  await runStep("groups dir", installGroups);
  await runStep("teams dir", installTeams);
  await runStep("session hook", installHook);
  await runStep("settings.json", updateSettingsJson);
  await runStep("CLAUDE.md", updateClaudeMd);

  stepStart("install verification");
  verifyInstall();
  stepOk();

  printSummary();
  await rl.close();
}

main();
