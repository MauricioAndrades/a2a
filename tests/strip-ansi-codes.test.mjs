import { test } from "vitest";
import assert from "node:assert/strict";
import { stripAnsiCodes } from "../src/a2a-config.mjs";

// ─── plain passthrough ────────────────────────────────────────────────────

test("returns plain text unchanged", () => {
  assert.equal(stripAnsiCodes("hello world"), "hello world");
});

test("coerces non-string inputs via String()", () => {
  assert.equal(stripAnsiCodes(42), "42");
  assert.equal(stripAnsiCodes(null), "null");
  assert.equal(stripAnsiCodes(undefined), "undefined");
});

test("preserves embedded newlines and tabs", () => {
  assert.equal(stripAnsiCodes("a\nb\tc"), "a\nb\tc");
});

// ─── SGR (color) ──────────────────────────────────────────────────────────

test("strips a single SGR color sequence", () => {
  assert.equal(stripAnsiCodes("\x1b[31mred\x1b[0m"), "red");
});

test("strips SGR with multiple parameters", () => {
  assert.equal(
    stripAnsiCodes("\x1b[1;31;47mbold red on white\x1b[0m"),
    "bold red on white",
  );
});

test("strips SGR with no parameters (reset)", () => {
  assert.equal(stripAnsiCodes("a\x1b[mb"), "ab");
});

// ─── non-SGR CSI ──────────────────────────────────────────────────────────

test("strips cursor-position CSI (\\x1b[H)", () => {
  assert.equal(stripAnsiCodes("\x1b[Hhome"), "home");
});

test("strips erase-line CSI (\\x1b[2K)", () => {
  assert.equal(stripAnsiCodes("\x1b[2Kerased"), "erased");
});

test("strips DEC private mode CSI with '?' parameter (\\x1b[?25l hide cursor)", () => {
  assert.equal(stripAnsiCodes("\x1b[?25lhidden\x1b[?25h"), "hidden");
});

test("strips CSI with intermediate bytes (\\x1b[ q cursor shape)", () => {
  // ESC [ <space> q  — sets cursor style. Intermediate byte 0x20 is " ".
  assert.equal(stripAnsiCodes("before\x1b[ qafter"), "beforeafter");
});

// ─── OSC ──────────────────────────────────────────────────────────────────

test("strips OSC terminated by BEL (terminal-title set)", () => {
  // ESC ] 0 ; title BEL
  assert.equal(stripAnsiCodes("\x1b]0;my window title\x07visible"), "visible");
});

test("strips OSC terminated by ST (ESC \\)", () => {
  // ESC ] 2 ; title ESC \
  assert.equal(stripAnsiCodes("\x1b]2;another title\x1b\\visible"), "visible");
});

test("strips OSC 8 hyperlink (open + close)", () => {
  // OSC 8 ; params ; URI ST <label> OSC 8 ; ; ST
  const open = "\x1b]8;;https://example.com\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  assert.equal(stripAnsiCodes(`${open  }click me${  close}`), "click me");
});

test("unterminated OSC consumes the rest of the input safely", () => {
  // Defensive: a malformed OSC missing its terminator must not throw and
  // must not bleed escape bytes into downstream grep targets.
  assert.equal(
    stripAnsiCodes("good\x1b]0;runaway-title-no-terminator"),
    "good",
  );
});

// ─── single-char ESC ──────────────────────────────────────────────────────

test("strips RIS reset (ESC c)", () => {
  assert.equal(stripAnsiCodes("\x1bcafter"), "after");
});

test("strips save-cursor (ESC 7) and restore-cursor (ESC 8)", () => {
  assert.equal(stripAnsiCodes("a\x1b7b\x1b8c"), "abc");
});

test("strips charset-switch (ESC ( B for ASCII)", () => {
  assert.equal(stripAnsiCodes("x\x1b(By"), "xy");
});

// ─── pathological / boundary ──────────────────────────────────────────────

test("trailing lone ESC byte is dropped", () => {
  assert.equal(stripAnsiCodes("text\x1b"), "text");
});

test("ESC followed by unknown low byte drops only the ESC", () => {
  // 0x05 is below 0x40 so it's not a recognized single-char terminator.
  assert.equal(stripAnsiCodes("a\x1b\x05b"), "a\x05b");
});

test("empty string round-trips empty", () => {
  assert.equal(stripAnsiCodes(""), "");
});

test("real-world cursor-agent banner with mixed CSI + OSC strips cleanly", () => {
  // Simulates the kind of output the chatter log was leaking when SGR-only.
  const banner =
    "\x1b]0;cursor-agent\x07" + // window title
    "\x1b[2J" + // erase screen
    "\x1b[H" + // cursor home
    "\x1b[1;36m> \x1b[0m" + // bold cyan prompt
    "ready";
  assert.equal(stripAnsiCodes(banner), "> ready");
});
