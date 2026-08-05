// File: key-sequence.mjs
// Pure parser + compiler for the --command DSL. No IO. Tests cover the parser
// and the tmux/iTerm compile tables independently of any transport.
//
// Public surface:
//   parseCommandDsl(spec, vars)   -> Op[]
//   compileSequence(spec, opts)   -> { ops, summary }
//   compileOpToTmuxKeys(op)       -> string[]   (tmux send-keys argv tail)
//   compileOpToBytes(op)          -> string     (raw bytes for iTerm bridge)
//   KEY_TABLE                     -> { [name]: { tmux, bytes } }
//
// The DSL grammar lives in docs/command-dsl.md. Keep that file and this module
// in sync — the canonical key table here is the source of truth mirrored by
// cmd/a2a-iterm2-bridge/bridge.py.

import { submitKeysForBackend } from "./backend-delivery.mjs";

const ESC = "\x1b";
const BYTES_PER_KIB = 1024;
const SETTLE_FLOOR_MS_DEFAULT = 300;
const SETTLE_PER_KB_MS_DEFAULT = 8;
const SETTLE_CEILING_MS_DEFAULT = 1500;

/**
 * Reads a non-negative integer env var with a fallback. Mirrors the parser
 * used by tmux-raw-delivery.mjs so the same A2A_RAW_PASTE_SETTLE_* knobs
 * apply.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function parseNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * Computes the post-paste settle delay used both inline by the sequence
 * runner and by tmux-raw-delivery.mjs. Same shape on purpose.
 *
 * @param {number} byteLength
 * @returns {number}
 */
export function computeSettleMs(byteLength) {
  const floor = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_FLOOR_MS",
    SETTLE_FLOOR_MS_DEFAULT,
  );
  const perKb = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_PER_KB_MS",
    SETTLE_PER_KB_MS_DEFAULT,
  );
  const ceiling = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_CEILING_MS",
    SETTLE_CEILING_MS_DEFAULT,
  );
  const kib = byteLength <= 0 ? 0 : Math.ceil(byteLength / BYTES_PER_KIB);
  return Math.max(0, Math.min(ceiling, floor + kib * perKb));
}

/**
 * Canonical key table. Every entry must be representable in BOTH tmux
 * `send-keys` and iTerm raw bytes — that's the cross-transport contract.
 *
 * @type {Record<string, { tmux: string, bytes: string }>}
 */
export const KEY_TABLE = {
  ENTER:  { tmux: "Enter",    bytes: "\r" },
  ESC:    { tmux: "Escape",   bytes: ESC },
  TAB:    { tmux: "Tab",      bytes: "\t" },
  BTAB:   { tmux: "BTab",     bytes: `${ESC}[Z` },
  SPACE:  { tmux: "Space",    bytes: " " },
  BSPACE: { tmux: "BSpace",   bytes: "\x7f" },
  UP:     { tmux: "Up",       bytes: `${ESC}[A` },
  DOWN:   { tmux: "Down",     bytes: `${ESC}[B` },
  RIGHT:  { tmux: "Right",    bytes: `${ESC}[C` },
  LEFT:   { tmux: "Left",     bytes: `${ESC}[D` },
  HOME:   { tmux: "Home",     bytes: `${ESC}OH` },
  END:    { tmux: "End",      bytes: `${ESC}OF` },
  PGUP:   { tmux: "PageUp",   bytes: `${ESC}[5~` },
  PGDN:   { tmux: "PageDown", bytes: `${ESC}[6~` },
  INS:    { tmux: "IC",       bytes: `${ESC}[2~` },
  DEL:    { tmux: "DC",       bytes: `${ESC}[3~` },
  F1:     { tmux: "F1",       bytes: `${ESC}OP` },
  F2:     { tmux: "F2",       bytes: `${ESC}OQ` },
  F3:     { tmux: "F3",       bytes: `${ESC}OR` },
  F4:     { tmux: "F4",       bytes: `${ESC}OS` },
  F5:     { tmux: "F5",       bytes: `${ESC}[15~` },
  F6:     { tmux: "F6",       bytes: `${ESC}[17~` },
  F7:     { tmux: "F7",       bytes: `${ESC}[18~` },
  F8:     { tmux: "F8",       bytes: `${ESC}[19~` },
  F9:     { tmux: "F9",       bytes: `${ESC}[20~` },
  F10:    { tmux: "F10",      bytes: `${ESC}[21~` },
  F11:    { tmux: "F11",      bytes: `${ESC}[23~` },
  F12:    { tmux: "F12",      bytes: `${ESC}[24~` },
};

