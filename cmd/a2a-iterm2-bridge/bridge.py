#!/usr/bin/env python3
"""
a2a iTerm2 bridge.

Long-running apython process. Connects to iTerm2's Python API and exposes
a small JSON-over-UNIX-socket protocol so other tools (a2a's Node CLI) can
route messages into iTerm2 sessions by GUID without shelling out to tmux.

Wire format
-----------
Per connection: client sends one JSON object, terminated by newline.
Server writes one JSON object, terminated by newline, then closes.

Request:  {"op": "<name>", "params": {...}}
Response: {"ok": true, ...}  |  {"ok": false, "error": "..."}

Ops
---
ping                        -> {ok, version}  # ok=false while the iTerm2
                                              # API connection is down
list_sessions               -> {ok, sessions: [{guid, name, job_name, pwd, window_id, tab_id,
                                                install_token, agent_id}]}
send_text  {guid, text,
           submit=false,
           submit_bytes="\\r"} -> {ok, bytes}
send_keys  {guid,
            steps: [ {type:"paste"|"type"|"key"|"chord"|"sleep", ...}, ... ]}
                            -> {ok, bytes}
screen     {guid, lines=40} -> {ok, lines: [str, ...]}
spawn      {name, cwd, command,
            where="window"|"tab",
            parent_guid?,
            install_token?,
            shell?,
            path_env?}       -> {ok, guid}
close      {guid}            -> {ok}
focus      {guid}            -> {ok}
set_name   {guid, name}      -> {ok}
configure_session
           {guid,
            native_scroll?}  -> {ok}    # native_scroll true = wheel scrolls
                                        # iterm buffer (not arrows to app)
"""

import asyncio
import fcntl
import json
import os
import shlex
import signal
import sys
import tempfile
from pathlib import Path

import iterm2

VERSION = "0.3"
SOCKET_PATH = Path(
    os.environ.get(
        "A2A_ITERM2_BRIDGE_SOCKET",
        str(Path.home() / ".local/state/a2a/iterm2-bridge.sock"),
    )
)

# Ownership map: guid -> install_token. The tmux side proves a2a-ownership via
# the @a2a-install-token session option (set at spawn, checked at kill --all
# orphan sweep). iTerm sessions have no per-session option, so the bridge owns
# the equivalent map and persists it next to the socket. The contract:
# spawn writes the token, list_sessions reports the token alongside guid+name,
# close removes the entry. The map survives bridge restarts so a CLI restart
# preserves orphan-detection ability.
OWNERSHIP_PATH = Path(
    os.environ.get(
        "A2A_ITERM2_BRIDGE_OWNERSHIP",
        str(Path.home() / ".local/state/a2a/iterm2-bridge.ownership.json"),
    )
)


def _load_ownership():
    try:
        with open(OWNERSHIP_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(v, str)}
    except FileNotFoundError:
        pass
    except Exception:
        # Corrupt file is non-fatal — start with an empty map and the next
        # write will overwrite it. Keeps the bridge from refusing to boot.
        pass
    return {}


def _save_ownership(owner_map):
    try:
        OWNERSHIP_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: dump to a temp file, then rename. Avoids leaving a
        # half-written file if the bridge dies during a write.
        tmp = OWNERSHIP_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(owner_map, fh, sort_keys=True)
        tmp.replace(OWNERSHIP_PATH)
    except Exception:
        # Non-fatal: if persistence fails, in-memory ownership still works
        # until bridge restart.
        pass


OWNERSHIP = _load_ownership()

# iTerm2 user variable holding the a2a agent id a session was spawned for.
# Lives in iTerm2's own session state, so it survives bridge restarts.
AGENT_ID_VAR = "user.a2a_agent_id"


async def _get_var(session, name):
    try:
        return await session.async_get_variable(name)
    except Exception:
        return None


async def op_ping(_app, _connection, _params):
    return {"ok": True, "version": VERSION}


