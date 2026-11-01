# tools/egress-proxy/tests/test_server.py
"""myrmidon(EGRESS-A): what the proxy does with a request, over a real socket.

Two requests go through a real proxy on 127.0.0.1 against real local targets: a
plain HTTP one (absolute-form request line) and a CONNECT tunnel. Both must
reach the destination and be recorded; a request for the proxy itself must be a
health probe and must not appear in the journal. A destination that does not
answer must be recorded as a failure and reported to the client as 502 — the
mode records, it does not refuse, so this is the only error path it has.
"""

from __future__ import annotations

import base64
import io
import json
import socket
import threading
import time
import traceback
import unittest
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from egress_proxy.config import BotEntry, Config
from egress_proxy.journal import DestinationJournal
from egress_proxy.server import EgressProxyServer, _Tunnel

#: The harness closes sockets by letting them go out of scope; the proxy's own
#: per-request connections are the runtime's business, not a leak to report here.
warnings.simplefilter("ignore", ResourceWarning)


class _TargetHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = b"target says hello"
        self.send_response(200, "OK")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


class ProxyHarnessTestCase(unittest.TestCase):
    #: `Config.tunnel_idle_sec` of the proxy under test.
    tunnel_idle_sec: float | None = None

    def setUp(self) -> None:
        self.journal_text = io.StringIO()
        self.proxy = EgressProxyServer(
            Config(
                mode="log",
                bind="127.0.0.1",
                port=0,
                connect_timeout_sec=2,
                bots={"agent-a": BotEntry(bot_key="agent-a", project="life")},
                tunnel_idle_sec=self.tunnel_idle_sec,
            ),
            DestinationJournal(self.journal_text, {"agent-a": BotEntry(bot_key="agent-a", project="life")}),
        )
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()

        self.target = ThreadingHTTPServer(("127.0.0.1", 0), _TargetHandler)
        self.target_thread = threading.Thread(target=self.target.serve_forever, daemon=True)
        self.target_thread.start()

        self.addCleanup(self.target.shutdown)
        self.addCleanup(self.proxy.shutdown)

    # -- helpers ----------------------------------------------------------

    @staticmethod
    def _basic(user: str) -> str:
        return "Basic " + base64.b64encode(f"{user}:egress".encode("utf-8")).decode("ascii")

    def _request(self, head: bytes, keep_open: bool = False) -> bytes:
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as sock:
            sock.sendall(head)
            sock.settimeout(5)
            chunks: list[bytes] = []
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                if not keep_open:
                    # The proxy answers with HTTP/1.0 and closes; one read is
                    # enough, but keep draining until the peer closes.
                    pass
            return b"".join(chunks)

    def _lines(self) -> list[dict]:
        return [json.loads(line) for line in self.journal_text.getvalue().splitlines() if line.strip()]


class PlainHttpTest(ProxyHarnessTestCase):
    def test_absolute_form_request_reaches_the_target_and_is_journalled(self) -> None:
        response = self._request(
            (
                f"GET http://127.0.0.1:{self.target.server_port}/hello HTTP/1.0\r\n"
                f"Host: 127.0.0.1:{self.target.server_port}\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        self.assertIn(b"target says hello", response)

        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["bot"], "agent-a")
        self.assertEqual(lines[0]["project"], "life")
        self.assertEqual(lines[0]["method"], "GET")
        self.assertEqual(lines[0]["scheme"], "http")
        self.assertEqual(lines[0]["destination"], "127.0.0.1")
        self.assertEqual(lines[0]["port"], self.target.server_port)
        self.assertEqual(lines[0]["result"], "ok")

    def test_a_request_without_a_proxy_user_is_still_served_and_recorded(self) -> None:
        response = self._request(
            f"GET http://127.0.0.1:{self.target.server_port}/hello HTTP/1.0\r\n\r\n".encode("ascii")
        )
        self.assertIn(b"target says hello", response)
        self.assertEqual(self._lines()[0]["bot"], "unknown")
        self.assertEqual(self._lines()[0]["project"], "")


class ConnectTest(ProxyHarnessTestCase):
    def test_connect_opens_a_tunnel_and_records_the_destination(self) -> None:
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as sock:
            sock.sendall(
                (
                    f"CONNECT 127.0.0.1:{self.target.server_port} HTTP/1.0\r\n"
                    f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                    "\r\n"
                ).encode("ascii")
            )
            head = sock.recv(4096)
            self.assertIn(b"200", head.split(b"\r\n", 1)[0])

            # Speak HTTP to the target through the tunnel.
            request = f"GET /hello HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".encode("ascii")
            sock.sendall(request)
            sock.settimeout(5)
            payload = b""
            while b"target says hello" not in payload:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                payload += chunk
            self.assertIn(b"target says hello", payload)

        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["method"], "CONNECT")
        self.assertEqual(lines[0]["scheme"], "https")
        self.assertEqual(lines[0]["port"], self.target.server_port)
        self.assertEqual(lines[0]["result"], "ok")

    def test_an_unreachable_destination_is_recorded_and_answered_with_502(self) -> None:
        # A port nothing listens on: closed socket on loopback.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]

        response = self._request(f"CONNECT 127.0.0.1:{dead_port} HTTP/1.0\r\n\r\n".encode("ascii"))
        self.assertIn(b"502", response.split(b"\r\n", 1)[0])
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["bot"], "unknown")
        self.assertTrue(lines[0]["result"].startswith("error:"), lines[0]["result"])


