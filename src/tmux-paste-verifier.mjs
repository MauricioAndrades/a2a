const PLACEHOLDER_PATTERN = /\[Pasted text #\d+/;
const PROMPT_LINE_PATTERN = /^[>›❯]\s+(\S.*)$/;

export function pasteLooksUnsubmitted(text, content) {
  if (PLACEHOLDER_PATTERN.test(text)) return true;
  const lines = String(text || "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const recent = lines.slice(-6);
  for (const raw of recent) {
    const line = (raw || "").trim();
    if (!line) continue;
    const match = PROMPT_LINE_PATTERN.exec(line);
    if (match && promptShowsPastedContent(match[1], content)) return true;
  }
  return false;
}

function promptShowsPastedContent(promptText, content) {
  if (typeof content !== "string" || content === "") return false;
  const shown = String(promptText || "").trim();
  if (!shown) return false;
  const firstLine = content.split("\n", 1)[0].trim();
  if (!firstLine) return false;
  return firstLine.startsWith(shown) || shown.startsWith(firstLine);
}