async def op_list_sessions(app, _connection, _params):
    out = []
    seen_guids = set()
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.sessions:
                guid = session.session_id
                seen_guids.add(guid)
                out.append({
                    "guid": guid,
                    "name": await _get_var(session, "name"),
                    "job_name": await _get_var(session, "jobName"),
                    "pwd": await _get_var(session, "path"),
                    "window_id": window.window_id,
                    "tab_id": tab.tab_id,
                    # install_token: the ownership marker set by spawn.
                    # Consumers (a2a kill --all orphan sweep) use this to
                    # decide whether the session is a2a-owned. tmux equiv:
                    # @a2a-install-token session option.
                    "install_token": OWNERSHIP.get(guid),
                    # agent_id: the tag op_spawn writes. Unlike `name` it
                    # survives the program retitling the tab. Null for
                    # sessions spawned before tagging existed.
                    "agent_id": await _get_var(session, AGENT_ID_VAR),
                })
    # Garbage-collect ownership entries for sessions that no longer exist.
    # Without this, the file accumulates dead guids forever.
    stale = [g for g in OWNERSHIP if g not in seen_guids]
    if stale:
        for g in stale:
            OWNERSHIP.pop(g, None)
        _save_ownership(OWNERSHIP)
    return {"ok": True, "sessions": out}