const NAMED_KEYS = new Set(Object.keys(KEY_TABLE));
const CHORD_MODIFIERS = new Set(["C", "S", "M"]);
const CHORD_MOD_ORDER = new Map([
  ["C", 0],
  ["S", 1],
  ["M", 2],
]);
const BODY_REFERENCE_NAMES = new Set(["write", "content", "command", "stdin"]);

// Variables substituted before key/text classification. Stored as a frozen
// lookup so the parser can't accidentally mutate the caller's vars object.
const BODY_VAR_ALIASES = new Set(["write", "content", "command"]);

/**
 * Build the substitution table from caller-provided context. Aliases that
 * resolve to the same body value are reified as the same string.
 *
 * @param {object} vars
 * @param {string} [vars.write]
 * @param {string} [vars.stdin]
 * @param {string} [vars.target]
 * @param {string} [vars.self]
 * @param {string} [vars.now]
 * @param {NodeJS.ProcessEnv} [vars.env]
 * @returns {Map<string, string>}
 */
function buildVarTable(vars) {
  const table = new Map();
  if (typeof vars?.write === "string") {
    for (const alias of BODY_VAR_ALIASES) table.set(alias, vars.write);
  }
  if (typeof vars?.stdin === "string") table.set("stdin", vars.stdin);
  if (typeof vars?.target === "string") table.set("target", vars.target);
  if (typeof vars?.self === "string") table.set("self", vars.self);
  if (typeof vars?.now === "string") table.set("now", vars.now);
  table.set(
    "__env__",
    vars?.env && typeof vars.env === "object" ? vars.env : {},
  );
  return table;
}

/**
 * Resolve a $name or ${env:NAME} reference. Throws on unknowns rather than
 * returning empty — silent empties are a footgun.
 *
 * @param {string} name
 * @param {Map<string, string>} vars
 * @returns {string}
 */
function resolveVariable(name, vars) {
  if (name.startsWith("env:")) {
    const envName = name.slice(4);
    const env = vars.get("__env__") || {};
    if (!Object.hasOwn(env, envName)) {
      throw new Error(`undefined env var: ${envName}`);
    }
    return String(env[envName]);
  }
  if (!vars.has(name)) {
    throw new Error(`undefined command variable: $${name}`);
  }
  return vars.get(name);
}

/**
 * Lexical split of a sequence string on top-level `|`, respecting quoted
 * string literals so the user can write `"foo|bar"` as a single literal.
 *
 * @param {string} spec
 * @returns {string[]}
 */
function splitSteps(spec) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < spec.length) {
        buf += spec[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (quote) throw new Error("unterminated quoted literal in --command");
  out.push(buf);
  return out;
}

/**
 * Strip surrounding quote pair from a literal token if present. Only the
 * escape pairs `\\`, `\'`, and `\"` are unescaped; any other `\x` pair is
 * passed through verbatim so literals like "C:\new" or "\n" keep their
 * backslashes.
 *
 * @param {string} token
 * @returns {string|null} unwrapped literal text, or null if not quoted
 */
function unwrapQuotedLiteral(token) {
  const t = token.trim();
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) return null;
  const inner = t.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "\\" || next === "'" || next === '"') {
        out += next;
        i++;
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

const REPEAT_RE = /^(.*)\*(\d+)$/;
const SLEEP_RE = /^SLEEP\((\d+)\)$/;
const VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_:.-]*)$|^\$\{([A-Za-z_][A-Za-z0-9_:.-]*)\}$/;
const CHORD_RE = /^([CSMA](?:-[CSMA])*)-(.+)$/;
const SLASH_RE = /^\/.+/;

