#!/usr/bin/env python3
"""myrmidon(BROWSER-CONSOLE): the screen node (part B).

Runs on the exec host next to the live browser and implements the node
contract from server/src/myrmidon/browser-console/screen-console-client.ts:

    POST /browsers/<id>/open                    -> {"wsUrl", "screenSessionId"}
    POST /sessions/<id>/done
    POST /sessions/<id>/heartbeat?activity=0|1
    POST /browsers/<id>/pause                    (mcp-reaper-proxy stop)
    POST /browsers/<id>/resume                   (mcp-reaper-proxy start)
    POST /browsers/<id>/clear-site-data?domain=  (CDP 127.0.0.1:9222)

Design decisions (see the PR description):
  * Python 3.13 standard library only: http.server for the API, subprocess
    for systemctl, a hand-written RFC6455 client for the CDP websocket — no
    third-party dependency with an unclear licence is added to the repo.
  * The x11vnc picture rides Guacamole (guacd VNC on this host), so `wsUrl`
    is informational: the node reports the VNC endpoint it opened, and the
    board signs a Guacamole auth-JSON instead of proxying websockets.
  * A session is kept alive by board heartbeats. If the board disappears
    (no heartbeat for HEARTBEAT_TIMEOUT_S, e.g. a lost `done`), the node
    stops the x11vnc unit itself — the screen must never linger unattended.
  * Bearer token from the environment file; the node binds the operational
    interface/address given by systemd/EnvironmentFile and nothing else.

Environment (EnvironmentFile, root 0600 — never in the repo):
  BROWSER_CONSOLE_NODE_TOKEN   required Bearer token
  BROWSER_CONSOLE_NODE_BIND    address to bind (default 127.0.0.1; systemd
                               passes the operational address explicitly)
  BROWSER_CONSOLE_NODE_PORT    port to listen on
  BROWSER_CONSOLE_VNC_PORT     rfbport for x11vnc (default 5900)
  BROWSER_CONSOLE_DISPLAY      X display to share (default :99)
  BROWSER_CONSOLE_CDP_PORT     CDP port on 127.0.0.1 (default 9222)
  BROWSER_CONSOLE_VNC_URL      host guacd uses to reach this x11vnc (the
                               informational vnc:// endpoint in open();
                               defaults to the bind address)
"""

from __future__ import annotations

import base64
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

TOKEN_ENV = "BROWSER_CONSOLE_NODE_TOKEN"
HEARTBEAT_TIMEOUT_S = 120.0  # board silent > 2 min -> the node releases the screen
SYSTEMCTL_TIMEOUT_S = 30.0
CDP_TIMEOUT_S = 15.0

DEFAULT_DISPLAY = ":99"
DEFAULT_VNC_PORT = 5900
DEFAULT_CDP_PORT = 9222

# Fleet browser ids are opaque slugs; the template unit instance and the CDP
# target lookup both key on them. Anything else is refused before systemctl.
BROWSER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# A bare registrable domain (the board validates first; this is the node's own
# second line — a CDP origin string must not carry a path, scheme or glob).
DOMAIN_RE = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$")

X11VNC_UNIT = "browser-screen-x11vnc@{browser}.service"
REAPER_PROXY_UNIT = "mcp-reaper-proxy.service"


def config() -> dict[str, object]:
    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        raise RuntimeError(f"{TOKEN_ENV} is not set; refusing to serve without a token")
    return {
        "token": token,
        "bind": os.environ.get("BROWSER_CONSOLE_NODE_BIND", "127.0.0.1").strip() or "127.0.0.1",
        "port": int(os.environ.get("BROWSER_CONSOLE_NODE_PORT", "0") or "0"),
        "vnc_port": int(os.environ.get("BROWSER_CONSOLE_VNC_PORT", str(DEFAULT_VNC_PORT))),
        "display": os.environ.get("BROWSER_CONSOLE_DISPLAY", DEFAULT_DISPLAY),
        "cdp_port": int(os.environ.get("BROWSER_CONSOLE_CDP_PORT", str(DEFAULT_CDP_PORT))),
        # The VNC endpoint as guacd sees it (informational wsUrl in open()).
        # Defaults to the bind address; set it when guacd reaches this host by
        # a different name (MYRMIDON_BROWSER_VNC_TARGET on the board side).
        "vnc_url": os.environ.get("BROWSER_CONSOLE_VNC_URL", "").strip() or None,
    }