async def op_send_text(app, _connection, params):
    guid = params.get("guid")
    text = params.get("text", "")
    submit = bool(params.get("submit", False))
    submit_bytes = params.get("submit_bytes", "\r")
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    if not isinstance(text, str):
        return {"ok": False, "error": "text must be a string"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    # Wrap in bracketed-paste markers so the receiving TUI sees one paste
    # event, not a stream of keystrokes. Without these, large payloads (e.g.
    # startup personas) get chunked by the TUI into multiple
    # "[Pasted text #N]" placeholders, and any text already in the input
    # field gets prefixed onto the message.
    # Submit bytes go AFTER the paste-end marker so the submit key is treated
    # as a real key press, not part of the pasted content.
    payload = PASTE_BEGIN + text + PASTE_END + (submit_bytes if submit else "")
    await session.async_send_text(payload)
    return {"ok": True, "bytes": len(payload.encode("utf-8"))}


# Canonical key table. Mirrors src/key-sequence.mjs KEY_TABLE — keep in sync.
ESC = "\x1b"
KEY_BYTES = {
    "ENTER":  "\r",
    "ESC":    ESC,
    "TAB":    "\t",
    "BTAB":   ESC + "[Z",
    "SPACE":  " ",
    "BSPACE": "\x7f",
    "UP":     ESC + "[A",
    "DOWN":   ESC + "[B",
    "RIGHT":  ESC + "[C",
    "LEFT":   ESC + "[D",
    "HOME":   ESC + "OH",
    "END":    ESC + "OF",
    "PGUP":   ESC + "[5~",
    "PGDN":   ESC + "[6~",
    "INS":    ESC + "[2~",
    "DEL":    ESC + "[3~",
    "F1":     ESC + "OP",
    "F2":     ESC + "OQ",
    "F3":     ESC + "OR",
    "F4":     ESC + "OS",
    "F5":     ESC + "[15~",
    "F6":     ESC + "[17~",
    "F7":     ESC + "[18~",
    "F8":     ESC + "[19~",
    "F9":     ESC + "[20~",
    "F10":    ESC + "[21~",
    "F11":    ESC + "[23~",
    "F12":    ESC + "[24~",
}

PASTE_BEGIN = "\x1b[200~"
PASTE_END = "\x1b[201~"


def _chord_bytes(mods, key):
    """Mirror of chordBytes() in src/key-sequence.mjs."""
    if key in KEY_BYTES:
        payload = KEY_BYTES[key]
        if "C" in mods and key == "ENTER":
            payload = ESC + "\r"
        elif "S" in mods and key == "TAB":
            payload = KEY_BYTES["BTAB"]
    elif len(key) == 1:
        target = key
        if "S" in mods:
            target = target.upper()
        if "C" in mods:
            payload = chr(ord(target) & 0x1F)
        else:
            payload = target
    else:
        raise ValueError(f"unknown chord tail: {key!r}")
    if "M" in mods:
        payload = ESC + payload
    return payload


async def op_send_keys(app, _connection, params):
    guid = params.get("guid")
    steps = params.get("steps", [])
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    if not isinstance(steps, list) or not steps:
        return {"ok": False, "error": "steps must be a non-empty list"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    total = 0
    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            return {"ok": False, "error": f"step {idx} is not an object"}
        kind = step.get("type")
        try:
            if kind == "paste":
                text = step.get("text", "")
                if not isinstance(text, str):
                    return {"ok": False, "error": f"step {idx}: paste text must be string"}
                payload = PASTE_BEGIN + text + PASTE_END
            elif kind == "type":
                text = step.get("text", "")
                if not isinstance(text, str):
                    return {"ok": False, "error": f"step {idx}: type text must be string"}
                payload = text
            elif kind == "key":
                name = step.get("key")
                if name not in KEY_BYTES:
                    return {"ok": False, "error": f"step {idx}: unknown key {name!r}"}
                payload = KEY_BYTES[name]
            elif kind == "chord":
                mods = step.get("mods") or []
                key = step.get("key")
                if not isinstance(mods, list) or not isinstance(key, str):
                    return {"ok": False, "error": f"step {idx}: bad chord shape"}
                payload = _chord_bytes(mods, key)
            elif kind == "sleep":
                ms = step.get("ms", 0)
                if not isinstance(ms, int) or ms < 0:
                    return {"ok": False, "error": f"step {idx}: bad sleep ms"}
                await asyncio.sleep(ms / 1000)
                continue
            else:
                return {"ok": False, "error": f"step {idx}: unknown type {kind!r}"}
        except Exception as exc:
            return {"ok": False, "error": f"step {idx}: {type(exc).__name__}: {exc}"}
        await session.async_send_text(payload)
        total += len(payload.encode("utf-8"))
    return {"ok": True, "bytes": total}


async def op_screen(app, _connection, params):
    guid = params.get("guid")
    lines = int(params.get("lines", 40))
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    contents = await session.async_get_screen_contents()
    total = contents.number_of_lines
    take = min(max(lines, 0), total)
    start = total - take
    rows = [contents.line(i).string for i in range(start, total)]
    return {"ok": True, "lines": rows}


def _write_spawn_script(cwd, command, shell, path_env):
    """Write a wrapper script that runs `command` from `cwd` using the
    caller-supplied shell. NOT self-deleting — earlier versions did
    `rm $0` then `exec backend`, which made iTerm display `execvp failed`
    when it tried to re-spawn on profile restore. A background sleep+rm
    cleans up after ~60s instead.

    `shell` is the user's actual shell (`$SHELL` captured by the CLI). We
    avoid login mode (`-l`) entirely — sourcing every rc file adds 1-3s
    of startup latency on common setups (nvm, oh-my-zsh, etc.). PATH is
    instead injected explicitly by the caller so the backend resolves the
    same way it would in the caller's terminal."""
    fd, path = tempfile.mkstemp(prefix="a2a-spawn-", suffix=".sh")
    shebang = f"#!{shell}\n" if shell else "#!/bin/sh\n"
    path_export = (
        f"export PATH={shlex.quote(path_env)}\n" if path_env else ""
    )
    body = (
        shebang
        + path_export
        + f"cd {shlex.quote(cwd)} || exit 1\n"
        # Background cleanup: detach a sleep+rm so the original PID can
        # `exec` into the backend without leaving the script on disk
        # forever. The 60s window covers the slowest reasonable iTerm
        # profile-init step.
        # Plain `&` for portability — `&!` is zsh-only and breaks bash/sh.
        # The subshell is orphaned when the parent execs into the backend,
        # gets reparented to init, and dies on its own after 60s.
        + f"( sleep 60 && rm -f -- {shlex.quote(path)} ) >/dev/null 2>&1 &\n"
        + f"{command}\n"
    )
    with os.fdopen(fd, "w") as fh:
        fh.write(body)
    os.chmod(path, 0o700)
    return path


async def op_spawn(app, connection, params):
    name = params.get("name")
    cwd = params.get("cwd") or os.path.expanduser("~")
    command = params.get("command")
    where = params.get("where", "window")
    parent_guid = params.get("parent_guid")
    install_token = params.get("install_token")
    # `shell` and `path_env` come from the CLI's process.env so the new
    # session inherits the user's shell choice and PATH without paying for a
    # login-shell rc replay on every spawn. Falls back to /bin/sh if unset.
    shell = params.get("shell") or os.environ.get("SHELL") or "/bin/sh"
    path_env = params.get("path_env") or os.environ.get("PATH") or ""

    if not isinstance(name, str) or not name:
        return {"ok": False, "error": "name required"}
    if not isinstance(command, str) or not command:
        return {"ok": False, "error": "command required"}
    if not isinstance(cwd, str) or not cwd:
        return {"ok": False, "error": "cwd required"}
    if not os.path.isdir(cwd):
        return {"ok": False, "error": f"cwd not a directory: {cwd}"}
    if install_token is not None and not isinstance(install_token, str):
        return {"ok": False, "error": "install_token must be a string if given"}
    if where == "tab" and not parent_guid:
        return {"ok": False, "error": "tab spawn requires parent_guid"}
    if where not in ("tab", "window"):
        return {"ok": False, "error": f"unknown where: {where!r}"}

    script_path = _write_spawn_script(cwd, command, shell, path_env)
    try:
        if where == "tab":
            parent_session = app.get_session_by_id(parent_guid)
            if parent_session is None:
                try:
                    os.remove(script_path)
                except Exception:
                    pass
                return {"ok": False, "error": f"unknown parent: {parent_guid}"}
            window = parent_session.window
            tab = await window.async_create_tab(command=script_path)
            session = tab.current_session
        else:
            window = await iterm2.Window.async_create(connection, command=script_path)
            if window is None:
                try:
                    os.remove(script_path)
                except Exception:
                    pass
                return {"ok": False, "error": "iterm refused to create window"}
            session = window.current_tab.current_session

        try:
            await session.async_set_name(name)
        except Exception:
            # Setting name is best-effort; the GUID is what matters.
            pass
        guid = session.session_id
        # The session name is not an identity: the backend retitles its tab
        # (Claude Code writes the task title), so a name lookup stops finding
        # the agent and a2a respawns a duplicate. A user variable is never
        # touched by the running program, so it is the durable agent tag.
        try:
            await session.async_set_variable(AGENT_ID_VAR, name)
        except Exception as exc:
            try:
                await session.async_close(force=True)
            except Exception:
                pass
            return {"ok": False, "error": f"could not tag session with agent id: {type(exc).__name__}: {exc}"}
        if install_token:
            OWNERSHIP[guid] = install_token
            _save_ownership(OWNERSHIP)
        return {"ok": True, "guid": guid}
    except Exception as exc:
        try:
            os.remove(script_path)
        except Exception:
            pass
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


async def op_configure_session(app, _connection, params):
    """Configure post-spawn session behavior. Right now only one knob:
    `native_scroll` — when true (default), the iTerm profile property
    "Allow Alternate Mouse Scroll" is set to NO on this session, so mouse-
    wheel scrolling moves iTerm's scrollback view instead of being
    forwarded to the running app as up/down arrows. Without this, scrolling
    in a Claude Code window drives the input cursor through prior commands
    instead of scrolling the view, which is what the user sees as
    "scrolling triggers messages to scroll in the view".
    """
    guid = params.get("guid")
    native_scroll = bool(params.get("native_scroll", True))
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    try:
        # iTerm profile keys: Profile.h KEY_ALTERNATE_MOUSE_SCROLL.
        # Setting via session-level override does not modify the underlying
        # saved profile — it only affects this session.
        # The iterm2 package has no typed setter for this key, so it is set
        # by name through the generic write-only-profile assignment.
        change = iterm2.LocalWriteOnlyProfile()
        change._simple_set("Allow Alternate Mouse Scroll", not native_scroll)
        await session.async_set_profile_properties(change)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"ok": True}


async def op_close(app, _connection, params):
    guid = params.get("guid")
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    session = app.get_session_by_id(guid)
    if session is None:
        # Session is already gone — drop ownership too. Surface the canonical
        # benign-cleanup error string the Node side recognizes.
        if OWNERSHIP.pop(guid, None) is not None:
            _save_ownership(OWNERSHIP)
        return {"ok": False, "error": f"unknown session: {guid}"}
    try:
        await session.async_close(force=True)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    if OWNERSHIP.pop(guid, None) is not None:
        _save_ownership(OWNERSHIP)
    return {"ok": True}


async def op_focus(app, _connection, params):
    guid = params.get("guid")
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    try:
        await session.async_activate()
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"ok": True}


