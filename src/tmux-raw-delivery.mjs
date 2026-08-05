// File: tmux-raw-delivery.mjs
import { spawnSync } from "node:child_process";
import { submitKeysForBackend } from "./backend-delivery.mjs";
import { pasteLooksUnsubmitted } from "./tmux-paste-verifier.mjs";
const TMUX_EXECUTABLE = "tmux";
const BUFFER_RANDOM_MASK = 0xffff;
const DEFAULT_SETTLE_FLOOR_MS = 300;
const DEFAULT_SETTLE_PER_KB_MS = 8;
const DEFAULT_SETTLE_CEILING_MS = 1500;
const DEFAULT_VERIFY_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_ENTER_RETRIES = 5;
const VERIFY_BACKOFF_MULTIPLIER = 1.5;
const BYTES_PER_KIB = 1024;
/**
 * Parses a non-negative integer environment value.
 *
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Fallback value when the env value is missing or invalid.
 * @returns {number} Parsed integer or fallback.
 * @example
 *   parseNonNegativeIntegerEnv("A2A_RAW_PASTE_SETTLE_FLOOR_MS", 300);
 */
function parseNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}
/**
 * Sleeps synchronously using the platform sleep command.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @returns {void}
 * @example
 *   sleepSync(250);
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Computes a bounded settle delay based on pasted content size.
 *
 * @param {number} byteLength - UTF-8 byte length of the pasted content.
 * @returns {number} Delay in milliseconds.
 * @example
 *   computeSettleMs(2048);
 */
function computeSettleMs(byteLength) {
  const floor = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_FLOOR_MS",
    DEFAULT_SETTLE_FLOOR_MS,
  );
  const perKb = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_PER_KB_MS",
    DEFAULT_SETTLE_PER_KB_MS,
  );
  const ceiling = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_SETTLE_CEILING_MS",
    DEFAULT_SETTLE_CEILING_MS,
  );
  const kib = byteLength <= 0 ? 0 : Math.ceil(byteLength / BYTES_PER_KIB);
  return Math.max(0, Math.min(ceiling, floor + kib * perKb));
}
/**
 * tmux's `-t name` resolves by prefix match, so a dead `alice` silently hits
 * a live `alice-worker`. Prefixing the session with `=` forces exact match.
 * Targets already using exact (`=`) or id forms (`$session`, `@window`,
 * `%pane`) pass through untouched.
 *
 * @param {string} target - Session name or pane spec, e.g. "bob" or "bob:0.0".
 * @returns {string} Exact-match target, e.g. "=bob:0.0".
 * @example
 *   exactTmuxTarget("bob:0.0"); // "=bob:0.0"
 */
export function exactTmuxTarget(target) {
  const t = String(target);
  if (/^[=$@%]/.test(t)) return t;
  return `=${t}`;
}
/**
 * Probes whether a pasted body still sits unsubmitted in the receiving pane.
 * Tri-state on purpose: a capture failure must not be reported as "submitted".
 *
 * Unsubmitted means either the bracketed-paste placeholder is visible (large
 * pastes) or the prompt line still shows the pasted content inline (small
 * pastes, which never get a placeholder).
 *
 * @param {string} target - Tmux target pane.
 * @param {string} content - The pasted content being verified.
 * @returns {boolean|null} true=still unsubmitted, false=submitted/clear,
 *   null=unknown (pane could not be captured).
 * @example
 *   rawPasteLooksUnsubmitted("bob:0.0", "hello");
 */
