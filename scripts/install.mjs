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
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";

/**
 * True in CI environments. Accepts both CI=1 and CI=true — GitHub Actions
 * sets CI=true, and missing it left the installer blocked on rl.question
 * with a non-tty stdin.
 */
function isCI() {
  return process.env.CI === "1" || process.env.CI === "true";
}

/**
 * Check if ANSI colors should be disabled.
 * Respects NO_COLOR and A2A_NO_COLOR environment variables, and CI environments.
 */
function shouldDisableAnsi() {
  if (process.env.NO_COLOR || process.env.A2A_NO_COLOR) return true;
  if (isCI()) return true;
  return false;
}

const ANSI_DISABLED = shouldDisableAnsi();

const RED = ANSI_DISABLED ? "" : "\x1b[0;31m";
const GREEN = ANSI_DISABLED ? "" : "\x1b[0;32m";
const YELLOW = ANSI_DISABLED ? "" : "\x1b[1;33m";
const BOLD = ANSI_DISABLED ? "" : "\x1b[1m";
const DIM = ANSI_DISABLED ? "" : "\x1b[2m";
const RESET = ANSI_DISABLED ? "" : "\x1b[0m";

const SCRIPT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const INSTALL_ARGV = process.argv.slice(2);

/**
 * @returns {{ autoYes: boolean, showHelp: boolean, skipNgrok: boolean,
 *   skipKey: boolean, skipPath: boolean, verifyNgrok: boolean }}
 */
function parseInstallArgv(argv) {
  let autoYes = false;
  let showHelp = false;
  let skipNgrok = false;
  let skipKey = false;
  let skipPath = false;
  let verifyNgrok = false;
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") autoYes = true;
    if (arg === "--help" || arg === "-h") showHelp = true;
    if (arg === "--no-ngrok") skipNgrok = true;
    if (arg === "--no-key") skipKey = true;
    if (arg === "--no-path") skipPath = true;
    if (arg === "--verify-ngrok") verifyNgrok = true;
  }
  if (process.env.A2A_SETUP_YES === "1" || isCI()) autoYes = true;
  if (process.env.A2A_SETUP_NO_NGROK === "1") skipNgrok = true;
  if (process.env.A2A_SETUP_NO_KEY === "1") skipKey = true;
  if (process.env.A2A_SETUP_NO_PATH === "1") skipPath = true;
  return { autoYes, showHelp, skipNgrok, skipKey, skipPath, verifyNgrok };
}

const {
  autoYes: AUTO_YES,
  showHelp: SHOW_HELP,
  skipNgrok: SKIP_NGROK,
  skipKey: SKIP_KEY,
  skipPath: SKIP_PATH,
  verifyNgrok: VERIFY_NGROK,
} = parseInstallArgv(INSTALL_ARGV);

const HOME = os.homedir();
const A2A_ROOT = SCRIPT_DIR;
// The skills live in `skills/` (plural). This pointed at a non-existent
// `skill/` for long enough that every install silently reported "skipped:
// skill/a2a/SKILL.md not found in package" and still exited 0 — the skill,
// which is the entire point of the install, never landed.
const A2A_SKILL_SRC_DIR = path.join(A2A_ROOT, "skills", "a2a");
const A2A_SKILL_FILE = path.join(A2A_SKILL_SRC_DIR, "SKILL.md");
const A2A_TEAM_HARNESS_SRC_DIR = path.join(
  A2A_ROOT,
  "skills",
  "a2a-team-harness",
);
const CLAUDE_DIR = path.join(HOME, ".claude");
const WELCOME_DOC_PATH = path.join(A2A_ROOT, "src", "a2a-welcome.md");
const INSTALLED_SKILL_DIR = path.join(CLAUDE_DIR, "skills", "a2a");
const INSTALLED_SKILL_PATH = path.join(INSTALLED_SKILL_DIR, "SKILL.md");
const INSTALLED_TEAM_HARNESS_DIR = path.join(
  CLAUDE_DIR,
  "skills",
  "a2a-team-harness",
);
const INSTALLED_WELCOME_DOC_PATH = path.join(CLAUDE_DIR, "a2a-welcome.md");
const INSTALLED_GROUPS_DIR = path.join(INSTALLED_SKILL_DIR, "groups");
const INSTALLED_TEAMS_DIR = path.join(INSTALLED_SKILL_DIR, "teams");
const CONFIG_FILE = path.join(A2A_ROOT, "config.json");
/** Declared runtime dependencies. The CLI dies at import time without these. */
const RUNTIME_DEPS = ["js-yaml", "zod", "@modelcontextprotocol/sdk"];