async def op_set_name(app, _connection, params):
    guid = params.get("guid")
    name = params.get("name")
    if not isinstance(guid, str) or not guid:
        return {"ok": False, "error": "guid required"}
    if not isinstance(name, str) or not name:
        return {"ok": False, "error": "name required"}
    session = app.get_session_by_id(guid)
    if session is None:
        return {"ok": False, "error": f"unknown session: {guid}"}
    try:
        await session.async_set_name(name)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"ok": True}


OPS = {
    "ping": op_ping,
    "list_sessions": op_list_sessions,
    "send_text": op_send_text,
    "send_keys": op_send_keys,
    "screen": op_screen,
    "spawn": op_spawn,
    "close": op_close,
    "focus": op_focus,
    "set_name": op_set_name,
    "configure_session": op_configure_session,
}


# Ops that keep the connection open and write many response lines:
# `coroutine(reader, writer, params)`. Empty in the bare bridge; the a2a
# iTerm2 plugin adds `watch` (session lifecycle push).
STREAM_OPS = {}

DISCONNECTED_ERROR = "iTerm2 API not connected; the bridge is reconnecting"
RECONNECT_MIN_S = 0.5
RECONNECT_MAX_S = 5.0


class ITermLink:
    """One live websocket connection to iTerm2 and the App built on it.

    iTerm2 restarting (quit, crash) closes the websocket for good: the
    library's dispatch loop dies and every later RPC either raises
    ConnectionClosedError or awaits a reply nothing will deliver. A link is
    therefore never reused after `closed` is set; the supervisor builds a new
    one.
    """

    def __init__(self, connection, app):
        self.connection = connection
        self.app = app
        self.closed = asyncio.Event()

    async def watch(self):
        try:
            await self.connection.websocket.wait_closed()
        finally:
            self.closed.set()
            # The library's dispatch task re-raises the close; retrieve it so
            # asyncio does not also report "exception was never retrieved".
            dispatch = getattr(self.connection, "_Connection__dispatch_forever_future", None)
            if dispatch is not None and dispatch.done() and not dispatch.cancelled():
                dispatch.exception()


