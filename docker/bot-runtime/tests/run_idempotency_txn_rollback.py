#!/usr/bin/env python3
"""Behaviour regression for 34-run-idempotency-txn-rollback.patch (OPE-12759).

A write to the run idempotency store whose commit fails (disk full, I/O error, busy
timeout) must not leave the SQLite connection inside its transaction. Before the patch
the next ``BEGIN IMMEDIATE`` failed with "cannot start a transaction within a
transaction" and every run request answered 500 until the gateway restarted.
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout")


class _FailingCommit:
    """Delegates to the real connection; the first commit raises like a full disk."""

    def __init__(self, conn):
        self._conn = conn
        self.fail_next_commit = True

    def commit(self):
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise sqlite3.OperationalError("database or disk is full")
        return self._conn.commit()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def main(argv):
    sys.path.insert(0, str(_hermes_dir(argv)))
    from gateway.platforms import api_server_run_idempotency as module

    store_cls = next(
        value for value in vars(module).values()
        if isinstance(value, type) and hasattr(value, "_immediate_txn"))
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, call in (
            ("update_status", lambda s: s.update_status("run-1", {"status": "completed"})),
            ("extend_retention", lambda s: s.extend_retention("scope", "run-1", 4_102_444_800.0)),
            ("status_for_run", lambda s: s.status_for_run("scope", "run-1", retention_until=4_102_444_800.0)),
        ):
            store = store_cls(str(Path(tmp, f"{name}.db")))
            store.reserve("scope", "key-1", "fp", "run-1", {"status": "running"})
            real = store._conn
            store._conn = _FailingCommit(real)
            try:
                call(store)
                failures.append(f"{name}: the injected commit failure did not surface")
            except sqlite3.OperationalError:
                pass
            if real.in_transaction:
                failures.append(f"{name}: the connection stayed inside the failed transaction")
            try:
                outcome, _ = store.lookup("scope", "key-1", "fp")
                if outcome != "reused":
                    failures.append(f"{name}: lookup after the failure returned {outcome!r}")
            except sqlite3.OperationalError as exc:
                failures.append(f"{name}: lookup after the failure raised {exc}")
            store._conn = real
            store.close()
        # A transaction left open on the connection (by any path) is rolled back before the
        # next BEGIN IMMEDIATE instead of failing it.
        store = store_cls(str(Path(tmp, "left-open.db")))
        store.reserve("scope", "key-1", "fp", "run-1", {"status": "running"})
        store._conn.execute("UPDATE run_idempotency SET updated_at = updated_at")
        try:
            outcome, _ = store.lookup("scope", "key-1", "fp")
            if outcome != "reused":
                failures.append(f"left-open: lookup returned {outcome!r}")
        except sqlite3.OperationalError as exc:
            failures.append(f"left-open: lookup raised {exc}")
        store.close()
    if failures:
        print("run idempotency transaction regression FAILED:\n- " + "\n- ".join(failures))
        return 1
    print("run idempotency transaction regression: ok (3 write paths + a transaction left open)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
