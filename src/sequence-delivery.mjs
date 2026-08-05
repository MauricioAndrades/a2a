// File: sequence-delivery.mjs
// Executes a compiled key-sequence op list. Picks the transport per-recipient
// (transparent fall-through between tmux and iTerm) using selectTransportForAgent.
//
// Op shape: see src/key-sequence.mjs
//   { kind: 'paste'|'type'|'key'|'chord'|'sleep', ... }

import { spawnSync } from "node:child_process";
import { selectTransportForAgent } from "./transport-router.mjs";
import { deliverITerm2Sequence } from "./iterm2-delivery.mjs";
import { compileOpToTmuxKeys } from "./key-sequence.mjs";
import { exactTmuxTarget } from "./tmux-raw-delivery.mjs";

const TMUX_EXECUTABLE = "tmux";
const BUFFER_RANDOM_MASK = 0xffff;

/**
 * Sleep helper for async runners.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Deliver a compiled op list, choosing transport per recipient.
 *
 * @param {object} opts
 * @param {string} opts.agentName
 * @param {string} [opts.tmuxTarget]
 * @param {string} [opts.itermGuid]
 * @param {object} [opts.agent]      Full registry entry (preferred input).
 * @param {Array<{kind:string,[k:string]:any}>} opts.ops
 * @param {string} [opts.backend]
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string, warning?:string, transport:"tmux"|"iterm"|"none"}>}
 */
export async function deliverSequenceViaActiveProtocol(opts) {
  const agentInput = opts.agent || {
    agentId: opts.agentName,
    tmuxTarget: opts.tmuxTarget,
    itermGuid: opts.itermGuid,
    backend: opts.backend,
  };
  const { transport, reason, itermGuid } = await selectTransportForAgent(
    agentInput,
  );
  if (transport === null) {
    // No transport was attempted — reporting the *preference* here produced
    // misleading "via tmux failed" messages. "none" renders truthfully.
    return { ok: false, transport: "none", error: reason };
  }
  if (transport === "iterm") {
    return await deliverIterm({ ...opts, itermGuid });
  }
  return await deliverTmux(opts);
}

/**
 * tmux runner. Walks ops sequentially. Pastes use load-buffer/paste-buffer
 * with bracketed mode so the receiving TUI sees a paste, not typed input.
 * `type` uses send-keys -l so backend slash commands fire. Keys/chords use
 * tmux key names.
 *
 * @param {object} opts
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string, warning?:string, transport:"tmux"}>}
 */
async function deliverTmux({ agentName, tmuxTarget, ops, backend = "" }) {
  void backend;
  const target = tmuxTarget || `${agentName}:0.0`;
  let totalBytes = 0;
  for (const batch of buildTmuxOperationBatches(ops)) {
    const r = await runTmuxBatch(target, batch);
    if (!r.ok) return { ...r, transport: "tmux" };
    totalBytes += r.bytes || 0;
  }
  return { ok: true, bytes: totalBytes, transport: "tmux" };
}

/**
 * Build tmux execution batches without changing observable order. Paste ops
 * stay isolated because tmux bracketed-paste requires load/paste-buffer.
 * Adjacent literal type ops can be concatenated, and adjacent key/chord ops
 * can share one send-keys invocation.
 *
 * @param {Array<{kind:string,[k:string]:any}>} ops
 * @returns {Array<{kind:"sleep",ms:number}|{kind:"paste",text:string}|{kind:"type",text:string}|{kind:"keys",keys:string[],bytes:number}>}
 */
export function buildTmuxOperationBatches(ops) {
  const batches = [];
  let typeText = "";
  let keyArgs = [];
  let keyBytes = 0;

  const flushType = () => {
    if (!typeText) return;
    batches.push({ kind: "type", text: typeText });
    typeText = "";
  };
  const flushKeys = () => {
    if (keyArgs.length === 0) return;
    batches.push({ kind: "keys", keys: keyArgs, bytes: keyBytes });
    keyArgs = [];
    keyBytes = 0;
  };
  const flushAll = () => {
    flushType();
    flushKeys();
  };

  for (const op of Array.isArray(ops) ? ops : []) {
    if (op.kind === "sleep") {
      flushAll();
      batches.push({ kind: "sleep", ms: op.ms });
    } else if (op.kind === "paste") {
      flushAll();
      batches.push({ kind: "paste", text: op.text });
    } else if (op.kind === "type") {
      flushKeys();
      typeText += op.text;
    } else if (op.kind === "key" || op.kind === "chord") {
      flushType();
      const tail = compileOpToTmuxKeys(op);
      if (!tail) {
        batches.push({ kind: "invalid", error: `tmux compile produced empty tail for op ${op.kind}` });
        continue;
      }
      keyArgs.push(...tail);
      keyBytes += tail.join("").length;
    } else {
      flushAll();
      batches.push({ kind: "invalid", error: `unknown op kind: ${op.kind}` });
    }
  }
  flushAll();
  return batches;
}