# The current link, or None while disconnected. Request handlers read it per
# request, so a reconnect is picked up without restarting the socket server.
LINK = None

# Coroutines `hook(link)` run after every successful connection. Anything
# registered with iTerm2 (status-bar components, RPCs, monitors) is scoped to
# one connection and vanishes when iTerm2 restarts, so extensions such as the
# a2a iTerm2 plugin re-register here. A failing hook is logged, never fatal.
ON_CONNECT = []


async def _connect_once():
    # A cookie from the previous iTerm2 process is rejected by the new one;
    # drop it so authenticate() requests a fresh one. authenticate() never
    # launches iTerm2 (launch_if_needed=False), so a quit iTerm2 stays quit.
    for var in ("ITERM2_COOKIE", "ITERM2_KEY"):
        os.environ.pop(var, None)
    # async_get_app returns a process-wide App singleton. It is only cleared
    # by the library's disconnect callbacks, which run when Connection.run()
    # returns — never here — so without this the new connection would get the
    # App bound to the dead one.
    iterm2.app.invalidate_app()
    connection = await iterm2.Connection.async_create()
    try:
        app = await iterm2.async_get_app(connection)
    except BaseException:
        await connection.websocket.close()
        raise
    return ITermLink(connection, app)


async def supervise(connected):
    """Keep LINK connected to iTerm2 for the life of the process.

    `connected` resolves on the first successful connection; the socket server
    is only opened after it, so launch.sh's socket-exists readiness check still
    means "connected to iTerm2".
    """
    global LINK
    delay = RECONNECT_MIN_S
    last_error = None
    while True:
        try:
            link = await _connect_once()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # SystemExit from the library's 406 path too
            if isinstance(exc, KeyboardInterrupt):
                raise
            error = f"{type(exc).__name__}: {exc}"
            if error != last_error:
                print(f"a2a-iterm2-bridge: iTerm2 connect failed ({error}); retrying", flush=True)
                last_error = error
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)
            continue
        delay = RECONNECT_MIN_S
        last_error = None
        LINK = link
        print("a2a-iterm2-bridge: connected to iTerm2", flush=True)
        for hook in ON_CONNECT:
            try:
                await hook(link)
            except Exception as exc:
                print(f"a2a-iterm2-bridge: on-connect hook {getattr(hook, '__name__', hook)} failed: {type(exc).__name__}: {exc}", flush=True)
        if not connected.done():
            connected.set_result(None)
        try:
            await link.watch()
        finally:
            if LINK is link:
                LINK = None
        print("a2a-iterm2-bridge: iTerm2 connection lost; reconnecting", flush=True)


