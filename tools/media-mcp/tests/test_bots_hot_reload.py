"""myrmidon(MEDIA-PROVISION): the facade reloads bots.json without a restart.

The board regenerates the registry from the fleet's cards; these tests pin the
reload contract: an unchanged file keeps the parsed registry, a rewritten file
swaps it in for the next authenticate, a broken rewrite keeps the last valid
registry and only logs a warning (the facade is never taken down for bots that
still authenticate).
"""

import hashlib
import json
import logging
import os
import tempfile
import time
import unittest
from pathlib import Path

from media_mcp.auth import Authenticator, PeerResolver
from media_mcp.config import BotsWatcher, Settings, load_bots


class Resolver(PeerResolver):
    def addrs(self, host):
        return {"192.0.2.5"}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def write_registry(path: Path, bots: dict) -> None:
    path.write_text(json.dumps({"bots": bots}), encoding="utf-8")


def settings_with_registry(tmp: Path) -> Settings:
    write_registry(tmp / "bots.json", {"bot-a": {"token_sha256": sha("ta"), "peer_host": "myrmidon-bot-a"}})
    return Settings(data_dir=tmp, bots_file=tmp / "bots.json", bots=load_bots(tmp / "bots.json"))


def touch_forward(path: Path) -> None:
    """Guarantee a stamp change even on coarse filesystem timestamp granularity."""
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns + 10**9, st.st_mtime_ns + 10**9))


class WatcherStamp(unittest.TestCase):
    def test_unchanged_stamp_keeps_registry(self):
        with tempfile.TemporaryDirectory() as t:
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            self.assertFalse(w.maybe_reload())
            self.assertEqual(set(w.bots), {"bot-a"})

    def test_rewritten_file_swaps_registry(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            write_registry(p, {"bot-a": {"token_sha256": sha("ta")},
                               "bot-b": {"token_sha256": sha("tb")}})
            touch_forward(p)
            self.assertTrue(w.maybe_reload())
            self.assertEqual(set(w.bots), {"bot-a", "bot-b"})

    def test_min_interval_throttles_the_stat(self):
        with tempfile.TemporaryDirectory() as t:
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=60)
            w._last_check = time.monotonic()
            # Change the file behind the watcher: inside the interval the stamp
            # is not even consulted, so nothing reloads...
            write_registry(cfg.bots_file, {"bot-x": {"token_sha256": sha("tx")}})
            self.assertFalse(w.maybe_reload())
            # ...and force bypasses the throttle.
            self.assertTrue(w.maybe_reload(force=True))
            self.assertEqual(set(w.bots), {"bot-x"})


class WatcherBrokenFile(unittest.TestCase):
    def test_invalid_json_keeps_last_valid_and_warns(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            p.write_text("{ this is not json", encoding="utf-8")
            touch_forward(p)
            with self.assertLogs("media_mcp.config", level="WARNING") as logs:
                self.assertFalse(w.maybe_reload())
            self.assertTrue(any("reload failed" in line for line in logs.output))
            self.assertEqual(set(w.bots), {"bot-a"})  # the old registry still serves

    def test_contract_violation_keeps_last_valid(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            write_registry(p, {"BOT-UPPER": {"token_sha256": sha("t")}})  # bad bot key
            touch_forward(p)
            with self.assertLogs("media_mcp.config", level="WARNING"):
                self.assertFalse(w.maybe_reload())
            self.assertEqual(set(w.bots), {"bot-a"})

    def test_vanished_file_keeps_last_valid(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            p.unlink()
            with self.assertLogs("media_mcp.config", level="WARNING"):
                self.assertFalse(w.maybe_reload())
            self.assertEqual(set(w.bots), {"bot-a"})

    def test_recovers_when_the_next_rewrite_is_valid(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            p.write_text("broken", encoding="utf-8")
            touch_forward(p)
            with self.assertLogs("media_mcp.config", level=logging.WARNING):
                w.maybe_reload()
            write_registry(p, {"bot-a": {"token_sha256": sha("new-ta")}})
            touch_forward(p)
            self.assertTrue(w.maybe_reload())
            self.assertEqual(w.bots["bot-a"].token_sha256, sha("new-ta"))


class AuthenticatorHotReload(unittest.TestCase):
    def test_new_token_authenticates_after_rewrite_without_restart(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            auth = Authenticator(cfg, Resolver(), bots_watcher=w)
            self.assertEqual(auth.identify("ta", "192.0.2.5").key, "bot-a")
            self.assertIsNone(auth.identify("t-new", "192.0.2.5"))
            # The board rewrites the registry: bot-a rotates its token.
            write_registry(p, {"bot-a": {"token_sha256": sha("t-new"), "peer_host": "myrmidon-bot-a"}})
            touch_forward(p)
            # Same process, no restart: the new token lands, the old one stops working.
            self.assertEqual(auth.identify("t-new", "192.0.2.5").key, "bot-a")
            self.assertIsNone(auth.identify("ta", "192.0.2.5"))

    def test_removed_token_stops_authenticating(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "bots.json"
            cfg = settings_with_registry(Path(t))
            w = BotsWatcher(cfg.bots_file, cfg.bots, min_interval_s=0)
            auth = Authenticator(cfg, Resolver(), bots_watcher=w)
            self.assertIsNotNone(auth.identify("ta", "192.0.2.5"))
            write_registry(p, {})  # card revoked
            touch_forward(p)
            self.assertIsNone(auth.identify("ta", "192.0.2.5"))

    def test_without_watcher_behaviour_is_unchanged(self):
        with tempfile.TemporaryDirectory() as t:
            cfg = settings_with_registry(Path(t))
            auth = Authenticator(cfg, Resolver())
            self.assertEqual(auth.identify("ta", "192.0.2.5").key, "bot-a")
            # cfg.bots stays the startup snapshot when no watcher is wired.
            write_registry(cfg.bots_file, {"bot-a": {"token_sha256": sha("other")}})
            touch_forward(cfg.bots_file)
            self.assertEqual(auth.identify("ta", "192.0.2.5").key, "bot-a")


if __name__ == "__main__":
    unittest.main()