class _RawTarget:
    """A TCP server on localhost for what travels through a tunnel.

    `serve(target, conn)` runs on its own thread for every connection.
    `closed` is set when that connection ends: for a tunnel, the proxy let go of
    its side. `received` counts the bytes `_hold` read.
    """

    def __init__(self, serve) -> None:
        self._serve = serve
        self.received = 0
        self.closed = threading.Event()
        self._listener = socket.create_server(("127.0.0.1", 0))
        self.port = self._listener.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                conn, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._run, args=(conn,), daemon=True).start()

    def _run(self, conn: socket.socket) -> None:
        with conn:
            try:
                self._serve(self, conn)
            except OSError:
                pass
            finally:
                self.closed.set()

    def stop(self) -> None:
        try:
            self._listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._listener.close()


def _hold(target: _RawTarget, conn: socket.socket) -> None:
    """Read and count until the peer closes; never answer."""
    while True:
        data = conn.recv(4096)
        if not data:
            return
        target.received += len(data)


def _echo(target: _RawTarget, conn: socket.socket) -> None:
    while True:
        data = conn.recv(4096)
        if not data:
            return
        conn.sendall(data)


def _stream_when_asked(chunks: int, interval: float):
    """After the first bytes from the client, send `chunks` kilobytes, `interval` apart."""

    def serve(target: _RawTarget, conn: socket.socket) -> None:
        conn.recv(4096)
        for _ in range(chunks):
            conn.sendall(b"x" * 1024)
            time.sleep(interval)
        _hold(target, conn)

    return serve


