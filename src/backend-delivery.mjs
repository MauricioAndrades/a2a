const CURSOR_AGENT_BACKEND = "cursor-agent";
export function submitKeysForBackend(backend) {
  return backend === CURSOR_AGENT_BACKEND ? ["C-Enter"] : ["Enter"];
}

export function submitRecoveryKeysForBackend(_backend) {
  return [];
}
