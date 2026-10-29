#!/usr/bin/env python3
"""
a2a iTerm2 plugin.

Makes iTerm mode work like tmux mode: an agent runs inside a tmux session, and
iTerm2 only *presents* it through its tmux integration (`tmux -CC`). Closing
the iTerm window or tab no longer ends the agent — the tmux session keeps the
process, and `present` brings the same running process back. See
iterm2-plugin.md ("Agent persistence in iTerm mode").

This process is the a2a iTerm2 bridge plus plugin surfaces:

  * every socket op the bridge already serves (cmd/a2a-iterm2-bridge/bridge.py
    OPS), on the same Unix socket, so the Node CLI and server need no change
    to keep working;
  * `present {session}` — open (or un-hide) and focus an agent's tmux window
    in iTerm2 through `tmux -CC`;
  * `status` — what the plugin sees: tmux control connections, a2a agents,
    unread attention, the Toolbelt port;
  * `notify {agent, token, kind?, text?}` — an authenticated agent event that
    arrived over the socket (the agent's window is not presented);
  * `clear_unread {agent}`; `show_toolbelt` (reveal the a2a Toolbelt tool);
  * `watch` — a streaming op: one JSON line per iTerm2 session created,
    terminated, focused, or renamed/retagged, so the Node bridge drops its
    cached session list on change instead of waiting out the list's TTL;
  * the "a2a" status-bar component: agent count, a red unread badge fed by
    agent events, and a click that focuses the agent needing attention most
    and clears only that agent's unread;
  * the agent event channel: `OSC 1337 ; Custom=id=a2a:<payload> ST` written
    by `a2a notify` into the agent's pane, attributed by iTerm2 to the
    emitting session and accepted only when the payload's per-agent token
    verifies and the emitting session belongs to the claimed agent;
  * the "a2a" Toolbelt tool: a loopback web view (random port, capability
    token) serving toolbelt.html, an agent console styled after the VS Code
    chat sidebar: agent switcher, per-agent activity, multi-select with a
    shared or per-agent message, sent through the a2a CLI as an operator send.

Registrations with iTerm2 (status bar, Toolbelt, event subscription) are scoped
to one API connection, so they are redone on every reconnect via
bridge.ON_CONNECT. Unread state and the Toolbelt server live for the process.

Run with the same Python the bridge uses:
    cmd/a2a-iterm2-bridge/launch.sh start       (launch.sh runs this file)
"""

import asyncio
import base64
import binascii
import collections
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import iterm2

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "a2a-iterm2-bridge" / "bridge.py"
_spec = importlib.util.spec_from_file_location("a2a_iterm2_bridge", _BRIDGE_PATH)
bridge = importlib.util.module_from_spec(_spec)
sys.modules["a2a_iterm2_bridge"] = bridge
_spec.loader.exec_module(bridge)

PLUGIN_VERSION = "1.1"
STATUS_COMPONENT_ID = "com.a2a.plugin.status"
TOOLBELT_TOOL_ID = "com.a2a.plugin.toolbelt"
INSTALL_TOKEN_OPTION = "@a2a-install-token"
# How long `present` waits for iTerm2 to report a new `tmux -CC` connection
# and its tabs after it starts the gateway.
PRESENT_ATTACH_TIMEOUT_S = 8.0
PRESENT_POLL_S = 0.25

REPO_ROOT = Path(__file__).resolve().parents[2]
A2A_CLI = REPO_ROOT / "bin" / "a2a.mjs"

# Agent events. The wire format is shared with src/cli/plugin-notify.mjs:
#   OSC 1337 ; Custom=id=a2a:v1:<agentId>:<token>:<base64url(JSON {kind,text})> BEL
# token = first 32 hex chars of HMAC-SHA256(secret, "a2a-notify-v1:<agentId>"),
# secret = SECRET_PATH (mode 0600, created by the plugin).
SECRET_PATH = bridge.SOCKET_PATH.parent / "iterm2-plugin.secret"
NOTIFY_IDENTITY = "a2a"
NOTIFY_MAX_PAYLOAD = 4096
NOTIFY_MAX_TEXT = 512
NOTIFY_PAYLOAD_RE = re.compile(r"^v1:([A-Za-z0-9_-]+):([0-9a-f]{32}):([A-Za-z0-9_-]*)$")
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# Higher wins when a status-bar click picks which agent to focus.
KIND_PRIORITY = {"attention": 3, "done": 2, "info": 1}


def _tmux_bin():
    return shutil.which("tmux") or "tmux"


def _tmux(*args):
    """Run tmux synchronously; returns (status, stdout, stderr)."""
    try:
        r = subprocess.run([_tmux_bin(), *args], capture_output=True, text=True, timeout=10)
    except Exception as exc:
        return 1, "", f"{type(exc).__name__}: {exc}"
    return r.returncode, r.stdout, r.stderr


