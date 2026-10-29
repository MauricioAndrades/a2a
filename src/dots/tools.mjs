// The eight Dot tools, defined once and shared by both protocol eras. The
// legacy SDK handlers in a2a-dots.mjs and the stateless 2026-07-28 path in
// mcp-modern.mjs both route through createToolRouter, so neither era is a
// reimplementation that can drift from the other.

import { isAbsolute } from "node:path";

const BACKENDS = ["claude", "codex", "gemini", "cursor-agent"];
const SKILL_NAME = /^[A-Za-z0-9._-]+$/;
const DEFAULT_PEEK_LINES = 30;
const MAX_PEEK_LINES = 2000;

export const TOOL_DEFINITIONS = [
  {
    name: "send_message",
    description: "Send a message from this Dot to a registered a2a agent.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        to: { type: "string" },
        text: { type: "string" },
        action: { type: "string", enum: ["message", "reply", "ask"] },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "list_agents",
    description: "List agents registered with the running a2a bridge.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "get_agent",
    description: "Get one registered a2a agent by id.",
    inputSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" } }, required: ["agent"] },
  },
  {
    name: "receive_messages",
    description: "Read asynchronous replies. Pass the returned opaque cursor; reset/gap report adapter restart or inbox eviction.",
    inputSchema: { type: "object", additionalProperties: false, properties: { after: { type: "string" } } },
  },
  {
    name: "start_team",
    description: "Launch an existing a2a team by name through the normal a2a start contract.",
    inputSchema: { type: "object", additionalProperties: false, properties: { team: { type: "string" } }, required: ["team"] },
  },
  {
    name: "stop_agent",
    description: "Stop an a2a agent through the ownership-safe a2a kill contract.",
    inputSchema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" } }, required: ["agent"] },
  },
  {
    name: "start_agent",
    description: "Start one a2a agent by name through the normal `a2a start <agent>` contract. A name that is already running is re-registered, not duplicated. Optional backend (default claude), persona prompt, skills, cohort tag, working directory, and interactive mode (approvals on).",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        agent: { type: "string" },
        backend: { type: "string", enum: BACKENDS },
        prompt: { type: "string", description: "Persona / task brief delivered to the agent at startup (a2a start --prompt)." },
        skills: { type: "array", items: { type: "string" }, description: "Skill names appended to the persona (a2a start --skill NAME, repeatable)." },
        cohort: { type: "string", description: "Cohort tag the agent joins (a2a start --cohort NAME)." },
        cwd: { type: "string", description: "Absolute directory the agent works in; defaults to the adapter's working directory." },
        interactive: { type: "boolean", description: "true keeps the backend's approvals and sandbox on (a2a start --no-yolo); default false." },
      },
      required: ["agent"],
    },
  },
  {
    name: "peek_agent",
    description: "Read the last lines of a registered agent's terminal (a2a peek) without interrupting it. Use before calling an agent unresponsive.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        agent: { type: "string" },
        lines: { type: "integer", minimum: 1, maximum: MAX_PEEK_LINES, description: `Number of trailing lines; default ${DEFAULT_PEEK_LINES}.` },
      },
      required: ["agent"],
    },
  },
];

const TOOL_FIELDS = {
  send_message: ["to", "text", "action"],
  list_agents: [],
  get_agent: ["agent"],
  receive_messages: ["after"],
  start_team: ["team"],
  stop_agent: ["agent"],
  start_agent: ["agent", "backend", "prompt", "skills", "cohort", "cwd", "interactive"],
  peek_agent: ["agent", "lines"],
};

