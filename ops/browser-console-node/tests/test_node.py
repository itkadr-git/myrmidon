# myrmidon(BROWSER-CONSOLE): node contract tests (stdlib unittest — the node
# ships with no third-party dependency and neither do its tests).
#
# Covers every method of the screen-console-client contract — open/done/
# heartbeat/pause/resume/clear-site-data — the auth gate, and the heartbeat
# insurance: an unnoticed session must be released by the watchdog itself.

import sys
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import node  # noqa: E402


def make_cfg(**overrides):
    cfg = {
        "token": "test-token",
        "bind": "exec-host.invalid",
        "port": 8931,
        "vnc_port": 5900,
        "display": ":99",
        "cdp_port": 9222,
        "vnc_url": None,
    }
    cfg.update(overrides)
    return cfg


class FakeRegistryClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t


class RecordingSystemd:
    """Captures unit starts/stops and service actions instead of running systemctl."""

    def __init__(self, service_rc=0):
        self.started = []   # (unit, cmd)
        self.stopped = []   # unit
        self.actions = []   # (action, unit)
        self.service_rc = service_rc

    def start(self, unit, cmd):
        self.started.append((unit, cmd))

    def stop(self, unit):
        self.stopped.append(unit)

    def service(self, action, unit):
        self.actions.append((action, unit))
        return self.service_rc


class FakeCdpSocket:
    def __init__(self):
        self.calls = []
        self.closed = False

    def call(self, method, params=None):
        self.calls.append((method, params or {}))
        return {"id": len(self.calls), "result": {}}

    def close(self):
        self.closed = True


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeRegistryClock()
        self.registry = node.Registry(clock=self.clock.now)
        self.systemd = RecordingSystemd()
        self.cdp = FakeCdpSocket()
        self.cfg = make_cfg()

    def dispatch(self, method, path, **fakes):
        seams = {
            "start_unit": self.systemd.start,
            "stop_unit": self.systemd.stop,
            "service_action": self.systemd.service,
            "cdp_clear": lambda domain: node.clear_site_data(
                int(self.cfg["cdp_port"]), domain, ws_factory=lambda port: self.cdp
            ),
        }
        seams.update(fakes)
        return node.handle_request(method, path, self.cfg, self.registry, **seams)

    # -- open ---------------------------------------------------------------

    def test_open_starts_x11vnc_unit_and_returns_the_contract_shape(self):
        status, body = self.dispatch("POST", "/browsers/browser-a/open")
        self.assertEqual(status, 200)
        self.assertIn("wsUrl", body)
        self.assertIn("screenSessionId", body)
        unit, cmd = self.systemd.started[0]
        self.assertEqual(unit, "browser-screen-x11vnc@browser-a.service")
        self.assertEqual(cmd[0], "x11vnc")
        self.assertIn(":99", cmd)
        self.assertIn("5900", cmd)
        self.assertIn("-nopw", cmd)
        self.assertNotIn("-localhost", cmd)  # guacd is on another host
        self.assertEqual(body["wsUrl"], "vnc://exec-host.invalid:5900")

    def test_open_uses_the_guacd_visible_host_for_wsUrl(self):
        self.cfg["vnc_url"] = "vnc-host.invalid"
        _, body = self.dispatch("POST", "/browsers/browser-a/open")
        self.assertEqual(body["wsUrl"], "vnc://vnc-host.invalid:5900")

    def test_open_refuses_browser_ids_that_are_not_safe_unit_instances(self):
        for bad_id in ["../evil", "browser a", "browser;rm", ""]:
            # Wire-realistic: ids arrive percent-encoded so they stay one path
            # segment (a client would collapse un-encoded ../ into the path).
            status, _ = self.dispatch("POST", f"/browsers/{urllib.parse.quote(bad_id, safe='')}/open")
            self.assertEqual(status, 400, bad_id)
        self.assertEqual(self.systemd.started, [])

    # -- done ---------------------------------------------------------------

    def test_done_stops_the_unit_and_is_idempotent(self):
        _, body = self.dispatch("POST", "/browsers/browser-a/open")
        session_id = body["screenSessionId"]
        status, _ = self.dispatch("POST", f"/sessions/{session_id}/done")
        self.assertEqual(status, 200)
        self.assertEqual(self.systemd.stopped, ["browser-screen-x11vnc@browser-a.service"])
        # A second done (the board retried, or the watchdog won the race): 200, no second stop.
        status, _ = self.dispatch("POST", f"/sessions/{session_id}/done")
        self.assertEqual(status, 200)
        self.assertEqual(len(self.systemd.stopped), 1)

    # -- heartbeat ----------------------------------------------------------

    def test_heartbeat_refreshes_the_session(self):
        _, body = self.dispatch("POST", "/browsers/browser-a/open")
        session_id = body["screenSessionId"]
        session = self.registry.get(session_id)
        self.clock.t += 60
        status, _ = self.dispatch("POST", f"/sessions/{session_id}/heartbeat?activity=1")
        self.assertEqual(status, 200)
        self.assertEqual(self.clock.t, self.registry.get(session_id).last_seen)
        self.assertTrue(self.registry.get(session_id).activity)

    def test_heartbeat_for_unknown_session_is_404(self):
        status, _ = self.dispatch("POST", "/sessions/nobody/heartbeat?activity=0")
        self.assertEqual(status, 404)

    # -- pause / resume -----------------------------------------------------

    def test_pause_stops_the_reaper_proxy_resume_starts_it(self):
        status, body = self.dispatch("POST", "/browsers/browser-a/pause")
        self.assertEqual(status, 200)
        self.assertEqual(self.systemd.actions[-1], ("stop", "mcp-reaper-proxy.service"))
        status, body = self.dispatch("POST", "/browsers/browser-a/resume")
        self.assertEqual(status, 200)
        self.assertEqual(self.systemd.actions[-1], ("start", "mcp-reaper-proxy.service"))

    def test_pause_reports_502_when_systemctl_fails(self):
        self.systemd.service_rc = 1
        status, _ = self.dispatch("POST", "/browsers/browser-a/pause")
        self.assertEqual(status, 502)

    # -- clear-site-data ----------------------------------------------------

    def test_clear_site_data_drives_the_cdp_methods(self):
        _, body = self.dispatch("POST", "/browsers/browser-a/open")
        status, _ = self.dispatch("POST", "/browsers/browser-a/clear-site-data?domain=example.com")
        self.assertEqual(status, 200)
        methods = [call[0] for call in self.cdp.calls]
        self.assertEqual(methods, [
            "Network.enable",
            "Network.clearBrowserCookies",
            "Storage.clearDataForOrigin",
            "Storage.clearDataForOrigin",
        ])
        origins = {call[1]["origin"] for call in self.cdp.calls if call[0] == "Storage.clearDataForOrigin"}
        self.assertEqual(origins, {"https://example.com", "http://example.com"})
        self.assertTrue(self.cdp.closed)

    def test_clear_site_data_validates_the_domain(self):
        for bad in ["", "https://example.com", "example.com/path", "*.example.com", "localhost"]:
            status, _ = self.dispatch("POST", f"/browsers/browser-a/clear-site-data?domain={bad}")
            self.assertEqual(status, 400, bad)

    def test_clear_site_data_maps_cdp_failure_to_502(self):
        def explode(domain):
            raise RuntimeError("cdp refused")
        status, body = self.dispatch("POST", "/browsers/browser-a/clear-site-data?domain=example.com", cdp_clear=explode)
        self.assertEqual(status, 502)
        self.assertIn("cdp refused", body["error"])

    # -- misc ---------------------------------------------------------------

    def test_unknown_paths_are_404(self):
        status, _ = self.dispatch("POST", "/nope")
        self.assertEqual(status, 404)