def _session_id(session):
    """`$N` id of a tmux session by exact name, or None."""
    status, out, _ = _tmux("list-sessions", "-F", "#{session_id}\t#{session_name}")
    if status != 0:
        return None
    for line in out.splitlines():
        sid, _, name = line.partition("\t")
        if name == session:
            return sid
    return None


def _window_id(target):
    """tmux global window id (`@N`) for a session or `session:window` target."""
    status, out, _ = _tmux("display-message", "-p", "-t", target, "#{window_id}")
    window = out.strip()
    return window if status == 0 and window.startswith("@") else None


def _session_window_ids(session_id):
    """Global window ids (`@N`) of every window in a tmux session (by `$N`)."""
    status, out, _ = _tmux("list-windows", "-t", session_id, "-F", "#{window_id}")
    if status != 0:
        return set()
    return {line.strip() for line in out.splitlines() if line.strip()}


def _control_clients(session_id):
    status, out, _ = _tmux("list-clients", "-t", session_id, "-F", "#{client_tty}\t#{client_control_mode}")
    if status != 0:
        return []
    return [tty for tty, _, mode in (line.partition("\t") for line in out.splitlines()) if tty and mode == "1"]


async def _connection_for_session(connection, session):
    """The iTerm2 tmux connection attached to `session`, or None."""
    for conn in await iterm2.async_get_tmux_connections(connection):
        try:
            name = (await conn.async_send_command("display-message -p '#S'")).strip()
        except Exception:
            continue
        if name == session:
            return conn
    return None


def _tab_for_window(app, window_id):
    """The iTerm2 tab showing tmux window `@N`, or None. iTerm reports the id
    without the `@` (measured: tmux `@0` ↔ Tab.tmux_window_id `'0'`)."""
    bare = window_id.lstrip("@")
    for term_window in app.terminal_windows:
        for tab in term_window.tabs:
            if tab.tmux_connection_id and str(tab.tmux_window_id) == bare:
                return term_window, tab
    return None, None


async def op_present(app, connection, params):
    """Show an agent's tmux window in iTerm2 and focus it.

    params: {session: tmux session name, target?: `session:window` (defaults
    to the session's current window)}. Creates the `tmux -CC` gateway when no
    iTerm2 connection is attached to the session, un-hides the window when the
    operator closed (hid) it, then activates its tab. The agent process is
    never touched: presenting is view-only.
    """
    session = params.get("session")
    if not isinstance(session, str) or not session:
        return {"ok": False, "error": "session required"}
    sid = _session_id(session)
    if sid is None:
        return {"ok": False, "error": f"no tmux session '{session}'"}
    target = params.get("target") if isinstance(params.get("target"), str) and params.get("target") else sid
    window_id = _window_id(target)
    if window_id is None:
        return {"ok": False, "error": f"no tmux window for '{target}'"}

    conn = await _connection_for_session(connection, session)
    created_gateway = False
    if conn is None:
        # Any control client still attached is a stale gateway iTerm2 no longer
        # tracks; iTerm2 refuses a second `-CC attach` while one exists.
        for tty in _control_clients(sid):
            _tmux("detach-client", "-t", tty)
        # Windows the operator closed with "hide" are skipped on attach.
        _tmux("set-option", "-u", "-t", sid, "@hidden")
        command = f"{_tmux_bin()} -CC attach -t {sid}"
        await iterm2.Window.async_create(connection, command=command)
        created_gateway = True
        deadline = asyncio.get_running_loop().time() + PRESENT_ATTACH_TIMEOUT_S
        while conn is None and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(PRESENT_POLL_S)
            conn = await _connection_for_session(connection, session)
        if conn is None:
            return {"ok": False, "error": f"iTerm2 did not report a tmux connection for '{session}' within {PRESENT_ATTACH_TIMEOUT_S}s"}

    await app.async_refresh()
    term_window, tab = _tab_for_window(app, window_id)
    if tab is None:
        # A window the operator closed (with iTerm's tmux close action set to
        # hide) is hidden, not gone; show it again. iTerm accepts this only
        # for a hidden window and answers INVALID_WINDOW_ID otherwise
        # (measured), which here just means its tab is still being created.
        try:
            await conn.async_set_tmux_window_visible(window_id.lstrip("@"), True)
        except iterm2.TmuxException as exc:
            if "INVALID_WINDOW_ID" not in str(exc):
                raise
    deadline = asyncio.get_running_loop().time() + PRESENT_ATTACH_TIMEOUT_S
    while tab is None and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(PRESENT_POLL_S)
        await app.async_refresh()
        term_window, tab = _tab_for_window(app, window_id)
    if tab is None:
        return {"ok": False, "error": f"tmux window {window_id} of '{session}' has no iTerm2 tab after {PRESENT_ATTACH_TIMEOUT_S}s"}
    await tab.async_activate()
    await term_window.async_activate()
    await app.async_activate()
    current = tab.current_session
    return {"ok": True, "guid": current.session_id if current else None, "window_id": window_id, "created_gateway": created_gateway}


