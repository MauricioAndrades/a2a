// Regression tests for iterm2-delivery against a fake bridge served on a
// real unix socket. The fake bridge is the external nondeterminism boundary
// — everything asserted is an observable outcome: the result object returned
// to the caller and the byte-level requests the bridge actually received.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  deliverITerm2Input,
  deliverITerm2Sequence,
  rpcTimeoutForSteps,
} from "../src/iterm2-delivery.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts a fake bridge on a fresh unix socket. `handler(request, requests)`
 * returns the JSON response (optionally after a delay) — return a falsy
 * value to never respond (simulates a hung bridge).
 */
function startFakeBridge(handler) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-fake-bridge-"));
  const socketPath = join(dir, "bridge.sock");
  const requests = [];
  const server = createServer((sock) => {
    let buf = "";
    // The client destroys its socket on rpc timeout; late writes then emit
    // async errors that must not crash the test process.
    sock.on("error", () => undefined);
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const request = JSON.parse(line);
      const entry = { request, receivedAt: Date.now(), respondedAt: null };
      requests.push(entry);
      Promise.resolve(handler(request, requests)).then((response) => {
        if (!response) return;
        entry.respondedAt = Date.now();
        try {
          sock.write(`${JSON.stringify(response)}\n`);
        } catch {
          /* connection already torn down by the client */
        }
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      });
    });
  });
}

const cleanups = [];
afterEach(async () => {
  delete process.env.A2A_ITERM2_RPC_TIMEOUT_MS;
  while (cleanups.length > 0) await cleanups.pop()();
});

function sendKeysRequests(requests) {
  return requests.filter((r) => r.request.op === "send_keys");
}

describe("rpc timeout scales with bridge-side steps", () => {
  test("rpcTimeoutForSteps budgets base + sleep-step ms + per-step allowance", () => {
    const steps = [
      { type: "sleep", ms: 60_000 },
      { type: "key", key: "ENTER" },
    ];
    // base (>=5000 by default) + 60s of bridge-side sleep + step budget.
    expect(rpcTimeoutForSteps(steps)).toBeGreaterThanOrEqual(65_000);
    expect(rpcTimeoutForSteps([])).toBeGreaterThanOrEqual(5000);
  });

  test("deliverITerm2Sequence: sleep steps extend the timeout past the base", async () => {
    process.env.A2A_ITERM2_RPC_TIMEOUT_MS = "150";
    const bridge = await startFakeBridge(async () => {
      // Bridge executes all steps before replying — longer than the base.
      await wait(600);
      return { ok: true, bytes: 3 };
    });
    cleanups.push(bridge.close);

    // Control: with no sleep steps the shrunken base applies and times out.
    const control = await deliverITerm2Sequence({
      target: "guid-1",
      steps: [{ type: "key", key: "ENTER" }],
      socketPath: bridge.socketPath,
    });
    expect(control.ok).toBe(false);
    expect(control.error).toMatch(/timeout/);

    // With a 1s bridge-side sleep step the timeout must cover the wait.
    const result = await deliverITerm2Sequence({
      target: "guid-1",
      steps: [
        { type: "sleep", ms: 1000 },
        { type: "key", key: "ENTER" },
      ],
      socketPath: bridge.socketPath,
    });
    expect(result).toEqual({ ok: true, bytes: 3 });
  });

  test("deliverITerm2Input: the settle sleep is bridge-side and extends the timeout", async () => {
    process.env.A2A_ITERM2_RPC_TIMEOUT_MS = "150";
    const bridge = await startFakeBridge(async () => {
      await wait(600);
      return { ok: true, bytes: 5 };
    });
    cleanups.push(bridge.close);

    // Control: submit=false sends only the paste step — base timeout applies.
    const control = await deliverITerm2Input({
      target: "guid-1",
      content: "hello",
      submit: false,
      verify: false,
      socketPath: bridge.socketPath,
    });
    expect(control.ok).toBe(false);
    expect(control.error).toMatch(/timeout/);

    // submit=true adds the settle sleep step (>=300ms default floor) which
    // must be budgeted into the rpc timeout.
    const result = await deliverITerm2Input({
      target: "guid-1",
      content: "hello",
      submit: true,
      verify: false,
      socketPath: bridge.socketPath,
    });
    expect(result).toEqual({ ok: true, bytes: 5 });
  });
});

