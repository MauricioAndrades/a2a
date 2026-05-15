#!/usr/bin/env node
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
const A2A_ROOT = SCRIPT_DIR;
const A2A_SKILL_FILE = path.join(A2A_ROOT, "skill", "SKILL.md");
const CLAUDE_DIR = path.join(HOME, ".claude");
const WELCOME_DOC_PATH = path.join(A2A_ROOT, "src", "a2a-welcome.md");
const INSTALLED_SKILL_DIR = path.join(CLAUDE_DIR, "skills", "a2a");
const INSTALLED_SKILL_PATH = path.join(INSTALLED_SKILL_DIR, "SKILL.md");
const INSTALLED_WELCOME_DOC_PATH = path.join(CLAUDE_DIR, "a2a-welcome.md");
const INSTALLED_GROUPS_DIR = path.join(INSTALLED_SKILL_DIR, "groups");
const INSTALLED_TEAMS_DIR = path.join(INSTALLED_SKILL_DIR, "teams");

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
  println(`\n${BOLD}a2a setup${RESET}`);
  println(`${DIM}CLI links, Claude skill files, welcome doc, and examples${RESET}\n`);
}

function stepStart(label) {
  STEP += 1;
  CURRENT_STEP_LABEL = label;
  println(`${DIM}[${STEP}/${INSTALL_STEPS.length}]${RESET} ${BOLD}${label}${RESET}`);
}

function printResult(kind, message = "") {
  const label =
    kind === "ok" ? `${GREEN}ok${RESET}` :
    kind === "changed" ? `${GREEN}changed${RESET}` :
    kind === "skip" ? `${DIM}skipped${RESET}` :
    kind === "warn" ? `${YELLOW}warning${RESET}` :
    `${RED}failed${RESET}`;
  println(`  ${label} ${message}`);
}

function ok(message = "complete") {
  return { kind: "ok", message };
}

function changed(message = "updated") {
  return { kind: "changed", message };
}

function skipped(message = "already up to date") {
  return { kind: "skip", message };
}

function warning(message) {
  WARNINGS += 1;
  return { kind: "warn", message };
}

function printWarning(message) {
  printResult("warn", message);
  WARNINGS += 1;
}

