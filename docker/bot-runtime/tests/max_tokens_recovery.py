#!/usr/bin/env python3
"""Regression test for OPE-10837 / OPE-10858: Hermes custom provider max_tokens,

length_continue_retries reset after tool round, and truncation retry escalation.
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

def check(name: str, condition: bool) -> None:
    if not condition:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"PASS: {name}")

def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/opt/hermes-src")
    sys.path.insert(0, str(target))
    sys.path = [p for p in sys.path if not (target != Path("/opt/hermes-src") and p == "/opt/hermes-src")]
    sys.meta_path = [finder for finder in sys.meta_path if not finder.__class__.__name__.startswith("_Editable")]
    for k in list(sys.modules.keys()):
        if k == 'agent' or k.startswith('agent.') or k == 'run_agent' or k.startswith('providers'):
            del sys.modules[k]

    # 1. Config loading into agent.max_tokens
    from agent.agent_init import _apply_agent_section

    agent_cfg1 = SimpleNamespace(max_tokens=None, run_budget_seconds=None)
    _apply_agent_section(agent_cfg1, {"model": {"max_tokens": 32000}})
    check("agent.max_tokens read from model.max_tokens in config", agent_cfg1.max_tokens == 32000)

    agent_cfg2 = SimpleNamespace(max_tokens=None, run_budget_seconds=None)
    _apply_agent_section(agent_cfg2, {"model": {"max_output_tokens": 16000}})
    check("agent.max_tokens read from model.max_output_tokens fallback", agent_cfg2.max_tokens == 16000)

    agent_cfg3 = SimpleNamespace(max_tokens=None, run_budget_seconds=None)
    _apply_agent_section(agent_cfg3, {"model": {"max_tokens": "64000"}})
    check("agent.max_tokens parsed from string numeric config", agent_cfg3.max_tokens == 64000)

    # 2. Production request construction for custom OpenAI-compatible provider
    from run_agent import AIAgent
    from agent.chat_completion_helpers import build_api_kwargs
    from agent.transports.chat_completions import ChatCompletionsTransport
    from providers import get_provider_profile

    agent_prod = AIAgent(model="custom/test-model", base_url="http://localhost:8000/v1", api_key="dummy")
    agent_prod.provider = "custom"
    _apply_agent_section(agent_prod, {"model": {"max_tokens": 32000}})
    check("agent_prod.max_tokens set to 32000", agent_prod.max_tokens == 32000)

    # 2a. Real production agent method: agent._build_api_kwargs
    kw1 = agent_prod._build_api_kwargs([{"role": "user", "content": "hi"}])
    check("production agent._build_api_kwargs sends max_tokens: 32000", kw1.get("max_tokens") == 32000)

    # 2b. Real production helper: build_api_kwargs(agent, ...)
    kw2 = build_api_kwargs(agent_prod, [{"role": "user", "content": "hi"}])
    check("production build_api_kwargs sends max_tokens: 32000", kw2.get("max_tokens") == 32000)

    # 2c. ChatCompletionsTransport fallback when max_tokens_param_fn is omitted
    transport = ChatCompletionsTransport()
    profile = get_provider_profile("custom")
    kw3 = transport.build_kwargs("custom/test-model", [{"role": "user", "content": "hi"}], None, provider_profile=profile, max_tokens=32000)
    check("ChatCompletionsTransport applies max_tokens without max_tokens_param_fn", kw3.get("max_tokens") == 32000)

    # 3. Reset length_continue_retries after successful tool step
    from agent.turn_tool_round import run_tool_round

    mock_agent = AIAgent(model="custom/test", base_url="http://localhost:8000/v1", api_key="dummy")
    mock_agent._call_tool = MagicMock(return_value=("tool output", None))

    tc = SimpleNamespace(id="call_1", type="function", function=SimpleNamespace(name="read_file", arguments='{"path":"test.txt"}'))
    assistant_msg = SimpleNamespace(tool_calls=[tc], content=None)

    verdict = run_tool_round(
        mock_agent,
        assistant_message=assistant_msg,
        finish_reason="tool_calls",
        messages=[{"role": "user", "content": "read"}],
        conversation_history=[],
        api_call_count=1,
        effective_task_id="task-1",
        user_message={"role": "user", "content": "read"},
        system_message="sys",
        active_system_prompt="sys",
        compression_attempts=0,
        max_compression_attempts=3,
        final_response=None,
        failed=False,
        _turn_exit_reason=None,
        truncated_tool_call_retries=1,
        current_turn_user_idx=0,
        length_continue_retries=2,
    )
    check("ToolRoundVerdict resets length_continue_retries to 0", verdict.length_continue_retries == 0)

    # 4. Truncation retry increases max_tokens in apply_retry_restarts
    from agent.turn_iteration_prep import apply_retry_restarts
    from agent.turn_retry_state import TurnRetryState

    prep_agent = SimpleNamespace(
        max_tokens=32000,
        _ephemeral_max_output_tokens=None,
        _requested_output_cap_from_api_kwargs=lambda kwargs: kwargs.get("max_tokens"),
    )
    retry_state = TurnRetryState(restart_with_length_continuation=True)

    apply_retry_restarts(
        prep_agent,
        _retry=retry_state,
        response=None,
        interrupted=False,
        messages=[],
        conversation_history=[],
        user_message={"role": "user", "content": "hi"},
        api_kwargs={"max_tokens": 32000},
        current_turn_user_idx=0,
        final_response=None,
        retry_count=0,
        max_retries=3,
        api_call_count=1,
        restart_count=0,
        length_continue_retries=1,
        _preflight_compression_blocked=False,
        _turn_exit_reason=None,
    )
    check("apply_retry_restarts boosts max_tokens (retry 1: 32000 -> 64000)", prep_agent._ephemeral_max_output_tokens == 64000)

    apply_retry_restarts(
        prep_agent,
        _retry=retry_state,
        response=None,
        interrupted=False,
        messages=[],
        conversation_history=[],
        user_message={"role": "user", "content": "hi"},
        api_kwargs={"max_tokens": 32000},
        current_turn_user_idx=0,
        final_response=None,
        retry_count=0,
        max_retries=3,
        api_call_count=2,
        restart_count=0,
        length_continue_retries=2,
        _preflight_compression_blocked=False,
        _turn_exit_reason=None,
    )
    check("apply_retry_restarts boosts max_tokens further (retry 2: 64000 -> 128000)", prep_agent._ephemeral_max_output_tokens == 128000)

    # 5. Behavior coverage for truncation paths in turn_truncation.py
    from agent.turn_truncation import _Trunc, _continue_text, _retry_truncated_tool_call

    agent_trunc = SimpleNamespace(
        max_tokens=32000,
        log_prefix="[test] ",
        _vprint=lambda *a, **k: None,
        _buffer_vprint=lambda *a, **k: None,
        _build_assistant_message=lambda msg, reason: {"role": "assistant", "content": getattr(msg, "content", "")},
        _ephemeral_max_output_tokens=None,
        _ephemeral_reasoning_off=False,
        _session_messages=[],
        _requested_output_cap_from_api_kwargs=lambda kw: kw.get("max_tokens") if kw else None,
    )
    st = _Trunc(
        agent=agent_trunc,
        response=SimpleNamespace(id="resp_1"),
        finish_reason="length",
        conversation_history=None,
        api_call_count=1,
        effective_task_id=None,
        current_turn_user_idx=0,
        messages=[],
        length_continue_retries=0,
        truncated_response_parts=[],
        truncated_tool_call_retries=0,
        retry_count=0,
        compression_attempts=0,
    )
    retry_trunc = TurnRetryState()
    msg = SimpleNamespace(content="partial response")

    # 5a. _continue_text escalates _ephemeral_max_output_tokens
    _continue_text(st, retry_trunc, msg)
    check("turn_truncation._continue_text escalates max_tokens (retry 1: 32000 -> 64000)", agent_trunc._ephemeral_max_output_tokens == 64000)
    _continue_text(st, retry_trunc, msg)
    check("turn_truncation._continue_text escalates max_tokens (retry 2: 64000 -> 128000)", agent_trunc._ephemeral_max_output_tokens == 128000)

    # 5b. _retry_truncated_tool_call escalates _ephemeral_max_output_tokens
    st.truncated_tool_call_retries = 0
    _retry_truncated_tool_call(st, {"max_tokens": 32000})
    check("turn_truncation._retry_truncated_tool_call escalates max_tokens (retry 1: 32000 -> 64000)", agent_trunc._ephemeral_max_output_tokens == 64000)
    _retry_truncated_tool_call(st, {"max_tokens": 32000})
    check("turn_truncation._retry_truncated_tool_call escalates max_tokens (retry 2: 64000 -> 128000)", agent_trunc._ephemeral_max_output_tokens == 128000)

    print("ALL TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    main()
