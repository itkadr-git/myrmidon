#!/usr/bin/env python3
"""Behaviour regression for 30-vacuum-by-freelist.patch.

hermes ran the automatic VACUUM of state.db only in a pass whose own prune had just deleted a session
(``pruned > 0``). The bot runtime deletes old sessions through the API when a container starts, before
hermes' first maintenance tick, so that prune found nothing, VACUUM never ran and about 40% of every
state.db stayed free pages (15.6 GB of 39.9 GB on the fleet). With the patch the VACUUM runs when the
freelist share reaches AUTO_VACUUM_MIN_FREELIST_RATIO (0.25) whether or not this pass pruned anything,
and it first checks the room (2x the live data on the database's volume, a temp directory that is not RAM),
that no turn is running, and the ``min_vacuum_interval_days`` throttle.

The checks drive the real ``SessionDB.maybe_auto_prune_and_vacuum`` on real databases, and the gateway's
real ``_housekeeping_state_db_maintenance`` for the wiring. Only ``shutil.disk_usage`` and the filesystem
type probe are replaced where a scenario needs a full disk or a tmpfs.

Usage: vacuum_by_freelist.py [hermes-src-dir]   (exit 1 if any check fails; every check is run)
"""

import os
import shutil
import sys
import tempfile
import time
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace

