

import { spawnSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  clear: "\x1b[2J",
  home: "\x1b[H",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  alt: "\x1b[?1049h",
  main: "\x1b[?1049l",
  fg: {
    muted: "\x1b[38;5;245m",
    soft: "\x1b[38;5;250m",
    title: "\x1b[38;5;117m",
    ok: "\x1b[38;5;120m",
    warn: "\x1b[38;5;221m",
    bad: "\x1b[38;5;203m",
  },
  bg: {
    bar: "\x1b[48;5;235m",
    active: "\x1b[48;5;24m",
  },
};

const BOX = {
  h: "─",
  v: "│",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
};

const HELP = [
  ["↑/↓", "select agents"],
  ["PgUp/PgDn", "scroll preview"],
  ["Home/End", "top or bottom of roster"],
  ["1-9", "open first nine agent tabs"],
  ["Enter", "open selected agent tab"],
  ["m", "message selected"],
  ["a", "ask selected"],
  ["q", "open agent by name"],
  ["space", "mark group target"],
  ["g", "message checked agents"],
  ["b", "broadcast message"],
  ["r", "refresh"],
  ["c", "tmux chooser"],
  ["?", "toggle help"],
  ["x", "exit cockpit"],
];

function parseMemberArg(raw, fallbackSlot) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const id = value.slice(0, colon);
    const slotRaw = value.slice(colon + 1);
    if (/^[1-9]\d*$/.test(slotRaw)) return { id, slot: Number(slotRaw) };
  }
  return { id: value, slot: fallbackSlot };
}

function parseArgs(argv) {
  let session = "";
  const rawMembers = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session") {
      session = argv[++i] || "";
      continue;
    }
    if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
      continue;
    }
    if (arg === "--member") {
      const member = argv[++i] || "";
      if (member) rawMembers.push(member);
      continue;
    }
    if (arg.startsWith("--member=")) {
      const member = arg.slice("--member=".length);
      if (member) rawMembers.push(member);
    }
  }
  if (!session) {
    process.stderr.write("dashboard-tui: --session is required\n");
    process.exit(2);
  }
  const members = [];
  const seen = new Set();
  rawMembers.forEach((raw, index) => {
    const parsed = parseMemberArg(raw, index + 1);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    members.push(parsed);
  });
  return { session, members };
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    stdio:
      opts.input == null
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function stripAnsi(value) {
  /* eslint-disable no-control-regex */
  return String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "");
  /* eslint-enable no-control-regex */
}

function visibleWidth(value) {
  return stripAnsi(String(value ?? "")).length;
}

function padPlain(value, width) {
  const text = String(value ?? "");
  return text + " ".repeat(Math.max(0, width - text.length));
}

