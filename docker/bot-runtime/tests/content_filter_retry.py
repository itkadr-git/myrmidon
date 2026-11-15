#!/usr/bin/env python3
"""Behaviour regression for 36-content-filter-retry.patch.

An HTTP-200 reply with ``finish_reason == "content_filter"`` is re-issued only where it used to end the
turn at once: an agent with a fallback left still goes to the fallback exactly as before (no re-issue);
an agent without one (or with all of them used) re-issues the same model call, at most twice per call
(the restart flag is armed and the loop is told to "break" into the rebuilt-message restart without
consuming the turn's restart_count), and the refusal after that ends the turn with the typed
``content_policy_blocked`` result. The re-issues leave room in the turn's restart limit for the
configured fallbacks. A new call or turn starts the count from zero.

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

    def make_agent(chain: int = 0, available: int = 0):
        """``chain`` fallbacks configured, ``available`` of them still unused."""
        agent = MagicMock()
        agent.log_prefix = ""
        agent.model = "test-model"
        agent.provider = "custom"
        agent.thinking_callback = None
        agent._fallback_chain = [object()] * chain
        agent._avail = available
        agent._has_pending_fallback.side_effect = lambda: agent._avail > 0

        def activate():
            if agent._avail > 0:
                agent._avail -= 1
                return True
            return False

        agent._try_activate_fallback.side_effect = activate
        agent._content_filter_retries = None
        return agent

    def refuse(agent, retry, turn_id="turn-1", call=1, max_retries=3):
        return tt.handle_content_policy_refusal(
            agent, object(), retry, thinking_spinner=None, messages=[], api_messages=[], api_kwargs={},
            active_system_prompt="sys", conversation_history=[], api_call_count=call,
            effective_task_id="task", turn_id=turn_id, api_request_id=f"{turn_id}:api:{call}",
            api_start_time=0.0, retry_count=0, max_retries=max_retries,
        )

    def restarted(verdict, retry):
        return verdict.action == "break" and verdict.result is None and retry.restart_with_rebuilt_messages is True

    def counter(agent):
        state = agent._content_filter_retries
        return state["used"] if isinstance(state, dict) else 0

    limit = tt._CONTENT_FILTER_RETRIES
    check("per-call limit is 2", limit == 2, str(limit))

    from agent.turn_iteration_prep import apply_retry_restarts

    def prep(agent, retry, restart_count=0, call=1, max_retries=3):
        return apply_retry_restarts(
            agent, _retry=retry, response=None, interrupted=False, messages=[],
            conversation_history=[], user_message=None, api_kwargs={}, current_turn_user_idx=0,
            final_response=None, retry_count=0, max_retries=max_retries, api_call_count=call,
            restart_count=restart_count, length_continue_retries=0,
            _preflight_compression_blocked=True, _turn_exit_reason="",
        )

    # ---- agent WITHOUT a fallback: two re-issues per call, third refusal on same call ends it
    agent = make_agent()
    for i in (1, 2):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=1)
        check(f"no fallback, call 1 refusal {i}: re-issued", restarted(verdict, retry), verdict.action)
        check(f"no fallback, call 1 refusal {i}: session not persisted", not agent._persist_session.called)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("third refusal on same call ends it", verdict.action == "return", verdict.action)
    result = verdict.result or {}
    check("terminal result is content_policy_blocked", result.get("failure_reason") == "content_policy_blocked", str(result.get("failure_reason")))
    check("terminal result is failed", result.get("failed") is True and result.get("completed") is False)
    check("error says it repeated after 2 re-issued calls", "repeated after 2 re-issued calls" in str(result.get("error")), str(result.get("error")))
    check("terminal restart not armed", retry.restart_with_rebuilt_messages is False)
    check("terminal result persists the session once", agent._persist_session.call_count == 1)

    # ---- three content-filter refusals across different calls of one turn (empty fallback chain)
    agent = make_agent(chain=0, available=0)
    restart_count = 0
    all_reissued = True
    for call in (1, 2, 3):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=call, turn_id="turn-cf-calls")
        if not restarted(verdict, retry):
            all_reissued = False
            break
        pv = prep(agent, retry, restart_count=restart_count, call=call, max_retries=3)
        if pv.action != "continue":
            all_reissued = False
            break
        restart_count = pv.restart_count

    check("three filter refusals across different calls: each call re-issued", all_reissued)
    check("three filter refusals across different calls: turn not ended by restart_count", restart_count == 0 and all_reissued, f"restart_count={restart_count}")

    # ---- agent WITH two fallbacks configured: behavior as before (reserves first, no re-issues after)
    agent = make_agent(chain=2, available=2)
    restart_count = 0
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("fallback left: the fallback is activated", agent._try_activate_fallback.call_count == 1)
    check("fallback left: the loop restarts on it", restarted(verdict, retry), verdict.action)
    check("fallback left: no re-issue is counted", counter(agent) == 0, str(agent._content_filter_retries))
    pv = prep(agent, retry, restart_count=restart_count, call=1)
    restart_count = pv.restart_count
    check("fallback restart consumes restart_count", restart_count == 1, f"restart_count={restart_count}")

    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("second fallback left: used too, still no re-issue", restarted(verdict, retry) and counter(agent) == 0)
    pv = prep(agent, retry, restart_count=restart_count, call=1)
    restart_count = pv.restart_count
    check("second fallback restart consumes restart_count", restart_count == 2, f"restart_count={restart_count}")

    # ---- two fallbacks configured and both used: re-issue does not depend on _fallback_chain (2 re-issues per call)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("two fallbacks used: call 1 gets re-issue 1", restarted(verdict, retry) and counter(agent) == 1, verdict.action)
    pv = prep(agent, retry, restart_count=restart_count, call=1)
    check("two fallbacks used: filter re-issue does not consume restart_count", pv.restart_count == restart_count, f"restart_count={pv.restart_count}")

    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("two fallbacks used: call 1 gets re-issue 2", restarted(verdict, retry) and counter(agent) == 2, verdict.action)

    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=1)
    check("two fallbacks used: third refusal on call 1 ends it", verdict.action == "return", verdict.action)
    check("two fallbacks used: typed failed result", (verdict.result or {}).get("failed") is True and (verdict.result or {}).get("failure_reason") == "content_policy_blocked")
    check("two fallbacks used: error carries re-issue note", "repeated after 2 re-issued calls" in str((verdict.result or {}).get("error")))

    # ---- counter is per call: two refusals on call 1 (both re-issued), call 2 gets 2 re-issues again
    agent = make_agent()
    for i in (1, 2):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=1)
        check(f"call 1 refusal {i}: re-issued", restarted(verdict, retry))
        check(f"call 1 counter is {i}", counter(agent) == i)
    for i in (1, 2):
        retry = TurnRetryState()
        verdict = refuse(agent, retry, call=2)
        check(f"call 2 refusal {i}: re-issued", restarted(verdict, retry))
        check(f"call 2 counter is {i}", counter(agent) == i)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, call=2)
    check("third refusal on call 2 ends it", verdict.action == "return", verdict.action)

    # ---- a new turn starts from zero
    agent = make_agent()
    refuse(agent, TurnRetryState(), turn_id="turn-1", call=1)
    refuse(agent, TurnRetryState(), turn_id="turn-1", call=1)
    retry = TurnRetryState()
    verdict = refuse(agent, retry, turn_id="turn-2", call=1)
    check("new turn gets its own re-issues", restarted(verdict, retry) and counter(agent) == 1, verdict.action)

    if FAILS:
        print(f"{len(FAILS)} check(s) failed: {', '.join(FAILS)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
