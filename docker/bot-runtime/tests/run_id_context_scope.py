# myrmidon(OPE-10602): build-time regression for 20-run-scoped-run-id.patch
# after the rc.29 defect. The rc.29 image bound the gateway's INTERNAL
# run id (``run_<hex>``) as $PAPERCLIP_RUN_ID, so every agent board mutation
# died with HTTP 500 (``invalid input syntax for type uuid: "run_..."``) and
# reviewers could not write verdicts. This proves the patched behaviour the
# board depends on:
#   1. Only a UUID is a board run id — ``run_<hex>`` and friends are rejected
#      by normalize_board_run_id / set_run_id_vars (bind nothing).
#   2. The board run id carried on _RunLaunch.paperclip_run_id (from the
#      X-Paperclip-Run-Id request header) is the value that reaches
#      $PAPERCLIP_RUN_ID / $MYRMIDON_RUN_ID in a run's child env via the
#      _inject_session_context_env bridge — byte for byte, per run, and
#      never the gateway-internal run.run_id.
#   3. The bridge never touches the process env concurrent runs share.

import os
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.run_id_context import (
    normalize_board_run_id,
    run_id_bound,
    run_id_env,
    set_run_id_vars,
)
from tools.environments.local import _inject_session_context_env


BOARD_RUN_ID = "fadd45e9-0e04-44d8-ac32-22ed50d28e7a"
OTHER_BOARD_RUN_ID = "41816633-359d-411e-b471-9d037e01fac1"
GATEWAY_INTERNAL_RUN_ID = "run_964ef567abcdef0123456789abcdef01"


def main() -> None:
    # 1. Shape discipline: only a UUID names a board run.
    assert normalize_board_run_id(BOARD_RUN_ID) == BOARD_RUN_ID
    # Upper-case UUIDs are still UUIDs (board mints lowercase, do not 500 on
    # a hand-rolled caller).
    assert normalize_board_run_id(BOARD_RUN_ID.upper()) == BOARD_RUN_ID.upper()
    # The rc.29 garbage: gateway-internal run_<hex>.
    assert normalize_board_run_id(GATEWAY_INTERNAL_RUN_ID) is None
    # Idempotency keys / attempt labels are not run ids either.
    assert normalize_board_run_id("attempt-3") is None
    assert normalize_board_run_id("pc-run-1") is None
    assert normalize_board_run_id("") is None
    assert normalize_board_run_id(None) is None
    assert normalize_board_run_id("   ") is None
    # Whitespace around a UUID is tolerated (HTTP headers get stripped too,
    # but a defensive strip here costs nothing).
    assert normalize_board_run_id(f"  {BOARD_RUN_ID}\n") == BOARD_RUN_ID

    # 2a. Binding a non-UUID binds nothing — even when the caller (a future
    # patch, a delegate worker) passes the gateway-internal id by mistake.
    marker, reset = set_run_id_vars(GATEWAY_INTERNAL_RUN_ID)
    try:
        assert not run_id_bound()
        assert run_id_env() == {}
        env: dict = {"FOO": "1"}
        _inject_session_context_env(env)
        assert "PAPERCLIP_RUN_ID" not in env
        assert "MYRMIDON_RUN_ID" not in env
    finally:
        reset(marker)

    # 2b. Binding the board run id: the child-env bridge forwards exactly it.
    marker, reset = set_run_id_vars(BOARD_RUN_ID)
    try:
        assert run_id_bound()
        assert run_id_env() == {
            "PAPERCLIP_RUN_ID": BOARD_RUN_ID,
            "MYRMIDON_RUN_ID": BOARD_RUN_ID,
        }
        # An inherited stale container-level value must be overridden, and
        # the inherited value never survives under either name.
        env = {
            "FOO": "1",
            "PAPERCLIP_RUN_ID": "stale-container-run-id",
            "MYRMIDON_RUN_ID": "stale-container-run-id",
        }
        _inject_session_context_env(env)
        assert env["PAPERCLIP_RUN_ID"] == BOARD_RUN_ID
        assert env["MYRMIDON_RUN_ID"] == BOARD_RUN_ID
        # The bridge must not touch the process env concurrent runs share.
        assert os.environ.get("PAPERCLIP_RUN_ID") != BOARD_RUN_ID
    finally:
        reset(marker)
    assert not run_id_bound()

    # 2c. Two consecutive runs see exactly their own board run id — a second
    # bind replaces the first (this is the per-run invariant the rc.29 bug
    # broke fleet-wide).
    marker1, reset1 = set_run_id_vars(BOARD_RUN_ID)
    try:
        env = {"FOO": "1"}
        _inject_session_context_env(env)
        assert env["PAPERCLIP_RUN_ID"] == BOARD_RUN_ID
    finally:
        reset1(marker1)
    marker2, reset2 = set_run_id_vars(OTHER_BOARD_RUN_ID)
    try:
        env = {"FOO": "1"}
        _inject_session_context_env(env)
        assert env["PAPERCLIP_RUN_ID"] == OTHER_BOARD_RUN_ID
        assert env["MYRMIDON_RUN_ID"] == OTHER_BOARD_RUN_ID
    finally:
        reset2(marker2)

    # 2d. Unbound context: the bridge leaves a child env without the names —
    # never inventing a value, never resurrecting a stale one.
    env = {"FOO": "1"}
    _inject_session_context_env(env)
    assert "PAPERCLIP_RUN_ID" not in env
    assert "MYRMIDON_RUN_ID" not in env

    print("run-id run-scope regression (OPE-10602): ok")


if __name__ == "__main__":
    main()