# ---------------------------------------------------------------------------
# systemd helpers (injectable for tests)
# ---------------------------------------------------------------------------


def run_systemctl(args: list[str], timeout: float = SYSTEMCTL_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["systemctl", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_command(argv: list[str], timeout: float = SYSTEMCTL_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def systemctl_is_active(unit: str, runner=run_systemctl) -> bool:
    result = runner(["is-active", "--quiet", unit])
    return result.returncode == 0


def start_screen_unit(unit: str, cmd: list[str], runner=run_command) -> None:
    """Start x11vnc as a transient unit named after the browser's screen.

    systemd-run --unit gives the process a managed, self-collecting unit:
    `systemctl_stop_unit` below stops it by name, and --collect drops the unit when the
    process exits so a crashed x11vnc does not linger.
    """
    result = runner(["systemd-run", "--unit", unit.removesuffix(".service"), "--collect", *cmd])
    if result.returncode != 0:
        raise RuntimeError(f"could not start {unit}: {(result.stderr or result.stdout or '').strip()[:400]}")


def systemctl_stop_unit(unit: str, runner=run_systemctl) -> None:
    result = runner(["stop", unit])
    if result.returncode != 0:
        # Already stopped / transient unit gone: an idempotent stop is success.
        if systemctl_is_active(unit, runner):
            raise RuntimeError(f"could not stop {unit}: {(result.stderr or '').strip()[:400]}")


def browser_screen_command(browser_id: str, cfg: dict[str, object]) -> list[str]:
    """The x11vnc command for one browser's screen session.

    No -localhost: guacd lives on a different host (the console VM), so
    -localhost would lock the viewer out; reach is bounded by the network
    policy between the exec host and guacd (documented in the PR). -nopw is
    deliberate: authorization is the short-lived signed Guacamole auth-JSON
    the panel issues per owner, not a VNC password; x11vnc still refuses
    until a session unit exists — the unit itself is the on/off switch.
    """
    return [
        "x11vnc",
        "-display", str(cfg["display"]),
        "-rfbport", str(cfg["vnc_port"]),
        "-nopw",
        "-forever",
        "-shared",
    ]


# ---------------------------------------------------------------------------
# CDP (Chrome DevTools Protocol) over a hand-rolled RFC6455 client
# ---------------------------------------------------------------------------


def cdp_ws_url(port: int, opener=None) -> str:
    """The browser-level websocket endpoint from the CDP /json/version list."""
    if opener is None:
        opener = _http_get_json
    version = opener(f"http://127.0.0.1:{port}/json/version")
    url = version.get("webSocketDebuggerUrl")
    if not isinstance(url, str) or not url.startswith("ws://"):
        raise RuntimeError("CDP did not advertise a browser websocket endpoint")
    return url


def _http_get_json(url: str, timeout: float = CDP_TIMEOUT_S) -> dict:
    with socket.create_connection(("127.0.0.1", int(urllib.parse.urlsplit(url).port or 9222)), timeout=timeout) as sock:
        path = urllib.parse.urlsplit(url).path or "/"
        sock.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
        raw = b""
        while len(raw) < 1_000_000:
            chunk = sock.recv(65_536)
            if not chunk:
                break
            raw += chunk
        body = raw.split(b"\r\n\r\n", 1)[1]
        return json.loads(body.decode())


class WsClient:
    """Minimal RFC6455 text client: one websocket to one CDP endpoint."""

    def __init__(self, url: str, timeout: float = CDP_TIMEOUT_S) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "ws":
            raise ValueError("only ws:// CDP endpoints are supported")
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 80
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP websocket handshake closed early")
            response += chunk
        status = response.split(b"\r\n", 1)[0].decode()
        if " 101 " not in f"{status} ":
            raise RuntimeError(f"CDP websocket handshake failed: {status}")
        self._pending = response.split(b"\r\n\r\n", 1)[1]
        self._next_id = 0

    def send(self, payload: dict) -> None:
        data = json.dumps(payload).encode()
        header = bytearray([0x81])  # FIN + text frame
        length = len(data)
        mask = os.urandom(4)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(0x80 | 127)
            header.extend(length.to_bytes(8, "big"))
        header.extend(mask)
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv_exact(self, n: int) -> bytes:
        while len(self._pending) < n:
            chunk = self.sock.recv(65_536)
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            self._pending += chunk
        out, self._pending = self._pending[:n], self._pending[n:]
        return out

    def recv(self) -> dict:
        while True:
            first = self._recv_exact(2)
            opcode = first[0] & 0x0F
            length = first[1] & 0x7F
            if length == 126:
                length = int.from_bytes(self._recv_exact(2), "big")
            elif length == 127:
                length = int.from_bytes(self._recv_exact(8), "big")
            if first[1] & 0x80:  # masked server frame (non-standard, tolerate)
                length += 0  # payload follows after a 4-byte mask
                payload = self._recv_exact(4 + length)[4:]
            else:
                payload = self._recv_exact(length)
            if opcode == 0x8:  # close
                raise RuntimeError("CDP websocket closed by the browser")
            if opcode == 0x9:  # ping -> pong
                pong = bytearray([0x8A, 0x80 | len(payload)])
                mask = os.urandom(4)
                pong.extend(mask)
                self.sock.sendall(bytes(pong) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
                continue
            if opcode in (0x1, 0x2):
                return json.loads(payload.decode())

    def call(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        wanted = self._next_id
        self.send({"id": wanted, "method": method, "params": params or {}})
        while True:
            message = self.recv()
            if message.get("id") == wanted:
                if "error" in message:
                    raise RuntimeError(f"CDP {method} failed: {message['error'].get('message', message['error'])}")
                return message
            # unsolicited events: drop them.

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def clear_site_data(cdp_port: int, domain: str, ws_factory=None) -> None:
    """Cookies of the whole browser plus storage of one origin, over CDP.

    `ws_factory(port) -> websocket-like` is the test seam: production resolves
    the browser endpoint from /json/version and opens the hand-rolled client;
    tests hand in a fake CDP socket that records the method calls.
    """
    if ws_factory is None:
        ws_factory = _browser_ws
    ws = ws_factory(cdp_port)
    storage_types = ",".join([
        "cookies", "local_storage", "indexeddb", "cache_storage", "service_workers",
    ])
    try:
        ws.call("Network.enable")
        ws.call("Network.clearBrowserCookies")
        for scheme in ("https", "http"):
            ws.call(
                "Storage.clearDataForOrigin",
                {"origin": f"{scheme}://{domain}", "storageTypes": storage_types},
            )
    finally:
        ws.close()


def _browser_ws(port: int) -> WsClient:
    return WsClient(cdp_ws_url(port))


# ---------------------------------------------------------------------------
# session registry (heartbeat insurance)
# ---------------------------------------------------------------------------


class Session:
    __slots__ = ("session_id", "browser_id", "unit", "ws_url", "last_seen", "activity")

    def __init__(self, session_id: str, browser_id: str, unit: str, ws_url: str, now: float) -> None:
        self.session_id = session_id
        self.browser_id = browser_id
        self.unit = unit
        self.ws_url = ws_url
        self.last_seen = now
        self.activity = False


class Registry:
    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions: dict[str, Session] = {}

    def now(self) -> float:
        return self._clock()

    def add(self, session: Session) -> None:
        with self._lock:
            # The board keys one live session per browser (part A service), so
            # this registry only ever holds what the board opened; a stale row
            # is reaped by the watchdog, not here.
            self._sessions[session.session_id] = session

    def touch(self, session_id: str, activity: bool) -> Session | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            session.last_seen = self.now()
            session.activity = session.activity or activity
            return session

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def remove(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.pop(session_id, None)

    def stale(self, timeout_s: float = HEARTBEAT_TIMEOUT_S) -> list[Session]:
        cutoff = self.now() - timeout_s
        with self._lock:
            return [s for s in self._sessions.values() if s.last_seen < cutoff]

    def browser_session(self, browser_id: str) -> Session | None:
        with self._lock:
            for session in self._sessions.values():
                if session.browser_id == browser_id:
                    return session
            return None

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)


def release(session: Session, stop=systemctl_stop_unit) -> None:
    stop(session.unit)


def watchdog(registry: Registry, stop=systemctl_stop_unit, interval: float = 5.0, log=print) -> threading.Thread:
    """The heartbeat insurance: stop units the board forgot about."""

    def loop() -> None:
        while True:
            time.sleep(interval)
            for session in registry.stale():
                # Re-check under a fresh read: a heartbeat may have arrived
                # between listing and acting.
                current = registry.get(session.session_id)
                if current is None or current.last_seen > session.last_seen:
                    continue
                registry.remove(current.session_id)
                try:
                    stop(current.unit)
                    log(f"released stale screen session {current.session_id} (browser {current.browser_id})")
                except Exception as err:  # noqa: BLE001 - the loop must survive
                    log(f"could not release {current.session_id}: {err}")

    thread = threading.Thread(target=loop, name="screen-watchdog", daemon=True)
    thread.start()
    return thread


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

JsonResponse = tuple[int, dict]


def handle_request(method: str, path: str, cfg: dict[str, object], registry: Registry,
                   start_unit=None, stop_unit=None, service_action=None, cdp_clear=None) -> JsonResponse:
    """The whole node contract as one pure function (tests hit it directly)."""
    parts = urllib.parse.urlsplit(path)
    # No empty-segment filter: `/browsers//open` must reach the browser-id
    # guard (400), not fall through to 404 behind a collapsed path.
    segments = [urllib.parse.unquote(s) for s in parts.path.strip("/").split("/")]
    query = urllib.parse.parse_qs(parts.query)

    def bad(message: str) -> JsonResponse:
        return 400, {"error": message}

    def not_found(message: str) -> JsonResponse:
        return 404, {"error": message}

    if start_unit is None:
        start_unit = start_screen_unit
    if stop_unit is None:
        stop_unit = systemctl_stop_unit
    if service_action is None:
        service_action = _systemctl_service
    if cdp_clear is None:
        cdp_clear = lambda domain: clear_site_data(int(cfg["cdp_port"]), domain)  # noqa: E731

    def guard_browser_id(value: str) -> str | None:
        if not BROWSER_ID_RE.match(value):
            return bad("browser id is not a safe unit instance")
        return None

    if method == "POST" and len(segments) == 3 and segments[0] == "browsers" and segments[2] == "open":
        browser_id = segments[1]
        err = guard_browser_id(browser_id)
        if err:
            return err
        unit = X11VNC_UNIT.format(browser=browser_id)
        start_unit(unit, browser_screen_command(browser_id, cfg))
        session_id = str(uuid.uuid4())
        host = str(cfg.get("vnc_url") or cfg["bind"])
        ws_url = f"vnc://{host}:{cfg['vnc_port']}"
        registry.add(Session(session_id, browser_id, unit, ws_url, registry.now()))
        return 200, {"wsUrl": ws_url, "screenSessionId": session_id}

    if method == "POST" and len(segments) == 3 and segments[0] == "sessions" and segments[2] == "done":
        session = registry.remove(segments[1])
        if session is None:
            # Idempotent: done for an unknown/released session is success.
            return 200, {"done": True}
        stop_unit(session.unit)
        return 200, {"done": True}

    if method == "POST" and len(segments) == 3 and segments[0] == "sessions" and segments[2] == "heartbeat":
        activity = query.get("activity", ["0"])[0] == "1"
        session = registry.touch(segments[1], activity)
        if session is None:
            return not_found("unknown screen session")
        return 200, {"ok": True}

    if method == "POST" and len(segments) == 3 and segments[0] == "browsers" and segments[2] in ("pause", "resume"):
        browser_id = segments[1]
        err = guard_browser_id(browser_id)
        if err:
            return err
        action = "stop" if segments[2] == "pause" else "start"
        result = service_action(action, REAPER_PROXY_UNIT)
        if result != 0:
            return 502, {"error": f"could not {action} {REAPER_PROXY_UNIT}"}
        return 200, {"ok": True, "bots": "paused" if segments[2] == "pause" else "resumed"}

    if method == "POST" and len(segments) == 3 and segments[0] == "browsers" and segments[2] == "clear-site-data":
        browser_id = segments[1]
        err = guard_browser_id(browser_id)
        if err:
            return err
        domain = (query.get("domain", [""])[0] or "").strip().lower()
        if not DOMAIN_RE.match(domain):
            return bad("domain must be a bare registrable domain")
        try:
            cdp_clear(domain)
        except Exception as err2:  # noqa: BLE001 - surface as a node-level failure
            return 502, {"error": f"site data clear failed: {err2}"}
        return 200, {"cleared": True, "domain": domain}

    if method == "GET" and segments == ["health"]:
        return 200, {"ok": True, "sessions": registry.count()}

    return not_found("no such node endpoint")


def _systemctl_service(action: str, unit: str) -> int:
    return run_systemctl([action, unit]).returncode


class Handler(BaseHTTPRequestHandler):
    server_version = "MyrmidonBrowserConsoleNode/1.4"

    # set on the server object by main()
    @property
    def _cfg(self) -> dict[str, object]:
        return self.server.node_config  # type: ignore[attr-defined]

    def _authorized(self) -> bool:
        provided = self.headers.get("Authorization", "")
        expected = f"Bearer {self._cfg['token']}"
        return provided == expected

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._authorized():
            # The node never echoes the token; a wrong token is a plain 401.
            self._send(401, {"error": "unauthorized"})
            return
        try:
            status, payload = handle_request("POST", self.path, self._cfg, self.server.registry)  # type: ignore[attr-defined]
        except Exception as err:  # noqa: BLE001 - one request must not kill the node
            status, payload = 500, {"error": f"node request failed: {err}"}
        self._send(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            # Health stays unauthenticated but returns only liveness counters.
            status, payload = handle_request("GET", self.path, self._cfg, self.server.registry)  # type: ignore[attr-defined]
            self._send(status, payload)
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        self._send(404, {"error": "no such node endpoint"})

    def log_message(self, fmt: str, *args) -> None:  # no per-request token leaks
        sys.stderr.write("node: %s\n" % (fmt % args))


def main() -> int:
    cfg = config()
    registry = Registry()
    server = ThreadingHTTPServer((str(cfg["bind"]), int(cfg["port"])), Handler)
    server.node_config = cfg  # type: ignore[attr-defined]
    server.registry = registry  # type: ignore[attr-defined]
    watchdog(registry)
    print(f"browser console node listening on {cfg['bind']}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # The node owns the screens it opened: stop them on shutdown.
        for session in list(registry._sessions.values()):  # noqa: SLF001 - shutdown path
            registry.remove(session.session_id)
            try:
                systemctl_stop_unit(session.unit)
            except Exception as err:  # noqa: BLE001
                print(f"shutdown could not stop {session.unit}: {err}", file=sys.stderr)
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
