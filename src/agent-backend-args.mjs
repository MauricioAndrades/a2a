

// Team-spec approval/sandbox/yolo → backend argv. Pure function, no side
// effects, throws on invalid input.
//
// Canonical per-backend unattended-mode flags (verified against installed
// CLI --help on 2026-05-19):
//
//   claude        --dangerously-skip-permissions
//   codex         --dangerously-bypass-approvals-and-sandbox
//   cursor-agent  --yolo --sandbox disabled --approve-mcps
//   gemini        --approval-mode yolo --skip-trust  (do NOT pass --sandbox;
//                 -s/--sandbox is a Docker/Podman toggle, not a permission
//                 concept; for unsandboxed use, omit the flag entirely)
//
// Claude has no CLI-level sandbox concept, so the common `sandbox` field is
// ignored for claude beyond its effect on `yolo`-style intent. Gemini's
// --skip-trust skips the first-launch workspace-trust dialog and is required
// for any unattended mode, not just yolo.

const COMMON_APPROVALS = new Set(["default", "plan", "edit", "never"]);
const COMMON_SANDBOXES = new Set([
  "default",
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function hasAnyFlag(args, names) {
  return args.some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
}

function maybePush(args, ...parts) {
  for (const part of parts)
    if (part != null && part !== "") args.push(String(part));
}

function requireKnownValue(value, allowed, fieldName) {
  const raw = value || "default";
  if (!allowed.has(raw)) {
    throw new Error(`${fieldName} must be one of: ${[...allowed].join(", ")}`);
  }
  return raw;
}

function translateCommonAgentSettings(agent) {
  const args = Array.isArray(agent.args)
    ? [...agent.args.map((arg) => String(arg))]
    : [];
  const approval = requireKnownValue(
    agent.approval,
    COMMON_APPROVALS,
    "approval",
  );
  const sandbox = requireKnownValue(
    agent.sandbox,
    COMMON_SANDBOXES,
    "sandbox",
  );
  const model = agent.model == null ? null : String(agent.model);
  const yolo = agent.yolo === true;

  switch (agent.backend) {
    case "claude": {
      if (model && !hasAnyFlag(args, ["--model"]))
        maybePush(args, "--model", model);
      if (yolo || approval === "never") {
        // Claude has no CLI-level sandbox concept; the prior gating on
        // sandbox === "danger-full-access" was a bug that left
        // approval=never running with tool-approval prompts active.
        if (!hasAnyFlag(args, ["--dangerously-skip-permissions"])) {
          args.push("--dangerously-skip-permissions");
        }
      } else if (!hasAnyFlag(args, ["--permission-mode"])) {
        const mode = { default: null, plan: "plan", edit: "acceptEdits" }[
          approval
        ];
        if (mode) maybePush(args, "--permission-mode", mode);
      }
      break;
    }
    case "codex": {
      if (model && !hasAnyFlag(args, ["--model", "-m"]))
        maybePush(args, "--model", model);
      if (yolo || approval === "never") {
        // For a2a team usage codex must bypass even with
        // workspace-write, because workspace-write blocks writes to
        // paths outside cwd (e.g. ~/.claude/skills/a2a/registry.json).
        // `codex exec` also rejects --ask-for-approval, so the bypass
        // form is the only safe choice for unattended mode.
        if (!hasAnyFlag(args, ["--dangerously-bypass-approvals-and-sandbox"])) {
          args.push("--dangerously-bypass-approvals-and-sandbox");
        }
      } else if (approval === "plan") {
        if (!hasAnyFlag(args, ["--ask-for-approval", "-a"]))
          maybePush(args, "--ask-for-approval", "never");
        if (!hasAnyFlag(args, ["--sandbox", "-s"]))
          maybePush(
            args,
            "--sandbox",
            sandbox === "default" ? "read-only" : sandbox,
          );
      } else if (approval === "edit") {
        if (!hasAnyFlag(args, ["--ask-for-approval", "-a"]))
          maybePush(args, "--ask-for-approval", "never");
        if (!hasAnyFlag(args, ["--sandbox", "-s"]))
          maybePush(
            args,
            "--sandbox",
            sandbox === "default" ? "workspace-write" : sandbox,
          );
      } else if (
        sandbox !== "default" &&
        !hasAnyFlag(args, ["--sandbox", "-s"])
      ) {
        maybePush(args, "--sandbox", sandbox);
      }
      break;
    }
    case "gemini": {
      if (model && !hasAnyFlag(args, ["--model", "-m"]))
        maybePush(args, "--model", model);
      if (yolo || approval === "never") {
        if (!hasAnyFlag(args, ["--approval-mode"]))
          maybePush(args, "--approval-mode", "yolo");
      } else if (!hasAnyFlag(args, ["--approval-mode"])) {
        const mode = { default: null, plan: "plan", edit: "auto_edit" }[
          approval
        ];
        if (mode) maybePush(args, "--approval-mode", mode);
      }
      // --skip-trust skips the first-launch workspace-trust dialog. It is
      // unrelated to tool approvals, so we add it whenever ANY unattended
      // mode is in effect (yolo OR non-default approval). Pure-default
      // mode is left alone so interactive users still see the dialog.
      if (
        (yolo || approval !== "default") &&
        !hasAnyFlag(args, ["--skip-trust"])
      ) {
        args.push("--skip-trust");
      }
      // Deliberately do NOT translate `sandbox` into --sandbox here.
      // Gemini's -s/--sandbox is a boolean toggle that ENABLES the
      // Docker/Podman sandbox; --sandbox=false is non-idiomatic and
      // --sandbox=true requires a container runtime. For a2a's
      // unsandboxed unattended use the flag must be omitted entirely.
      // Callers that want the Docker sandbox can pass --sandbox via
      // agent.args explicitly.
      break;
    }
    case "cursor-agent": {
      if (model && !hasAnyFlag(args, ["--model"]))
        maybePush(args, "--model", model);
      if (yolo || approval === "never") {
        if (!hasAnyFlag(args, ["--yolo", "--force", "-f"])) args.push("--yolo");
        if (!hasAnyFlag(args, ["--sandbox"]))
          maybePush(args, "--sandbox", "disabled");
        if (!hasAnyFlag(args, ["--approve-mcps"])) args.push("--approve-mcps");
      } else {
        if (approval === "plan" && !hasAnyFlag(args, ["--mode", "--plan"]))
          maybePush(args, "--mode", "plan");
        if (
          approval === "edit" &&
          !hasAnyFlag(args, ["--yolo", "--force", "-f"])
        ) {
          args.push("--yolo");
        }
        if (!hasAnyFlag(args, ["--sandbox"])) {
          if (sandbox === "danger-full-access")
            maybePush(args, "--sandbox", "disabled");
          else if (sandbox !== "default")
            maybePush(args, "--sandbox", "enabled");
        }
      }
      break;
    }
    default:
      // The module contract is "throws on invalid input". Returning args
      // unchanged here used to launch unknown backends WITHOUT the
      // unattended-mode flags the caller asked for (yolo silently ignored).
      throw new Error(`unknown backend '${agent.backend}'`);
  }
  return args;
}

function applyBackendDefaults(backend, backendArgs) {
  if (backend !== "codex") return backendArgs;

  const hasSandboxOrApprovalOverride = backendArgs.some(
    (arg) =>
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--full-auto" ||
      arg === "--oss" ||
      arg === "-a" ||
      arg.startsWith("--ask-for-approval") ||
      arg === "-s" ||
      arg.startsWith("--sandbox"),
  );

  if (hasSandboxOrApprovalOverride) return backendArgs;
  return ["--dangerously-bypass-approvals-and-sandbox", ...backendArgs];
}

export { translateCommonAgentSettings, applyBackendDefaults };
