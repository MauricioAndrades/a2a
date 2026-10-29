import { afterAll, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  translateCommonAgentSettings,
  applyBackendDefaults,
} from "../src/agent-backend-args.mjs";
import { loadTeamSpec, teamSpecDefaultsToYolo } from "../src/a2a-team-spec.mjs";
import {
  teamAgentEffectiveYolo,
  translateTeamAgentArgs,
} from "../src/cli/team-agent-args.mjs";

// Fixture-owned mirror of the original teams/bug-killers.yaml (removed from
// the repo in c7826bb). Written to a temp dir so the tests keep exercising
// the REAL loadTeamSpec + teamSpecDefaultsToYolo + translateTeamAgentArgs
// path without depending on operational team files.
const fixtureTeamDir = mkdtempSync(join(tmpdir(), "a2a-bug-killers-spec-"));
const bugKillersSpecPath = join(fixtureTeamDir, "bug-killers.yaml");
writeFileSync(
  bugKillersSpecPath,
  `version: 2
name: bug-killers
description: fixture mirror of the original bug-killers team spec
defaults:
  backend: claude
agents:
  lead: {}
  scout:
    model: sonnet
  reproducer:
    backend: codex
  patcher:
    backend: cursor-agent
  verifier:
    backend: gemini
`,
);

afterAll(() => {
  rmSync(fixtureTeamDir, { recursive: true, force: true });
});

function codexFinalArgv(agent) {
  return applyBackendDefaults("codex", translateCommonAgentSettings(agent));
}

// ─── codex ────────────────────────────────────────────────────────────────

test("codex approval never maps to --dangerously-bypass-approvals-and-sandbox (workspace-write sandbox)", () => {
  assert.deepEqual(
    codexFinalArgv({
      id: "codex-argv-repro",
      backend: "codex",
      approval: "never",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("codex approval never maps to bypass for default sandbox (no ask-for-approval never alone)", () => {
  assert.deepEqual(
    codexFinalArgv({
      id: "a",
      backend: "codex",
      approval: "never",
      sandbox: "default",
      args: [],
    }),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("codex approval never does not duplicate an existing bypass flag", () => {
  assert.deepEqual(
    codexFinalArgv({
      id: "a",
      backend: "codex",
      approval: "never",
      sandbox: "danger-full-access",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    }),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("codex approval edit keeps ask-for-approval + sandbox; applyBackendDefaults does not prepend bypass", () => {
  assert.deepEqual(
    codexFinalArgv({
      id: "a",
      backend: "codex",
      approval: "edit",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
  );
});

test("codex spawn with empty argv still gets bypass from applyBackendDefaults alone", () => {
  assert.deepEqual(applyBackendDefaults("codex", []), [
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
});

test("codex yolo=true forces bypass even with approval=plan", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "codex",
      approval: "plan",
      sandbox: "read-only",
      yolo: true,
      args: [],
    }),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("codex yolo=true forces bypass with no approval/sandbox", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "codex",
      yolo: true,
      args: [],
    }),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("codex approval=plan without yolo keeps ask-for-approval + read-only sandbox", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "codex",
      approval: "plan",
      sandbox: "default",
      args: [],
    }),
    ["--ask-for-approval", "never", "--sandbox", "read-only"],
  );
});

// ─── claude ───────────────────────────────────────────────────────────────

test("claude approval=never emits --dangerously-skip-permissions regardless of sandbox", () => {
  // Regression for the L458 gating bug — claude has no CLI-level sandbox
  // concept, so the prior `&& sandbox === "danger-full-access"` gating was
  // dropping the dangerous flag for workspace-write callers.
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "never",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--dangerously-skip-permissions"],
  );
});

test("claude approval=never with default sandbox also emits --dangerously-skip-permissions", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "never",
      sandbox: "default",
      args: [],
    }),
    ["--dangerously-skip-permissions"],
  );
});

test("claude yolo=true emits --dangerously-skip-permissions", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      yolo: true,
      args: [],
    }),
    ["--dangerously-skip-permissions"],
  );
});

test("claude approval=edit emits --permission-mode acceptEdits and not the dangerous flag", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "edit",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--permission-mode", "acceptEdits"],
  );
});

test("claude approval=plan emits --permission-mode plan", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "plan",
      sandbox: "default",
      args: [],
    }),
    ["--permission-mode", "plan"],
  );
});

test("claude approval=default emits no permission/sandbox/dangerous flags", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "default",
      sandbox: "default",
      args: [],
    }),
    [],
  );
});

test("claude does not duplicate --dangerously-skip-permissions if user supplied it", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "never",
      args: ["--dangerously-skip-permissions"],
    }),
    ["--dangerously-skip-permissions"],
  );
});

