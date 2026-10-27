"""End-to-end checks for the opt-in WAKE-9.2 launcher."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LAUNCHER = Path(__file__).with_name("reviewer-isolation.py")


class ReviewerIsolationTests(unittest.TestCase):
    def test_reviewer_cannot_read_executor_files_or_history(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            root = Path(directory)
            author = root / "executor"
            author.mkdir()
            secret = author / "uncommitted.txt"
            secret.write_text("executor-only-canary")
            history = author / "session.json"
            history.write_text("executor-history-canary")
            link = root / "alias"
            link.symlink_to(secret)
            task = root / "task.txt"
            task.write_text("Review the submitted diff only.")
            diff = root / "change.diff"
            diff.write_text("+ approved change\n")
            probe = '''
import json, os, pathlib, subprocess, sys
context = json.load(sys.stdin)
assert context == {"task": "Review the submitted diff only.", "diff": "+ approved change\\n"}
assert "EXECUTOR_SESSION" not in os.environ
assert not list(pathlib.Path.home().iterdir())
assert sorted(p.name for p in pathlib.Path.cwd().iterdir()) == ["change.diff", "task.txt"]
for name in sys.argv[1:]:
    try:
        pathlib.Path(name).read_text()
    except PermissionError:
        pass
    else:
        raise AssertionError("executor file readable: " + name)
assert pathlib.Path("change.diff").read_text() == context["diff"]
child = subprocess.run([sys.executable, "-I", "-c",
    "import pathlib,sys; pathlib.Path(sys.argv[1]).read_text()", sys.argv[1]],
    text=True, capture_output=True)
assert child.returncode != 0 and "PermissionError" in child.stderr
pathlib.Path("review.txt").write_text("review result")
print("ISOLATED: task+diff readable; executor files, symlink and history denied")
'''
            result = subprocess.run(
                [sys.executable, str(LAUNCHER), "--task", str(task), "--diff", str(diff),
                 "--", sys.executable, "-I", "-c", probe, str(secret), str(history), str(link)],
                text=True, capture_output=True,
                env={**os.environ, "EXECUTOR_SESSION": "executor-history-canary"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("ISOLATED:", result.stdout)

    def test_fails_closed_without_landlock(self):
        # Invalid architecture must not silently fall back to an ordinary subprocess.
        import importlib.util
        spec = importlib.util.spec_from_file_location("reviewer_isolation", LAUNCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaisesRegex(RuntimeError, "Unsupported architecture"):
            module.landlock_syscalls("unsupported")


if __name__ == "__main__":
    unittest.main()
