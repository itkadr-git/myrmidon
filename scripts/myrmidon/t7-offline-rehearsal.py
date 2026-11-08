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
TARGET_MARKER = ".t7-offline-rehearsal-target"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_manifest(root: Path) -> dict[str, str]:
    manifest = {}
    if root.is_symlink():
        raise ValueError(f"symlink is not allowed as tree root: {root}")
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ValueError(f"symlink is not allowed in fixture tree: {relative}")
        if path.is_file() and path.name not in {"manifest.json", TARGET_MARKER}:
            manifest[relative.as_posix()] = digest(path)
    return manifest


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
    if source.is_symlink() or adopted.parent.is_symlink() or adopted.is_symlink():
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
    if adopted.exists():
        if not adopted.is_dir() or adopted.is_symlink() or not (adopted / TARGET_MARKER).is_file():
            raise ValueError("refusing to overwrite pre-existing rehearsal target")
    else:
        shutil.copytree(source, adopted)
        (adopted / TARGET_MARKER).touch()
    copied = tree_manifest(adopted)
    if copied != before or continuity(adopted / db_rel) != session_before:
        raise RuntimeError("adopt verification failed")
    print("ADOPT VERIFIED: path/hash manifest and session continuity match")
    if interrupt:
        print("INTERRUPTED MID-REHEARSAL (simulated); rerun rollback to restore")
    # Only remove a target created and marked by this rehearsal.
    if not (adopted / TARGET_MARKER).is_file():
        raise ValueError("refusing rollback of an unowned rehearsal target")
    if tree_manifest(adopted) != before:
        raise ValueError("refusing rollback of a modified rehearsal target")
    shutil.rmtree(adopted)
    shutil.copytree(source, adopted)
    (adopted / TARGET_MARKER).touch()
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