// ─── gemini ───────────────────────────────────────────────────────────────

test("gemini yolo=true emits --approval-mode yolo and --skip-trust", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      yolo: true,
      args: [],
    }),
    ["--approval-mode", "yolo", "--skip-trust"],
  );
});

test("gemini approval=never emits --approval-mode yolo and --skip-trust", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "never",
      sandbox: "default",
      args: [],
    }),
    ["--approval-mode", "yolo", "--skip-trust"],
  );
});

test("gemini approval=plan emits --approval-mode plan AND --skip-trust (workspace-trust separate from approval)", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "plan",
      sandbox: "default",
      args: [],
    }),
    ["--approval-mode", "plan", "--skip-trust"],
  );
});

test("gemini approval=edit emits --approval-mode auto_edit AND --skip-trust", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "edit",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--approval-mode", "auto_edit", "--skip-trust"],
  );
});

test("gemini approval=default leaves both --approval-mode and --skip-trust off (interactive default)", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "default",
      sandbox: "default",
      args: [],
    }),
    [],
  );
});

test("gemini does NOT emit --sandbox for any common sandbox value (Docker toggle, not permission)", () => {
  for (const sandbox of [
    "default",
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]) {
    const out = translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "never",
      sandbox,
      args: [],
    });
    assert.equal(
      out.some((a) => a === "--sandbox" || a.startsWith("--sandbox=")),
      false,
      `gemini sandbox=${sandbox} unexpectedly produced --sandbox in: ${JSON.stringify(out)}`,
    );
  }
});

test("gemini does not duplicate --skip-trust if user supplied it", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "gemini",
      approval: "never",
      args: ["--skip-trust"],
    }),
    ["--skip-trust", "--approval-mode", "yolo"],
  );
});

// ─── cursor-agent ─────────────────────────────────────────────────────────

test("cursor-agent yolo=true emits --yolo --sandbox disabled --approve-mcps", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      yolo: true,
      args: [],
    }),
    ["--yolo", "--sandbox", "disabled", "--approve-mcps"],
  );
});

test("cursor-agent yolo=true with approval=edit still produces full yolo argv (yolo overrides approval branch)", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      approval: "edit",
      sandbox: "workspace-write",
      yolo: true,
      args: [],
    }),
    ["--yolo", "--sandbox", "disabled", "--approve-mcps"],
  );
});

test("cursor-agent approval=edit (no yolo) emits --yolo and --sandbox enabled for workspace-write", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      approval: "edit",
      sandbox: "workspace-write",
      args: [],
    }),
    ["--yolo", "--sandbox", "enabled"],
  );
});

test("cursor-agent sandbox=danger-full-access (no yolo) emits --sandbox disabled", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      approval: "edit",
      sandbox: "danger-full-access",
      args: [],
    }),
    ["--yolo", "--sandbox", "disabled"],
  );
});

test("cursor-agent sandbox=default (no yolo) omits --sandbox", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      approval: "edit",
      sandbox: "default",
      args: [],
    }),
    ["--yolo"],
  );
});

test("cursor-agent approval=plan emits --mode plan, no --yolo", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      approval: "plan",
      sandbox: "default",
      args: [],
    }),
    ["--mode", "plan"],
  );
});

test("cursor-agent yolo=true does not duplicate --yolo if user supplied --force", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      yolo: true,
      args: ["--force"],
    }),
    ["--force", "--sandbox", "disabled", "--approve-mcps"],
  );
});

test("cursor-agent yolo=true does not duplicate user-supplied --approve-mcps", () => {
  assert.deepEqual(
    translateCommonAgentSettings({
      id: "a",
      backend: "cursor-agent",
      yolo: true,
      args: ["--approve-mcps"],
    }),
    ["--approve-mcps", "--yolo", "--sandbox", "disabled"],
  );
});

// ─── invalid input fails loudly ───────────────────────────────────────────

test("translateCommonAgentSettings rejects unknown approval", () => {
  assert.throws(
    () => translateCommonAgentSettings({
      id: "a",
      backend: "claude",
      approval: "wat",
      args: [],
    }),
    /approval must be one of/,
  );
});

test("translateCommonAgentSettings rejects unknown sandbox", () => {
  assert.throws(
    () => translateCommonAgentSettings({
      id: "a",
      backend: "codex",
      sandbox: "nope",
      args: [],
    }),
    /sandbox must be one of/,
  );
});