def _a2a_tmux_agents():
    """tmux sessions stamped with an a2a install token, excluding *-view
    dashboards."""
    status, out, _ = _tmux("list-sessions", "-F", f"#{{session_name}}\t#{{{INSTALL_TOKEN_OPTION}}}")
    if status != 0:
        return []
    agents = []
    for line in out.splitlines():
        name, _, token = line.partition("\t")
        if token and name and not name.endswith("-view"):
            agents.append(name)
    return agents


# ---------------------------------------------------------------------------
# Agent events, unread attention, and the per-agent secret
# ---------------------------------------------------------------------------


def load_or_create_secret(path=None):
    """The install secret every notify token derives from. Created once with
    mode 0600; an existing file with wider permissions is narrowed."""
    path = Path(path or SECRET_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.stat().st_mode & 0o077:
            os.chmod(path, 0o600)
        value = path.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise RuntimeError(f"{path} is not a 64-hex-char a2a plugin secret")
        return value
    value = secrets.token_hex(32)
    with os.fdopen(fd, "w", encoding="ascii") as fh:
        fh.write(value + "\n")
    return value


def notify_token(secret, agent_id):
    """Per-agent token. Mirror of notifyToken() in src/cli/plugin-notify.mjs."""
    digest = hmac.new(secret.encode("ascii"), f"a2a-notify-v1:{agent_id}".encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()[:32]


def decode_notify_payload(payload):
    """Parse an OSC payload. Returns (agent, token, body dict) or raises
    ValueError with the rejection reason."""
    if len(payload) > NOTIFY_MAX_PAYLOAD:
        raise ValueError(f"payload over {NOTIFY_MAX_PAYLOAD} bytes")
    match = NOTIFY_PAYLOAD_RE.match(payload)
    if not match:
        raise ValueError("malformed payload")
    agent, token, encoded = match.groups()
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        body = json.loads(raw.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"undecodable body: {type(exc).__name__}") from None
    if not isinstance(body, dict):
        raise ValueError("body is not an object")
    return agent, token, body


def _normalize_event_body(body):
    kind = body.get("kind", "info")
    text = body.get("text", "")
    if kind not in KIND_PRIORITY:
        raise ValueError(f"unknown kind {kind!r}")
    if not isinstance(text, str) or len(text) > NOTIFY_MAX_TEXT:
        raise ValueError(f"text must be a string of at most {NOTIFY_MAX_TEXT} chars")
    return kind, text


class Attention:
    """Unread agent events, per agent. Lives for the plugin process; iTerm2
    reconnects re-apply the badge from here."""

    def __init__(self):
        self.unread = {}
        self.events = collections.deque(maxlen=50)
        self.rejected = collections.deque(maxlen=50)

    def accept(self, agent, kind, text, via, session):
        event = {"agent": agent, "kind": kind, "text": text, "via": via, "session": session, "at": time.time()}
        self.events.append(event)
        entry = self.unread.setdefault(agent, {"count": 0, "priority": 0, "last_at": 0.0, "last_text": "", "last_kind": kind})
        entry["count"] += 1
        entry["priority"] = max(entry["priority"], KIND_PRIORITY[kind])
        entry["last_at"] = event["at"]
        entry["last_text"] = text
        entry["last_kind"] = kind
        return event

    def reject(self, reason, via, session=None, agent=None):
        record = {"reason": reason, "via": via, "session": session, "agent": agent, "at": time.time()}
        self.rejected.append(record)
        print(f"a2a-iterm2-plugin: rejected agent event via {via} (session {session}, agent {agent}): {reason}", flush=True)
        return record

    def total(self):
        return sum(entry["count"] for entry in self.unread.values())

    def top(self):
        """The agent a click should focus: highest event priority, then most
        unread, then most recent."""
        if not self.unread:
            return None
        return max(self.unread, key=lambda a: (self.unread[a]["priority"], self.unread[a]["count"], self.unread[a]["last_at"]))

    def clear(self, agent):
        return self.unread.pop(agent, None) is not None


ATTENTION = Attention()
SECRET = None
# The status-bar component registered on the current connection.
COMPONENT = None


# Sessions whose status-bar instance has been given the current badge.
BADGED_SESSIONS = set()


async def _badge_session(component, session_id):
    try:
        await component.async_set_unread_count(session_id, ATTENTION.total())
    except Exception as exc:
        BADGED_SESSIONS.discard(session_id)
        print(f"a2a-iterm2-plugin: could not badge session {session_id}: {type(exc).__name__}: {exc}", flush=True)


async def refresh_badge():
    component = COMPONENT
    # A per-session count overrides the global one in that instance, so the
    # instances badged individually are updated individually; the global set
    # below reaches every other existing instance, and instances that render
    # later are badged from the status RPC.
    badged = list(BADGED_SESSIONS)
    BADGED_SESSIONS.clear()
    if component is None:
        return
    total = ATTENTION.total()
    for session_id in badged:
        try:
            await component.async_set_unread_count(session_id, total)
        except Exception:
            pass
        if total:
            BADGED_SESSIONS.add(session_id)
    try:
        await component.async_set_unread_count(None, ATTENTION.total())
    except Exception as exc:
        print(f"a2a-iterm2-plugin: could not set unread count: {type(exc).__name__}: {exc}", flush=True)


async def _session_bound_to_agent(app, session_id, agent):
    """Whether iTerm2 session `session_id` presents agent `agent`. A tmux -CC
    tab belongs to the agent when its tmux window is one of the windows of the
    agent's tmux session (dashboard views link the same window ids); a plain
    iTerm2 session belongs to it when its spawn tag says so."""
    session = app.get_session_by_id(session_id)
    if session is None:
        await app.async_refresh()
        session = app.get_session_by_id(session_id)
    if session is None:
        return False, f"unknown iTerm2 session {session_id}"
    _window, tab = app.get_window_and_tab_for_session(session)
    if tab is not None and tab.tmux_connection_id and tab.tmux_window_id is not None:
        sid = _session_id(agent)
        if sid is None:
            return False, f"no tmux session for agent '{agent}'"
        if f"@{tab.tmux_window_id}" in _session_window_ids(sid):
            return True, None
        return False, f"tmux window @{tab.tmux_window_id} is not in the tmux session of agent '{agent}'"
    tagged = await bridge._get_var(session, bridge.AGENT_ID_VAR)
    if tagged == agent:
        return True, None
    return False, f"session is tagged {tagged!r}, not '{agent}'"


async def handle_osc_event(app, session_id, identity, payload):
    if identity != NOTIFY_IDENTITY:
        return None
    try:
        agent, token, body = decode_notify_payload(payload)
        kind, text = _normalize_event_body(body)
    except ValueError as exc:
        return ATTENTION.reject(str(exc), "osc", session_id)
    if not hmac.compare_digest(token, notify_token(SECRET, agent)):
        return ATTENTION.reject("wrong secret", "osc", session_id, agent)
    bound, reason = await _session_bound_to_agent(app, session_id, agent)
    if not bound:
        return ATTENTION.reject(f"attribution: {reason}", "osc", session_id, agent)
    event = ATTENTION.accept(agent, kind, text, "osc", session_id)
    print(f"a2a-iterm2-plugin: {kind} from {agent} (session {session_id}): {text[:80]}", flush=True)
    await refresh_badge()
    return event


async def op_notify(_app, _connection, params):
    """Agent event over the socket, for an agent whose window is not
    presented (no iTerm2 session to emit an OSC into). Authenticated by the
    same per-agent token; there is no emitting session to attribute."""
    agent = params.get("agent")
    token = params.get("token")
    if not isinstance(agent, str) or not AGENT_ID_RE.match(agent):
        ATTENTION.reject("bad agent id", "socket")
        return {"ok": False, "error": "agent must match [A-Za-z0-9_-]+"}
    if not isinstance(token, str) or not hmac.compare_digest(token, notify_token(SECRET, agent)):
        ATTENTION.reject("wrong secret", "socket", agent=agent)
        return {"ok": False, "error": "wrong secret"}
    try:
        kind, text = _normalize_event_body(params)
    except ValueError as exc:
        ATTENTION.reject(str(exc), "socket", agent=agent)
        return {"ok": False, "error": str(exc)}
    event = ATTENTION.accept(agent, kind, text, "socket", None)
    await refresh_badge()
    return {"ok": True, "unread": ATTENTION.unread[agent]["count"], "at": event["at"]}


async def op_clear_unread(_app, _connection, params):
    agent = params.get("agent")
    if not isinstance(agent, str) or not agent:
        return {"ok": False, "error": "agent required"}
    cleared = ATTENTION.clear(agent)
    await refresh_badge()
    return {"ok": True, "cleared": cleared}


async def _focus_agent(app, connection, agent):
    """Present an agent: its tmux window through `tmux -CC`, or a plain
    iTerm2 session carrying its spawn tag."""
    if _session_id(agent) is not None:
        return await op_present(app, connection, {"session": agent})
    for window in app.terminal_windows:
        for tab in window.tabs:
            for session in tab.sessions:
                if await bridge._get_var(session, bridge.AGENT_ID_VAR) == agent:
                    await session.async_activate()
                    await app.async_activate()
                    return {"ok": True, "guid": session.session_id}
    return {"ok": False, "error": f"no tmux or iTerm2 session for '{agent}'"}


async def on_status_click(session_id):
    agent = ATTENTION.top()
    print(f"a2a-iterm2-plugin: status bar clicked in session {session_id}; focusing {agent or '(nothing unread)'}", flush=True)
    if agent is None:
        return
    ATTENTION.clear(agent)
    await refresh_badge()
    link = bridge.LINK
    if link is None:
        return
    result = await _focus_agent(link.app, link.connection, agent)
    if not result.get("ok"):
        print(f"a2a-iterm2-plugin: could not focus '{agent}': {result.get('error')}", flush=True)


def _status_text():
    count = len(_a2a_tmux_agents())
    text = f"a2a {count} agent{'' if count == 1 else 's'}"
    top = ATTENTION.top()
    if top is not None:
        entry = ATTENTION.unread[top]
        snippet = entry["last_text"][:32]
        text += f" · {top}{': ' + snippet if snippet else ''}"
    return text


async def register_status_bar(link):
    global COMPONENT
    component = iterm2.StatusBarComponent(
        short_description="a2a",
        detailed_description="a2a: agents running in tmux, with an unread badge for agent events (a2a notify). Click to focus the agent that needs attention most.",
        knobs=[],
        exemplar="a2a 3 agents · bob: tests pass",
        update_cadence=5,
        identifier=STATUS_COMPONENT_ID,
    )

    @iterm2.StatusBarRPC
    async def a2a_status(knobs, session_id=iterm2.Reference("id")):
        # iTerm2 applies an unread count only to component instances that
        # exist when it is set, so a status bar created later (a new window
        # or tab) would show no badge. Re-apply it for each instance the
        # first time it renders while anything is unread.
        if ATTENTION.total() and session_id not in BADGED_SESSIONS:
            BADGED_SESSIONS.add(session_id)
            asyncio.ensure_future(_badge_session(component, session_id))
        return _status_text()

    await component.async_register(link.connection, a2a_status, onclick=on_status_click)
    COMPONENT = component
    await refresh_badge()
    print(f"a2a-iterm2-plugin: registered status-bar component {STATUS_COMPONENT_ID}", flush=True)


async def register_event_channel(link):
    async def on_custom_sequence(_connection, notification):
        try:
            await handle_osc_event(link.app, notification.session, notification.sender_identity, notification.payload)
        except Exception as exc:
            print(f"a2a-iterm2-plugin: agent event handler failed: {type(exc).__name__}: {exc}", flush=True)

    await iterm2.notifications.async_subscribe_to_custom_escape_sequence_notification(link.connection, on_custom_sequence, None)
    print(f"a2a-iterm2-plugin: listening for OSC 1337 Custom=id={NOTIFY_IDENTITY} agent events", flush=True)


# ---------------------------------------------------------------------------
# Toolbelt: loopback web view with roster, multi-select, targeted sends
# ---------------------------------------------------------------------------

TOOLBELT_MAX_BODY = 64 * 1024
TOOLBELT_MAX_TARGETS = 32
TOOLBELT_MAX_MESSAGE = 8000
CLI_TIMEOUT_S = 30

# The Toolbelt page: one self-contained HTML file next to this module, read
# on every page request so UI edits show up without restarting the plugin.
TOOLBELT_HTML_PATH = Path(__file__).resolve().parent / "toolbelt.html"


# Port and capability token survive plugin restarts (mode 0600 file next to
# the socket), so a Toolbelt panel iTerm2 already has open keeps working
# instead of pointing at a dead port with a dead token.
TOOLBELT_STATE_PATH = bridge.SOCKET_PATH.parent / "iterm2-plugin.toolbelt.json"


def toolbelt_html():
    return TOOLBELT_HTML_PATH.read_text(encoding="utf-8")


def toolbelt_ui_version():
    """Fingerprint of the page on disk. The page embeds the value it was
    served with and reloads itself when the roster reports a different one:
    an open iTerm2 web view never refetches the page on its own."""
    return hashlib.sha256(TOOLBELT_HTML_PATH.read_bytes()).hexdigest()[:16]


def toolbelt_page():
    return toolbelt_html().replace("__A2A_UI_VERSION__", toolbelt_ui_version())


def _cli_env():
    """Environment for a2a CLI calls made on the operator's behalf. Agent and
    tmux identity are stripped so a plugin started from inside an agent's
    pane never sends as that agent; A2A_OPERATOR_SOURCE=cli is the trusted
    operator-surface marker src/cli/sender-identity.mjs honors (as the
    dashboard does), stamping from=user origin=user."""
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "A2A_AGENT_ID", "A2A_SESSION")}
    env["A2A_OPERATOR_SOURCE"] = "cli"
    return env


