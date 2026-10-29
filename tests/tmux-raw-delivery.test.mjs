// Regression tests for tmux-raw-delivery against real tmux sessions.
// Sessions are uniquely named per test process and killed afterwards.
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  deliverRawTmuxInput,
  exactTmuxTarget,
  rawPasteLooksUnsubmitted,
} from "../src/tmux-raw-delivery.mjs";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const BASE = `a2a-rawtest-${process.pid}`;
const created = [];

function newSession(name, command) {
  const r = spawnSync("tmux", ["new-session", "-d", "-s", name, command]);
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr?.toString()}`);
  }
  created.push(name);
}

function capturePane(name) {
  const r = spawnSync("tmux", [
    "capture-pane",
    "-t",
    `=${name}:0.0`,
    "-p",
    "-S",
    "-30",
  ]);
  return (r.stdout || "").toString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterAll(() => {
  for (const name of created) {
    spawnSync("tmux", ["kill-session", "-t", `=${name}`]);
  }
});

describe("exactTmuxTarget", () => {
  test("prefixes plain session targets with = for exact matching", () => {
    expect(exactTmuxTarget("bob:0.0")).toBe("=bob:0.0");
    expect(exactTmuxTarget("bob")).toBe("=bob");
  });

  test("passes exact and id-form targets through untouched", () => {
    expect(exactTmuxTarget("=bob:0.0")).toBe("=bob:0.0");
    expect(exactTmuxTarget("$3")).toBe("$3");
    expect(exactTmuxTarget("%7")).toBe("%7");
    expect(exactTmuxTarget("@2")).toBe("@2");
  });
});

describe.skipIf(!hasTmux)("deliverRawTmuxInput — real tmux", () => {
  test("a dead session name never prefix-matches into a live sibling", () => {
    newSession(`${BASE}-collide-worker`, "cat");
    const result = deliverRawTmuxInput({
      target: `${BASE}-collide:0.0`,
      content: "must not arrive",
      submit: true,
      verify: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/paste-buffer failed/);
    expect(capturePane(`${BASE}-collide-worker`)).not.toContain(
      "must not arrive",
    );
  });

  test("a small paste stuck on the prompt line is detected and surfaced as a warning", async () => {
    // The pane permanently renders `> stuck body` — to the verifier this is
    // our small paste sitting unsubmitted in the input (no placeholder ever
    // appears for small pastes).
    newSession(`${BASE}-stuck`, "printf '> stuck body\\n'; cat");
    await wait(300);
    process.env.A2A_RAW_PASTE_SETTLE_FLOOR_MS = "50";
    process.env.A2A_RAW_PASTE_MAX_ENTER_RETRIES = "2";
    process.env.A2A_RAW_PASTE_VERIFY_RETRY_DELAY_MS = "50";
    try {
      const result = deliverRawTmuxInput({
        target: `${BASE}-stuck:0.0`,
        content: "stuck body",
        submit: true,
        verify: true,
      });
      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/could not be verified/);
    } finally {
      delete process.env.A2A_RAW_PASTE_SETTLE_FLOOR_MS;
      delete process.env.A2A_RAW_PASTE_MAX_ENTER_RETRIES;
      delete process.env.A2A_RAW_PASTE_VERIFY_RETRY_DELAY_MS;
    }
  });

  test("delivers and submits into the exactly-named session", () => {
    newSession(`${BASE}-ok`, "cat");
    const result = deliverRawTmuxInput({
      target: `${BASE}-ok:0.0`,
      content: "hello raw delivery",
      submit: true,
      verify: true,
    });
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength("hello raw delivery", "utf8"));
    expect(capturePane(`${BASE}-ok`)).toContain("hello raw delivery");
  });
});

describe.skipIf(!hasTmux)("rawPasteLooksUnsubmitted — real tmux", () => {
  test("returns null (unknown) when the pane cannot be captured", () => {
    expect(rawPasteLooksUnsubmitted(`${BASE}-no-such:0.0`, "x")).toBeNull();
  });

  test("flags the paste placeholder as unsubmitted", async () => {
    newSession(
      `${BASE}-ph`,
      "printf '[Pasted text #4 +12 lines]\\n'; sleep 30",
    );
    await wait(300);
    expect(rawPasteLooksUnsubmitted(`${BASE}-ph:0.0`, "anything")).toBe(true);
  });

  test("flags a small paste sitting inline on the prompt line — but only our content", async () => {
    newSession(`${BASE}-prompt`, "printf '> hello world\\n'; sleep 30");
    await wait(300);
    // Our pasted content still visible on the prompt line: unsubmitted.
    expect(rawPasteLooksUnsubmitted(`${BASE}-prompt:0.0`, "hello world")).toBe(
      true,
    );
    // Someone else's prompt content must not read as our unsubmitted paste.
    expect(
      rawPasteLooksUnsubmitted(`${BASE}-prompt:0.0`, "totally different body"),
    ).toBe(false);
  });
});