/**
 * Execute one precomputed batch against a tmux pane.
 *
 * @param {string} target
 * @param {{kind:string,[k:string]:any}} batch
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string}>}
 */
async function runTmuxBatch(target, batch) {
  if (batch.kind === "sleep") {
    await sleep(batch.ms);
    return { ok: true, bytes: 0 };
  }
  if (batch.kind === "paste") {
    return tmuxPaste(target, batch.text);
  }
  if (batch.kind === "type") {
    return tmuxTypeLiteral(target, batch.text);
  }
  if (batch.kind === "keys") {
    return tmuxSendKeys(target, batch.keys, batch.bytes);
  }
  return { ok: false, error: batch.error || `unknown tmux batch kind: ${batch.kind}` };
}

function tmuxSendKeys(target, keys, bytes = 0) {
  const r = spawnSync(TMUX_EXECUTABLE, [
    "send-keys",
    "-t",
    exactTmuxTarget(target),
    ...keys,
  ]);
  if (r.status !== 0) {
    return {
      ok: false,
      error: `tmux send-keys failed: ${r.stderr?.toString().trim() || "unknown"}`,
    };
  }
  return { ok: true, bytes };
}

/**
 * Bracketed paste-buffer delivery for one body chunk.
 *
 * @param {string} target
 * @param {string} text
 * @returns {{ok:boolean, bytes?:number, error?:string}}
 */
function tmuxPaste(target, text) {
  const buf = `a2a-seq-${process.pid}-${Date.now()}-${Math.floor(Math.random() * BUFFER_RANDOM_MASK).toString(16)}`;
  const load = spawnSync(TMUX_EXECUTABLE, ["load-buffer", "-b", buf, "-"], {
    input: text,
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
    buf,
    "-t",
    exactTmuxTarget(target),
  ]);
  if (paste.status !== 0) {
    spawnSync(TMUX_EXECUTABLE, ["delete-buffer", "-b", buf]);
    return {
      ok: false,
      error: `tmux paste-buffer failed: ${paste.stderr?.toString().trim() || "unknown"}`,
    };
  }
  return { ok: true, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * Typed text delivery via send-keys -l (literal). Backend TUIs see real
 * keystrokes — required for slash-command handlers.
 *
 * @param {string} target
 * @param {string} text
 * @returns {{ok:boolean, bytes?:number, error?:string}}
 */
function tmuxTypeLiteral(target, text) {
  // `--` ends option parsing so text starting with "-" is not read as a flag.
  const r = spawnSync(TMUX_EXECUTABLE, [
    "send-keys",
    "-t",
    exactTmuxTarget(target),
    "-l",
    "--",
    text,
  ]);
  if (r.status !== 0) {
    return {
      ok: false,
      error: `tmux send-keys -l failed: ${r.stderr?.toString().trim() || "unknown"}`,
    };
  }
  return { ok: true, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * iTerm runner. Ships the entire op list in a single bridge round-trip via
 * the `send_keys` op so paste/type/key/chord/sleep execute in order inside
 * the bridge process.
 *
 * @param {object} opts
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string, warning?:string, transport:"iterm"}>}
 */
async function deliverIterm({ itermGuid, ops }) {
  if (!itermGuid) {
    return {
      ok: false,
      transport: "iterm",
      error: "itermGuid not provided and bridge name lookup failed",
    };
  }
  const steps = ops.map(opToBridgeStep);
  const r = await deliverITerm2Sequence({ target: itermGuid, steps });
  return { ...r, transport: "iterm" };
}

/**
 * Translate one runner op into the JSON shape the bridge expects.
 *
 * @param {{kind:string,[k:string]:any}} op
 * @returns {object}
 */
function opToBridgeStep(op) {
  if (op.kind === "paste") return { type: "paste", text: op.text };
  if (op.kind === "type") return { type: "type", text: op.text };
  if (op.kind === "key") return { type: "key", key: op.key };
  if (op.kind === "chord") return { type: "chord", mods: op.mods, key: op.key };
  if (op.kind === "sleep") return { type: "sleep", ms: op.ms };
  throw new Error(`unknown op kind: ${op.kind}`);
}
