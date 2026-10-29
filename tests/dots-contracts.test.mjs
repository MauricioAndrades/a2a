import { describe, expect, test } from "vitest";
import { dotsConfig, agentId } from "../src/dots/config.mjs";
import { createInbox } from "../src/dots/inbox.mjs";
import { parseStartArgs } from "../src/cli/parse-start-args.mjs";

describe("Dot configuration and client contracts", () => {
  test("defaults use the separate callback listener", () => {
    expect(dotsConfig({})).toMatchObject({ port: 7743, callbackPort: 7744, callbackUrl: "http://127.0.0.1:7744", maxInbox: 1000 });
  });
  test.each(["", "0", "-1", "1.5", "2junk", "NaN", "9007199254740992"])("rejects malformed inbox cap %j", (value) => {
    expect(() => dotsConfig({ A2A_DOTS_MAX_INBOX: value })).toThrow();
  });
  test.each(["65536", "7743junk", "0", "-3"])("rejects invalid ports %j", (value) => {
    expect(() => dotsConfig({ A2A_DOTS_PORT: value })).toThrow();
    expect(() => dotsConfig({ A2A_DOTS_CALLBACK_PORT: value })).toThrow();
  });
  test.each(["file:///tmp/bridge", "http://user:secret@localhost", "http://localhost/?q=1", "http://localhost/#fragment"])("rejects invalid base URL %j", (value) => {
    expect(() => dotsConfig({ A2A_BRIDGE: value })).toThrow();
    expect(() => dotsConfig({ A2A_DOTS_CALLBACK_URL: value })).toThrow();
  });
  test("rejects invalid identity, host, path, timeout, and callback setup", () => {
    for (const env of [
      { A2A_DOTS_AGENT_ID: "--all" }, { A2A_DOTS_HOST: "http://localhost" },
      { A2A_DOTS_MCP_PATH: "/health" }, { A2A_DOTS_MCP_PATH: "mcp" },
      { A2A_DOTS_REQUEST_TIMEOUT_MS: "60001" }, { A2A_DOTS_RECONCILE_MS: "zero" },
      { A2A_DOTS_CALLBACK_PORT: "7743" }, { A2A_DOTS_CALLBACK_URL: "http://127.0.0.1:7743" },
    ]) expect(() => dotsConfig(env)).toThrow();
    expect(agentId(" scout_2 ")).toBe("scout_2");
    expect(() => agentId("--all")).toThrow();
  });
  test("strict team mode is opt-in and does not leak to backend argv", () => {
    expect(parseStartArgs(["release-1.2", "--require-team"])).toMatchObject({ name: "release-1.2", requireTeam: true, backendArgs: [] });
    expect(parseStartArgs(["scout"])).toMatchObject({ name: "scout", requireTeam: false });
    expect(() => parseStartArgs(["--require-team=true"])).toThrow(/does not take a value/);
  });
  test("inbox cursors distinguish reset, retention gaps, and normal incremental reads", () => {
    const inbox = createInbox(2), before = inbox.read();
    for (let n = 1; n <= 3; n++) inbox.enqueue({ text: `reply ${n}` });
    const all = inbox.read(before.cursor);
    expect(all).toMatchObject({ reset: false, gap: true, oldestCursor: `${all.generation}:2` });
    expect(all.messages.map((message) => message.text)).toEqual(["reply 2", "reply 3"]);
    expect(inbox.read(all.cursor)).toMatchObject({ reset: false, gap: false, messages: [] });
    expect(inbox.read(all.messages[0].cursor).messages).toHaveLength(1);
    const next = createInbox(2);
    next.enqueue({ text: "new instance" });
    expect(next.read(all.cursor)).toMatchObject({ reset: true, messages: [{ text: "new instance" }] });
    expect(next.read("100")).toMatchObject({ reset: true, messages: [{ text: "new instance" }] });
    expect(() => inbox.read("1suffix")).toThrow();
    expect(() => inbox.read(null)).toThrow();
  });
});