FAILS = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"PASS: {name}")
    else:
        FAILS.append(name)
        print(f"FAIL: {name}" + (f"  [{detail}]" if detail else ""))


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/opt/hermes-src")
    root = Path(tempfile.mkdtemp(prefix="vacuum-by-freelist-"))
    os.environ["HERMES_HOME"] = str(root / "hermes-home")
    (root / "hermes-home").mkdir()
    sys.path.insert(0, str(target))
    sys.path = [p for p in sys.path if not (target != Path("/opt/hermes-src") and p == "/opt/hermes-src")]
    sys.meta_path = [finder for finder in sys.meta_path if not finder.__class__.__name__.startswith("_Editable")]
    for name in list(sys.modules):
        if name.startswith(("hermes_state", "hermes_cli", "gateway", "agent", "hermes_constants")):
            del sys.modules[name]

    # The VACUUM temp file goes to a directory on the same volume as the databases, like the entrypoint's
    # SQLITE_TMPDIR=$HERMES_HOME/.sqlite-tmp (the runtime image has no writable /var/tmp, and /tmp is RAM).
    sqlite_tmp = root / "sqlite-tmp"
    sqlite_tmp.mkdir()
    os.environ["SQLITE_TMPDIR"] = str(sqlite_tmp)

    import hermes_state as state
    import hermes_state_maintenance as maintenance
    import hermes_state_wal as wal
    from hermes_state_common import AUTO_VACUUM_MIN_FREELIST_RATIO

    check("the freelist threshold is still 0.25", AUTO_VACUUM_MIN_FREELIST_RATIO == 0.25,
          str(AUTO_VACUUM_MIN_FREELIST_RATIO))

    text = os.urandom(4096).hex()  # 8 KB of incompressible-looking text per message

    def fill(db, share: float) -> None:
        """Sessions with 20 messages each, plus a scratch table that is dropped again, so that `share` of
        the file ends up on the freelist (what a mass delete of old sessions leaves behind)."""
        for i in range(40):
            sid = f"s{i:03d}"
            db.create_session(sid, "api_server")
            db.append_messages_batch(
                sid, [{"role": "user" if n % 2 == 0 else "assistant", "content": f"{n} {text}"} for n in range(20)])
        pages = db._page_pragmas(("page_count",), "pragmas: %s")[0]
        rows = int(pages * share / (1.0 - share) / 2)  # an 8000-byte row takes two 4 KiB pages
        blob = os.urandom(8000)

        def _ballast(conn):
            conn.execute("CREATE TABLE ballast (x BLOB)")
            conn.executemany("INSERT INTO ballast VALUES (?)", ((blob,) for _ in range(rows)))
        db._execute_write(_ballast)
        db._write_sql("DROP TABLE ballast")

    counter = [0]

    def fresh_db(share: float = 0.5):
        counter[0] += 1
        path = root / f"case{counter[0]}" / "state.db"
        path.parent.mkdir()
        db = state.SessionDB(path)
        fill(db, share)
        db._try_checkpoint("TRUNCATE", "checkpoint: %s")
        return db

    def maint(db, **kwargs):
        # nothing is older than retention: the prune of this pass deletes nothing (pruned == 0)
        params = dict(retention_days=90, min_interval_hours=24, vacuum=True, min_vacuum_interval_days=7)
        params.update(kwargs)
        return db.maybe_auto_prune_and_vacuum(**params)

    def live_bytes(db) -> int:
        pc, fl, ps = db._page_pragmas(("page_count", "freelist_count", "page_size"), "pragmas: %s")
        return (pc - fl) * ps

    # --- 1. half of the pages are free, the prune finds nothing: VACUUM runs --------------------------------
    db = fresh_db()
    ratio_before = db._freelist_ratio()
    size_before = db.logical_size_bytes()
    check("setup: the database has at least 40% free pages", ratio_before is not None and ratio_before >= 0.4,
          f"ratio={ratio_before}")
    result = maint(db)
    check("pruned == 0 and the freelist share is above 25%: the VACUUM runs",
          result.get("pruned") == 0 and result.get("vacuumed") is True, str(result))
    ratio_after = db._freelist_ratio()
    size_after = db.logical_size_bytes()
    check("the free pages are gone after it", ratio_after is not None and ratio_after < 0.05,
          f"ratio_after={ratio_after}")
    check("the file shrank by about the free share",
          size_before is not None and size_after is not None and size_after < size_before * 0.65,
          f"{size_before} -> {size_after}")
    check("last_vacuum and last_auto_prune are recorded", bool(db.get_meta("last_vacuum"))
          and bool(db.get_meta("last_auto_prune")))
    check("the temp copy went to SQLITE_TMPDIR and left nothing behind", not any(sqlite_tmp.iterdir()),
          str(list(sqlite_tmp.iterdir())))
    again = maint(db)
    check("a second pass inside min_interval_hours does nothing", again.get("skipped") is True, str(again))
    db.close()

    # --- 2. below the threshold: no VACUUM ------------------------------------------------------------------
    db = fresh_db(share=0.10)
    ratio = db._freelist_ratio()
    result = maint(db)
    check("a database under 25% free is left alone",
          ratio is not None and ratio < 0.25 and result.get("vacuumed") is False and "vacuum_skipped" not in result,
          f"ratio={ratio} result={result}")
    db.close()

    db = fresh_db()
    real_ratio = db._freelist_ratio
    db._freelist_ratio = lambda: AUTO_VACUUM_MIN_FREELIST_RATIO
    result = maint(db)
    check("exactly at the threshold the vendor's strict gate still skips (25.0% does not VACUUM)",
          result.get("vacuumed") is False and "vacuum_skipped" not in result, str(result))
    db._freelist_ratio = real_ratio
    db.close()

    # --- 3. not enough room: skipped, retried on the next tick, runs once there is room ------------------
    db = fresh_db()
    live = live_bytes(db)
    Usage = namedtuple("Usage", "total used free")
    real_disk_usage = shutil.disk_usage
    try:
        shutil.disk_usage = lambda path: Usage(total=10 * live, used=0, free=2 * live - 1)
        result = maint(db)
        check("less than 2x the live data free: the VACUUM is skipped, with the reason",
              result.get("vacuumed") is False and "GB free" in result.get("vacuum_skipped", ""), str(result))
        check("a skipped VACUUM leaves last_auto_prune unset, so the next tick retries it",
              db.get_meta("last_auto_prune") is None and db.get_meta("last_vacuum") is None)
        shutil.disk_usage = lambda path: Usage(total=10 * live, used=0, free=2 * live)
        result = maint(db)
        check("exactly 2x the live data free: the VACUUM runs on the retry",
              result.get("vacuumed") is True, str(result))
        shutil.disk_usage = lambda path: (_ for _ in ()).throw(OSError("statvfs failed"))
        db2 = fresh_db()
        result = maint(db2)
        check("free space that cannot be read fails closed",
              result.get("vacuumed") is False and "could not read the free space" in result.get("vacuum_skipped", ""),
              str(result))
        db2.close()
    finally:
        shutil.disk_usage = real_disk_usage
    db.close()

    # --- 4. the temp directory is RAM (tmpfs): refused -----------------------------------------------------
    db = fresh_db()
    real_fstype = wal._mountinfo_fstype
    try:
        wal._mountinfo_fstype = lambda directory, *a, **k: "tmpfs"
        result = maint(db)
        check("a tmpfs temp directory is refused",
              result.get("vacuumed") is False and "RAM" in result.get("vacuum_skipped", ""), str(result))
    finally:
        wal._mountinfo_fstype = real_fstype
    result = maint(db)
    check("the same database is vacuumed once the temp directory is on the volume",
          result.get("vacuumed") is True, str(result))
    db.close()

    # --- 5. min_vacuum_interval_days -----------------------------------------------------------------------
    db = fresh_db()
    db.set_meta("last_vacuum", str(time.time() - 3 * 86400))
    result = maint(db, min_vacuum_interval_days=7)
    check("a VACUUM 3 days ago, interval 7 days: skipped",
          result.get("vacuumed") is False and "vacuum_skipped" not in result and "freelist_ratio" not in result,
          str(result))
    db._write_sql("DELETE FROM state_meta WHERE key = 'last_auto_prune'")
    db.set_meta("last_vacuum", str(time.time() - 8 * 86400))
    result = maint(db, min_vacuum_interval_days=7)
    check("a VACUUM 8 days ago, interval 7 days: runs", result.get("vacuumed") is True, str(result))
    db.close()

    db = fresh_db()
    result = maint(db, vacuum=False)
    check("vacuum_after_prune: false still disables it", result.get("vacuumed") is False, str(result))
    db.close()

    # --- 6. a turn is running ------------------------------------------------------------------------------
    db = fresh_db()
    sid = "s001"
    holder = f"pid={os.getpid()}:turn=test"
    check("setup: the turn lease is taken", db.try_acquire_session_turn_lease(sid, holder, ttl_seconds=300))
    result = maint(db)
    check("a live session turn lease holds the VACUUM back",
          result.get("vacuumed") is False and "turn" in result.get("vacuum_skipped", ""), str(result))
    check("and the pass is retried by the next tick", db.get_meta("last_auto_prune") is None)
    db.release_session_turn_lease(sid, holder)
    result = maint(db)
    check("the VACUUM runs after the lease is released", result.get("vacuumed") is True, str(result))
    db.close()

    db = fresh_db()
    result = maint(db, vacuum_defer=lambda: "the gateway is running 1 turn(s)")
    check("a reason from the caller (a turn the gateway runs) holds it back",
          result.get("vacuumed") is False and result.get("vacuum_skipped") == "the gateway is running 1 turn(s)",
          str(result))

    def boom():
        raise RuntimeError("no count")

    result = maint(db, vacuum_defer=boom)
    check("a caller that cannot tell fails closed", result.get("vacuumed") is False
          and "could not tell" in result.get("vacuum_skipped", ""), str(result))
    result = maint(db, vacuum_defer=lambda: None)
    check("a caller with no objection lets it run", result.get("vacuumed") is True, str(result))
    db.close()

    # --- 6b. size-based growth trigger (OPE-12883) -----------------------------------------------------------
    # A DB whose freelist is small (steady-state, pages reused in place) but whose file has
    # doubled since the last VACUUM must be vacuumed: the high-water mark means a large
    # fraction of the file is dead space that the freelist never shows.
    db = fresh_db(share=0.05)  # 5% free pages: way below the 25% threshold
    ratio = db._freelist_ratio()
    # Simulate: last VACUUM left the file at half its current size.
    current_size = db.logical_size_bytes()
    db.set_meta("last_vacuum_size_bytes", str(current_size // 2))
    db.set_meta("last_vacuum", str(time.time() - 8 * 86400))  # 8 days ago, past the 7-day throttle
    result = maint(db, min_vacuum_interval_days=7)
    check("a file that doubled since the last VACUUM is vacuumed even at 5% free",
          ratio is not None and ratio < 0.25 and result.get("vacuumed") is True, str(result))
    check("last_vacuum_size_bytes is refreshed after the VACUUM",
          db.get_meta("last_vacuum_size_bytes") is not None
          and int(db.get_meta("last_vacuum_size_bytes")) <= db.logical_size_bytes())
    db.close()

    # A file that grew less than the trigger is left alone even when the interval passed.
    db = fresh_db(share=0.05)
    current_size = db.logical_size_bytes()
    db.set_meta("last_vacuum_size_bytes", str(int(current_size * 0.9)))  # only 11% growth
    db.set_meta("last_vacuum", str(time.time() - 8 * 86400))
    result = maint(db, min_vacuum_interval_days=7)
    check("a file that grew only 11% since the last VACUUM is left alone",
          result.get("vacuumed") is False and "vacuum_skipped" not in result, str(result))
    db.close()

    # No recorded baseline: the freelist ratio is the only signal (existing behavior).
    db = fresh_db(share=0.05)
    db._write_sql("DELETE FROM state_meta WHERE key = 'last_vacuum_size_bytes'")
    db.set_meta("last_vacuum", str(time.time() - 8 * 86400))
    result = maint(db, min_vacuum_interval_days=7)
    check("no size baseline: the freelist ratio decides (small freelist, no VACUUM)",
          result.get("vacuumed") is False, str(result))
    db.close()

    # --- 7. the gateway: wiring and the busy check ---------------------------------------------------------
    import gateway.run as gateway_run

    idle = SimpleNamespace(_running_agent_count=lambda: 0, _active_api_run_count=lambda: 0)
    busy_api = SimpleNamespace(_running_agent_count=lambda: 0, _active_api_run_count=lambda: 2)
    busy_msg = SimpleNamespace(_running_agent_count=lambda: 1, _active_api_run_count=lambda: 0)

    def broken_count():
        raise RuntimeError("x")

    broken = SimpleNamespace(_running_agent_count=broken_count, _active_api_run_count=lambda: 0)
    check("the gateway check: idle -> no objection", gateway_run._vacuum_defer_reason(idle) is None)
    check("the gateway check: no runner -> no objection", gateway_run._vacuum_defer_reason(None) is None)
    check("the gateway check: API-server runs defer it", "2 turn" in (gateway_run._vacuum_defer_reason(busy_api) or ""))
    check("the gateway check: platform turns defer it", "1 turn" in (gateway_run._vacuum_defer_reason(busy_msg) or ""))
    check("the gateway check: an unreadable count defers it", "could not tell" in (gateway_run._vacuum_defer_reason(broken) or ""))

    home = Path(os.environ["HERMES_HOME"])
    seed = state.SessionDB(home / "state.db")
    fill(seed, 0.5)
    seed._try_checkpoint("TRUNCATE", "checkpoint: %s")
    seed.close()
    gateway_run._housekeeping_state_db_maintenance(None, busy_api)
    probe = state.SessionDB(home / "state.db", read_only=True)
    check("housekeeping with a run in flight: the free pages stay, nothing is recorded",
          probe._freelist_ratio() is not None and probe._freelist_ratio() >= 0.4
          and probe.get_meta("last_vacuum") is None
          and probe.get_meta("last_auto_prune") is None,
          f"ratio={probe._freelist_ratio()} last_vacuum={probe.get_meta('last_vacuum')}")
    probe.close()
    gateway_run._housekeeping_state_db_maintenance(None, idle)
    probe = state.SessionDB(home / "state.db", read_only=True)
    check("the next tick, idle: the gateway's housekeeping vacuums the store",
          probe._freelist_ratio() is not None and probe._freelist_ratio() < 0.05
          and probe.get_meta("last_vacuum") is not None,
          f"ratio={probe._freelist_ratio()} last_vacuum={probe.get_meta('last_vacuum')}")
    probe.close()

    # --- 8. the temp directory SQLite would pick -----------------------------------------------------------
    check("SQLITE_TMPDIR is the first choice", maintenance._sqlite_temp_dir() == os.path.realpath(sqlite_tmp))
    del os.environ["SQLITE_TMPDIR"]
    os.environ["TMPDIR"] = str(root)
    check("then TMPDIR", maintenance._sqlite_temp_dir() == os.path.realpath(root))
    os.environ["SQLITE_TMPDIR"] = str(root / "does-not-exist")
    check("a SQLITE_TMPDIR that does not exist falls through to TMPDIR",
          maintenance._sqlite_temp_dir() == os.path.realpath(root))

    shutil.rmtree(root, ignore_errors=True)
    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