let STEP = 0;
let WARNINGS = 0;
const START_EPOCH = Date.now();

let INSTALL_BIN_DIR = "";
let INSTALLED_A2A_PATH = "";
let INSTALLED_A2A_SERVER_PATH = "";
let PATH_WARNING = false;
let CURRENT_STEP_LABEL = "";

/** Set once the core skill file is verified on disk at its destination. */
let SKILL_INSTALLED = false;
/** True when the user explicitly declined a step, so verify won't call it a defect. */
let BINARY_STEP_SKIPPED = false;
let SKILL_STEP_SKIPPED = false;
/** Human-readable ngrok outcome for the summary. */
let NGROK_STATUS = "not checked";
/** Shell profile the PATH line was appended to, if any. */
let PROFILE_UPDATED = "";
/**
 * True when verification found the install unusable. The process exits
 * non-zero in that case: an installer that prints "installed" over a CLI that
 * cannot start is the failure this whole step exists to catch.
 */
let INSTALL_BROKEN = false;

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
  println(
    `${DIM}CLI links, Claude skill files, welcome doc, and examples${RESET}\n`,
  );
}

function stepStart(label) {
  STEP += 1;
  CURRENT_STEP_LABEL = label;
  println(
    // eslint-disable-next-line no-use-before-define -- INSTALL_STEPS is a const defined after this function but always initialized before any call
    `${DIM}[${STEP}/${INSTALL_STEPS.length}]${RESET} ${BOLD}${label}${RESET}`,
  );
}

