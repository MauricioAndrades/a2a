import { afterEach, describe, expect, test } from "vitest";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, freePort, json, post, reply, runtimeFixture, waitFor } from "./helpers/dots-runtime.mjs";

let fixture;
afterEach(async () => { if (fixture) await fixture.close(); });
function setup() { fixture = runtimeFixture(); return fixture; }

describe("a2a-dots isolated runtime", () => {
  test("registers an owned callback route and queues asynchronous replies", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge);
    const { agents } = (await json(bridge.url, "/api/a2a/agents")).body.data;
    expect(agents[0]).toMatchObject({ agentId: "dot", backend: "mcp", bridgeUrl: adapter.callback, registrationOwner: expect.any(String) });
    expect((await post(bridge.url, "/api/a2a/send", reply())).status).toBe(200);
    const inbox = await call(await f.client(adapter), "receive_messages");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ from: "worker", text: "fixture reply", cursor: `${inbox.generation}:1` });
    expect(inbox.cursor).toBe(inbox.messages[0].cursor);
    expect((await json(adapter.url, "/health")).body.data).toMatchObject({ ok: true, state: "ready", inbox: 1 });
  });

  test("serves all eight tools over Streamable HTTP MCP", async () => {
    const f = setup(), adapter = await f.adapter(await f.bridge()), client = await f.client(adapter);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "get_agent", "list_agents", "peek_agent", "receive_messages", "send_message", "start_agent", "start_team", "stop_agent",
    ]);
    expect(await call(client, "get_agent", { agent: "dot" })).toMatchObject({ backend: "mcp" });
  });

  test("start_agent and peek_agent compose narrow CLI argv, honour cwd, and reject injection", async () => {
    const f = setup(), bridge = await f.bridge();
    // Captures argv AND the directory the CLI ran in, which the shared
    // capture fixture does not report.
    const captureCwd = join(f.root, "capture-cwd.mjs");
    writeFileSync(captureCwd, `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o755 });
    const adapter = await f.adapter(bridge, { A2A_DOTS_BIN: captureCwd }), client = await f.client(adapter);
    for (const args of [
      { agent: "--all" }, { agent: "dot" }, { agent: "scout", backend: "bash" }, { agent: "scout", prompt: "" },
      { agent: "scout", skills: [] }, { agent: "scout", skills: ["../escape"] }, { agent: "scout", cohort: "--global" },
      { agent: "scout", cwd: "relative/dir" }, { agent: "scout", cwd: join(f.root, "absent") }, { agent: "scout", interactive: "yes" },
      { agent: "scout", team: "x" },
    ]) {
      await expect(call(client, "start_agent", args), JSON.stringify(args)).rejects.toThrow();
    }
    const started = await call(client, "start_agent", {
      agent: "scout", backend: "codex", prompt: "--looks-like-a-flag but is prompt text", skills: ["a2a"], cohort: "lane", cwd: f.root, interactive: true,
    });
    expect(started.agent).toBe("scout");
    // process.cwd() reports the resolved path, and the fixture root sits under
    // a symlinked temp directory on macOS.
    const root = realpathSync(f.root);
    expect(JSON.parse(started.output)).toEqual({
      argv: ["start", "scout", "--codex", "--prompt", "--looks-like-a-flag but is prompt text", "--skill", "a2a", "--cohort", "lane", "--no-yolo"],
      cwd: root,
    });
    const minimal = await call(client, "start_agent", { agent: "scout" });
    expect(JSON.parse(minimal.output)).toEqual({ argv: ["start", "scout"], cwd: root });

    for (const args of [{ agent: "scout" }, { agent: "--all" }, { agent: "dot", lines: 0 }, { agent: "dot", lines: 5000 }, { agent: "dot", lines: "9" }]) {
      await expect(call(client, "peek_agent", args), JSON.stringify(args)).rejects.toThrow();
    }
    await post(bridge.url, "/api/a2a/register", { agentId: "scout", tmuxTarget: "scout:0.0" });
    const peeked = await call(client, "peek_agent", { agent: "scout" });
    expect(peeked).toMatchObject({ agent: "scout", lines: 30 });
    expect(JSON.parse(peeked.screen).argv).toEqual(["peek", "scout", "--lines=30"]);
    expect(JSON.parse((await call(client, "peek_agent", { agent: "scout", lines: 5 })).screen).argv).toEqual(["peek", "scout", "--lines=5"]);
  });

  test("start_agent surfaces the real CLI's failure instead of reporting a launch", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge), client = await f.client(adapter);
    // The fixture tmux exits 1, so the real `a2a start scout` fails at
    // new-session; the tool must relay that failure, not report a launch.
    await expect(call(client, "start_agent", { agent: "scout" })).rejects.toThrow(/tmux new-session for 'scout'/);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents.map((agent) => agent.agentId)).toEqual(["dot"]);
  });

  test("rejects wrong recipients, invalid callback JSON, and envelope fields", async () => {
    const f = setup(), adapter = await f.adapter(await f.bridge());
    expect((await post(adapter.callback, "/api/a2a/send", { ...reply(), to: "someone-else" })).status).toBe(404);
    for (const body of [null, [], { ...reply(), origin: "invented" }, { ...reply(), action: "write" }, { ...reply(), from: 1 }, { ...reply(), body: 1 }]) {
      expect((await post(adapter.callback, "/api/a2a/send", body)).status).toBe(400);
    }
    expect((await json(adapter.callback, "/api/a2a/send", { method: "POST", body: "{" })).status).toBe(400);
    expect((await json(adapter.url, "/health")).body.data.inbox).toBe(0);
  });

  test("recovers registration after a real bridge restart without clearing inbox", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge), client = await f.client(adapter);
    await post(bridge.url, "/api/a2a/send", reply("before restart"));
    const before = await call(client, "receive_messages");
    await f.stop(bridge.child);
    expect((await json(adapter.url, "/health")).body.data).toMatchObject({ ok: false, state: "degraded" });
    const replacement = await f.bridge(bridge.port);
    await waitFor(async () => (await json(replacement.url, "/api/a2a/agents")).body.data.agents.some((agent) => agent.agentId === "dot"));
    expect((await post(replacement.url, "/api/a2a/send", reply("after restart"))).status).toBe(200);
    const after = await call(client, "receive_messages", { after: before.cursor });
    expect(after).toMatchObject({ generation: before.generation, reset: false, gap: false });
    expect(after.messages.map((message) => message.text)).toEqual(["after restart"]);
    expect((await json(adapter.url, "/health")).status).toBe(200);
  });

  test("starts degraded before the bridge and becomes ready once it is available", async () => {
    const f = setup(), port = await freePort(), target = { port, url: `http://127.0.0.1:${port}` };
    const adapter = await f.adapter(target, {}, false);
    expect((await json(adapter.url, "/health")).status).toBe(503);
    const bridge = await f.bridge(port);
    await waitFor(async () => (await json(bridge.url, "/api/a2a/agents")).body.data.agents.length === 1);
    expect((await json(adapter.url, "/health")).body.data.ok).toBe(true);
  });

  test("duplicate adapter stays degraded and cannot unregister the owner's route", async () => {
    const f = setup(), bridge = await f.bridge(), first = await f.adapter(bridge);
    const second = await f.adapter(bridge, {}, false);
    expect((await json(second.url, "/health")).body.data).toMatchObject({ ok: false, error: expect.stringContaining("another instance") });
    await f.stop(second.child);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents[0].bridgeUrl).toBe(first.callback);
    await f.stop(first.child);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents).toEqual([]);
  });

  test("an older owner cannot overwrite or delete a replacement registration", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge);
    const old = (await json(bridge.url, "/api/a2a/agents")).body.data.agents[0];
    expect((await post(bridge.url, "/api/a2a/register", { ...old, registrationOwner: "replacement" })).status).toBe(409);
    expect((await json(bridge.url, "/api/a2a/register/dot", { method: "DELETE", headers: { "x-a2a-registration-owner": "wrong" } })).status).toBe(409);
    await json(bridge.url, "/api/a2a/register/dot", { method: "DELETE" });
    expect((await post(bridge.url, "/api/a2a/register", { ...old, registrationOwner: "replacement" })).status).toBe(200);
    await f.stop(adapter.child);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents[0].registrationOwner).toBe("replacement");
  });

  test("health repairs an owned route mismatch and rejects unowned collisions", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge);
    const old = (await json(bridge.url, "/api/a2a/agents")).body.data.agents[0];
    await post(bridge.url, "/api/a2a/register", { ...old, backend: "wrong", bridgeUrl: "http://127.0.0.1:1234" });
    expect((await json(adapter.url, "/health")).status).toBe(200);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents[0]).toMatchObject({ backend: "mcp", bridgeUrl: adapter.callback });
    await f.stop(adapter.child);
    await post(bridge.url, "/api/a2a/register", { agentId: "dot", tmuxTarget: "dot:0.0" });
    const collision = await f.adapter(bridge, {}, false);
    expect((await json(collision.url, "/health")).status).toBe(503);
    await f.stop(collision.child);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents).toHaveLength(1);
  });

  test("lifecycle option injection is rejected and valid references use narrow CLI modes", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge, { A2A_DOTS_BIN: f.captureCli }), client = await f.client(adapter);
    for (const args of [{ agent: "--all" }, { agent: " --all " }, { agent: "dot" }, { agent: "missing" }, { agent: "../team" }]) {
      await expect(call(client, "stop_agent", args)).rejects.toThrow();
    }
    for (const team of ["--global", "--insecure", "", "\nteam"]) await expect(call(client, "start_team", { team })).rejects.toThrow();
    await post(bridge.url, "/api/a2a/register", { agentId: "scout", tmuxTarget: "scout:0.0" });
    expect(JSON.parse((await call(client, "stop_agent", { agent: "scout" })).output)).toEqual(["kill", "--agent", "scout"]);
    expect(JSON.parse((await call(client, "start_team", { team: "release-1.2" })).output)).toEqual(["start", "--require-team", "release-1.2"]);
    for (const action of ["invalid", null]) await expect(call(client, "send_message", { to: "scout", text: "body", action })).rejects.toThrow();
    await expect(call(client, "list_agents", { extra: true })).rejects.toThrow();
  });

  test("start_team rejects missing specs through the real CLI without launching a worker", async () => {
    const f = setup(), adapter = await f.adapter(await f.bridge()), client = await f.client(adapter);
    await expect(call(client, "start_team", { team: "__missing_fixture_team__" })).rejects.toThrow(/--require-team needs an existing team spec/);
    const unnamed = await f.exited(f.launch("src/cli.mjs", ["start", "--require-team"]));
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain("--require-team needs an existing team spec");
  });

  test("kill --agent stops only the named registration even if a team has the same name", async () => {
    const f = setup(), bridge = await f.bridge(), adapter = await f.adapter(bridge), client = await f.client(adapter);
    // Malformed spec proves this branch never attempts team resolution.
    writeFileSync(join(f.root, "teams", "scout.yaml"), "invalid: team");
    for (const id of ["scout", "other"]) await post(bridge.url, "/api/a2a/register", {
      agentId: id, tmuxTarget: `${id}:0.0`, description: "team:scout", bridgeUrl: adapter.callback,
    });
    expect((await call(client, "stop_agent", { agent: "scout" })).output).toContain("scout:");
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents.map((agent) => agent.agentId).sort()).toEqual(["dot", "other"]);
    const conflict = await f.exited(f.launch("src/cli.mjs", ["kill", "--agent", "other", "--all"], { A2A_BRIDGE: bridge.url }));
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("cannot be combined");
  });

  test("strict team mode resolves dotted names and paths while preserving existing dashboard reuse", async () => {
    const f = setup();
    const spec = join(f.root, "teams", "release-1.2.json");
    writeFileSync(spec, JSON.stringify({ name: "release-1-2", agents: { scout: { role: "fixture" } } }));
    // Only fixture programs run: all tmux operations are harmless stubs.
    writeFileSync(join(f.root, "fake-bin", "tmux"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
    for (const ref of ["release-1.2", spec]) {
      const exit = await f.exited(f.launch("src/cli.mjs", ["start", "--require-team", ref, "--dashboard"]));
      expect(exit.status).toBe(0);
      expect(exit.stderr).toContain("dashboard 'release-1-2-view' is already running");
    }
  });

  test("legacy registration overwrite is preserved and owner fields are validated", async () => {
    const f = setup(), bridge = await f.bridge();
    const route = { agentId: "worker", tmuxTarget: "worker:0.0", description: "first" };
    expect((await post(bridge.url, "/api/a2a/register", route)).status).toBe(200);
    expect((await post(bridge.url, "/api/a2a/register", { ...route, description: "second" })).status).toBe(200);
    expect((await json(bridge.url, "/api/a2a/agents")).body.data.agents[0].description).toBe("second");
    for (const owner of [null, "", "invalid owner", 1, "a".repeat(129)]) {
      expect((await post(bridge.url, "/api/a2a/register", { ...route, registrationOwner: owner })).status).toBe(400);
    }
    expect((await json(bridge.url, "/api/a2a/register/worker", { method: "DELETE", headers: { "x-a2a-registration-owner": "invalid owner" } })).status).toBe(400);
    expect((await json(bridge.url, "/api/a2a/register/worker", { method: "DELETE" })).status).toBe(200);
    expect((await json(bridge.url, "/api/a2a/register/worker", { method: "DELETE", headers: { "x-a2a-registration-owner": "unused" } })).body.data.removed).toBe(false);
  });

  test("authenticated ownership retains peer restrictions and outbound peer identity", async () => {
    const f = setup(), configPath = join(f.root, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, key: "fixture-operator", peers: { remote: { key: "fixture-peer", url: "http://127.0.0.1:1234" } } }));
    const bridge = await f.bridge(), adapter = await f.adapter(bridge, { A2A_KEY: "fixture-operator" }), client = await f.client(adapter);
    expect((await json(bridge.url, "/api/a2a/agents")).status).toBe(401);
    for (const action of ["message", "reply", "ask"]) {
      await call(client, "send_message", { to: "dot", text: `outbound ${action}`, action });
    }
    expect((await call(client, "receive_messages")).messages.map((message) => ({ from: message.from, origin: message.origin, action: message.action }))).toEqual(
      ["message", "reply", "ask"].map((action) => ({ from: "dot", origin: "peer", action })),
    );
    const headers = { "content-type": "application/json", authorization: "Bearer fixture-peer" };
    const forbidden = await json(bridge.url, "/api/a2a/register", {
      method: "POST", headers, body: JSON.stringify({ agentId: "dot", tmuxTarget: "dot:0.0", registrationOwner: "peer-owner" }),
    });
    expect(forbidden.status).toBe(403);
    expect((await json(bridge.url, "/api/a2a/register/dot", { method: "DELETE", headers: { ...headers, "x-a2a-registration-owner": "peer-owner" } })).status).toBe(403);
    const allowed = await json(bridge.url, "/api/a2a/register", {
      method: "POST", headers, body: JSON.stringify({ agentId: "remote__worker", tmuxTarget: "remote__worker:0.0", registrationOwner: "peer-owner" }),
    });
    expect(allowed.status).toBe(200);
  });

  test("adapter restart reports cursor reset and replays retained fresh messages", async () => {
    const f = setup(), bridge = await f.bridge(), first = await f.adapter(bridge), client = await f.client(first);
    await post(first.callback, "/api/a2a/send", reply());
    const before = await call(client, "receive_messages");
    await client.close();
    await f.stop(first.child);
    const second = await f.adapter(bridge), nextClient = await f.client(second);
    await post(second.callback, "/api/a2a/send", reply("fresh instance"));
    const after = await call(nextClient, "receive_messages", { after: before.cursor });
    expect(after).toMatchObject({ reset: true, gap: false });
    expect(after.generation).not.toBe(before.generation);
    expect(after.messages.map((message) => message.text)).toEqual(["fresh instance"]);
    expect((await call(nextClient, "receive_messages", { after: "999" })).reset).toBe(true);
  });

  test("bounded inbox reports eviction gaps and validates whole cursors", async () => {
    const f = setup(), adapter = await f.adapter(await f.bridge(), { A2A_DOTS_MAX_INBOX: "2" }), client = await f.client(adapter);
    const empty = await call(client, "receive_messages");
    for (let n = 0; n < 4; n++) await post(adapter.callback, "/api/a2a/send", reply(`reply ${n}`));
    const after = await call(client, "receive_messages", { after: empty.cursor });
    expect(after).toMatchObject({ reset: false, gap: true });
    expect(after.messages.map((message) => message.text)).toEqual(["reply 2", "reply 3"]);
    expect(after.oldestCursor).toBe(`${after.generation}:3`);
    expect((await call(client, "receive_messages", { after: after.cursor })).messages).toEqual([]);
    for (const cursor of ["1garbage", "-1", "", `${after.generation}:999`, "9007199254740992"]) {
      await expect(call(client, "receive_messages", { after: cursor })).rejects.toThrow();
    }
  });

  test("bounded requests mark stalled inventory degraded and shutdown survives stalled unregister", async () => {
    const f = setup();
    let registration, stallInventory = false, stallDelete = false;
    const mock = await f.mockBridge(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if ((req.method === "DELETE" && stallDelete) || (req.method === "GET" && stallInventory)) return;
      let data = {};
      if (req.method === "POST") { registration = JSON.parse(raw); data = registration; }
      if (req.method === "GET") data = { agents: registration ? [registration] : [], registrationOwnership: true };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data }));
    });
    const adapter = await f.adapter(mock);
    stallInventory = true;
    const degraded = await json(adapter.url, "/health");
    expect(degraded.status).toBe(503);
    expect(degraded.body.data.error).toContain("timed out");
    stallDelete = true;
    const before = Date.now();
    const exit = await f.stop(adapter.child);
    expect(exit.signal).toBeNull();
    expect(Date.now() - before).toBeLessThan(1500);
    expect(exit.stderr).toContain("unregister: a2a bridge request timed out");
  });

  test("shutdown conditionally unregisters even when the registration response is lost", async () => {
    const f = setup();
    let registration, deletedOwner;
    const mock = await f.mockBridge(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.method === "POST") {
        registration = JSON.parse(raw);
        return; // The bridge committed the route, but no acknowledgement arrives.
      }
      if (req.method === "GET" && registration) return;
      if (req.method === "DELETE") {
        deletedOwner = req.headers["x-a2a-registration-owner"];
        if (deletedOwner === registration.registrationOwner) registration = undefined;
      }
      res.end(JSON.stringify({ success: true, data: { agents: [], registrationOwnership: true } }));
    });
    const adapter = await f.adapter(mock, {}, false);
    expect(registration).toBeDefined();
    const expectedOwner = registration.registrationOwner;
    await f.stop(adapter.child);
    expect(deletedOwner).toBe(expectedOwner);
    expect(registration).toBeUndefined();
  });

  test("invalid environment fails before binding and old bridges cannot report owned readiness", async () => {
    const f = setup();
    for (const env of [{ A2A_DOTS_MAX_INBOX: "invalid" }, { A2A_DOTS_PORT: "7743junk" }, { A2A_DOTS_CALLBACK_PORT: "0" }, { A2A_DOTS_AGENT_ID: "--all" }]) {
      const exit = await f.exited(f.launch("src/a2a-dots.mjs", [], env));
      expect(exit.status).toBe(1);
    }
    let deletes = 0, registrations = 0;
    const oldBridge = await f.mockBridge(async (req, res) => {
      for await (const _chunk of req) { /* Discard synthetic body. */ }
      if (req.method === "DELETE") deletes++;
      if (req.method === "POST") registrations++;
      res.end(JSON.stringify({ success: true, data: req.method === "GET" ? { agents: [] } : {} }));
    });
    const adapter = await f.adapter(oldBridge, {}, false);
    expect((await json(adapter.url, "/health")).body.data.error).toContain("does not support owned adapter registration");
    await f.stop(adapter.child);
    expect(deletes).toBe(0);
    expect(registrations).toBe(0);
  });
});