/**
 * Parse one DSL step into one or more ops. A repeat marker (`*N`) is unrolled
 * at parse time so the op list is flat.
 *
 * @param {string} raw
 * @param {Map<string, string>} vars
 */
function parseStep(raw, vars) {
  const token = raw.trim();
  if (!token) throw new Error("empty step in --command");

  const repeatMatch = REPEAT_RE.exec(token);
  if (repeatMatch) {
    const inner = repeatMatch[1].trim();
    const count = Number(repeatMatch[2]);
    if (!Number.isSafeInteger(count) || count <= 0 || count > 1000) {
      throw new Error(`repeat count out of range: ${token}`);
    }
    const innerOps = parseStep(inner, vars);
    const out = [];
    for (let i = 0; i < count; i++) out.push(...innerOps);
    return out;
  }

  const sleepMatch = SLEEP_RE.exec(token);
  if (sleepMatch) {
    const ms = Number(sleepMatch[1]);
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 60_000) {
      throw new Error(`sleep duration out of range: ${token}`);
    }
    return [{ kind: "sleep", ms }];
  }

  const varMatch = VAR_RE.exec(token);
  if (varMatch) {
    const name = varMatch[1] || varMatch[2];
    const text = resolveVariable(name, vars);
    if (text === "") return [];
    return [{ kind: "paste", text }];
  }

  const literal = unwrapQuotedLiteral(token);
  if (literal !== null) {
    if (literal === "") return [];
    return [{ kind: "type", text: literal }];
  }

  if (NAMED_KEYS.has(token)) {
    return [{ kind: "key", key: token }];
  }

  const chordMatch = CHORD_RE.exec(token);
  if (chordMatch) {
    const mods = chordMatch[1].split("-");
    const tail = chordMatch[2];
    return [parseChord(mods, tail, token)];
  }

  if (SLASH_RE.test(token)) {
    return [{ kind: "type", text: token }];
  }

  throw new Error(`unknown command step: ${JSON.stringify(token)}`);
}

/**
 * Normalize a chord into { mods, key }. Validates modifiers and key.
 *
 * @param {string[]} rawMods
 * @param {string} tail
 * @param {string} originalToken
 * @returns {{kind:'chord', mods:string[], key:string}}
 */
