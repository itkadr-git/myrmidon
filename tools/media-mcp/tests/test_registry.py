"""Registry build from bot cards (OPE-6377).

The deploy side exports the board's bot cards; the registry turns them into
the media service's bots.json. Every card gets an entry naming the environment
variable that carries the live token (token_env); the file itself holds no
credential. A bot whose variable is unset keeps its seat but no bearer token
matches — and because the profile compiler only adds the media block when a
token was issued, such a bot never calls the service at all.
"""
import json
import tempfile
import unittest
from pathlib import Path

from media_mcp import registry
from media_mcp.config import load_bots


class Registry(unittest.TestCase):
    def test_token_env_name_is_deterministic(self):
        self.assertEqual(registry.token_env_name("writer-bot"), "MEDIA_BOT_TOKEN_WRITER_BOT")
        self.assertEqual(registry.token_env_name("writer-bot"), registry.token_env_name("writer-bot"))

    def test_every_card_gets_a_token_env_entry(self):
        cards = [
            {"key": "writer-bot", "tools": ["send_photo"], "quota_bytes": 1024},
            {"key": "ops-bot"},
        ]
        out = registry.build_registry(cards)
        bots = out["bots"]
        self.assertEqual(set(bots), {"writer-bot", "ops-bot"})
        self.assertEqual(bots["writer-bot"]["token_env"], "MEDIA_BOT_TOKEN_WRITER_BOT")
        self.assertEqual(bots["ops-bot"]["token_env"], "MEDIA_BOT_TOKEN_OPS_BOT")
        self.assertEqual(bots["writer-bot"]["tools"], ["send_photo"])
        self.assertEqual(bots["writer-bot"]["quota_bytes"], 1024)
        # The registry file holds no usable credential.
        self.assertNotIn("token_sha256", bots["writer-bot"])
        self.assertNotIn('"token":', json.dumps(out))

    def test_bad_key_is_rejected(self):
        with self.assertRaises(ValueError):
            registry.build_registry([{"key": "bad key!"}])

    def test_registry_round_trips_through_load_bots(self):
        cards = [{"key": "writer-bot"}, {"key": "ops-bot"}]
        out = registry.build_registry(cards)
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "bots.json"
            path.write_text(json.dumps(out))
            loaded = load_bots(path)
        self.assertEqual(set(loaded), {"writer-bot", "ops-bot"})
        # The env var is unset: the seat exists, but no bearer token matches.
        self.assertIsNone(loaded["writer-bot"].token_sha256)
        self.assertEqual(loaded["writer-bot"].env_token, "MEDIA_BOT_TOKEN_WRITER_BOT")

    def test_live_token_resolves_at_load_time(self):
        import os
        os.environ["MEDIA_BOT_TOKEN_WRITER_BOT"] = "tok-writer"
        try:
            cards = [{"key": "writer-bot"}]
            out = registry.build_registry(cards)
            with tempfile.TemporaryDirectory() as t:
                path = Path(t) / "bots.json"
                path.write_text(json.dumps(out))
                loaded = load_bots(path)
            import hashlib
            self.assertEqual(loaded["writer-bot"].token_sha256, hashlib.sha256(b"tok-writer").hexdigest())
        finally:
            del os.environ["MEDIA_BOT_TOKEN_WRITER_BOT"]

    def test_check_reports_unset_tokens(self):
        cards = [{"key": "writer-bot"}]
        out = registry.build_registry(cards)
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "bots.json"
            path.write_text(json.dumps(out))
            rc = registry.main(["--check", str(path)])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
