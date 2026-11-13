#!/usr/bin/env python3
"""Behaviour regression for 36-content-filter-retry.patch.

An HTTP-200 reply with ``finish_reason == "content_filter"`` must not end the turn at once: the same
model call is re-issued, at most twice in a row (a model call that was not refused restarts the count) and
at most eight times per turn (the restart flag is armed and the loop is told to "break" into the
rebuilt-message restart); only a refusal that outlasts these limits ends the turn with the typed
``content_policy_blocked`` result. A new turn starts the counts from zero. The fallback chain is
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

    def refuse(agent, retry, turn_id="turn-1", call=1):
        return tt.handle_content_policy_refusal(
            agent, object(), retry, thinking_spinner=None, messages=[], api_messages=[], api_kwargs={},
            active_system_prompt="sys", conversation_history=[], api_call_count=call,
            effective_task_id="task", turn_id=turn_id, api_request_id=f"{turn_id}:api:{call}",
            api_start_time=0.0, retry_count=0, max_retries=3,
        )

    def reissued(verdict, retry):
        return verdict.action == "break" and verdict.result is None and retry.restart_with_rebuilt_messages is True

    limit = tt._CONTENT_FILTER_RETRIES
    ceiling = tt._CONTENT_FILTER_RETRIES_PER_TURN
    check("consecutive limit is 2", limit == 2, str(limit))
    check("per-turn ceiling is 8", ceiling == 8, str(ceiling))

    # ---- three refusals of the same call in a row end the turn with the typed result
    agent = make_agent()
    for i in range(limit):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=1)
        check(f"same call, refusal {i + 1}: re-issued", reissued(verdict, retry), verdict.action)
        check(f"same call, refusal {i + 1}: session not persisted", not agent._persist_session.called)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("third refusal in a row ends the turn", verdict.action == "return", verdict.action)
    result = verdict.result or {}
    check("terminal result is content_policy_blocked", result.get("failure_reason") == "content_policy_blocked", str(result.get("failure_reason")))
    check("error says it repeated in a row", f"repeated {limit} times in a row" in str(result.get("error")), str(result.get("error")))
    check("terminal restart not armed", retry.restart_with_rebuilt_messages is False)
    check("terminal result persists the session once", agent._persist_session.call_count == 1)

    # ---- block, success, block, block, success: the turn goes on (a success changes the call number)
    agent = make_agent()
    ok = True
    for call in (1, 2, 2, 3):  # refused call 1, answered; refused call 2 twice, answered; refused call 3
        retry = TurnRetryState()
        ok = ok and reissued(refuse(agent, retry, call=call), retry)
    check("block, success, block, block, success, block never ends the turn", ok)
    check("streak restarted after a success", agent._content_filter_retries["streak"] == 1, str(agent._content_filter_retries))

    # ---- per-turn ceiling: eight re-issues across many calls, the ninth refusal ends the turn
    agent = make_agent()
    for n in range(1, ceiling + 1):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=n)  # every call refused once, then answered
        check(f"ceiling: re-issue {n} of {ceiling}", reissued(verdict, retry), verdict.action)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=ceiling + 1)
    check("ninth re-issue in the turn ends it", verdict.action == "return", verdict.action)
    check("error names the per-turn ceiling", "ceiling of 8 per run" in str((verdict.result or {}).get("error")), str((verdict.result or {}).get("error")))

    # ---- a new turn starts from zero
    retry = TurnRetryState()
    verdict = refuse(agent, retry, turn_id="turn-2", call=1)
    check("new turn gets its own retries", reissued(verdict, retry), verdict.action)

    # ---- fallback configured: retries first, then the fallback
    agent = make_agent(fallback=True)
    for _ in range(limit):
        refuse(agent, TurnRetryState(), call=1)
    check("fallback is not tried before the retries are spent", agent._try_activate_fallback.call_count == 0)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("fallback is tried once the retries are spent", agent._try_activate_fallback.call_count == 1)
    check("fallback activation restarts the loop", reissued(verdict, retry), verdict.action)

    if FAILS:
        print(f"{len(FAILS)} check(s) failed: {', '.join(FAILS)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