function parseChord(rawMods, tail, originalToken) {
  const mods = [];
  const seen = new Set();
  for (const m of rawMods) {
    const norm = m === "A" ? "M" : m;
    if (!CHORD_MODIFIERS.has(norm)) {
      throw new Error(`unknown modifier in chord: ${originalToken}`);
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    mods.push(norm);
  }
  if (mods.length === 0) {
    throw new Error(`chord missing modifier: ${originalToken}`);
  }
  let key;
  const tailUpper = tail.toUpperCase();
  if (NAMED_KEYS.has(tailUpper)) {
    key = tailUpper;
  } else if (tail.length === 1) {
    key = tail;
  } else {
    throw new Error(`unknown chord tail: ${originalToken}`);
  }
  // Canonical mod order: C, S, M
  mods.sort(compareChordModifiers);
  return { kind: "chord", mods, key };
}

function compareChordModifiers(a, b) {
  return CHORD_MOD_ORDER.get(a) - CHORD_MOD_ORDER.get(b);
}

/**
 * Parse a full sequence string into an op list, given substitution context.
 *
 * @param {string} spec
 * @param {object} [vars]
 * @returns {Array<{kind:string, [k:string]: any}>}
 */
export function parseCommandDsl(spec, vars = {}) {
  if (typeof spec !== "string") {
    throw new Error("--command must be a string");
  }
  const trimmed = spec.trim();
  if (trimmed === "") {
    throw new Error("--command must not be empty");
  }
  const varTable = buildVarTable(vars);
  const steps = splitSteps(trimmed)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (steps.length === 0) {
    throw new Error("--command must not be empty");
  }
  const ops = [];
  for (const step of steps) {
    ops.push(...parseStep(step, varTable));
  }
  return ops;
}

/**
 * Compile a sequence into the final op list a transport runner will execute.
 *
 * Implicit ops inserted here:
 *   - sleep(computeSettleMs(byteLen)) after every paste op
 *   - leading paste of $write when --write is supplied AND the parsed
 *     sequence does not already reference any body variable
 *   - trailing ENTER when the final op is paste and `submit !== false`
 *
 * @param {string} spec
 * @param {object} opts
 * @param {object} [opts.vars]
 * @param {boolean} [opts.submit=true]
 * @param {string} [opts.backend=""]
 * @returns {{ ops: Array<{kind:string, [k:string]: any}>, summary: { pastes:number, types:number, keys:number, sleeps:number } }}
 */
export function compileSequence(
  spec,
  { vars = {}, submit = true, backend = "" } = {},
) {
  const varTable = buildVarTable(vars);
  const parsed = parseCommandDsl(spec, vars);

  const usesBody = referencesBodyVariable(spec);
  const hasWriteBody = typeof vars.write === "string" && vars.write.length > 0;
  const ops = [];

  if (hasWriteBody && !usesBody) {
    ops.push({ kind: "paste", text: vars.write });
  }
  ops.push(...parsed);

  // Insert settle sleeps after each paste op so the next op doesn't race the
  // bracketed-paste commit.
  const withSettle = [];
  for (const op of ops) {
    withSettle.push(op);
    if (op.kind === "paste") {
      const byteLen = Buffer.byteLength(op.text, "utf8");
      withSettle.push({ kind: "sleep", ms: computeSettleMs(byteLen) });
    }
  }

  // Trailing auto-submit: if the user did not end on an Enter and we still
  // have a paste sitting at the tail (post-settle), append Enter so the body
  // commits. Matches the existing cmdRaw default. Suppressed by submit=false.
  if (submit && shouldAppendSubmit(withSettle)) {
    withSettle.push(...submitOpsForBackend(backend));
  }

  if (withSettle.length === 0) {
    throw new Error("command sequence compiled to zero ops");
  }

  // Use the un-mutated reference so callers can audit which vars resolved.
  void varTable;

  return {
    ops: withSettle,
    summary: summarize(withSettle),
  };
}

function shouldAppendSubmit(ops) {
  if (ops.length === 0) return false;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === "sleep") continue;
    if (op.kind === "paste" || op.kind === "type") return true;
    return false;
  }
  return false;
}

/**
 * Map backend submit keys (tmux spellings) to runner ops.
 *
 * @param {string} backend
 * @returns {Array<{kind:string,[k:string]:any}>}
 */
function submitOpsForBackend(backend) {
  const tmuxKeys = submitKeysForBackend(backend);
  const ops = [];
  for (const tmuxKey of tmuxKeys) {
    const chordMatch = /^([CSMA](?:-[CSMA])*)-(.+)$/.exec(tmuxKey);
    if (chordMatch) {
      const mods = [];
      for (const m of chordMatch[1].split("-")) {
        mods.push(m === "A" ? "M" : m);
      }
      mods.sort(compareChordModifiers);
      const tail = chordMatch[2];
      const tailUpper = tail.toUpperCase();
      const key = NAMED_KEYS.has(tailUpper) ? tailUpper : tail;
      ops.push({ kind: "chord", mods, key });
      continue;
    }
    const named = tmuxKey.toUpperCase();
    if (NAMED_KEYS.has(named)) {
      ops.push({ kind: "key", key: named });
    } else {
      ops.push({ kind: "type", text: tmuxKey });
    }
  }
  return ops;
}

function summarize(ops) {
  let pastes = 0;
  let types = 0;
  let keys = 0;
  let sleeps = 0;
  for (const op of ops) {
    if (op.kind === "paste") pastes++;
    else if (op.kind === "type") types++;
    else if (op.kind === "key" || op.kind === "chord") keys++;
    else if (op.kind === "sleep") sleeps++;
  }
  return { pastes, types, keys, sleeps };
}

/**
 * Determine if the raw spec mentions any body variable. Used to decide
 * whether to auto-prepend a $write paste step.
 *
 * @param {string} spec
 * @returns {boolean}
 */
