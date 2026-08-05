import { beforeEach, describe, expect, test, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  registry: {
    agents: [],
    groups: [],
    installToken: null,
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: runtimeMocks.spawnSync,
}));

vi.mock("../src/a2a-config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadRegistry: vi.fn(() => runtimeMocks.registry),
  };
});

vi.mock("../src/transport-probes.mjs", () => ({
  itermSessionNameMatches: vi.fn((sessionName, agentName) => {
    if (typeof sessionName !== "string") return false;
    return (
      sessionName === agentName ||
      sessionName.startsWith(`${agentName} — `)
    );
  }),
  listITermSessionsWithOwnership: vi.fn(),
}));

import {
  itermSessionNameMatches,
  listITermSessionsWithOwnership,
} from "../src/transport-probes.mjs";
import {
  buildRuntimeSnapshotFromState,
  clearRuntimeSnapshotCache,
} from "../src/runtime/runtime-snapshot.mjs";

beforeEach(() => {
  clearRuntimeSnapshotCache();
  runtimeMocks.spawnSync.mockReset();
  runtimeMocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  runtimeMocks.registry = {
    agents: [],
    groups: [],
    installToken: null,
  };
  vi.mocked(listITermSessionsWithOwnership).mockReset();
  vi.mocked(itermSessionNameMatches).mockClear();
});

describe("runtime snapshot iTerm inventory", () => {
  test("indexes one iTerm session listing for live status and ownership inputs", async () => {
    vi.mocked(listITermSessionsWithOwnership).mockResolvedValue([
      {
        guid: "guid-alpha",
        name: "alpha — ~/project",
        installToken: "test-token",
      },
      {
        guid: "guid-beta",
        name: "beta",
        installToken: "test-token",
      },
    ]);

    const result = await buildRuntimeSnapshotFromState({
      registeredAgents: [
        {
          agentId: "alpha",
          tmuxTarget: "alpha:0.0",
          description: "",
        },
        {
          agentId: "beta",
          tmuxTarget: "beta:0.0",
          description: "",
        },
        {
          agentId: "gamma",
          tmuxTarget: "gamma:0.0",
          description: "",
        },
      ],
      cache: false,
    });

    expect(listITermSessionsWithOwnership).toHaveBeenCalledTimes(1);
    expect(itermSessionNameMatches).not.toHaveBeenCalled();
    expect(
      result.inventory.registered.map((agent) => [
        agent.agentId,
        agent.status,
      ]),
    ).toEqual([
      ["alpha", "live"],
      ["beta", "live"],
      ["gamma", "bridge-only"],
    ]);
  });

  test("ignores decorated iTerm names that cannot be agent ids", async () => {
    vi.mocked(listITermSessionsWithOwnership).mockResolvedValue([
      {
        guid: "guid-title",
        name: "not an agent — ~/project",
        installToken: "test-token",
      },
    ]);

    const result = await buildRuntimeSnapshotFromState({
      registeredAgents: [
        {
          agentId: "not",
          tmuxTarget: "not:0.0",
          description: "",
        },
      ],
      cache: false,
    });

    expect(result.inventory.registered[0]).toMatchObject({
      agentId: "not",
      status: "bridge-only",
    });
  });

  test("cache hit reuses the prior snapshot without another iTerm probe", async () => {
    vi.mocked(listITermSessionsWithOwnership).mockResolvedValue([
      {
        guid: "guid-alpha",
        name: "alpha",
        installToken: "test-token",
      },
    ]);

    const input = {
      registeredAgents: [
        {
          agentId: "alpha",
          tmuxTarget: "alpha:0.0",
          description: "",
          registeredAt: 1,
        },
      ],
      self: "alpha",
      launchCwd: "/tmp/a2a-cache-test",
      cache: true,
    };

    const first = await buildRuntimeSnapshotFromState(input);
    const second = await buildRuntimeSnapshotFromState(input);

    expect(second).toBe(first);
    expect(listITermSessionsWithOwnership).toHaveBeenCalledTimes(1);
  });

  test("batches tmux ownership tokens into the session listing", async () => {
    runtimeMocks.registry = {
      agents: [],
      groups: [],
      installToken: "ai-test-token",
    };
    runtimeMocks.spawnSync.mockImplementation((command, args) => {
      if (command !== "tmux") {
        return { status: 127, stdout: "", stderr: "unexpected command" };
      }
      if (args?.[0] === "list-sessions") {
        return {
          status: 0,
          stdout: [
            "alpha\tai-test-token",
            "stray\tai-test-token",
            "unowned\tother-token",
            "ops-view\tai-test-token",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected tmux command" };
    });
    vi.mocked(listITermSessionsWithOwnership).mockResolvedValue([]);

    const result = await buildRuntimeSnapshotFromState({
      registeredAgents: [
        {
          agentId: "alpha",
          tmuxTarget: "alpha:0.0",
          description: "",
        },
      ],
      cache: false,
    });

    expect(result.inventory.registered[0]).toMatchObject({
      agentId: "alpha",
      status: "live",
    });
    expect(result.inventory.orphans).toEqual(["stray"]);
    expect(result.inventory.views.map((view) => view.session)).toEqual([
      "ops-view",
    ]);
    expect(runtimeMocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.spawnSync.mock.calls[0][1]).toEqual([
      "list-sessions",
      "-F",
      "#{session_name}\t#{@a2a-install-token}",
    ]);
  });
});