class TunnelHarnessTestCase(ProxyHarnessTestCase):
    """A CONNECT tunnel to a raw TCP target; what ends it, and how, is observed.

    `tunnel_done` is set when the proxy has finished with a tunnel (both pump
    threads joined, sockets closed); `errors` collects whatever a thread of the
    proxy raised instead of ending quietly.
    """

    def setUp(self) -> None:
        super().setUp()
        self.errors: list[str] = []
        self.tunnel_done = threading.Event()

        def record_handler_error(request, client_address) -> None:
            self.errors.append("handler: " + traceback.format_exc())

        self.proxy.handle_error = record_handler_error

        previous_hook = threading.excepthook
        threading.excepthook = lambda args: self.errors.append(
            f"thread {getattr(args.thread, 'name', '?')}: {args.exc_type.__name__}: {args.exc_value}"
        )
        self.addCleanup(setattr, threading, "excepthook", previous_hook)

        original_run = _Tunnel.run

        def run_and_report(tunnel: _Tunnel) -> None:
            try:
                original_run(tunnel)
            finally:
                self.tunnel_done.set()

        patcher = mock.patch.object(_Tunnel, "run", run_and_report)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _target(self, serve) -> _RawTarget:
        target = _RawTarget(serve)
        self.addCleanup(target.stop)
        return target

    def _open_tunnel(self, target: _RawTarget) -> socket.socket:
        sock = socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5)
        self.addCleanup(sock.close)
        sock.sendall(
            (
                f"CONNECT 127.0.0.1:{target.port} HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        head = b""
        while b"\r\n\r\n" not in head:
            part = sock.recv(4096)
            self.assertTrue(part, "the proxy closed before answering CONNECT")
            head += part
        self.assertIn(b"200", head.split(b"\r\n", 1)[0])
        return sock

    @staticmethod
    def _wait_closed(sock: socket.socket, limit: float) -> float:
        """Seconds until the proxy closes `sock` (reading it); fails if it does not within `limit`."""
        started = time.monotonic()
        while time.monotonic() - started < limit:
            sock.settimeout(limit - (time.monotonic() - started))
            try:
                data = sock.recv(4096)
            except socket.timeout:
                break
            except ConnectionResetError:
                return time.monotonic() - started
            if not data:
                return time.monotonic() - started
        raise AssertionError(f"the tunnel was still open after {limit} s")

    def _assert_tunnel_released_cleanly(self) -> None:
        self.assertTrue(self.tunnel_done.wait(3), "the proxy did not finish with the tunnel")
        self.assertEqual(self.errors, [])


class TunnelIdleTest(TunnelHarnessTestCase):
    """`tunnel_idle_sec`: a tunnel with no byte in either direction is closed."""

    tunnel_idle_sec = 1

    def test_an_idle_tunnel_is_closed_after_the_timeout_and_frees_its_threads(self) -> None:
        target = self._target(_hold)
        sock = self._open_tunnel(target)

        elapsed = self._wait_closed(sock, limit=4)

        self.assertGreaterEqual(elapsed, 0.8, "closed before the idle timeout")
        self.assertTrue(target.closed.wait(2), "the upstream side was left open")
        self._assert_tunnel_released_cleanly()
        # The journal still has the one CONNECT line and nothing about the close.
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual((lines[0]["method"], lines[0]["result"]), ("CONNECT", "ok"))

    def test_a_trickle_in_both_directions_keeps_the_tunnel_open_until_it_stops(self) -> None:
        target = self._target(_echo)
        sock = self._open_tunnel(target)
        sock.settimeout(2)

        # 2.4 s of traffic, well over the 1 s limit, never silent for 0.3 s.
        for number in range(8):
            sock.sendall(b"x")
            self.assertEqual(sock.recv(16), b"x", f"closed during the trickle, at byte {number}")
            time.sleep(0.3)
        self.assertFalse(target.closed.is_set())

        elapsed = self._wait_closed(sock, limit=4)
        self.assertGreaterEqual(elapsed, 0.5, "the silence was not counted from the last byte")
        self._assert_tunnel_released_cleanly()

    def test_a_download_the_client_never_answers_is_not_idle(self) -> None:
        target = self._target(_stream_when_asked(chunks=8, interval=0.3))
        sock = self._open_tunnel(target)
        sock.settimeout(2)
        sock.sendall(b"go")

        received = 0
        while received < 8 * 1024:
            data = sock.recv(65536)
            self.assertTrue(data, f"closed during the download, after {received} bytes")
            received += len(data)
        self.assertFalse(target.closed.is_set())

        self._wait_closed(sock, limit=4)
        self._assert_tunnel_released_cleanly()

    def test_an_upload_nothing_answers_is_not_idle(self) -> None:
        target = self._target(_hold)
        sock = self._open_tunnel(target)

        for _ in range(8):
            sock.sendall(b"x" * 1024)
            time.sleep(0.3)
        deadline = time.monotonic() + 2
        while target.received < 8 * 1024 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(target.received, 8 * 1024)
        self.assertFalse(target.closed.is_set())

        self.assertTrue(target.closed.wait(4), "the tunnel stayed open after the upload stopped")
        self._assert_tunnel_released_cleanly()


class TunnelWithoutIdleLimitTest(TunnelHarnessTestCase):
    """The default: nothing but the two ends closes a tunnel."""

    def test_no_limit_is_configured_by_default(self) -> None:
        self.assertIsNone(self.proxy.config.tunnel_idle_sec)

    def test_an_idle_tunnel_stays_open_far_past_the_limit_the_other_tests_use(self) -> None:
        target = self._target(_echo)
        sock = self._open_tunnel(target)
        sock.settimeout(2)

        time.sleep(2.5)  # the idle tests close a silent tunnel after 1 s

        sock.sendall(b"still here")
        self.assertEqual(sock.recv(64), b"still here")
        self.assertFalse(target.closed.is_set())
        self.assertFalse(self.tunnel_done.is_set())
        sock.shutdown(socket.SHUT_WR)
        self.assertEqual(sock.recv(64), b"")
        self._assert_tunnel_released_cleanly()


class TunnelSendTest(unittest.TestCase):
    """The idle clock counts bytes moved, so a reader that takes a little now and then is not idle."""

    def setUp(self) -> None:
        self.sink, self.reader = socket.socketpair()
        self.other, self.other_peer = socket.socketpair()
        for sock in (self.sink, self.reader, self.other, self.other_peer):
            self.addCleanup(sock.close)
        # Tiny buffers, so that the chunk below cannot be absorbed in one go.
        self.sink.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        self.reader.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        self.tunnel = _Tunnel(self.sink, self.other, idle_sec=1)

    def _send(self, chunk: bytes, limit: float = 8) -> tuple[bool, float]:
        """`_Tunnel._send` on its own thread, so a send that never ends fails the test instead of hanging it."""
        outcome: dict[str, float | bool] = {}

        def work() -> None:
            started = time.monotonic()
            outcome["whole"] = self.tunnel._send(self.sink, chunk)
            outcome["seconds"] = time.monotonic() - started

        thread = threading.Thread(target=work, daemon=True)
        thread.start()
        thread.join(limit)
        self.assertFalse(thread.is_alive(), "the send did not end")
        return bool(outcome["whole"]), float(outcome["seconds"])

    def test_a_slow_reader_that_keeps_taking_bytes_does_not_time_the_chunk_out(self) -> None:
        stop = threading.Event()
        self.reader.settimeout(0.3)

        def read_slowly() -> None:
            while not stop.is_set():
                time.sleep(0.2)
                try:
                    self.reader.recv(2048)
                except OSError:
                    pass

        thread = threading.Thread(target=read_slowly, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(stop.set)

        whole, seconds = self._send(b"x" * 40000)

        self.assertTrue(whole)
        self.assertGreater(seconds, 2.0, "the chunk was absorbed at once; the test proves nothing")

    def test_a_reader_that_takes_nothing_ends_the_send_once_idle(self) -> None:
        whole, seconds = self._send(b"x" * 1_000_000)

        self.assertFalse(whole)
        self.assertGreaterEqual(seconds, 0.8)

    def test_a_non_positive_limit_is_refused(self) -> None:
        for bad in (0, -1, 0.0):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    _Tunnel(self.sink, self.other, idle_sec=bad)


class HealthTest(ProxyHarnessTestCase):
    def test_the_proxy_itself_is_a_health_probe_and_not_a_destination(self) -> None:
        response = self._request(b"GET /healthz HTTP/1.0\r\n\r\n")
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        body = json.loads(response.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["mode"], "log")
        self.assertEqual(body["destinations"], 0)
        self.assertEqual(self._lines(), [])

    def test_any_other_local_path_is_404(self) -> None:
        response = self._request(b"GET /nothing-here HTTP/1.0\r\n\r\n")
        self.assertIn(b"404", response.split(b"\r\n", 1)[0])
        self.assertEqual(self._lines(), [])


class EnforceTest(unittest.TestCase):
    """myrmidon(EGRESS-B): the same proxy, now with a decision."""

    def setUp(self) -> None:
        from egress_proxy.policy import BotPolicy, Destination, EgressPolicy, ProjectPolicy

        self.journal_text = io.StringIO()
        self.target = ThreadingHTTPServer(("127.0.0.1", 0), _TargetHandler)
        threading.Thread(target=self.target.serve_forever, daemon=True).start()
        self.addCleanup(self.target.shutdown)

        self.policy = EgressPolicy(
            bots={
                "agent-a": BotPolicy(project="example-project", allow=(Destination("127.0.0.1", 9999),)),
                "agent-b": BotPolicy(project="other-project"),
            },
            projects={
                "example-project": ProjectPolicy(mode="block", allow=(Destination("127.0.0.1", self.target.server_port),)),
                "other-project": ProjectPolicy(mode="log"),
            },
        )
        self.proxy = EgressProxyServer(
            Config(
                mode="enforce",
                bind="127.0.0.1",
                port=0,
                connect_timeout_sec=2,
                bots={"agent-a": BotEntry(bot_key="agent-a", project="from-the-file")},
            ),
            DestinationJournal(self.journal_text, {}),
            policy=self.policy,
        )
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
        self.addCleanup(self.proxy.shutdown)

    @staticmethod
    def _basic(user: str) -> str:
        return "Basic " + base64.b64encode(f"{user}:egress".encode("utf-8")).decode("ascii")

    def _request(self, head: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as sock:
            sock.sendall(head)
            sock.settimeout(5)
            chunks: list[bytes] = []
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)

    def _lines(self) -> list[dict]:
        return [json.loads(line) for line in self.journal_text.getvalue().splitlines() if line.strip()]

    def test_an_allowed_destination_still_goes_through(self) -> None:
        response = self._request(
            (
                f"GET http://127.0.0.1:{self.target.server_port}/hello HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        self.assertEqual(self._lines()[0]["result"], "ok")
        self.assertEqual(self._lines()[0]["project"], "example-project")

    def test_a_destination_on_no_list_is_refused_and_recorded(self) -> None:
        response = self._request(
            (
                f"CONNECT 127.0.0.1:{self.target.server_port + 1} HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        self.assertIn(b"403", response.split(b"\r\n", 1)[0])
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["result"], "blocked")
        self.assertEqual(lines[0]["project"], "example-project")

    def test_the_bot_s_own_list_is_added_to_its_project_s(self) -> None:
        response = self._request(
            (
                f"GET http://127.0.0.1:9999/hello HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        # Nothing listens on 9999: the point is that the policy let it through,
        # so the answer is the upstream 502, not the policy's 403.
        self.assertIn(b"502", response.split(b"\r\n", 1)[0])

    def test_a_project_in_log_mode_is_only_recorded(self) -> None:
        response = self._request(
            (
                f"CONNECT 127.0.0.1:{self.target.server_port} HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-b')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        self.assertEqual(self._lines()[0]["project"], "other-project")
        self.assertEqual(self._lines()[0]["result"], "ok")

    def test_the_refusal_feed_lists_what_was_refused(self) -> None:
        self._request(
            (
                f"CONNECT 127.0.0.1:{self.target.server_port + 1} HTTP/1.0\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        response = self._request(b"GET /refusals HTTP/1.0\r\n\r\n")
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        body = json.loads(response.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(len(body["refusals"]), 1)
        self.assertEqual(body["refusals"][0]["result"], "blocked")
        self.assertEqual(body["refusals"][0]["destination"], "127.0.0.1")

    def test_log_mode_is_the_rollback_switch(self) -> None:
        # The same document, but the service is in `log`: nothing may be refused
        # even though the project's policy says `block`.
        log_proxy = EgressProxyServer(
            Config(mode="log", bind="127.0.0.1", port=0, connect_timeout_sec=2),
            DestinationJournal(io.StringIO(), {}),
            policy=self.policy,
        )
        threading.Thread(target=log_proxy.serve_forever, daemon=True).start()
        self.addCleanup(log_proxy.shutdown)
        with socket.create_connection(("127.0.0.1", log_proxy.port), timeout=5) as sock:
            sock.sendall(
                (
                    f"CONNECT 127.0.0.1:{self.target.server_port + 1} HTTP/1.0\r\n"
                    f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                    "\r\n"
                ).encode("ascii")
            )
            head = sock.recv(4096)
        # 502 (nothing there) is the upstream answer; a 403 would mean the policy
        # was enforced in a mode that must only record.
        self.assertIn(b"502", head.split(b"\r\n", 1)[0])


if __name__ == "__main__":
    unittest.main()