function referencesBodyVariable(spec) {
  const steps = splitSteps(spec.trim())
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const step of steps) {
    // Repeat markers wrap any step (`$write*2`); strip them (possibly
    // nested) so the bare token classifies the same way parseStep sees it.
    // Otherwise `$write*2` fails VAR_RE, the body is auto-prepended AND
    // unrolled, and the message is delivered 3x.
    let bare = step;
    let repeatMatch;
    while ((repeatMatch = REPEAT_RE.exec(bare)) !== null) {
      bare = repeatMatch[1].trim();
    }
    // Quoted literals may contain "$write" as text — not a body reference.
    if (unwrapQuotedLiteral(bare) !== null) continue;
    const varMatch = VAR_RE.exec(bare);
    if (!varMatch) continue;
    const name = varMatch[1] || varMatch[2];
    if (BODY_REFERENCE_NAMES.has(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Map an op to the tmux send-keys tail. `paste` and `type` are handled by the
 * runner (load-buffer / send-keys -l), so this only emits keys.
 *
 * @param {{kind:string, [k:string]: any}} op
 * @returns {string[] | null} argv tail for tmux send-keys, or null if the op
 *   isn't a key-style op.
 */
export function compileOpToTmuxKeys(op) {
  if (op.kind === "key") {
    const entry = KEY_TABLE[op.key];
    if (!entry) throw new Error(`unknown key in compile: ${op.key}`);
    return [entry.tmux];
  }
  if (op.kind === "chord") {
    return [`${op.mods.join("-")}-${chordTailForTmux(op.key)}`];
  }
  return null;
}

/**
 * Map a single-character or named chord tail to tmux's name. Single chars
 * are passed through verbatim; named keys go via KEY_TABLE.
 *
 * @param {string} key
 * @returns {string}
 */
function chordTailForTmux(key) {
  const entry = KEY_TABLE[key];
  if (entry) return entry.tmux;
  return key;
}

/**
 * Map an op to raw bytes for the iTerm bridge. paste/type return their
 * literal text (the bridge wraps paste in `\x1b[200~ … \x1b[201~`).
 *
 * @param {{kind:string, [k:string]: any}} op
 * @returns {string|null}
 */
export function compileOpToBytes(op) {
  if (op.kind === "paste") return op.text;
  if (op.kind === "type") return op.text;
  if (op.kind === "key") {
    const entry = KEY_TABLE[op.key];
    if (!entry) throw new Error(`unknown key in compile: ${op.key}`);
    return entry.bytes;
  }
  if (op.kind === "chord") return chordBytes(op.mods, op.key);
  if (op.kind === "sleep") return null;
  throw new Error(`unknown op kind: ${op.kind}`);
}

/**
 * Compute the raw byte sequence for a chord. Ctrl applies the 0x1f mask to
 * ASCII letters and a handful of symbols. Meta/Alt prepends \x1b. Shift
 * uppercases an ASCII letter.
 *
 * @param {string[]} mods
 * @param {string} key
 * @returns {string}
 */
export function chordBytes(mods, key) {
  let target = key;
  let bytes;
  let hasCtrl = false;
  let hasShift = false;
  let hasMeta = false;
  for (const mod of mods) {
    if (mod === "C") hasCtrl = true;
    else if (mod === "S") hasShift = true;
    else if (mod === "M") hasMeta = true;
  }
  const named = KEY_TABLE[target];
  if (named) {
    if (hasCtrl && target === "ENTER") {
      bytes = `${ESC}\r`;
    } else {
      bytes =
        hasShift && target === "TAB"
          ? KEY_TABLE.BTAB.bytes
          : named.bytes;
    }
  } else if (target.length === 1) {
    if (hasShift) target = target.toUpperCase();
    if (hasCtrl) {
      const code = target.charCodeAt(0);
      const masked = code & 0x1f;
      bytes = String.fromCharCode(masked);
    } else {
      bytes = target;
    }
  } else {
    throw new Error(`unknown chord tail: ${key}`);
  }
  if (hasMeta) bytes = ESC + bytes;
  return bytes;
}
