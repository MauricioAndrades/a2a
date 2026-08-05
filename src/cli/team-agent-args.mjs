import { translateCommonAgentSettings } from "../agent-backend-args.mjs";

function teamAgentEffectiveYolo(agent, cliYolo) {
  return cliYolo === false ? false : agent.yolo === true;
}

function translateTeamAgentArgs(agent, cliYolo) {
  try {
    return translateCommonAgentSettings({
      ...agent,
      yolo: teamAgentEffectiveYolo(agent, cliYolo),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agent '${agent.id}': ${msg}`, { cause: err });
  }
}

export { teamAgentEffectiveYolo, translateTeamAgentArgs };
