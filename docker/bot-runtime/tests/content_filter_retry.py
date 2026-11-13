#!/usr/bin/env python3
"""Behaviour regression for 36-content-filter-retry.patch.

An HTTP-200 reply with ``finish_reason == "content_filter"`` must not end the turn at once: the same
model call is re-issued up to twice in the same turn (the restart flag is armed and the loop is told to
"break" into the rebuilt-message restart); only a refusal that repeats after that ends the turn with the
typed ``content_policy_blocked`` result. A new turn starts the count from zero. The fallback chain is
still used after the retries when one is configured.

``handle_content_policy_refusal`` is the real function; the agent is a stub that records the calls.

Usage: content_filter_retry.py [hermes-src-dir]   (exit 1 if any check fails; every check is run)
"""

import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

FAILS = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"PASS: {name}")
    else:
        FAILS.append(name)
        print(f"FAIL: {name}" + (f"  [{detail}]" if detail else ""))


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/opt/hermes-src")
    sys.path.insert(0, str(target))
    sys.path = [p for p in sys.path if not (target != Path("/opt/hermes-src") and p == "/opt/hermes-src")]
    sys.meta_path = [finder for finder in sys.meta_path if not finder.__class__.__name__.startswith("_Editable")]
    for k in list(sys.modules.keys()):
        if k == "agent" or k.startswith("agent.") or k == "run_agent" or k.startswith("providers"):
            del sys.modules[k]
    os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="content-filter-retry-test-"))

    import agent.turn_truncation as tt
    from agent.turn_retry_state import TurnRetryState

    tt.normalize_response_for_agent = lambda agent, response: SimpleNamespace(
        content="partial reply cut by the filter", provider_data={}
    )

    def make_agent(fallback: bool = False):
        agent = MagicMock()
        agent.log_prefix = ""
        agent.model = "test-model"
        agent.provider = "custom"
        agent.thinking_callback = None
        agent._has_pending_fallback.return_value = fallback
        agent._try_activate_fallback.return_value = fallback
        agent._content_filter_retries = None
        return agent

    def refuse(agent, retry, turn_id="turn-1"):
        return tt.handle_content_policy_refusal(
            agent, object(), retry, thinking_spinner=None, messages=[], api_messages=[], api_kwargs={},
            active_system_prompt="sys", conversation_history=[], api_call_count=1,
            effective_task_id="task", turn_id=turn_id, api_request_id=f"{turn_id}:api:1",
            api_start_time=0.0, retry_count=0, max_retries=3,
        )

    limit = tt._CONTENT_FILTER_RETRIES
    check("retry budget is bounded to 1..2 re-issued calls", 1 <= limit <= 2, str(limit))

    # ---- no fallback: re-issue `limit` times, then the typed terminal result
    agent = make_agent()
    for i in range(limit):
        retry = TurnRetryState()
        verdict = refuse(agent, retry)
        check(f"refusal {i + 1}: loop re-issues the call", verdict.action == "break" and verdict.result is None, verdict.action)
        check(f"refusal {i + 1}: restart armed", retry.restart_with_rebuilt_messages is True)
        check(f"refusal {i + 1}: session not persisted as a failed turn", not agent._persist_session.called)
    retry = TurnRetryState()
    verdict = refuse(agent, retry)
    check("refusal after the retries ends the turn", verdict.action == "return", verdict.action)
    result = verdict.result or {}
    check("terminal result is content_policy_blocked", result.get("failure_reason") == "content_policy_blocked", str(result.get("failure_reason")))
    check("terminal result names the repeated retries", f"after {limit} re-issued calls" in str(result.get("error")), str(result.get("error")))
    check("terminal restart not armed", retry.restart_with_rebuilt_messages is False)
    check("terminal result persists the session once", agent._persist_session.call_count == 1)

    # ---- a new turn starts from zero
    retry = TurnRetryState()
    verdict = refuse(agent, retry, turn_id="turn-2")
    check("new turn gets its own retries", verdict.action == "break" and retry.restart_with_rebuilt_messages is True, verdict.action)

    # ---- fallback configured: retries first, then the fallback
    agent = make_agent(fallback=True)
    for _ in range(limit):
        refuse(agent, TurnRetryState())
    check("fallback is not tried before the retries are spent", agent._try_activate_fallback.call_count == 0)
    retry = TurnRetryState()
    verdict = refuse(agent, retry)
    check("fallback is tried once the retries are spent", agent._try_activate_fallback.call_count == 1)
    check("fallback activation restarts the loop", verdict.action == "break" and retry.restart_with_rebuilt_messages is True, verdict.action)

    if FAILS:
        print(f"{len(FAILS)} check(s) failed: {', '.join(FAILS)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