async def _run_op(handler, op, params):
    link = LINK
    if link is None:
        if op == "ping":
            return {"ok": False, "version": VERSION, "error": DISCONNECTED_ERROR}
        return {"ok": False, "error": DISCONNECTED_ERROR}
    # Race the op against the link closing: an RPC in flight when iTerm2 dies
    # waits on a reply future only the (now dead) dispatch loop resolves.
    task = asyncio.ensure_future(handler(link.app, link.connection, params))
    closed = asyncio.ensure_future(link.closed.wait())
    try:
        await asyncio.wait({task, closed}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        closed.cancel()
    if not task.done():
        task.cancel()
        return {"ok": False, "error": f"iTerm2 connection lost during {op}"}
    try:
        return task.result()
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


async def handle_client(reader, writer):
    try:
        line = await reader.readline()
        if not line:
            return
        try:
            req = json.loads(line)
        except Exception as exc:
            resp = {"ok": False, "error": f"bad json: {exc}"}
        else:
            op = req.get("op")
            stream = STREAM_OPS.get(op)
            if stream is not None:
                # A streaming op owns the connection until it returns (it
                # writes its own newline-delimited JSON lines).
                await stream(reader, writer, req.get("params") or {})
                return
            handler = OPS.get(op)
            if handler is None:
                resp = {"ok": False, "error": f"unknown op: {op!r}"}
            else:
                resp = await _run_op(handler, op, req.get("params") or {})
        writer.write((json.dumps(resp) + "\n").encode("utf-8"))
        await writer.drain()
    except ConnectionError:
        # The client gave up (its rpc timeout) before the reply was written.
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


# One process serves a socket path. Without this, a second bridge or plugin
# (a manual `launch.sh start` next to the launchd agent, two checkouts) unlinks
# the live socket and binds its own: clients then talk to whichever process
# bound last, while the first keeps its iTerm2 registrations (status bar,
# Toolbelt, monitors) — two writers over one iTerm2 surface. The lock lives
# next to the socket and is held for the life of the process; the kernel drops
# it when the process dies, so a crash never leaves a stale lock.
LOCK_PATH = SOCKET_PATH.with_name(SOCKET_PATH.name + ".lock")
_INSTANCE_LOCK_FD = None


class SplitBrainError(RuntimeError):
    pass


def acquire_instance_lock(lock_path=None):
    """Hold an exclusive lock for this socket path, or raise SplitBrainError
    naming the pid that holds it."""
    global _INSTANCE_LOCK_FD
    path = Path(lock_path or LOCK_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            holder = os.pread(fd, 32, 0).decode("ascii", "replace").strip() or "unknown"
        finally:
            os.close(fd)
        raise SplitBrainError(
            f"split-brain refused: another a2a iTerm2 bridge (pid {holder}) already serves "
            f"{SOCKET_PATH} (lock {path}); stop it first (a2a bridge iterm stop, or "
            f"a2a bridge iterm uninstall when launchd runs it)"
        ) from None
    os.ftruncate(fd, 0)
    os.pwrite(fd, f"{os.getpid()}\n".encode("ascii"), 0)
    _INSTANCE_LOCK_FD = fd
    return fd


async def main():
    try:
        acquire_instance_lock()
    except SplitBrainError as exc:
        print(f"a2a-iterm2-bridge: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(3) from None
    # Only the lock holder touches the socket path and the launcher's pid
    # file, so a refused second start leaves the live instance's intact. A
    # socket file present now is stale (its owner no longer holds the lock);
    # removing it here keeps "socket exists" meaning "this process is serving".
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    pidfile = os.environ.get("A2A_ITERM2_BRIDGE_PIDFILE")
    if pidfile:
        Path(pidfile).write_text(f"{os.getpid()}\n", encoding="ascii")
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
        except NotImplementedError:
            pass

    connected = loop.create_future()
    supervisor = asyncio.ensure_future(supervise(connected))
    try:
        await asyncio.wait({connected, stop}, return_when=asyncio.FIRST_COMPLETED)
        if stop.done():
            return

        SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
        if SOCKET_PATH.exists():
            SOCKET_PATH.unlink()
        server = await asyncio.start_unix_server(handle_client, path=str(SOCKET_PATH))
        os.chmod(SOCKET_PATH, 0o600)

        print(f"a2a-iterm2-bridge listening on {SOCKET_PATH}", flush=True)
        async with server:
            await stop
    finally:
        supervisor.cancel()
        link = LINK
        if link is not None:
            try:
                await link.connection.websocket.close()
            except Exception:
                pass


# The bridge owns its event loop instead of iterm2.run_until_complete, which
# opens exactly one connection and gives no way to replace it after iTerm2
# restarts. Guarded so the a2a iTerm2 plugin can import this module, extend
# OPS and ON_CONNECT, and then run main() itself.
if __name__ == "__main__":
    asyncio.run(main())