describe("submit verification", () => {
  const CONTENT = "ping from tests";

  test("waits for a post-ENTER frame before reading the screen", async () => {
    const bridge = await startFakeBridge((request) => {
      if (request.op === "send_keys") return { ok: true, bytes: 1 };
      return { ok: true, lines: ["", "─────", ""] };
    });
    cleanups.push(bridge.close);

    const result = await deliverITerm2Input({
      target: "guid-1",
      content: CONTENT,
      submit: true,
      verify: true,
      socketPath: bridge.socketPath,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();

    const sendKeys = sendKeysRequests(bridge.requests);
    const screens = bridge.requests.filter((r) => r.request.op === "screen");
    expect(screens.length).toBeGreaterThanOrEqual(1);
    // The first screen read must happen AFTER a backoff following the ENTER
    // reply — reading immediately checks a stale frame and double-submits.
    const gap = screens[0].receivedAt - sendKeys[0].respondedAt;
    expect(gap).toBeGreaterThanOrEqual(120);
  });

  test("the recipient's own half-typed prompt does not trigger a stray ENTER", async () => {
    const bridge = await startFakeBridge((request) => {
      if (request.op === "send_keys") return { ok: true, bytes: 1 };
      // A non-empty prompt line that is NOT our pasted content.
      return { ok: true, lines: ["> drafting my own reply here"] };
    });
    cleanups.push(bridge.close);

    const result = await deliverITerm2Input({
      target: "guid-1",
      content: CONTENT,
      submit: true,
      verify: true,
      socketPath: bridge.socketPath,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    // Exactly one send_keys: the original delivery. No resubmit ENTERs that
    // would submit the recipient's half-typed prompt.
    expect(sendKeysRequests(bridge.requests)).toHaveLength(1);
  });

  test("a paste genuinely stuck in the input is resubmitted until it clears", async () => {
    const bridge = await startFakeBridge((request, requests) => {
      if (request.op === "send_keys") return { ok: true, bytes: 1 };
      const enters = sendKeysRequests(requests).length;
      // Our own content sits on the prompt line until the second ENTER.
      if (enters < 2) return { ok: true, lines: [`> ${CONTENT}`] };
      return { ok: true, lines: [""] };
    });
    cleanups.push(bridge.close);

    const result = await deliverITerm2Input({
      target: "guid-1",
      content: CONTENT,
      submit: true,
      verify: true,
      socketPath: bridge.socketPath,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(sendKeysRequests(bridge.requests)).toHaveLength(2);
  });

  test("a failed resubmit rpc surfaces a warning instead of being ignored", async () => {
    const bridge = await startFakeBridge((request, requests) => {
      if (request.op === "send_keys") {
        const enters = sendKeysRequests(requests).length;
        if (enters > 1) return { ok: false, error: "boom" };
        return { ok: true, bytes: 1 };
      }
      return { ok: true, lines: [`> ${CONTENT}`] };
    });
    cleanups.push(bridge.close);

    const result = await deliverITerm2Input({
      target: "guid-1",
      content: CONTENT,
      submit: true,
      verify: true,
      socketPath: bridge.socketPath,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/resubmit ENTER failed: boom/);
  });

  test("an unreadable screen yields a warning, not a silent success claim", async () => {
    const bridge = await startFakeBridge((request) => {
      if (request.op === "send_keys") return { ok: true, bytes: 1 };
      return { ok: false, error: "no such session" };
    });
    cleanups.push(bridge.close);

    const result = await deliverITerm2Input({
      target: "guid-1",
      content: CONTENT,
      submit: true,
      verify: true,
      socketPath: bridge.socketPath,
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/could not read screen/);
  });
});
