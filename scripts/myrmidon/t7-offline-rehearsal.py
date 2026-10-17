#!/usr/bin/env python3
"""Offline-only synthetic adopt/rollback rehearsal for T7-A."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from pathlib import Path

MARKER = ".t7-offline-rehearsal"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_manifest(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): digest(p)
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != "manifest.json"
    }


def continuity(db: Path) -> tuple[int, str]:
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT session_id, payload FROM sessions ORDER BY session_id").fetchall()
    encoded = json.dumps(rows, separators=(",", ":"), ensure_ascii=True)
    return len(rows), hashlib.sha256(encoded.encode()).hexdigest()


def safe_root(path: Path) -> Path:
    root = path.resolve()
    if not root.is_dir() or not (root / MARKER).is_file():
        raise ValueError(f"refusing unmarked synthetic fixture: {root}")
    return root


def run(root: Path, execute: bool, interrupt: bool) -> None:
    root = safe_root(root)
    source, adopted = root / "hermes", root / "adopted" / "hermes"
    if source.is_symlink() or adopted.is_symlink():
        raise ValueError("symlink roots are not allowed")
    before = tree_manifest(source)
    db_rel = "workspace/state/sessions.sqlite"
    session_before = continuity(source / db_rel)
    print("MODE: " + ("OFFLINE EXECUTION" if execute else "DRY-RUN (default)"))
    print("LIVE ACCEPTANCE: NO; synthetic fixture only")
    print(f"SOURCE FILES: {len(before)}; sessions: {session_before[0]}; session digest: {session_before[1]}")
    print("SEQUENCE: gates T3/T4/T6 + security + headroom -> work-finansist canary (datadir preserved, profile no-op) -> idle -> heavy -> work")
    print("LEGACY vm-core containers: quarantine, never delete; snapshot cadence: 15 minutes; synchronous replication: absent in 1.6.6")
    if not execute:
        print("Would copy synthetic tree, verify manifest/session continuity, then restore on rollback.")
        return
    target = adopted.parent
    target.mkdir(parents=True, exist_ok=True)
    if not adopted.exists():
        shutil.copytree(source, adopted)
    copied = tree_manifest(adopted)
    if copied != before or continuity(adopted / db_rel) != session_before:
        raise RuntimeError("adopt verification failed")
    print("ADOPT VERIFIED: path/hash manifest and session continuity match")
    if interrupt:
        print("INTERRUPTED MID-REHEARSAL (simulated); rerun rollback to restore")
    # A rollback always replaces only this rehearsal's marked synthetic target.
    shutil.rmtree(adopted)
    shutil.copytree(source, adopted)
    if tree_manifest(adopted) != before or continuity(adopted / db_rel) != session_before:
        raise RuntimeError("rollback verification failed")
    print("ROLLBACK VERIFIED: manifest and sessions match; repeated rollback creates no duplicate target")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path, help="explicit synthetic fixture root containing marker")
    parser.add_argument("--execute", action="store_true", help="perform file operations (otherwise dry-run)")
    parser.add_argument("--simulate-interruption", action="store_true", help="report interrupted middle and verify rollback")
    args = parser.parse_args()
    try:
        run(args.fixture, args.execute, args.simulate_interruption)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