async def run_a2a_cli(*args, timeout=CLI_TIMEOUT_S):
    node = shutil.which("node")
    if node is None:
        return 127, "", "node not found on PATH"
    proc = await asyncio.create_subprocess_exec(
        node, str(A2A_CLI), *args,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=_cli_env(), cwd=str(REPO_ROOT),
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", f"a2a {args[0]} timed out after {timeout}s"
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def toolbelt_roster():
    status, out, err = await run_a2a_cli("list", "--json", "--no-peers")
    if status != 0:
        return {"ok": False, "error": (err.strip().splitlines() or [f"a2a list exited {status}"])[-1]}
    try:
        listed = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": "a2a list --json returned non-JSON"}
    agents = []
    for agent in listed.get("registered", []):
        agent_id = agent.get("agentId")
        unread = ATTENTION.unread.get(agent_id) or {}
        agents.append({
            "agentId": agent_id,
            "status": agent.get("status"),
            "cohort": agent.get("cohort"),
            "backend": agent.get("backend"),
            "unread": unread.get("count", 0),
            "lastText": unread.get("last_text", ""),
        })
    return {"ok": True, "agents": agents, "unread": ATTENTION.total(), "uiVersion": toolbelt_ui_version()}


async def toolbelt_send(body):
    targets = body.get("targets") if isinstance(body, dict) else None
    if not isinstance(targets, list) or not targets or len(targets) > TOOLBELT_MAX_TARGETS:
        return {"ok": False, "error": f"targets must be a list of 1-{TOOLBELT_MAX_TARGETS} {{agent, text}}"}
    seen = set()
    for target in targets:
        if not isinstance(target, dict):
            return {"ok": False, "error": "each target must be {agent, text}"}
        agent, text = target.get("agent"), target.get("text")
        if not isinstance(agent, str) or not AGENT_ID_RE.match(agent) or agent in seen:
            return {"ok": False, "error": f"bad or duplicate agent {agent!r}"}
        if not isinstance(text, str) or not text.strip() or len(text) > TOOLBELT_MAX_MESSAGE:
            return {"ok": False, "error": f"message for {agent} must be 1-{TOOLBELT_MAX_MESSAGE} chars"}
        seen.add(agent)
    results = []
    for target in targets:
        # `--` ends option parsing in the CLI, so a message beginning with
        # `--` or `from:` is delivered as text, never read as a flag.
        status, _out, err = await run_a2a_cli("say", f"to:{target['agent']}", "--", target["text"])
        lines = [line.removeprefix("a2a: ") for line in err.strip().splitlines() if line.strip()]
        results.append({"agent": target["agent"], "ok": status == 0, "detail": lines[-1] if lines else f"exit {status}"})
    print(f"a2a-iterm2-plugin: toolbelt sent to {', '.join(r['agent'] + ('' if r['ok'] else ' (failed)') for r in results)}", flush=True)
    return {"ok": True, "results": results}


async def toolbelt_focus(body):
    agent = body.get("agent") if isinstance(body, dict) else None
    if not isinstance(agent, str) or not AGENT_ID_RE.match(agent):
        return {"ok": False, "error": "agent required"}
    ATTENTION.clear(agent)
    await refresh_badge()
    link = bridge.LINK
    if link is None:
        return {"ok": False, "error": bridge.DISCONNECTED_ERROR}
    return await _focus_agent(link.app, link.connection, agent)


class Toolbelt:
    """Loopback HTTP server behind the Toolbelt web view. Bound to 127.0.0.1
    on a random port; every request needs the per-process capability token
    (query `t` for the page, header X-A2A-Token for the API) and a Host header
    naming this listener, which also defeats DNS-rebinding pages."""

    def __init__(self):
        self.token = None
        self.server = None
        self.port = None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/?t={self.token}"

    def _load_state(self):
        try:
            data = json.loads(TOOLBELT_STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(data.get("token"), str) and len(data["token"]) >= 24 and isinstance(data.get("port"), int):
                return data["port"], data["token"]
        except (OSError, ValueError, AttributeError):
            pass
        return None, None

    def _save_state(self):
        try:
            fd = os.open(TOOLBELT_STATE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"port": self.port, "token": self.token}, fh)
            os.chmod(TOOLBELT_STATE_PATH, 0o600)
        except OSError as exc:
            print(f"a2a-iterm2-plugin: could not persist toolbelt address: {exc}", flush=True)

    async def ensure_started(self):
        if self.server is not None:
            return
        port, token = self._load_state()
        self.token = token or secrets.token_urlsafe(24)
        if port:
            try:
                self.server = await asyncio.start_server(self._handle, host="127.0.0.1", port=port)
            except OSError:
                self.server = None
        if self.server is None:
            self.server = await asyncio.start_server(self._handle, host="127.0.0.1", port=0)
        self.port = self.server.sockets[0].getsockname()[1]
        self._save_state()
        print(f"a2a-iterm2-plugin: toolbelt server on 127.0.0.1:{self.port}{' (same address as before)' if port == self.port else ''}", flush=True)

    def _authorized(self, presented):
        return isinstance(presented, str) and hmac.compare_digest(presented, self.token)

    async def _handle(self, reader, writer):
        try:
            status, ctype, payload = await self._respond(reader)
        except Exception as exc:
            status, ctype, payload = 500, "application/json", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        body = payload.encode("utf-8")
        head = f"HTTP/1.1 {status} {'OK' if status == 200 else 'Error'}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        try:
            writer.write(head.encode("ascii") + body)
            await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()

    async def _respond(self, reader):
        request_line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1").strip()
        parts = request_line.split(" ")
        if len(parts) != 3:
            return 400, "application/json", json.dumps({"ok": False, "error": "bad request line"})
        method, target, _version = parts
        headers = {}
        for _ in range(100):
            line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1")
            if line in ("\r\n", "\n", ""):
                break
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        if headers.get("host") not in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            return 403, "application/json", json.dumps({"ok": False, "error": "bad host"})
        url = urllib.parse.urlsplit(target)
        if method == "GET" and url.path == "/":
            if not self._authorized(urllib.parse.parse_qs(url.query).get("t", [None])[0]):
                return 403, "text/plain", "forbidden"
            print(f"a2a-iterm2-plugin: toolbelt page served (ui {toolbelt_ui_version()}, {headers.get('user-agent', '?')[:60]})", flush=True)
            return 200, "text/html; charset=utf-8", toolbelt_page()
        if not self._authorized(headers.get("x-a2a-token")):
            return 403, "application/json", json.dumps({"ok": False, "error": "forbidden"})
        body = None
        if method == "POST":
            length = int(headers.get("content-length") or 0)
            if length < 0 or length > TOOLBELT_MAX_BODY:
                return 413, "application/json", json.dumps({"ok": False, "error": "body too large"})
            try:
                body = json.loads((await asyncio.wait_for(reader.readexactly(length), 10)).decode("utf-8")) if length else {}
            except (json.JSONDecodeError, UnicodeDecodeError):
                return 400, "application/json", json.dumps({"ok": False, "error": "bad json"})
        routes = {
            ("GET", "/api/roster"): lambda: toolbelt_roster(),
            ("POST", "/api/send"): lambda: toolbelt_send(body),
            ("POST", "/api/focus"): lambda: toolbelt_focus(body),
        }
        handler = routes.get((method, url.path))
        if handler is None:
            return 404, "application/json", json.dumps({"ok": False, "error": "not found"})
        return 200, "application/json", json.dumps(await handler())


TOOLBELT = Toolbelt()


async def op_show_toolbelt(_app, connection, _params):
    """Open the Toolbelt with the a2a tool showing (re-registration with
    reveal_if_already_registered=True is iTerm2's way to reveal a tool)."""
    await TOOLBELT.ensure_started()
    await iterm2.tool.async_register_web_view_tool(connection, "a2a", TOOLBELT_TOOL_ID, True, TOOLBELT.url)
    return {"ok": True, "port": TOOLBELT.port}


async def register_toolbelt(link):
    await TOOLBELT.ensure_started()
    try:
        await iterm2.tool.async_register_web_view_tool(link.connection, "a2a", TOOLBELT_TOOL_ID, False, TOOLBELT.url)
    except iterm2.RPCException as exc:
        print(f"a2a-iterm2-plugin: toolbelt tool registration refused: {exc}", flush=True)
        return
    print(f"a2a-iterm2-plugin: registered Toolbelt tool {TOOLBELT_TOOL_ID} (View > Toolbelt > a2a)", flush=True)


# ---------------------------------------------------------------------------
# Session lifecycle push (`watch` stream op)
# ---------------------------------------------------------------------------

WATCH_QUEUE_MAX = 256
# Session variables whose change alters how a2a identifies a session: the
# title (untagged sessions fall back to it) and the spawn tag.
WATCHED_SESSION_VARIABLES = ("name", bridge.AGENT_ID_VAR)
WATCHERS = set()


def publish_session_event(event):
    """Fan an event out to every `watch` client. A client that stopped
    reading loses its oldest events, never blocks the plugin."""
    event = {**event, "at": time.time()}
    for queue in list(WATCHERS):
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(event)


async def stream_watch(reader, writer, _params):
    """`watch`: keep the connection open and write one JSON line per iTerm2
    session event (created, terminated, focused, renamed/retagged) plus
    `connected`/`disconnected` for the iTerm2 link. Consumers (the Node
    bridge's probe cache) drop their cached session list on every line, so a
    change is visible on the next lookup instead of after the list's TTL."""
    queue = asyncio.Queue(maxsize=WATCH_QUEUE_MAX)
    WATCHERS.add(queue)
    closed = asyncio.ensure_future(reader.read())
    try:
        writer.write((json.dumps({"ok": True, "watching": True, "connected": bridge.LINK is not None}) + "\n").encode("utf-8"))
        await writer.drain()
        while True:
            getter = asyncio.ensure_future(queue.get())
            done, _ = await asyncio.wait({getter, closed}, return_when=asyncio.FIRST_COMPLETED)
            if closed in done:
                getter.cancel()
                return
            writer.write((json.dumps(getter.result()) + "\n").encode("utf-8"))
            await writer.drain()
    except ConnectionError:
        return
    finally:
        WATCHERS.discard(queue)
        closed.cancel()


async def register_session_events(link):
    notifications = iterm2.notifications

    async def on_new(_connection, message):
        publish_session_event({"event": "session_created", "session": message.session_id})

    async def on_terminate(_connection, message):
        publish_session_event({"event": "session_terminated", "session": message.session_id})

    async def on_focus(_connection, message):
        which = message.WhichOneof("event")
        session = message.session if which == "session" else None
        publish_session_event({"event": "focus_changed", "kind": which, "session": session})

    async def on_variable(_connection, message):
        publish_session_event({"event": "session_identity_changed", "session": message.identifier, "variable": message.name})

    await notifications.async_subscribe_to_new_session_notification(link.connection, on_new)
    await notifications.async_subscribe_to_terminate_session_notification(link.connection, on_terminate)
    await notifications.async_subscribe_to_focus_change_notification(link.connection, on_focus)
    for name in WATCHED_SESSION_VARIABLES:
        await notifications.async_subscribe_to_variable_change_notification(link.connection, on_variable, iterm2.VariableScopes.SESSION.value, name, "all")
    publish_session_event({"event": "connected"})
    asyncio.ensure_future(_publish_disconnect(link))
    print("a2a-iterm2-plugin: publishing session lifecycle events to watch clients", flush=True)


async def _publish_disconnect(link):
    await link.closed.wait()
    publish_session_event({"event": "disconnected"})


# ---------------------------------------------------------------------------
# status op and wiring
# ---------------------------------------------------------------------------


async def op_status(app, connection, _params):
    conns = []
    for conn in await iterm2.async_get_tmux_connections(connection):
        try:
            session = (await conn.async_send_command("display-message -p '#S'")).strip()
        except Exception:
            session = None
        conns.append({"connection_id": conn.connection_id, "session": session})
    return {
        "ok": True,
        "version": PLUGIN_VERSION,
        "pid": os.getpid(),
        "tmux_connections": conns,
        "tmux_agents": _a2a_tmux_agents(),
        "unread": {agent: dict(entry) for agent, entry in ATTENTION.unread.items()},
        "unread_total": ATTENTION.total(),
        "events": list(ATTENTION.events),
        "rejected": list(ATTENTION.rejected),
        "toolbelt_port": TOOLBELT.port,
        "watchers": len(WATCHERS),
        # The socket is mode 0600, so its clients are this user; the token
        # guards the loopback port against web pages, not against the user.
        "toolbelt_url": TOOLBELT.url if TOOLBELT.port else None,
    }


bridge.OPS["present"] = op_present
bridge.OPS["status"] = op_status
bridge.OPS["notify"] = op_notify
bridge.OPS["clear_unread"] = op_clear_unread
bridge.OPS["show_toolbelt"] = op_show_toolbelt
bridge.STREAM_OPS["watch"] = stream_watch
bridge.ON_CONNECT.extend([register_status_bar, register_event_channel, register_toolbelt, register_session_events])


async def plugin_main():
    global SECRET
    SECRET = load_or_create_secret()
    await bridge.main()


if __name__ == "__main__":
    print(f"a2a-iterm2-plugin {PLUGIN_VERSION} (bridge {bridge.VERSION})", flush=True)
    asyncio.run(plugin_main())