function stepFail(message) {
  printResult("fail", message);
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
  fs.copyFileSync(filePath, `${filePath}.bak.${Date.now()}`);
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
 * @param {string[]} lines
 */
function explain(lines) {
  if (AUTO_YES) return;
  println(`  ${DIM}will${RESET}`);
  for (const line of lines) {
    println(`    ${line}`);
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

  explain([
    `This step makes the CLI available on your PATH by creating symlinks in ${INSTALL_BIN_DIR}.`,
    `It will attempt to create:`,
    `  ${INSTALLED_A2A_PATH} -> ${a2aSrc}`,
    `  ${INSTALLED_A2A_SERVER_PATH} -> ${a2aServerSrc}`,
    `It will not delete or replace any existing file.`,
  ]);

  if (!(await confirm("Proceed with binary setup?"))) {
    return skipped("user skipped binary setup");
  }

  fs.chmodSync(a2aSrc, 0o755);
  fs.chmodSync(a2aServerSrc, 0o755);

  if (useSudo) {
    return warning("sudo-managed install dir detected; manual setup recommended for /usr/local/bin");
  }

  ensureDir(INSTALL_BIN_DIR);

  const a2aResult = ensureSymlinkWithoutReplacing(a2aSrc, INSTALLED_A2A_PATH);
  const serverResult = ensureSymlinkWithoutReplacing(a2aServerSrc, INSTALLED_A2A_SERVER_PATH);

  if (a2aResult.status === "conflict") {
    printWarning(a2aResult.message);
  }
  if (serverResult.status === "conflict") {
    printWarning(serverResult.message);
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  if (!pathEntries.includes(INSTALL_BIN_DIR)) {
    PATH_WARNING = true;
    WARNINGS += 1;
  }

  if (a2aResult.status === "conflict" || serverResult.status === "conflict") {
    return warning("one or more binary destinations already existed");
  }

  if (a2aResult.status === "skip" && serverResult.status === "skip") {
    return skipped("binary symlinks already correct");
  }

  return changed(`linked commands in ${INSTALL_BIN_DIR}`);
}

async function installSkill() {
  explain([
    "This step installs the a2a skill under ~/.claude/skills/a2a.",
    `Source: ${A2A_SKILL_FILE}`,
    `Destination: ${INSTALLED_SKILL_PATH}`,
    "If the destination exists and differs, it will be backed up with a timestamped .bak suffix.",
  ]);

  if (!(await confirm("Proceed with skill install?"))) {
    return skipped("user skipped skill step");
  }

  if (!fs.existsSync(A2A_SKILL_FILE)) {
    return skipped("skill/SKILL.md not found in package");
  }

  const result = copyFileWithBackup(A2A_SKILL_FILE, INSTALLED_SKILL_PATH);
  return result.status === "skip" ? skipped(result.message) : changed(result.message);
}

async function installWelcomeDoc() {
  explain([
    "This step installs the a2a session welcome document under ~/.claude.",
    `Source: ${WELCOME_DOC_PATH}`,
    `Destination: ${INSTALLED_WELCOME_DOC_PATH}`,
    "If the destination exists and differs, it will be backed up with a timestamped .bak suffix.",
  ]);

  if (!(await confirm("Proceed with welcome doc install?"))) {
    return skipped("user skipped welcome doc step");
  }

  if (!fs.existsSync(WELCOME_DOC_PATH)) {
    return skipped("src/a2a-welcome.md not found in package");
  }

  const result = copyFileWithBackup(WELCOME_DOC_PATH, INSTALLED_WELCOME_DOC_PATH);
  return result.status === "skip" ? skipped(result.message) : changed(result.message);
}

async function installGroups() {
  const src = path.join(SCRIPT_DIR, "teams", "star-wars");
  const dest = path.join(INSTALLED_GROUPS_DIR, "star-wars");

  explain([
    "This step copies the default star-wars example group into the a2a groups folder.",
    `Source: ${src}`,
    `Destination: ${dest}`,
    "It only creates the group if it does not already exist.",
  ]);

  if (!(await confirm("Proceed with group install?"))) {
    return skipped("user skipped group install");
  }

  ensureDir(INSTALLED_GROUPS_DIR);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return skipped("source group template not found");
  }

  if (fs.existsSync(dest)) {
    return skipped("group already exists");
  }

  fs.cpSync(src, dest, { recursive: true });
  return changed(`created ${dest}`);
}

async function installTeams() {
  const src = path.join(SCRIPT_DIR, "teams", "bug-killers.yaml");
  const dest = path.join(INSTALLED_TEAMS_DIR, "bug-killers.yaml");

  explain([
    "This step copies the default bug-killers team spec into the a2a teams folder.",
    `Source: ${src}`,
    `Destination: ${dest}`,
    "It only creates the team spec if it does not already exist.",
  ]);

  if (!(await confirm("Proceed with team spec install?"))) {
    return skipped("user skipped team spec install");
  }

  ensureDir(INSTALLED_TEAMS_DIR);

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return skipped("source team spec not found");
  }

  if (fs.existsSync(dest)) {
    return skipped("team spec already exists");
  }

  fs.copyFileSync(src, dest);
  return changed(`created ${dest}`);
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
  println(`  ${DIM}skill${RESET}          ${INSTALLED_SKILL_PATH}`);
  println(`  ${DIM}welcome${RESET}        ${INSTALLED_WELCOME_DOC_PATH}`);
  println("");

  if (PATH_WARNING && INSTALL_BIN_DIR) {
    println(`${YELLOW}your PATH does not include ${INSTALL_BIN_DIR}${RESET}`);
    println("add this to your shell profile:\n");
    println(`  export PATH="${INSTALL_BIN_DIR}:$PATH"\n`);
  }

  println("quick start\n");
  println(`  ${DIM}a2a bridge start${RESET}          start the bridge`);
  println(`  ${DIM}a2a start bob${RESET}             spawn an agent named bob`);
  println(`  ${DIM}a2a --bob 'hello'${RESET}         send bob a message`);
  println(`  ${DIM}a2a gen-key${RESET}               generate a key for your bridge`);
  println("");
  println(`  ${DIM}a2a help${RESET} for full reference\n`);
}

function printInstallHelp() {
  println(`
${BOLD}a2a setup${RESET}

usage:
  node scripts/install.mjs [options]

options:
  -y, --yes     run all steps without prompts (same as A2A_SETUP_YES=1 or CI=1)
  -h, --help    show this message

npm:
  npm run bootstrap    non-interactive setup (skill, welcome doc, samples, PATH symlinks)
`);
}

function verifyInstall() {
  if (!INSTALLED_A2A_PATH) {
    return warning("binary install was skipped");
  }

  if (!fs.existsSync(INSTALLED_A2A_PATH)) {
    return warning("a2a binary path does not exist");
  }

  const stat = fs.lstatSync(INSTALLED_A2A_PATH);
  if (!stat.isSymbolicLink() && (stat.mode & 0o111) === 0) {
    return warning("a2a path exists but is not executable");
  }
  return ok(`${INSTALLED_A2A_PATH} is ready`);
}

async function runStep(label, fn) {
  stepStart(label);
  const result = await fn() || ok();
  printResult(result.kind, result.message || "");
  println("");
}

const INSTALL_STEPS = [
  ["Link commands", installBinaries],
  ["Install Claude skill", installSkill],
  ["Install welcome document", installWelcomeDoc],
  ["Install sample group", installGroups],
  ["Install sample team", installTeams],
  ["Verify install", verifyInstall],
];

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
    println(`${BOLD}a2a setup${RESET} ${DIM}(--yes)${RESET}\n`);
    printPrereqs();
    println("");
  }

  for (const [label, fn] of INSTALL_STEPS) {
    await runStep(label, fn);
  }

  printSummary();
  await rl.close();
}

main();
