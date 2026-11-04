#!/usr/bin/env python3
"""Behaviour regression for 24-max-tokens-recovery.patch (OPE-10837/OPE-10858).

Verifies that:
1. Custom OpenAI-compatible provider forwards configured max_tokens from config.yaml.
2. length_continue_retries is reset to 0 after a successful tool round.
3. Truncation retry increases max_tokens (ephemeral max output tokens) instead of
   capping at 32 768 or base limit, supporting models with persistent thinking.

    python3 tests/max_tokens_recovery.py [hermes-checkout-dir]
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "run_agent.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


def main():
    hermes = _hermes_dir(sys.argv)
    if str(hermes) != "/opt/hermes-src":
        sys.meta_path = [h for h in sys.meta_path if "editable" not in str(type(h)).lower() and "finder" not in str(type(h)).lower()]
    if str(hermes) not in sys.path:
        sys.path.insert(0, str(hermes))

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print(f"FAIL: {name}")
        else:
            print(f"OK: {name}")

    # 1. Config max_tokens propagation and custom provider kwargs
    from agent.agent_init import _apply_agent_section
    from agent.transports.chat_completions import ChatCompletionsTransport
    from providers import get_provider_profile

    agent = SimpleNamespace(
        max_tokens=None,
        run_budget_seconds=None,
        dangerously_skip_permissions=False,
        budget_warning_ratio=0.8,
        _tool_use_enforcement="auto",
        _execution_guidance="auto",
        _empty_guard_enabled=True,
        _empty_guard_cost_threshold_usd=0.25,
        _intent_ack_continuation="auto",
        log_prefix="",
        quiet_mode=True,
        _max_tokens_param=lambda val: {"max_tokens": val},
    )

    cfg = {"model": {"default": "custom/test-model", "max_tokens": 32000}}
    _apply_agent_section(agent, cfg)
    check("agent.max_tokens read from model.max_tokens in config", agent.max_tokens == 32000)

    transport = ChatCompletionsTransport()
    profile = get_provider_profile("custom")
    api_kwargs = transport.build_kwargs(
        "custom/test-model",
        [{"role": "user", "content": "hi"}],
        None,
        provider_profile=profile,
        max_tokens=agent.max_tokens,
        max_tokens_param_fn=agent._max_tokens_param,
    )
    check("custom provider api_kwargs sends configured max_tokens", api_kwargs.get("max_tokens") == 32000)

    # Test fallback to model.max_output_tokens in config
    agent2 = SimpleNamespace(
        max_tokens=None,
        run_budget_seconds=None,
        dangerously_skip_permissions=False,
        budget_warning_ratio=0.8,
        _tool_use_enforcement="auto",
        _execution_guidance="auto",
        _empty_guard_enabled=True,
        _empty_guard_cost_threshold_usd=0.25,
        _intent_ack_continuation="auto",
    )
    _apply_agent_section(agent2, {"model": {"max_output_tokens": 16000}})
    check("agent.max_tokens read from model.max_output_tokens fallback", agent2.max_tokens == 16000)

    # 2. Reset length_continue_retries after successful tool step
    from run_agent import AIAgent
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

    # 3. Truncation retry increases max_tokens
    from agent.turn_iteration_prep import apply_retry_restarts
    from agent.turn_retry_state import TurnRetryState

    prep_agent = SimpleNamespace(
        max_tokens=32000,
        _ephemeral_max_output_tokens=None,
        _requested_output_cap_from_api_kwargs=lambda kwargs: kwargs.get("max_tokens"),
    )
    retry_state = TurnRetryState(restart_with_length_continuation=True)

    # Retry 1: should increase beyond 32000 base
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
    check("truncation retry boosts max_tokens (retry 1: 32000 -> 64000)", prep_agent._ephemeral_max_output_tokens == 64000)

    # Retry 2: should boost further
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
    check("truncation retry boosts max_tokens (retry 2: 32000 -> 128000)", prep_agent._ephemeral_max_output_tokens == 128000)

    if failures:
        sys.exit(f"{len(failures)} checks failed: {failures}")
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