class HeartbeatInsuranceTests(unittest.TestCase):
    """The watchdog releases a session the board stopped talking about."""

    def setUp(self):
        self.clock = FakeRegistryClock()
        self.registry = node.Registry(clock=self.clock.now)
        self.stopped = []

    def test_stale_after_the_timeout_and_reap_stops_the_unit(self):
        session = node.Session("s-1", "browser-a", "browser-screen-x11vnc@browser-a.service", "vnc://h:5900", self.clock.now())
        self.registry.add(session)
        self.assertEqual(self.registry.stale(), [])
        # 119 seconds: still fresh (the board heartbeat cadence is 30 s).
        self.clock.t += node.HEARTBEAT_TIMEOUT_S - 1
        self.assertEqual(self.registry.stale(), [])
        # past 120 s: stale, and the release seam stops the unit.
        self.clock.t += 2
        stale = self.registry.stale()
        self.assertEqual([s.session_id for s in stale], ["s-1"])
        self.registry.remove("s-1")
        node.release(stale[0], stop=self.stopped.append)
        self.assertEqual(self.stopped, ["browser-screen-x11vnc@browser-a.service"])
        self.assertEqual(self.registry.stale(), [])


class BrowserScreenCommandTests(unittest.TestCase):
    def test_command_attaches_the_display_on_the_vnc_port(self):
        cmd = node.browser_screen_command("browser-a", make_cfg(vnc_port=5901, display=":99"))
        self.assertEqual(cmd, ["x11vnc", "-display", ":99", "-rfbport", "5901", "-nopw", "-forever", "-shared"])


class RegistryUnitTests(unittest.TestCase):
    def test_touch_on_missing_session_returns_none(self):
        registry = node.Registry(clock=FakeRegistryClock().now)
        self.assertIsNone(registry.touch("gone", True))

    def test_activity_latches_until_done(self):
        clock = FakeRegistryClock()
        registry = node.Registry(clock=clock.now)
        session = node.Session("s", "b", "u", "v", clock.now())
        registry.add(session)
        registry.touch("s", False)
        self.assertFalse(registry.get("s").activity)
        registry.touch("s", True)
        registry.touch("s", False)
        self.assertTrue(registry.get("s").activity)


class WsFrameTests(unittest.TestCase):
    """The hand-rolled client masks per RFC6455; CDP servers reject the rest."""

    class Recorder:
        def __init__(self):
            self.written = b""

        def sendall(self, data):
            self.written += data

    def _client(self):
        client = node.WsClient.__new__(node.WsClient)  # no socket for the frame test
        client.sock = self.Recorder()
        client._next_id = 0
        return client

    def test_send_masks_a_text_frame(self):
        client = self._client()
        payload = {"id": 1, "method": "Network.enable"}
        client.send(payload)
        raw = client.sock.written
        self.assertEqual(raw[0], 0x81)
        self.assertTrue(raw[1] & 0x80)  # the mask bit must be set
        length = raw[1] & 0x7F
        mask = raw[2:6]
        body = raw[6:6 + length]
        unmasked = bytes(b ^ mask[i % 4] for i, b in enumerate(body))
        import json as _json
        self.assertEqual(_json.loads(unmasked), payload)


if __name__ == "__main__":
    unittest.main()
