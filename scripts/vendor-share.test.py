#!/usr/bin/env python3
"""Behaviour tests for scripts/vendor-share.py (OPE-12084, AUDIT-PHASE-1).

Acceptance: the script prints JSON with `overall_percent` and `by_component`,
exits 0, and does not break on empty subdirectories. Everything runs in a
temporary git fixture; the real checkout is never touched.

    python3 scripts/vendor-share.test.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "vendor-share.py"


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


class VendorShareAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="vendor-share-py-"))
        cls.repo = cls.tmp / "repo"
        cls.repo.mkdir()

        def write(rel: str, text: str) -> None:
            path = cls.repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

        # -- vendor base commit -------------------------------------------------
        # (the real vendor base has no scripts/vendor-share.* files: the metric
        # of record is our own addition, so the fixture copies it in at HEAD)
        write("server/src/services/heartbeat.ts", "vendor line 1\nvendor line 2\nvendor line 3\n")
        write("ui/src/pages/Board.tsx", "vendor ui 1\nvendor ui 2\n")
        write("packages/mcp-server/index.mjs", "vendor mcp 1\nvendor mcp 2\n")
        write("packages/paperclip-runner/loop.js", "vendor runner 1\nvendor runner 2\n")
        write("tools/fleetd/main.go", "vendor fleet 1\nvendor fleet 2\n")
        write("doc/notes.md", "vendor doc 1\nvendor doc 2\n")
        write("doc/empty-area/keep.txt", "vendor empty 1\nvendor empty 2\n")
        write("package-lock.json", "{}\n")  # excluded by the metric of record
        git(cls.repo, "init", "-q", "-b", "main")
        git(cls.repo, "add", "-A")
        git(cls.repo, "commit", "-q", "-m", "vendor base")
        cls.base = git(cls.repo, "rev-parse", "HEAD")

        # -- our fork state -----------------------------------------------------
        # server: file touched but still above the threshold -> vendor-derived
        write("server/src/services/heartbeat.ts", "vendor line 1\nvendor line 2\nvendor line 3\nour line\n")
        # ui: file fully rewritten below the threshold -> NOT vendor-derived
        write("ui/src/pages/Board.tsx", "our own ui text one\nour own ui text two\n")
        # mcp/runner/fleet stay byte-identical -> vendor-derived
        # other: a brand-new file -> NOT vendor-derived
        write("doc/notes.md", "vendor doc 1\nvendor doc 2\nfork note\n")
        write("doc/new-fork-doc.md", "brand new\n")
        # a component and an area left with zero tracked files after the fork
        # commit: the script must still exit 0 and keep reporting them
        (cls.repo / "doc" / "empty-area" / "keep.txt").unlink()
        (cls.repo / "tools" / "fleetd" / "main.go").unlink()
        # the metric of record itself: new since the base, never vendor-derived
        real_metric = Path(__file__).resolve().parent / "myrmidon" / "vendor-share.mjs"
        metric_dst = cls.repo / "scripts" / "myrmidon"
        metric_dst.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(real_metric, metric_dst / "vendor-share.mjs")
        # an empty subdirectory (git cannot track it, but the script must not
        # break on it either way) and an empty matching area:
        (cls.repo / "tools" / "image-mcp").mkdir()
        git(cls.repo, "add", "-A")
        git(cls.repo, "commit", "-q", "-m", "fork changes")
        env = dict(os.environ)
        env.pop("MYRMIDON_VENDOR_SHARE_THRESHOLD", None)
        cls.env = env

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_script(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(self.env)
        env["MYRMIDON_VENDOR_SHARE_COMPONENTS"] = os.environ.get(
            "MYRMIDON_VENDOR_SHARE_COMPONENTS",
            "",  # suite-level override support only; default map otherwise
        )
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            cwd=str(self.tmp),
            env=env,
        )

    def test_acceptance_json_fields_and_exit_zero(self) -> None:
        result = self.run_script("--repo", str(self.repo), "--base", self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("overall_percent", payload)
        self.assertIn("by_component", payload)
        self.assertEqual(payload["base_commit"], self.base)
        # server: modified-but-similar -> vendor-derived (100%)
        self.assertEqual(payload["by_component"]["server"]["percent"], 100.0)
        self.assertEqual(payload["by_component"]["server"]["total"], 1)
        # ui: rewritten below the threshold -> not vendor-derived (0%)
        self.assertEqual(payload["by_component"]["ui"]["percent"], 0.0)
        # mcp/worker untouched -> 100%
        for component in ("mcp", "worker"):
            self.assertEqual(payload["by_component"][component]["total"], 1, component)
            self.assertEqual(payload["by_component"][component]["percent"], 100.0, component)
        # fleet: zero tracked files remain -> 0% without error
        self.assertEqual(payload["by_component"]["fleet"]["total"], 0)
        self.assertEqual(payload["by_component"]["fleet"]["percent"], 0.0)
        # doc/* is outside the audit map -> other; new file is not vendor-derived
        self.assertEqual(payload["by_component"]["other"]["total"], 2)
        self.assertEqual(payload["by_component"]["other"]["vendor_derived"], 1)
        overall_vendor = sum(b["vendor_derived"] for b in payload["by_component"].values())
        self.assertEqual(payload["total_files"], 6)
        self.assertEqual(payload["vendor_derived_files"], overall_vendor)
        self.assertEqual(payload["vendor_derived_files"], 4)
        self.assertAlmostEqual(payload["overall_percent"], round(4 / 6 * 100, 4))

    def test_compact_view_is_stable(self) -> None:
        full = json.loads(self.run_script("--repo", str(self.repo), "--base", self.base).stdout)
        compact = json.loads(
            self.run_script("--repo", str(self.repo), "--base", self.base, "--compact").stdout
        )
        self.assertEqual(compact["overall_percent"], full["overall_percent"])
        self.assertEqual(compact["by_component"], full["by_component"])
        self.assertNotIn("files", compact)

    def test_threshold_env_wins_over_default_and_flag_wins_over_env(self) -> None:
        base_run = json.loads(self.run_script("--repo", str(self.repo), "--base", self.base).stdout)
        self.assertEqual(base_run["threshold_source"], "default")
        env_run = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.repo), "--base", self.base],
            capture_output=True,
            text=True,
            env={**self.env, "MYRMIDON_VENDOR_SHARE_THRESHOLD": "0.9"},
        )
        self.assertEqual(env_run.returncode, 0, env_run.stderr)
        self.assertEqual(json.loads(env_run.stdout)["threshold_source"], "env")
        flag_run = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--repo", str(self.repo), "--base", self.base, "--threshold", "0.1",
            ],
            capture_output=True,
            text=True,
            env={**self.env, "MYRMIDON_VENDOR_SHARE_THRESHOLD": "0.9"},
        )
        self.assertEqual(flag_run.returncode, 0, flag_run.stderr)
        self.assertEqual(json.loads(flag_run.stdout)["threshold_source"], "flag")

    def test_component_override_env(self) -> None:
        result = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--repo", str(self.repo), "--base", self.base, "--compact",
            ],
            capture_output=True,
            text=True,
            env={
                **self.env,
                "MYRMIDON_VENDOR_SHARE_COMPONENTS": "doc=^doc/",
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("doc", payload["by_component"])
        self.assertEqual(payload["by_component"]["doc"]["total"], 2)
        self.assertEqual(payload["by_component"]["doc"]["vendor_derived"], 1)
        # the override is APPENDED to the built-in map, so built-ins still win
        # their own paths; only paths matching no built-in rule move to `doc`
        self.assertEqual(payload["by_component"]["server"]["total"], 1)
        # empty components stay in the output with zero counters
        self.assertEqual(payload["by_component"]["fleet"]["total"], 0)
        self.assertEqual(payload["by_component"]["fleet"]["percent"], 0.0)
        # leftover: the metric file itself is excluded by the metric of record
        self.assertEqual(payload["by_component"]["other"]["total"], 0)
        self.assertEqual(payload["by_component"]["other"]["vendor_derived"], 0)

    def test_bad_threshold_fails_cleanly(self) -> None:
        result = self.run_script("--repo", str(self.repo), "--base", self.base, "--threshold", "2")
        self.assertEqual(result.returncode, 1)
        self.assertIn("between 0 and 1", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_missing_base_file_fails_cleanly(self) -> None:
        empty = Path(tempfile.mkdtemp(prefix="vendor-share-empty-", dir=str(self.tmp)))
        self.addCleanup(shutil.rmtree, empty, True)
        metric_dirs = empty / "scripts" / "myrmidon"
        metric_dirs.mkdir(parents=True)
        shutil.copyfile(
            Path(__file__).resolve().parent / "myrmidon" / "vendor-share.mjs",
            metric_dirs / "vendor-share.mjs",
        )
        result = self.run_script("--repo", str(empty))
        self.assertEqual(result.returncode, 1)
        self.assertIn("--base", result.stderr)


if __name__ == "__main__":
    unittest.main()
