"""Safety tests for the synthetic T7 rehearsal fixture."""
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("t7-offline-rehearsal.py")
SPEC = importlib.util.spec_from_file_location("t7_rehearsal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class RehearsalSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / MODULE.MARKER).touch()
        db = self.root / "hermes/workspace/state/sessions.sqlite"
        db.parent.mkdir(parents=True)
        with sqlite3.connect(db) as conn:
            conn.execute("CREATE TABLE sessions(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            conn.execute("INSERT INTO sessions VALUES ('synthetic', 'fixture')")

    def test_preexisting_target_is_preserved(self):
        adopted = self.root / "adopted/hermes"
        adopted.mkdir(parents=True)
        sentinel = adopted / "valuable.txt"
        sentinel.write_text("must survive")
        with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
            MODULE.run(self.root, execute=True, interrupt=False)
        self.assertEqual(sentinel.read_text(), "must survive")

    def test_nested_symlink_escape_is_rejected(self):
        outside = self.root.parent / (self.root.name + "-outside")
        outside.write_text("outside fixture")
        self.addCleanup(outside.unlink, missing_ok=True)
        (self.root / "hermes/workspace/escape").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink is not allowed"):
            MODULE.tree_manifest(self.root / "hermes")

    def test_rollback_is_idempotent_for_owned_target(self):
        MODULE.run(self.root, execute=True, interrupt=True)
        target = self.root / "adopted/hermes"
        marker = target / MODULE.TARGET_MARKER
        self.assertTrue(marker.is_file())
        MODULE.run(self.root, execute=True, interrupt=False)
        self.assertTrue(marker.is_file())
        self.assertEqual(MODULE.continuity(target / "workspace/state/sessions.sqlite")[0], 1)


if __name__ == "__main__":
    unittest.main()