// Composes the `a2a start` argv for start_agent. Every value travels as its
// own argv element, so prompt text can never be parsed as a flag; the only
// inputs that reach argv unquoted are validated identifiers and literals.
function startAgentArgs(id, args, agentId) {
  const cli = ["start", id];
  if (args.backend !== undefined) {
    if (!BACKENDS.includes(args.backend)) {
      throw new Error(`backend must be one of ${BACKENDS.join(", ")}`);
    }
    cli.push(`--${args.backend}`);
  }
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.includes("\0")) {
      throw new Error("prompt must be non-empty text");
    }
    cli.push("--prompt", args.prompt);
  }
  if (args.skills !== undefined) {
    if (!Array.isArray(args.skills) || args.skills.length === 0) {
      throw new Error("skills must be a non-empty array of skill names");
    }
    for (const skill of args.skills) {
      if (typeof skill !== "string" || !SKILL_NAME.test(skill) || skill === "." || skill === ".." || skill.includes("..")) {
        throw new Error("skills must be single safe path segments");
      }
      cli.push("--skill", skill);
    }
  }
  if (args.cohort !== undefined) {
    cli.push("--cohort", agentId(args.cohort, "cohort"));
  }
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== "string" || !isAbsolute(args.cwd) || args.cwd.includes("\0")) {
      throw new Error("cwd must be an absolute directory path");
    }
  }
  if (args.interactive !== undefined) {
    if (typeof args.interactive !== "boolean") {
      throw new Error("interactive must be a boolean");
    }
    if (args.interactive) {
      cli.push("--no-yolo");
    }
  }
  return cli;
}

function peekLines(value) {
  if (value === undefined) {
    return DEFAULT_PEEK_LINES;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PEEK_LINES) {
    throw new Error(`lines must be an integer between 1 and ${MAX_PEEK_LINES}`);
  }
  return value;
}

export class UnknownToolError extends Error {
  constructor(name) {
    super(`unknown tool: ${name}`);
    this.toolName = name;
  }
}

// deps keeps this module free of process state so tests can drive the router
// directly: { dotId, agentId, sendMessage, reconcileRegistration, inbox, runCli, isStopping }
export function createToolRouter(deps) {
  return {
    list() {
      return TOOL_DEFINITIONS;
    },
    async call(name, rawArguments) {
      const args = rawArguments || {};
      const allowed = TOOL_FIELDS[name];
      if (!allowed) {
        throw new UnknownToolError(name);
      }
      if (typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((field) => !allowed.includes(field))) {
        throw new Error("invalid tool arguments");
      }
      if (deps.isStopping()) {
        throw new Error("adapter is stopping");
      }
      switch (name) {
        case "send_message":
          {
            return deps.sendMessage(args.to, args.text, args.action);
          }
        case "list_agents":
          {
            return deps.reconcileRegistration();
          }
        case "get_agent": {
          const id = deps.agentId(args.agent);
          const agent = (await deps.reconcileRegistration()).find((item) => item.agentId === id);
          if (!agent) {
            throw new Error(`no registered agent '${args.agent}'`);
          }
          return agent;
        }
        case "receive_messages":
          {
            return { agentId: deps.dotId, ...deps.inbox.read(args.after) };
          }
        case "start_team": {
          if (typeof args.team !== "string" || !args.team.trim() || args.team.trim().startsWith("-") ||
              [...args.team].some((char) => char.charCodeAt(0) < 32)) {
            throw new Error("team must be an existing team reference, not an option");
          }
          await deps.reconcileRegistration();
          return { team: args.team.trim(), output: await deps.runCli(["start", "--require-team", args.team.trim()]) };
        }
        case "stop_agent": {
          const id = deps.agentId(args.agent);
          if (id === deps.dotId) {
            throw new Error("stop_agent cannot stop the Dot adapter itself");
          }
          const agents = await deps.reconcileRegistration();
          if (!agents.some((item) => item.agentId === id)) {
            throw new Error(`no registered agent '${id}'`);
          }
          return { agent: id, output: await deps.runCli(["kill", "--agent", id]) };
        }
        case "start_agent": {
          const id = deps.agentId(args.agent);
          if (id === deps.dotId) {
            throw new Error("start_agent cannot start the Dot adapter itself");
          }
          const cli = startAgentArgs(id, args, deps.agentId);
          await deps.reconcileRegistration();
          return { agent: id, output: await deps.runCli(cli, args.cwd === undefined ? {} : { cwd: args.cwd }) };
        }
        case "peek_agent": {
          const id = deps.agentId(args.agent);
          const lines = peekLines(args.lines);
          const agents = await deps.reconcileRegistration();
          if (!agents.some((item) => item.agentId === id)) {
            throw new Error(`no registered agent '${id}'`);
          }
          return { agent: id, lines, screen: await deps.runCli(["peek", id, `--lines=${lines}`]) };
        }
        default:
          {
            throw new UnknownToolError(name);
          }
      }
    },
  };
}