test("translateCommonAgentSettings rejects unknown backends instead of silently ignoring yolo", () => {
  // Regression: an unknown backend with yolo:true returned args unchanged,
  // launching the agent WITHOUT any unattended-mode flags despite the module
  // contract ("throws on invalid input").
  assert.throws(
    () =>
      translateCommonAgentSettings({
        id: "a",
        backend: "aider",
        yolo: true,
        args: ["--keep"],
      }),
    /unknown backend 'aider'/,
  );
  assert.throws(
    () =>
      translateCommonAgentSettings({
        id: "a",
        backend: "aider",
        approval: "default",
        sandbox: "default",
        args: [],
      }),
    /unknown backend 'aider'/,
  );
});

// ─── model passthrough ────────────────────────────────────────────────────

test("claude model is passed via --model and survives yolo override", () => {
  const out = translateCommonAgentSettings({
    id: "a",
    backend: "claude",
    model: "sonnet",
    yolo: true,
    args: [],
  });
  assert.deepEqual(out, [
    "--model",
    "sonnet",
    "--dangerously-skip-permissions",
  ]);
});

test("codex model uses --model and survives yolo override", () => {
  const out = translateCommonAgentSettings({
    id: "a",
    backend: "codex",
    model: "gpt-5",
    yolo: true,
    args: [],
  });
  assert.deepEqual(out, [
    "--model",
    "gpt-5",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
});

function normalizedBugKillerAgent(id) {
  const spec = loadTeamSpec(bugKillersSpecPath);
  const raw = spec.agents[id];
  const defaults = spec.defaults || {};
  const merged = {
    ...defaults,
    ...raw,
    args: [...(defaults.args || []), ...(raw.args || [])],
  };
  return {
    id,
    backend: merged.backend || "claude",
    model: merged.model == null ? null : String(merged.model),
    approval: merged.approval == null ? "default" : String(merged.approval),
    sandbox: merged.sandbox == null ? "default" : String(merged.sandbox),
    yolo:
      typeof raw.yolo === "boolean"
        ? raw.yolo
        : typeof defaults.yolo === "boolean"
          ? defaults.yolo
          : teamSpecDefaultsToYolo(spec),
    args: merged.args,
  };
}

test("bug-killers default team launch flags put every backend in unattended mode", () => {
  assert.deepEqual(
    translateTeamAgentArgs(normalizedBugKillerAgent("scout"), undefined),
    ["--model", "sonnet", "--dangerously-skip-permissions"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(normalizedBugKillerAgent("reproducer"), undefined),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(normalizedBugKillerAgent("patcher"), undefined),
    ["--yolo", "--sandbox", "disabled", "--approve-mcps"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(normalizedBugKillerAgent("verifier"), undefined),
    ["--approval-mode", "yolo", "--skip-trust"],
  );
});

test("team --no-yolo disables schema-default yolo while preserving explicit approval settings", () => {
  /**
   * The team-harness skill rule (skill/a2a-team-harness/SKILL.md) bans
   * `approval:`/`sandbox:` entries on yolo-default agents because they
   * become stale text under the launcher's bypass flags. So this test
   * does NOT load approval data from the operational bug-killers YAML —
   * it constructs inline agent fixtures that DO carry explicit approval
   * (the case the skill carves out: "unless the agent explicitly has
   * yolo: false") and verifies those explicit values survive cliYolo=false.
   */
  const explicitApprovalAgent = (overrides) => ({
    id: "test",
    backend: "claude",
    model: null,
    approval: "default",
    sandbox: "default",
    yolo: false,
    args: [],
    ...overrides,
  });
  assert.deepEqual(
    translateTeamAgentArgs(
      explicitApprovalAgent({ backend: "claude", model: "sonnet", approval: "edit" }),
      false,
    ),
    ["--model", "sonnet", "--permission-mode", "acceptEdits"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(
      explicitApprovalAgent({ backend: "codex", approval: "never" }),
      false,
    ),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(
      explicitApprovalAgent({
        backend: "cursor-agent",
        approval: "edit",
        sandbox: "workspace-write",
      }),
      false,
    ),
    ["--yolo", "--sandbox", "enabled"],
  );
  assert.deepEqual(
    translateTeamAgentArgs(
      explicitApprovalAgent({ backend: "gemini", approval: "plan" }),
      false,
    ),
    ["--approval-mode", "plan", "--skip-trust"],
  );
});

test("team yolo state recorded for registration matches launched authority", () => {
  assert.equal(
    teamAgentEffectiveYolo(normalizedBugKillerAgent("verifier"), undefined),
    true,
  );
  assert.equal(
    teamAgentEffectiveYolo(normalizedBugKillerAgent("verifier"), false),
    false,
  );
});