function clipPlain(value, width) {
  const text = stripAnsi(String(value ?? ""));
  if (width <= 0) return "";
  if (text.length <= width) return padPlain(text, width);
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function cleanPreviewLine(value) {
  return stripAnsi(value)
    .replace(/[\r\t]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[│┃┆┇┊┋╎╏]+/g, "|")
    .replace(/[─━╌╍┄┅┈┉]+/g, "-")
    .trimEnd();
}

function panel(width, height, title, lines) {
  const inner = Math.max(0, width - 2);
  const bodyHeight = Math.max(0, height - 2);
  const safeTitle = ` ${stripAnsi(title || "")} `;
  const titleWidth = Math.min(inner, safeTitle.length);
  const left = Math.max(0, Math.floor((inner - titleWidth) / 2));
  const right = Math.max(0, inner - titleWidth - left);
  const out = [
    `${BOX.tl}${BOX.h.repeat(left)}${ANSI.bold}${safeTitle.slice(0, titleWidth)}${ANSI.reset}${BOX.h.repeat(right)}${BOX.tr}`,
  ];
  for (let i = 0; i < bodyHeight; i++) {
    out.push(`${BOX.v}${clipPlain(lines[i] || "", inner)}${BOX.v}`);
  }
  out.push(`${BOX.bl}${BOX.h.repeat(inner)}${BOX.br}`);
  return out;
}

function hjoin(blocks, gap = " ") {
  const height = Math.max(0, ...blocks.map((block) => block.length));
  const widths = blocks.map((block) =>
    Math.max(0, ...block.map((line) => visibleWidth(line))),
  );
  const out = [];
  for (let i = 0; i < height; i++) {
    out.push(
      blocks
        .map((block, index) => {
          const line = block[i] || "";
          return line + " ".repeat(Math.max(0, widths[index] - visibleWidth(line)));
        })
        .join(gap),
    );
  }
  return out;
}

function readA2aState() {
  const result = run("a2a", ["list", "--json", "--no-peers"]);
  if (!result.ok) {
    return {
      bridgeError: result.stderr.trim() || "a2a list failed",
      registered: [],
      orphans: [],
      views: [],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      bridgeError: parsed.bridgeError || null,
      registered: Array.isArray(parsed.registered) ? parsed.registered : [],
      orphans: Array.isArray(parsed.orphans) ? parsed.orphans : [],
      views: Array.isArray(parsed.views) ? parsed.views : [],
    };
  } catch {
    return {
      bridgeError: "a2a list returned invalid JSON",
      registered: [],
      orphans: [],
      views: [],
    };
  }
}

function captureAgent(target, lines) {
  const result = run("tmux", [
    "capture-pane",
    "-t",
    target,
    "-p",
    "-S",
    `-${lines}`,
  ]);
  if (!result.ok) return [`capture failed: ${result.stderr.trim() || "unknown"}`];
  return result.stdout
    .split("\n")
    .map(cleanPreviewLine)
    .filter((line) => line.trim().length > 0);
}

// Resolve `<agentId>:0`'s tmux global window_id (e.g. `@7`). window_id is
// stable across sessions and link-window keeps it identical in every session
// referencing the window, so it is the only reliable join key between the
// agent's own session and our view-session links. Returns null when the
// agent's source window is gone.
function agentWindowId(agentId) {
  const result = run("tmux", [
    "display-message",
    "-p",
    "-t",
    `${agentId}:0`,
    "#{window_id}",
  ]);
  if (!result.ok) return null;
  const wid = result.stdout.trim();
  return wid || null;
}

// Map window_id -> current window_index for every window in the view session.
// The index is always read fresh because tmux can renumber (renumber-windows,
// kill-window, move-window) and our `--member id:slot` baked-in slots go stale
// the moment that happens.
function viewWindows(session) {
  const result = run("tmux", [
    "list-windows",
    "-t",
    session,
    "-F",
    "#{window_id}\t#{window_index}\t#{window_name}",
  ]);
  if (!result.ok) return [];
  const windows = [];
  for (const line of result.stdout.split("\n")) {
    const [id, index, name = ""] = line.split("\t");
    if (id && index) windows.push({ id, index, name });
  }
  return windows;
}

function viewWindowIndexByWindowId(session) {
  const map = new Map();
  for (const window of viewWindows(session)) {
    map.set(window.id, window.index);
  }
  return map;
}

function viewWindowIndexForMember(session, member) {
  const windows = viewWindows(session);
  const named = windows.find((window) => window.name === member.id);
  if (named) return named.index;
  const slotted = windows.find((window) => window.index === String(member.slot));
  return slotted?.index || null;
}

function openViewWindow(state, index) {
  const target = `${state.session}:${index}`;
  const switched = process.env.TMUX
    ? run("tmux", ["switch-client", "-t", target])
    : { ok: false, stderr: "" };
  if (switched.ok) return true;

  const selected = run("tmux", ["select-window", "-t", target]);
  if (selected.ok) return true;

  const reason =
    selected.stderr.trim() || switched.stderr.trim() || "unknown tmux error";
  addLog(state, `open ${target} failed: ${reason}`);
  return false;
}

// Open the agent's window in the view session, repairing state on the way.
// Sequence:
//   1. Look up the agent's stable window_id from its own session.
//   2. Find its current index inside the view session.
//   3. If not present (link was nuked, e.g. window killed in the view but the
//      agent itself is alive), re-link `<agent>:0` into the view session and
//      resolve the freshly appended index.
//   4. If the source session is gone but the view still has the linked tab,
//      open the survivor by name, then by its original slot as a last resort.
//   5. Switch the attached client to the resolved window, falling back to
//      select-window for detached/test contexts.
function jumpToAgent(state, member) {
  if (!member) return;
  const wid = agentWindowId(member.id);
  let index;
  if (wid == null) {
    index = viewWindowIndexForMember(state.session, member);
    if (index == null) {
      addLog(state, `cannot open ${member.id}: source window unavailable`);
      return;
    }
    addLog(state, `opening existing ${member.id} tab; source session unavailable`);
  } else {
    index = viewWindowIndexByWindowId(state.session).get(wid);
  }
  if (index == null && wid != null) {
    const linked = run("tmux", [
      "link-window",
      "-s",
      `${member.id}:0`,
      "-t",
      `${state.session}:`,
    ]);
    if (!linked.ok) {
      addLog(
        state,
        `relink ${member.id} failed: ${linked.stderr.trim() || "unknown"}`,
      );
      return;
    }
    index = viewWindowIndexByWindowId(state.session).get(wid);
    if (index == null) {
      addLog(state, `relinked ${member.id} but cannot resolve window index`);
      return;
    }
    addLog(state, `relinked ${member.id} at window ${index}`);
  }
  openViewWindow(state, index);
}

function openChooser() {
  run("tmux", ["choose-tree", "-w"]);
}

function sendA2a(action, targets, body) {
  const args = ["--from", "user"];
  if (targets.length === 0) {
    args.push(action === "ask" ? "--ask" : "--message");
  } else {
    if (action === "ask") args.push("--ask");
    for (const target of targets) args.push(`--${target}`);
  }
  args.push(body);
  const result = run("a2a", args, {
    env: { A2A_OPERATOR_SOURCE: "cli" },
  });
  return {
    ok: result.ok,
    text:
      (result.stdout || result.stderr || "").trim() ||
      (result.ok ? "sent" : "send failed"),
  };
}

function currentTmuxPaneSize() {
  const target = process.env.TMUX_PANE;
  if (!target) return null;
  const result = run("tmux", [
    "display-message",
    "-p",
    "-t",
    target,
    "#{pane_width}\t#{pane_height}",
  ]);
  if (!result.ok) return null;
  const [colsRaw, rowsRaw] = result.stdout.trim().split("\t");
  const cols = Number(colsRaw);
  const rows = Number(rowsRaw);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

function size() {
  const tmuxSize = currentTmuxPaneSize();
  return {
    cols: Math.max(80, tmuxSize?.cols || process.stdout.columns || 120),
    rows: Math.max(24, tmuxSize?.rows || process.stdout.rows || 40),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createState(config) {
  return {
    session: config.session,
    members: config.members,
    memberBySlot: new Map(config.members.map((member) => [member.slot, member])),
    selected: 0,
    rosterScroll: 0,
    previewScroll: 0,
    checked: new Set(),
    mode: "normal",
    promptTitle: "",
    promptAction: null,
    promptTargets: [],
    quickQuery: "",
    input: "",
    log: ["command center ready"],
    help: false,
    state: readA2aState(),
    preview: [],
  };
}

function selectedMember(state) {
  return state.members[state.selected] || null;
}

function selectedAgentId(state) {
  return selectedMember(state)?.id || null;
}

function refresh(state) {
  state.state = readA2aState();
  const agent = selectedAgentId(state);
  state.preview = agent ? captureAgent(`${agent}:0.0`, 500) : [];
  state.previewScroll = clamp(state.previewScroll, 0, maxPreviewScroll(state, 10));
}

function addLog(state, line) {
  const stamp = new Date().toLocaleTimeString();
  state.log.push(`[${stamp}] ${line}`);
  state.log = state.log.slice(-200);
}

function maxPreviewScroll(state, visibleRows) {
  return Math.max(0, state.preview.length - visibleRows);
}

function ensureSelectedVisible(state, visibleRows) {
  if (state.selected < state.rosterScroll) state.rosterScroll = state.selected;
  if (state.selected >= state.rosterScroll + visibleRows) {
    state.rosterScroll = state.selected - visibleRows + 1;
  }
  state.rosterScroll = clamp(
    state.rosterScroll,
    0,
    Math.max(0, state.members.length - visibleRows),
  );
}

function moveSelection(state, delta) {
  state.selected = clamp(
    state.selected + delta,
    0,
    Math.max(0, state.members.length - 1),
  );
  state.previewScroll = 0;
  refresh(state);
}

function renderRosterRow(member, index, state, registered, orphanIds) {
  const active = index === state.selected;
  const checked = state.checked.has(member.id) ? "●" : "○";
  const reg = registered.get(member.id);
  const status = reg?.status || (orphanIds.has(member.id) ? "tmux-only" : "unknown");
  const mode = reg?.yolo === true ? "yolo" : reg?.yolo === false ? "safe" : "";
  const quick = member.slot >= 1 && member.slot <= 9 ? String(member.slot) : " ";
  const slotLabel = String(member.slot).padStart(2, " ");
  return {
    active,
    status,
    text: `${quick} ${checked} #${slotLabel} ${member.id.padEnd(18)} ${status.padEnd(10)} ${mode}`,
  };
}

function renderRoster(state, width, height) {
  const visibleRows = Math.max(0, height - 2);
  ensureSelectedVisible(state, visibleRows);
  const registered = new Map(
    state.state.registered.map((agent) => [agent.agentId, agent]),
  );
  const orphanIds = new Set(state.state.orphans);
  const inner = Math.max(0, width - 2);
  const rows = state.members
    .map((member, index) =>
      renderRosterRow(member, index, state, registered, orphanIds),
    )
    .slice(state.rosterScroll, state.rosterScroll + visibleRows);
  const bodyLines = rows.map((row) => clipPlain(row.text, inner));
  const rendered = panel(
    width,
    height,
    `Agents ${state.rosterScroll + 1}-${Math.min(state.members.length, state.rosterScroll + visibleRows)}/${state.members.length}`,
    bodyLines,
  );
  for (let i = 0; i < rows.length && i + 1 < rendered.length - 1; i++) {
    if (!rows[i].active) continue;
    const content = rendered[i + 1].slice(1, -1);
    rendered[i + 1] = `${BOX.v}${ANSI.bg.active}${ANSI.bold}${content}${ANSI.reset}${BOX.v}`;
  }
  return rendered;
}

function renderPreview(state, width, height) {
  const selected = selectedMember(state);
  const visibleRows = Math.max(0, height - 2);
  const maxScroll = maxPreviewScroll(state, visibleRows);
  state.previewScroll = clamp(state.previewScroll, 0, maxScroll);
  const end = state.preview.length - state.previewScroll;
  const start = Math.max(0, end - visibleRows);
  const lines = state.preview.slice(start, end);
  const title = selected
    ? `Preview ${selected.id} - slot ${selected.slot} - scroll ${state.previewScroll}/${maxScroll}`
    : "Preview none";
  return panel(width, height, title, lines);
}

function renderFooter(state, width) {
  if (state.mode === "quick-target") {
    return [
      `${ANSI.bg.bar}${ANSI.bold} open agent by name: ${ANSI.reset}${ANSI.bg.bar}${state.quickQuery}${" ".repeat(Math.max(0, width - state.quickQuery.length - 22))}${ANSI.reset}`,
      `${ANSI.fg.muted} type name filter · enter opens first match · esc cancel${ANSI.reset}`,
    ];
  }
  if (state.mode === "prompt") {
    return [
      `${ANSI.bg.bar}${ANSI.bold} ${state.promptTitle}: ${ANSI.reset}${ANSI.bg.bar}${state.input}${" ".repeat(Math.max(0, width - state.promptTitle.length - state.input.length - 3))}${ANSI.reset}`,
      `${ANSI.fg.muted} enter submit · esc cancel${ANSI.reset}`,
    ];
  }
  if (state.help) {
    const parts = HELP.map(([key, desc]) => `${key} ${desc}`);
    const lines = [];
    let current = "";
    for (const part of parts) {
      const plain = stripAnsi(current ? `${current}   ${part}` : part);
      if (plain.length > width && current) {
        lines.push(current);
        current = part;
      } else {
        current = current ? `${current}   ${part}` : part;
      }
    }
    if (current) lines.push(current);
    return lines.slice(0, 4);
  }
  return [
    `${ANSI.fg.muted}↑/↓ select · Enter open real tab · 1-9 quick open · q open by name · m message · a ask · space mark · g group · b broadcast · r refresh · x quit${ANSI.reset}`,
  ];
}

function quickTargetMatches(state) {
  const query = state.quickQuery.toLowerCase();
  return state.members.filter((member) =>
    member.id.toLowerCase().includes(query),
  );
}

function quickTargetLines(state) {
  const matches = quickTargetMatches(state).slice(0, 8);
  if (matches.length === 0) return ["no matching agents"];
  return matches.map((member, index) =>
    `${index + 1}. ${member.id}  slot ${member.slot}`,
  );
}

function render(state) {
  const { cols, rows } = size();
  const leftWidth = Math.min(54, Math.max(32, Math.floor(cols * 0.34)));
  const rightWidth = Math.max(20, cols - leftWidth - 1);
  const footerLines = renderFooter(state, cols);
  const headerHeight = 3;
  const footerHeight = footerLines.length + 1;
  const bodyHeight = Math.max(12, rows - headerHeight - footerHeight);
  const roster = renderRoster(state, leftWidth, bodyHeight);
  const preview =
    state.mode === "quick-target"
      ? panel(rightWidth, bodyHeight, "Open Agent By Name", quickTargetLines(state))
      : renderPreview(state, rightWidth, bodyHeight);
  const body = hjoin([roster, preview], " ");
  const bridge =
    state.state.bridgeError == null
      ? `${ANSI.fg.ok}bridge ok${ANSI.reset}`
      : `${ANSI.fg.bad}${state.state.bridgeError}${ANSI.reset}`;
  const checked = state.checked.size ? ` · ${state.checked.size} selected` : "";
  const selected = selectedMember(state);
  const selectedText = selected ? ` · selected ${selected.id}#${selected.slot}` : "";
  const title = `${ANSI.bold}${ANSI.fg.title}a2a command center${ANSI.reset} ${ANSI.fg.muted}${state.session}${checked}${selectedText}${ANSI.reset}`;
  const status = `${bridge} · ${state.members.length} agents · ${new Date().toLocaleTimeString()}`;
  process.stdout.write(
    `${ANSI.home
      }${ANSI.bg.bar} ${title}${" ".repeat(Math.max(0, cols - visibleWidth(title) - visibleWidth(status) - 3))}${status} ${ANSI.reset}\n` +
      `${ANSI.fg.muted}${BOX.h.repeat(cols)}${ANSI.reset}\n${
      body.join("\n")
      }\n` +
      `${ANSI.fg.muted}${BOX.h.repeat(cols)}${ANSI.reset}\n${
      footerLines.map((line) => clipPlain(line, cols)).join("\n")
      }${ANSI.reset}`,
  );
}

function beginPrompt(state, title, action, targets) {
  state.mode = "prompt";
  state.promptTitle = title;
  state.promptAction = action;
  state.promptTargets = targets;
  state.input = "";
}

function submitPrompt(state) {
  const body = state.input.trim();
  const action = state.promptAction;
  const targets = state.promptTargets;
  state.mode = "normal";
  state.promptTitle = "";
  state.promptAction = null;
  state.promptTargets = [];
  state.input = "";
  if (!body || !action) return;
  const result = sendA2a(action, targets, body);
  addLog(
    state,
    `${result.ok ? "sent" : "failed"} ${action} ${targets.length ? targets.join(",") : "broadcast"}: ${result.text}`,
  );
  refresh(state);
}

function cancelPrompt(state) {
  state.mode = "normal";
  state.promptTitle = "";
  state.promptAction = null;
  state.promptTargets = [];
  state.input = "";
}

function cancelQuickTarget(state) {
  state.mode = "normal";
  state.quickQuery = "";
}

function isEnterKey(str, key) {
  return (
    key?.name === "return" ||
    key?.name === "enter" ||
    str === "\r" ||
    str === "\n"
  );
}

function handleQuickTargetKey(state, str, key) {
  if (key.name === "escape") {
    cancelQuickTarget(state);
    return;
  }
  if (isEnterKey(str, key)) {
    const match = quickTargetMatches(state)[0];
    cancelQuickTarget(state);
    if (match) jumpToAgent(state, match);
    return;
  }
  if (key.name === "backspace") {
    state.quickQuery = state.quickQuery.slice(0, -1);
    return;
  }
  if (str && !key.ctrl && !key.meta && str.length === 1) {
    state.quickQuery += str;
  }
}

function handlePromptKey(state, str, key) {
  if (key.name === "escape") {
    cancelPrompt(state);
    return;
  }
  if (isEnterKey(str, key)) {
    submitPrompt(state);
    return;
  }
  if (key.name === "backspace") {
    state.input = state.input.slice(0, -1);
    return;
  }
  if (str && !key.ctrl && !key.meta) state.input += str;
}

function handleNormalKey(state, str, key) {
  const selected = selectedMember(state);
  if (key.name === "x") return false;
  if (/^[1-9]$/.test(str || "")) {
    const slot = Number(str);
    const member = state.memberBySlot.get(slot);
    if (member) jumpToAgent(state, member);
    return true;
  }
  if (isEnterKey(str, key)) {
    if (selected) jumpToAgent(state, selected);
    return true;
  }
  switch (key.name) {
    case "up":
      moveSelection(state, -1);
      return true;
    case "down":
      moveSelection(state, 1);
      return true;
    case "pageup":
      state.previewScroll = Math.min(
        state.previewScroll + 10,
        maxPreviewScroll(state, size().rows - 10),
      );
      return true;
    case "pagedown":
      state.previewScroll = Math.max(0, state.previewScroll - 10);
      return true;
    case "home":
      state.rosterScroll = 0;
      state.selected = 0;
      state.previewScroll = 0;
      refresh(state);
      return true;
    case "end":
      state.selected = Math.max(0, state.members.length - 1);
      state.previewScroll = 0;
      refresh(state);
      return true;
    case "q":
      state.mode = "quick-target";
      state.quickQuery = "";
      return true;
    case "space":
      if (selected) {
        if (state.checked.has(selected.id)) state.checked.delete(selected.id);
        else state.checked.add(selected.id);
      }
      return true;
    case "m":
      if (selected) beginPrompt(state, `message ${selected.id}`, "message", [selected.id]);
      return true;
    case "a":
      if (selected) beginPrompt(state, `ask ${selected.id}`, "ask", [selected.id]);
      return true;
    case "g": {
      const targets = [...state.checked];
      if (targets.length) beginPrompt(state, `message ${targets.join(",")}`, "message", targets);
      else addLog(state, "mark agents with space before group send");
      return true;
    }
    case "b":
      beginPrompt(state, "broadcast message", "message", []);
      return true;
    case "r":
    case "p":
    case "l":
      refresh(state);
      addLog(state, "refreshed");
      return true;
    case "c":
      openChooser();
      return true;
    case "?":
      state.help = !state.help;
      return true;
    default:
      if (str === "?") state.help = !state.help;
      return true;
  }
}

function cleanup() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  process.stdout.write(ANSI.show + ANSI.main + ANSI.reset);
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  const state = createState(config);
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(ANSI.alt + ANSI.hide + ANSI.clear);
  refresh(state);
  render(state);
  const redraw = () => render(state);
  process.stdout.on("resize", redraw);
  const timer = setInterval(() => {
    if (state.mode === "normal") {
      refresh(state);
      render(state);
    }
  }, 5000);
  process.stdin.on("keypress", (str, key = {}) => {
    if (key.ctrl && key.name === "c") {
      clearInterval(timer);
      cleanup();
      process.exit(0);
    }
    let keepRunning = true;
    if (state.mode === "prompt") handlePromptKey(state, str, key);
    else if (state.mode === "quick-target") handleQuickTargetKey(state, str, key);
    else keepRunning = handleNormalKey(state, str, key);
    if (!keepRunning) {
      clearInterval(timer);
      cleanup();
      process.exit(0);
    }
    render(state);
  });
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    clearInterval(timer);
    cleanup();
    process.exit(0);
  });
}

main();