function printResult(kind, message = "") {
  const label =
    kind === "ok"
      ? `${GREEN}ok${RESET}`
      : kind === "changed"
        ? `${GREEN}changed${RESET}`
        : kind === "skip"
          ? `${DIM}skipped${RESET}`
          : kind === "warn"
            ? `${YELLOW}warning${RESET}`
            : `${RED}failed${RESET}`;
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
  const result = spawnSync(
    "sh",
    ["-lc", `command -v ${shellQuote(bin)} >/dev/null 2>&1`],
    {
      stdio: "ignore",
    },
  );
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
    println(
      `  ${padRight(bin, 10)} ${padRight(ver, 12)} ${YELLOW}needs ${minMajor}+${RESET}`,
    );
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
  const candidates = [
    path.join(HOME, ".local", "bin"),
    path.join(HOME, "bin"),
    "/usr/local/bin",
  ];

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
  // lstat, not existsSync: existsSync follows symlinks, so a dangling link
  // reported "nothing here" and the subsequent symlinkSync aborted the whole
  // installer with EEXIST.
  let stat = null;
  try {
    stat = fs.lstatSync(dest);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  if (stat === null) {
    fs.symlinkSync(src, dest);
    return { status: "ok", message: `created symlink ${dest} -> ${src}` };
  }

  if (stat.isSymbolicLink()) {
    const current = fs.readlinkSync(dest);
    if (!fs.existsSync(dest)) {
      // Dangling link (target no longer exists) — replaceable: it cannot be
      // anyone's working file.
      fs.unlinkSync(dest);
      fs.symlinkSync(src, dest);
      return {
        status: "ok",
        message: `replaced dangling symlink ${dest} (was -> ${current}) with -> ${src}`,
      };
    }
    if (current === src) {
      return {
        status: "skip",
        message: `${dest} already points to the correct source`,
      };
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

/**
 * Every file under `dir`, recursively. .DS_Store is skipped so macOS Finder
 * droppings never get published into ~/.claude.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Copy a whole tree with the same no-clobber contract as copyFileWithBackup:
 * differing destinations are backed up, identical ones left alone.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {{created:number, updated:number, unchanged:number, total:number}}
 */
function copyTreeWithBackup(srcDir, destDir) {
  const files = listFilesRecursive(srcDir);
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const src of files) {
    const dest = path.join(destDir, path.relative(srcDir, src));
    const existed = fs.existsSync(dest);
    const result = copyFileWithBackup(src, dest);
    if (result.status === "skip") unchanged += 1;
    else if (existed) updated += 1;
    else created += 1;
  }
  return { created, updated, unchanged, total: files.length };
}

/**
 * Ask for a value (not a yes/no). Unlike confirm(), --yes does NOT auto-answer
 * this: an ngrok authtoken is a per-account secret that cannot be invented, so
 * the only options are "ask" or "skip and say so".
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
async function promptValue(question) {
  if (isCI()) return "";
  if (!process.stdin.isTTY) return "";
  const answer = await rl.question(`  ${question} `);
  return answer.trim();
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?:string, timeout?:number}} [opts]
 */
function runCapture(bin, args, opts = {}) {
  return spawnSync(bin, args, {
    cwd: opts.cwd || A2A_ROOT,
    encoding: "utf8",
    timeout: opts.timeout ?? 300_000,
  });
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function tailLines(text, max = 4) {
  return String(text || "")
    .trim()
    .split("\n")
    .slice(-max)
    .join("; ");
}

/**
 * @returns {string[]} declared runtime deps missing from node_modules
 */
function missingRuntimeDeps() {
  return RUNTIME_DEPS.filter(
    (dep) => !fs.existsSync(path.join(A2A_ROOT, "node_modules", dep)),
  );
}

async function installDependencies() {
  const missing = missingRuntimeDeps();

  explain([
    "This step installs the npm dependencies the CLI imports at startup.",
    `Required: ${RUNTIME_DEPS.join(", ")}`,
    missing.length
      ? `Currently missing: ${missing.join(", ")}`
      : "All present -- this step will do nothing.",
    `Runs: npm install (in ${A2A_ROOT})`,
  ]);

  if (missing.length === 0) {
    return skipped("dependencies already present");
  }

  if (!(await confirm("Install npm dependencies?"))) {
    return warning(
      `dependencies missing (${missing.join(", ")}); the a2a CLI cannot start without them`,
    );
  }

  if (!commandExists("npm")) {
    return warning(
      "npm not found; install Node.js with npm, then re-run — the CLI cannot start without its dependencies",
    );
  }

  const result = runCapture("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);

  if (result.status !== 0) {
    stepFail(
      `npm install failed (exit ${result.status}): ${tailLines(
        result.stderr || result.stdout,
      )}`,
    );
  }

  const stillMissing = missingRuntimeDeps();
  if (stillMissing.length) {
    stepFail(
      `npm install finished but these are still missing: ${stillMissing.join(", ")}`,
    );
  }

  return changed(`installed ${missing.length} missing dependency tree(s)`);
}

async function installBinaries() {
  INSTALL_BIN_DIR = detectInstallBinDir();

  const useSudo =
    INSTALL_BIN_DIR === "/usr/local/bin" && !isWritableDir(INSTALL_BIN_DIR);
  if (useSudo && !canUsePasswordlessSudo()) {
    stepFail(
      "install dir is /usr/local/bin but sudo is required. Re-run with sudo, or create ~/.local/bin and retry.",
    );
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
    BINARY_STEP_SKIPPED = true;
    return skipped("user skipped binary setup");
  }

  fs.chmodSync(a2aSrc, 0o755);
  fs.chmodSync(a2aServerSrc, 0o755);

  if (useSudo) {
    return warning(
      "sudo-managed install dir detected; manual setup recommended for /usr/local/bin",
    );
  }

  ensureDir(INSTALL_BIN_DIR);

  const a2aResult = ensureSymlinkWithoutReplacing(a2aSrc, INSTALLED_A2A_PATH);
  const serverResult = ensureSymlinkWithoutReplacing(
    a2aServerSrc,
    INSTALLED_A2A_SERVER_PATH,
  );

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
    `Source: ${A2A_SKILL_SRC_DIR}`,
    `Destination: ${INSTALLED_SKILL_DIR}`,
    "If a destination file exists and differs, it will be backed up with a timestamped .bak suffix.",
  ]);

  if (!(await confirm("Proceed with skill install?"))) {
    SKILL_STEP_SKIPPED = true;
    return skipped("user skipped skill step");
  }

  // A missing source here is a packaging bug, not a user choice. Reporting it
  // as "skipped" is what let the skill quietly go missing from every install.
  if (!fs.existsSync(A2A_SKILL_FILE)) {
    stepFail(
      `skill source missing: ${A2A_SKILL_FILE} — the repo is incomplete, so there is nothing to install`,
    );
  }

  const stats = copyTreeWithBackup(A2A_SKILL_SRC_DIR, INSTALLED_SKILL_DIR);
  SKILL_INSTALLED = fs.existsSync(INSTALLED_SKILL_PATH);

  if (!SKILL_INSTALLED) {
    stepFail(`copied the skill but ${INSTALLED_SKILL_PATH} is not on disk`);
  }

  if (stats.created === 0 && stats.updated === 0) {
    return skipped(`${stats.total} skill file(s) already up to date`);
  }
  return changed(
    `${stats.created} created, ${stats.updated} updated in ${INSTALLED_SKILL_DIR}`,
  );
}

async function installTeamHarnessSkill() {
  explain([
    "This step installs the a2a-team-harness skill (team YAML authoring) under",
    "~/.claude/skills/a2a-team-harness, including its references/ and assets/.",
    `Source: ${A2A_TEAM_HARNESS_SRC_DIR}`,
    `Destination: ${INSTALLED_TEAM_HARNESS_DIR}`,
  ]);

  if (!(await confirm("Proceed with team-harness skill install?"))) {
    return skipped("user skipped team-harness skill step");
  }

  if (!fs.existsSync(path.join(A2A_TEAM_HARNESS_SRC_DIR, "SKILL.md"))) {
    return warning(
      `team-harness skill source missing: ${A2A_TEAM_HARNESS_SRC_DIR}`,
    );
  }

  const stats = copyTreeWithBackup(
    A2A_TEAM_HARNESS_SRC_DIR,
    INSTALLED_TEAM_HARNESS_DIR,
  );

  if (stats.created === 0 && stats.updated === 0) {
    return skipped(`${stats.total} harness file(s) already up to date`);
  }
  return changed(
    `${stats.created} created, ${stats.updated} updated in ${INSTALLED_TEAM_HARNESS_DIR}`,
  );
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

  const result = copyFileWithBackup(
    WELCOME_DOC_PATH,
    INSTALLED_WELCOME_DOC_PATH,
  );
  return result.status === "skip"
    ? skipped(result.message)
    : changed(result.message);
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
  const src = path.join(SCRIPT_DIR, "teams", "star-wars.yaml");
  const dest = path.join(INSTALLED_TEAMS_DIR, "star-wars.yaml");

  explain([
    "This step copies the default star-wars team spec into the a2a teams folder.",
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

async function ensureOperatorKey() {
  explain([
    "This step generates the bridge operator key if one is not set yet.",
    "`a2a start --global` refuses to expose the bridge without a key, so a",
    "fresh install cannot do cross-machine sessions until one exists.",
    `Stored in: ${CONFIG_FILE} (written mode 0600, git-ignored)`,
    "An existing key is never replaced.",
  ]);

  if (SKIP_KEY) return skipped("--no-key");

  if (!(await confirm("Generate an operator key if one is missing?"))) {
    return skipped("user skipped key generation");
  }

  let config;
  try {
    config = await import(
      pathToFileURL(path.join(A2A_ROOT, "src", "a2a-config.mjs")).href
    );
  } catch (error) {
    return warning(`could not load the a2a config module: ${error.message}`);
  }

  try {
    if (config.activeKey()) return skipped("operator key already configured");
    config.configSet("key", config.generateKey());
    if (!config.activeKey()) {
      return warning("wrote a key but the config still reports none");
    }
    return changed(`generated operator key in ${CONFIG_FILE}`);
  } catch (error) {
    return warning(`key generation failed: ${error.message}`);
  }
}

/**
 * Path of the config file ngrok itself reports. Parsed from `ngrok config
 * check` rather than guessed, because the macOS default lives under
 * "Application Support" (a path with a space in it).
 *
 * @returns {string}
 */
function ngrokConfigPath() {
  if (!commandExists("ngrok")) return "";
  const result = runCapture("ngrok", ["config", "check"], { timeout: 15_000 });
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  const match = text.match(/configuration file at (.+)/);
  return match ? match[1].trim() : "";
}

/**
 * Whether ngrok has a credential. Having the binary is NOT enough: an
 * unauthenticated agent dies with ERR_NGROK_4018 the moment `a2a start
 * --global` spawns it.
 *
 * @returns {boolean}
 */
function ngrokAuthtokenPresent() {
  if ((process.env.NGROK_AUTHTOKEN || "").trim()) return true;
  const candidates = [
    ngrokConfigPath(),
    path.join(HOME, "Library", "Application Support", "ngrok", "ngrok.yml"),
    path.join(HOME, ".config", "ngrok", "ngrok.yml"),
    path.join(HOME, ".ngrok2", "ngrok.yml"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const text = fs.readFileSync(candidate, "utf8");
      if (/^\s*authtoken\s*:\s*\S+/m.test(text)) return true;
    } catch {
      // Unreadable config counts as "no token" — the caller will offer to set one.
    }
  }
  return false;
}

/**
 * @returns {boolean} true if ngrok is on PATH afterwards
 */
function installNgrokBinary() {
  if (process.platform === "darwin" && commandExists("brew")) {
    println(`  ${DIM}running: brew install --cask ngrok${RESET}`);
    const result = spawnSync("brew", ["install", "--cask", "ngrok"], {
      stdio: "inherit",
      timeout: 900_000,
    });
    return result.status === 0 && commandExists("ngrok");
  }
  if (process.platform === "linux" && commandExists("snap")) {
    println(`  ${DIM}running: snap install ngrok${RESET}`);
    const result = spawnSync("snap", ["install", "ngrok"], {
      stdio: "inherit",
      timeout: 900_000,
    });
    return result.status === 0 && commandExists("ngrok");
  }
  return false;
}

/**
 * Classify ngrok's own logfmt output as "credential accepted" or not.
 *
 * Both signals below were observed from real ngrok 3.39.9 runs on this
 * machine, which is why the check is written against them and not against a
 * tunnel URL:
 *
 *   - An unauthenticated agent (empty config) logs ERR_NGROK_4018 and never
 *     logs "client session established".
 *   - An authenticated agent logs "client session established" first. If a
 *     session is already running it then fails with ERR_NGROK_334 (simultaneous
 *     session limit) — that is a busy account, NOT a bad credential, so
 *     treating it as failure would report a false defect.
 *
 * Deliberately does NOT look for a tunnel URL: no successful tunnel could be
 * opened here to confirm the field name, so parsing one would be a guess.
 *
 * @param {string} output
 * @returns {{state:"rejected"|"accepted"|"busy"|"unknown", detail:string}}
 */
function classifyNgrokAuthLog(output) {
  const text = String(output || "");
  if (/ERR_NGROK_4018/.test(text)) {
    return { state: "rejected", detail: "ERR_NGROK_4018 (not authenticated)" };
  }
  if (/client session established/.test(text)) {
    if (/ERR_NGROK_334/.test(text)) {
      return {
        state: "busy",
        detail: "credential accepted; another ngrok agent is already running",
      };
    }
    return { state: "accepted", detail: "credential accepted by ngrok" };
  }
  const anyErr = text.match(/ERR_NGROK_\d+/);
  return {
    state: "unknown",
    detail: anyErr ? anyErr[0] : "no decisive signal from ngrok",
  };
}

/**
 * Start ngrok briefly and classify its log to prove the credential works.
 * Opt-in (--verify-ngrok) because it starts a real agent process.
 *
 * @param {number} port
 * @returns {Promise<{state:string, detail:string}>}
 */
function probeNgrokAuth(port) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(
      "ngrok",
      ["http", String(port), "--log", "stdout", "--log-format", "logfmt"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      resolve(result);
    };

    timer = setTimeout(
      () => finish(classifyNgrokAuthLog(output)),
      20_000,
    );

    const onData = (chunk) => {
      output += chunk.toString();
      const verdict = classifyNgrokAuthLog(output);
      if (verdict.state !== "unknown") finish(verdict);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) =>
      finish({
        state: "unknown",
        detail: `could not spawn ngrok: ${error.message}`,
      }),
    );
  });
}

async function setupNgrok() {
  explain([
    "This step makes cross-machine sessions (`a2a start --global`) work.",
    "It ensures the ngrok binary exists, then ensures ngrok has an authtoken:",
    "  - installs ngrok via brew (macOS) or snap (Linux) when missing",
    "  - runs `ngrok config add-authtoken <token>` if no credential is set",
    "An authtoken is a per-account secret from dashboard.ngrok.com, so if one",
    "is missing you will be asked to paste it. Everything else is automatic.",
    "This step never fails the install: ngrok is only needed for --global.",
  ]);

  if (SKIP_NGROK) {
    NGROK_STATUS = "skipped (--no-ngrok)";
    return skipped("--no-ngrok");
  }

  if (!(await confirm("Set up ngrok for cross-machine sessions?"))) {
    NGROK_STATUS = "skipped by user";
    return skipped("user skipped ngrok setup");
  }

  let haveBinary = commandExists("ngrok");
  let installedBinary = false;

  if (!haveBinary && isCI()) {
    // Never install system packages on a CI runner: --yes is implied there, so
    // an unattended `brew install` would be a surprise side effect of a build.
    NGROK_STATUS = "missing (not auto-installed under CI)";
    return warning("ngrok is missing; skipping auto-install because CI is set");
  }

  if (!haveBinary) {
    installedBinary = installNgrokBinary();
    haveBinary = installedBinary || commandExists("ngrok");
  }

  if (!haveBinary) {
    NGROK_STATUS = "binary not installed";
    return warning(
      "could not install ngrok automatically on this platform; install it from https://ngrok.com/download, then re-run — local sessions work without it",
    );
  }

  let haveToken = ngrokAuthtokenPresent();

  if (!haveToken) {
    println(
      `  ${DIM}ngrok has no authtoken. Get one (free) at https://dashboard.ngrok.com/get-started/your-authtoken${RESET}`,
    );
    const token = await promptValue(
      "paste ngrok authtoken (or press enter to skip):",
    );

    if (token) {
      const result = runCapture(
        "ngrok",
        ["config", "add-authtoken", token],
        { timeout: 30_000 },
      );
      if (result.status !== 0) {
        NGROK_STATUS = "authtoken rejected";
        return warning(
          `ngrok config add-authtoken failed: ${tailLines(
            result.stderr || result.stdout,
          )}`,
        );
      }
      haveToken = ngrokAuthtokenPresent();
    }
  }

  if (!haveToken) {
    NGROK_STATUS = "binary ready, no authtoken";
    return warning(
      "ngrok is installed but has no authtoken, so `a2a start --global` will fail with ERR_NGROK_4018; run `ngrok config add-authtoken <token>` when you have one",
    );
  }

  if (VERIFY_NGROK) {
    const probe = await probeNgrokAuth(4599);
    if (probe.state === "rejected") {
      NGROK_STATUS = `authtoken present but rejected (${probe.detail})`;
      return warning(
        `ngrok rejected the stored credential: ${probe.detail} — re-run \`ngrok config add-authtoken <token>\``,
      );
    }
    if (probe.state === "unknown") {
      NGROK_STATUS = `authtoken set, probe inconclusive (${probe.detail})`;
      return warning(`could not confirm the ngrok credential: ${probe.detail}`);
    }
    NGROK_STATUS =
      probe.state === "busy"
        ? "ready (credential verified; an agent is already running)"
        : "ready (credential verified)";
    return installedBinary
      ? changed(`installed ngrok; ${probe.detail}`)
      : ok(probe.detail);
  }

  NGROK_STATUS = "ready (binary + authtoken)";
  if (installedBinary) return changed("installed ngrok and configured authtoken");
  return ok("ngrok binary and authtoken already in place");
}

const PATH_MARKER = "# added by a2a install";

/**
 * @returns {{file:string, kind:"posix"|"fish"}|null}
 */
function shellProfileTarget() {
  const shell = path.basename((process.env.SHELL || "").trim());
  if (shell === "zsh") return { file: path.join(HOME, ".zshrc"), kind: "posix" };
  if (shell === "bash") {
    const rc = path.join(HOME, ".bashrc");
    if (fs.existsSync(rc)) return { file: rc, kind: "posix" };
    return { file: path.join(HOME, ".bash_profile"), kind: "posix" };
  }
  if (shell === "fish") {
    return {
      file: path.join(HOME, ".config", "fish", "config.fish"),
      kind: "fish",
    };
  }
  return null;
}

async function configureShellPath() {
  if (SKIP_PATH) return skipped("--no-path");
  if (!INSTALL_BIN_DIR) return skipped("binary step did not run");
  if (!PATH_WARNING) return skipped(`${INSTALL_BIN_DIR} is already on PATH`);

  const target = shellProfileTarget();
  if (!target) {
    return warning(
      `unrecognised shell (SHELL=${process.env.SHELL || "unset"}); add ${INSTALL_BIN_DIR} to your PATH manually`,
    );
  }

  // Write $HOME-relative so the profile stays valid if the home path changes.
  const portable = INSTALL_BIN_DIR.startsWith(HOME + path.sep)
    ? `$HOME/${path
        .relative(HOME, INSTALL_BIN_DIR)
        .split(path.sep)
        .join("/")}`
    : INSTALL_BIN_DIR;
  const line =
    target.kind === "fish"
      ? `fish_add_path ${portable}`
      : `export PATH="${portable}:$PATH"`;

  explain([
    `${INSTALL_BIN_DIR} is not on your PATH, so \`a2a\` would not resolve.`,
    `This step appends one line to ${target.file}:`,
    `  ${line}`,
    "The file is backed up first, and the line is only added once.",
  ]);

  if (!(await confirm(`Add ${INSTALL_BIN_DIR} to PATH in ${target.file}?`))) {
    return skipped("user skipped PATH setup");
  }

  let existing = "";
  try {
    existing = fs.readFileSync(target.file, "utf8");
  } catch {
    // No profile yet — it gets created below.
  }

  if (existing.includes(portable) || existing.includes(INSTALL_BIN_DIR)) {
    return skipped(`${target.file} already puts ${INSTALL_BIN_DIR} on PATH`);
  }

  ensureDir(path.dirname(target.file));
  backupFile(target.file);
  const separator = existing.length && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(target.file, `${separator}\n${PATH_MARKER}\n${line}\n`);
  PROFILE_UPDATED = target.file;
  return changed(`added PATH line to ${target.file}`);
}

function printPrereqs() {
  println("prerequisites\n");
  checkVersion("node", 18);
  checkVersion("tmux", null);
  if (commandExists("ngrok")) {
    println(
      `  ${padRight("ngrok", 10)} ${DIM}installed${
        ngrokAuthtokenPresent() ? ", authtoken set" : ", no authtoken yet"
      }${RESET}`,
    );
  } else if (SKIP_NGROK) {
    println(`  ${padRight("ngrok", 10)} ${DIM}missing -- skipped${RESET}`);
  } else {
    println(
      `  ${padRight("ngrok", 10)} ${DIM}missing -- will be installed for cross-machine sessions${RESET}`,
    );
  }
  println("");
}

function printSummary() {
  const elapsed = elapsedHuman();

  println("");
  if (WARNINGS > 0) {
    println(
      `installed in ${elapsed}  ${YELLOW}(${WARNINGS} warning(s) above)${RESET}`,
    );
  } else {
    println(`installed in ${elapsed}`);
  }

  println("\nlocations\n");
  println(`  ${DIM}bin dir${RESET}        ${INSTALL_BIN_DIR || "(not set)"}`);
  // Only claim a location that actually exists. This block used to print the
  // skill path unconditionally, including on runs where the skill never
  // installed at all.
  println(
    `  ${DIM}skill${RESET}          ${
      fs.existsSync(INSTALLED_SKILL_PATH)
        ? INSTALLED_SKILL_PATH
        : `${YELLOW}not installed${RESET}`
    }`,
  );
  println(
    `  ${DIM}harness${RESET}        ${
      fs.existsSync(path.join(INSTALLED_TEAM_HARNESS_DIR, "SKILL.md"))
        ? INSTALLED_TEAM_HARNESS_DIR
        : `${DIM}not installed${RESET}`
    }`,
  );
  println(`  ${DIM}welcome${RESET}        ${INSTALLED_WELCOME_DOC_PATH}`);
  println(`  ${DIM}ngrok${RESET}          ${NGROK_STATUS}`);
  println("");

  if (PROFILE_UPDATED) {
    println(`${GREEN}added ${INSTALL_BIN_DIR} to PATH${RESET} in ${PROFILE_UPDATED}`);
    println("open a new shell, or load it into this one:\n");
    println(`  source ${PROFILE_UPDATED}\n`);
  } else if (PATH_WARNING && INSTALL_BIN_DIR) {
    println(`${YELLOW}your PATH does not include ${INSTALL_BIN_DIR}${RESET}`);
    println("add this to your shell profile:\n");
    println(`  export PATH="${INSTALL_BIN_DIR}:$PATH"\n`);
  }

  if (INSTALL_BROKEN) {
    println(
      `${RED}this install is not usable yet${RESET} -- see the Verify step above.`,
    );
    println(`${DIM}re-run ./install after fixing what it reported.${RESET}\n`);
  }

  println("quick start\n");
  println(`  ${DIM}a2a bridge start${RESET}          start the bridge`);
  println(`  ${DIM}a2a start bob${RESET}             spawn an agent named bob`);
  println(`  ${DIM}a2a --bob 'hello'${RESET}         send bob a message`);
  println(
    `  ${DIM}a2a gen-key${RESET}               generate a key for your bridge`,
  );
  println("");
  println(`  ${DIM}a2a help${RESET} for full reference\n`);
}

function printInstallHelp() {
  println(`
${BOLD}a2a setup${RESET}

usage:
  ./install                    everything, no prompts (recommended)
  node scripts/install.mjs [options]

options:
  -y, --yes         run all steps without prompts (same as A2A_SETUP_YES=1, CI=1, or CI=true)
      --no-ngrok    skip ngrok setup entirely (A2A_SETUP_NO_NGROK=1)
      --no-key      do not generate a bridge operator key (A2A_SETUP_NO_KEY=1)
      --no-path     do not touch your shell profile (A2A_SETUP_NO_PATH=1)
      --verify-ngrok   start ngrok briefly to confirm its credential is accepted
  -h, --help        show this message

what it does:
  installs npm dependencies, links a2a + a2a-server onto your PATH, installs the
  a2a and a2a-team-harness Claude skills, the welcome doc and samples, generates
  a bridge operator key, installs and authenticates ngrok, adds the bin dir to
  your shell profile, then runs \`a2a help\` to prove the install works.

npm:
  npm run bootstrap    same as ./install
`);
}

/**
 * Prove the install is usable by running the CLI, not by stat-ing a symlink.
 * The old version only lstat'd the link and checked the exec bit, which is why
 * a clone with no node_modules reported "a2a is ready" and then died with
 * ERR_MODULE_NOT_FOUND on the first real command.
 */
function verifyInstall() {
  const problems = [];
  const notes = [];

  const missing = missingRuntimeDeps();
  if (missing.length) {
    problems.push(`missing dependencies: ${missing.join(", ")}`);
  }

  // Prefer the installed symlink: that exercises the exact path a user hits,
  // including link resolution and the shebang. Fall back to the in-repo entry
  // point when linking was declined, so deps still get verified.
  const useLink = Boolean(
    INSTALLED_A2A_PATH && fs.existsSync(INSTALLED_A2A_PATH),
  );
  const bin = useLink ? INSTALLED_A2A_PATH : process.execPath;
  const args = useLink
    ? ["help"]
    : [path.join(A2A_ROOT, "bin", "a2a.mjs"), "help"];

  const run = runCapture(bin, args, { timeout: 60_000 });
  if (run.error) {
    problems.push(`could not execute ${bin}: ${run.error.message}`);
  } else if (run.status !== 0) {
    problems.push(
      `\`a2a help\` exited ${run.status}: ${tailLines(run.stderr || run.stdout)}`,
    );
  }

  if (!useLink) {
    if (BINARY_STEP_SKIPPED) {
      notes.push("command linking was skipped, so `a2a` is not on your PATH");
    } else {
      problems.push("a2a was not linked into a PATH directory");
    }
  }

  if (!fs.existsSync(INSTALLED_SKILL_PATH)) {
    if (SKILL_STEP_SKIPPED) {
      notes.push(`skill install was skipped (${INSTALLED_SKILL_PATH} absent)`);
    } else {
      problems.push(`skill missing at ${INSTALLED_SKILL_PATH}`);
    }
  }

  if (problems.length) {
    INSTALL_BROKEN = true;
    return warning(problems.join(" | "));
  }

  const detail = `\`a2a help\` runs${
    SKILL_INSTALLED ? "; skill present" : ""
  }${notes.length ? `; ${notes.join("; ")}` : ""}`;
  return ok(detail);
}

async function runStep(label, fn) {
  stepStart(label);
  const result = (await fn()) || ok();
  printResult(result.kind, result.message || "");
  println("");
}

const INSTALL_STEPS = [
  ["Install dependencies", installDependencies],
  ["Link commands", installBinaries],
  ["Install Claude skill", installSkill],
  ["Install team-harness skill", installTeamHarnessSkill],
  ["Install welcome document", installWelcomeDoc],
  ["Install sample group", installGroups],
  ["Install sample team", installTeams],
  ["Generate operator key", ensureOperatorKey],
  ["Set up ngrok", setupNgrok],
  ["Configure PATH", configureShellPath],
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

  // Exit non-zero when verification found the install unusable. Reporting
  // success over a CLI that cannot start is the exact failure mode the verify
  // step exists to prevent.
  if (INSTALL_BROKEN) process.exit(1);
}

main();
