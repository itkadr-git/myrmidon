# myrmidon(BOT-DISK-H5b): build-time regression for 10-run-workspace-open.patch.
# The import smoke proves the patched modules import; this proves the behaviour
# the board depends on (contract C6): a run's ``workspace`` body field runs
# ``myr-ws open <key> <repo> [--base <ref>] --json`` before the model starts,
# binds the opened path as the run's cwd and MYRMIDON_TASK_WORKSPACE for its
# children, falls back to /scratch with a warning payload on exit codes 3/4/5,
# and is a complete no-op when the field is absent. A fake myr-ws script
# (MYRMIDON_WS_BIN) stands in for the real CLI from the sibling tasks.

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.run_workspace import (
    RUN_WORKSPACE_FALLBACK_DIR,
    MYR_WS_OPEN_TIMEOUT_SEC,
    _validate_workspace_field,
    open_task_workspace,
    reset_run_task_workspace,
    run_task_workspace_env,
    run_task_workspace_path,
    set_run_task_workspace,
    task_workspace_env_name,
)
from tools.environments.local import _inject_session_context_env


def _fake_myr_ws(tmpdir: str, *, code: int, payload: dict, record: str) -> str:
    script = os.path.join(tmpdir, "myr-ws-fake")
    with open(script, "w") as fh:
        fh.write(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" > {record}\n"
            f"printf '%s\\n' '{json.dumps(payload)}'\n"
            f"exit {code}\n"
        )
    os.chmod(script, 0o755)
    return script


def main() -> None:
    tmpdir = tempfile.mkdtemp(prefix="ws-open-test-")
    record = os.path.join(tmpdir, "argv.txt")
    os.environ["MYRMIDON_WS_BIN"] = _fake_myr_ws(
        tmpdir, code=0,
        payload={"ok": True, "key": "OPE-1", "path": "/workspace/OPE-1",
                 "class": "E", "repo": "acme/widgets", "branch": "bot/OPE-1",
                 "base": "origin/main", "reused": False},
        record=record)

    # Field present: open called with the contract argv, path bound, env
    # fragment carries MYRMIDON_TASK_WORKSPACE only for the bound run context.
    field = {"key": "OPE-1", "repo": "acme/widgets", "baseRef": "main"}
    opened = open_task_workspace(field)
    assert opened == {"path": "/workspace/OPE-1", "fallback": False,
                      "exit_code": 0, "error": ""}
    with open(record) as fh:
        argv_seen = fh.read().strip()
    assert argv_seen == "open OPE-1 acme/widgets --base main --json", argv_seen
    token = set_run_task_workspace(opened["path"], fallback=opened["fallback"])
    try:
        assert run_task_workspace_path() == "/workspace/OPE-1"
        assert run_task_workspace_env() == {"MYRMIDON_TASK_WORKSPACE": "/workspace/OPE-1"}
        env = {"FOO": "1", "MYRMIDON_TASK_WORKSPACE": "stale"}
        _inject_session_context_env(env)
        assert env["MYRMIDON_TASK_WORKSPACE"] == "/workspace/OPE-1"
        # The bridge must not touch the process env concurrent runs share.
        assert "MYRMIDON_TASK_WORKSPACE" not in os.environ
    finally:
        reset_run_task_workspace(token)
    assert run_task_workspace_path() is None

    # No field: unbound context injects nothing and STRIPS an inherited value —
    # an earlier surface's path must never serve a different run.
    env = {"FOO": "1", "MYRMIDON_TASK_WORKSPACE": "stale"}
    _inject_session_context_env(env)
    assert "MYRMIDON_TASK_WORKSPACE" not in env
    assert run_task_workspace_env() == {}

    # No baseRef: argv has no --base pair at all.
    os.remove(record)
    open_task_workspace({"key": "OPE-2", "repo": "acme/widgets"})
    with open(record) as fh:
        assert fh.read().strip() == "open OPE-2 acme/widgets --json"

    # Contract refusal family 3/4/5: fallback to /scratch with the CLI's error
    # text as the warning (never a silent wrong-directory run, never a raise).
    for code in (3, 4, 5):
        os.environ["MYRMIDON_WS_BIN"] = _fake_myr_ws(
            tmpdir, code=code,
            payload={"ok": False, "error": f"refusal {code}", "exitCode": code},
            record=record)
        opened = open_task_workspace({"key": "OPE-3", "repo": "acme/widgets"})
        assert opened["fallback"] is True, (code, opened)
        assert opened["path"] == RUN_WORKSPACE_FALLBACK_DIR == "/scratch"
        assert opened["exit_code"] == code
        assert f"refusal {code}" in opened["error"]

    # Non-refusal failure (timeout family): a hard RuntimeError, not a silent
    # fallback — a broken CLI or call shape is operator-visible breakage.
    os.environ["MYRMIDON_WS_BIN"] = _fake_myr_ws(
        tmpdir, code=2, payload={"ok": False, "error": "usage", "exitCode": 2},
        record=record)
    try:
        open_task_workspace({"key": "OPE-4", "repo": "acme/widgets"})
        raise AssertionError("exit 2 must raise, not fall back")
    except RuntimeError as exc:
        assert "exit 2" in str(exc)

    # Missing binary: the contract refusal family covers a host without the CLI
    # too — fall back with a warning rather than fail every run there.
    os.environ["MYRMIDON_WS_BIN"] = os.path.join(tmpdir, "no-such-binary")
    opened = open_task_workspace({"key": "OPE-5", "repo": "acme/widgets"})
    assert opened["fallback"] is True and opened["path"] == "/scratch"

    # Field validation mirrors the C6 zod schema: key PREFIX-123, repo
    # owner/name, optional baseRef a plausible git ref.
    assert _validate_workspace_field(
        {"key": "ABC-101", "repo": "acme/widgets", "baseRef": "origin/x"}) == \
        {"key": "ABC-101", "repo": "acme/widgets", "baseRef": "origin/x"}
    for bad in ({}, {"key": "ope-1", "repo": "a/b"}, {"key": "A-1"},
                {"key": "A-1", "repo": "noowner"}, {"key": "A-1", "repo": "a/b", "baseRef": " "},
                "OPE-1"):
        try:
            _validate_workspace_field(bad)
            raise AssertionError(f"accepted malformed field: {bad!r}")
        except ValueError:
            pass
    assert MYR_WS_OPEN_TIMEOUT_SEC == 120
    assert task_workspace_env_name() == "MYRMIDON_TASK_WORKSPACE"

    print("run-workspace-open regression: ok")


if __name__ == "__main__":
    main()