export function rawPasteLooksUnsubmitted(target, content) {
  const r = spawnSync(TMUX_EXECUTABLE, [
    "capture-pane",
    "-t",
    exactTmuxTarget(target),
    "-p",
    "-S",
    "-10",
  ]);
  if (r.status !== 0) return null;
  return pasteLooksUnsubmitted((r.stdout || "").toString(), content);
}
/**
 * Delivers raw text into a tmux pane and optionally submits it.
 *
 * This is intentionally not an a2a envelope. It pastes exactly the user's raw
 * input into the backend CLI pane, so backend-native slash commands, @file
 * commands, model commands, and ordinary prompts behave as if typed directly.
 *
 * @param {object} opts - Delivery options.
 * @param {string} opts.target - Tmux target pane, e.g. "bob:0.0".
 * @param {string} opts.content - Raw text to paste.
 * @param {string=} opts.backend - Backend id used for submit-key selection.
 * @param {boolean=} opts.submit - Whether to press the backend submit key after paste.
 * @param {boolean=} opts.verify - Whether to verify bracketed-paste submission.
 * @returns {{ ok: boolean; bytes?: number; error?: string; warning?: string }}
 * @example
 *   deliverRawTmuxInput({ target: "bob:0.0", content: "/clear", backend: "claude" });
 */
export function deliverRawTmuxInput({
  target,
  content,
  backend = "",
  submit = true,
  verify = process.env.A2A_RAW_PASTE_VERIFY !== "0" &&
    process.env.A2A_PASTE_VERIFY !== "0",
} = {}) {
  if (typeof target !== "string" || target.trim() === "") {
    return { ok: false, error: "target must be a non-empty tmux target" };
  }
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "content must be a non-empty string" };
  }
  const bufferName = `a2a-raw-${process.pid}-${Date.now()}-${Math.floor(
    Math.random() * BUFFER_RANDOM_MASK,
  ).toString(16)}`;
  const load = spawnSync(TMUX_EXECUTABLE, ["load-buffer", "-b", bufferName, "-"], {
    input: content,
  });
  if (load.status !== 0) {
    return {
      ok: false,
      error: `tmux load-buffer failed: ${load.stderr?.toString().trim() || "unknown"}`,
    };
  }
  const paste = spawnSync(TMUX_EXECUTABLE, [
    "paste-buffer",
    "-p",
    "-d",
    "-b",
    bufferName,
    "-t",
    exactTmuxTarget(target),
  ]);
  if (paste.status !== 0) {
    spawnSync(TMUX_EXECUTABLE, ["delete-buffer", "-b", bufferName]);
    return {
      ok: false,
      error: `tmux paste-buffer failed: ${paste.stderr?.toString().trim() || "unknown"}`,
    };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (!submit) return { ok: true, bytes };
  sleepSync(computeSettleMs(bytes));
  const submitKeys = submitKeysForBackend(backend);
  const maxRetries = Math.max(
    1,
    parseNonNegativeIntegerEnv(
      "A2A_RAW_PASTE_MAX_ENTER_RETRIES",
      DEFAULT_MAX_ENTER_RETRIES,
    ),
  );
  const retryDelay = parseNonNegativeIntegerEnv(
    "A2A_RAW_PASTE_VERIFY_RETRY_DELAY_MS",
    DEFAULT_VERIFY_RETRY_DELAY_MS,
  );
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const enter = spawnSync(TMUX_EXECUTABLE, [
      "send-keys",
      "-t",
      exactTmuxTarget(target),
      ...submitKeys,
    ]);
    if (enter.status !== 0) {
      return {
        ok: false,
        error: `tmux send-keys failed: ${enter.stderr?.toString().trim() || "unknown"}`,
      };
    }
    if (!verify) return { ok: true, bytes };
    const delay = Math.floor(retryDelay * VERIFY_BACKOFF_MULTIPLIER ** attempt);
    sleepSync(delay);
    const unsubmitted = rawPasteLooksUnsubmitted(target, content);
    if (unsubmitted === null) {
      return {
        ok: true,
        bytes,
        warning: "tmux paste verify could not read pane; submit uncertain",
      };
    }
    if (unsubmitted === false) {
      return { ok: true, bytes };
    }
  }
  return {
    ok: true,
    bytes,
    warning: "tmux paste submit could not be verified; leaving input in pane",
  };
}
