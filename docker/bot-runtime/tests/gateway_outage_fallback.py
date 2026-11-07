#!/usr/bin/env python3
"""Behaviour regression for 29-gateway-outage-keeps-primary.patch.

A lost connection to the model gateway must keep the run on the primary model (retry with a growing
pause for up to the outage budget) instead of switching to a fallback that then stays active; a model or
provider error (429, quota, "model not found", "no healthy deployments") still switches to the fallback
at once; a run that is on a fallback goes back to the primary every N model calls.

The classification and the retry loop run through the real ``handle_api_error`` of a real ``AIAgent``;
only the sleep, the clock and the fallback activation are replaced.

Usage: gateway_outage_fallback.py [hermes-src-dir]   (exit 1 if any check fails; every check is run)
"""

import inspect
import os
import sys
import tempfile
import time
from pathlib import Path
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
    os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="gateway-outage-test-"))
    os.environ.pop("HERMES_GATEWAY_OUTAGE_BUDGET_S", None)
    os.environ.pop("HERMES_FALLBACK_PROBE_EVERY", None)

    import httpx
    import openai

    from agent.error_classifier import classify_api_error
    import agent.turn_api_error as turn_api_error
    from agent.turn_retry_state import TurnRetryState
    from run_agent import AIAgent

    try:
        import agent.gateway_outage as outage
    except ImportError:
        outage = None

    # ---------------------------------------------------------------- errors as the OpenAI SDK raises them
    request = httpx.Request("POST", "http://172.22.0.1:4000/v1/chat/completions")

    def status_error(cls, status, body, text=None):
        response = httpx.Response(status, request=request, text=text if text is not None else str(body))
        return cls(str(body), response=response, body=body)

    def timeout_error(cause):
        err = openai.APITimeoutError(request=request)
        err.__cause__ = cause
        return err

    def litellm_body(message):
        return {"error": {"message": message, "type": None, "param": None, "code": "503"}}

    gateway_down = {
        "APIConnectionError": lambda: openai.APIConnectionError(request=request),
        "connect timeout (APITimeoutError caused by ConnectTimeout)": lambda: timeout_error(httpx.ConnectTimeout("timed out")),
        "httpx.ConnectError": lambda: httpx.ConnectError("[Errno 111] Connection refused"),
        "ConnectionRefusedError": lambda: ConnectionRefusedError(111, "Connection refused"),
        "502 Bad Gateway page": lambda: status_error(
            openai.InternalServerError, 502, "<html><body><h1>502 Bad Gateway</h1></body></html>"),
        "503 Service Unavailable, empty body": lambda: status_error(
            openai.InternalServerError, 503, "Service Unavailable"),
        "504 Gateway Time-out page": lambda: status_error(
            openai.InternalServerError, 504, "<html><h1>504 Gateway Time-out</h1></html>"),
    }
    model_side = {
        "429 rate limit": lambda: status_error(
            openai.RateLimitError, 429, {"error": {"message": "litellm.RateLimitError: Rate limit exceeded", "code": "429"}}),
        "429 quota": lambda: status_error(
            openai.RateLimitError, 429,
            {"error": {"message": "You exceeded your current quota, please check your plan", "code": "insufficient_quota"}}),
        "404 model not found": lambda: status_error(
            openai.NotFoundError, 404, {"error": {"message": "The model `gpt-6-sol` does not exist or you do not have access to it.", "code": "model_not_found"}}),
        "503 no healthy deployments": lambda: status_error(
            openai.InternalServerError, 503,
            litellm_body("litellm.ServiceUnavailableError: No healthy deployments available for this model")),
        "503 provider overloaded": lambda: status_error(
            openai.InternalServerError, 503,
            litellm_body("litellm.ServiceUnavailableError: AnthropicException - Overloaded")),
        "500 litellm internal error": lambda: status_error(
            openai.InternalServerError, 500, litellm_body("litellm.InternalServerError: OpenAIException - boom")),
        "read timeout of a slow model": lambda: timeout_error(httpx.ReadTimeout("read timed out")),
        "401 auth": lambda: status_error(openai.AuthenticationError, 401, {"error": {"message": "invalid api key"}}),
    }

    # ---------------------------------------------------------------- 1. classification
    for name, make in gateway_down.items():
        err = make()
        classified = classify_api_error(err, provider="custom", model="m", base_url="http://172.22.0.1:4000/v1")
        verdict = outage is not None and outage.is_gateway_outage(err, classified)
        check(f"classified as gateway outage: {name}", verdict, f"reason={classified.reason.value}")
    for name, make in model_side.items():
        err = make()
        classified = classify_api_error(err, provider="custom", model="m", base_url="http://172.22.0.1:4000/v1")
        verdict = outage is not None and not outage.is_gateway_outage(err, classified)
        check(f"classified as model/provider error: {name}", verdict, f"reason={classified.reason.value}")

    # ---------------------------------------------------------------- 2. the retry loop of a real agent
    class Clock:
        t = 1000.0

    clock = Clock()
    waits = []

    def fake_sleep(_agent, wait, _retry, **_kw):
        waits.append(wait)
        clock.t += wait
        return None

    turn_api_error.interruptible_backoff_sleep = fake_sleep
    if outage is not None:
        outage._now = lambda: clock.t

    def make_agent(chain=True):
        agent = AIAgent(model="custom/primary", base_url="http://172.22.0.1:4000/v1", api_key="dummy", quiet_mode=True)
        agent.provider = "custom"
        agent._fallback_chain = (
            [{"provider": "custom", "model": "fallback-model", "base_url": "http://172.22.0.1:4000/v1"}] if chain else []
        )
        agent._fallback_index = 0
        agent._try_activate_fallback = MagicMock(return_value=True)
        return agent

    def drive(agent, make_error, *, until=None, limit=60, budget_env=None):
        """Feed the same kind of error to ``handle_api_error`` the way the retry loop does.
        Stops when the verdict leaves the retry loop, or when the (fake) clock reaches ``until``
        seconds - the moment the gateway is back."""
        if budget_env is None:
            os.environ.pop("HERMES_GATEWAY_OUTAGE_BUDGET_S", None)
        else:
            os.environ["HERMES_GATEWAY_OUTAGE_BUDGET_S"] = budget_env
        waits.clear()
        clock.t = 1000.0
        retry = TurnRetryState()
        retry_count, max_retries = 0, agent._api_max_retries
        actions = []
        first_max_retries = None
        for _ in range(limit):
            if until is not None and clock.t - 1000.0 >= until:
                actions.append("recovered")
                break
            verdict = turn_api_error.handle_api_error(
                agent, api_error=make_error(), _retry=retry, thinking_spinner=None,
                messages=[{"role": "user", "content": "hi"}],
                api_messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}],
                api_kwargs={}, system_message=None, active_system_prompt="s", conversation_history=[],
                approx_tokens=10, retry_count=retry_count, max_retries=max_retries, compression_attempts=0,
                max_compression_attempts=3, api_call_count=1, api_request_id="r1", api_start_time=time.time(),
                effective_task_id="t", turn_id="turn",
            )
            retry_count, max_retries = verdict.retry_count, verdict.max_retries
            if first_max_retries is None:
                first_max_retries = max_retries
            actions.append(verdict.action)
            if verdict.action not in ("continue", "fallthrough"):
                break
        return actions, first_max_retries

    # 2a. the incident: the gateway restarts for ~75 s - the run stays on the primary
    agent = make_agent()
    actions, _ = drive(agent, gateway_down["APIConnectionError"], until=75)
    check("gateway restart of 75 s: no fallback was activated", agent._try_activate_fallback.call_count == 0,
          f"fallback calls={agent._try_activate_fallback.call_count}, actions={actions}")
    check("gateway restart of 75 s: the primary was retried more than the default 3 times", len(actions) > 4,
          f"actions={actions}")
    check("gateway restart of 75 s: the pauses grow", len(waits) >= 3 and waits[2] > waits[0], f"waits={waits}")

    # 2b. every kind of "gateway not answering" is held
    for name, make in gateway_down.items():
        agent = make_agent()
        actions, _ = drive(agent, make, until=100)
        check(f"held for 100 s without a fallback: {name}", agent._try_activate_fallback.call_count == 0,
              f"fallback calls={agent._try_activate_fallback.call_count}, actions={actions}")

    # 2c. a gateway that stays down: the fallback comes after the budget (about 3 minutes), not before
    agent = make_agent()
    actions, _ = drive(agent, gateway_down["APIConnectionError"])
    spent = clock.t - 1000.0
    check("gateway that stays down: the fallback is activated in the end",
          agent._try_activate_fallback.call_count == 1 and actions[-1] == "break", f"actions={actions}")
    check("gateway that stays down: the fallback came after the 180 s budget, not before",
          170.0 <= spent <= 200.0, f"spent={spent:.1f}s")
    check("gateway that stays down: the total pause stays inside the budget", sum(waits) <= 180.5,
          f"sum={sum(waits):.1f}s")

    # 2d. errors of a model or a provider switch at once or after the usual two retries, as before
    for name in ("429 rate limit", "429 quota", "404 model not found"):
        agent = make_agent()
        actions, _ = drive(agent, model_side[name])
        check(f"model/provider error goes to the fallback at once: {name}",
              agent._try_activate_fallback.call_count == 1 and actions == ["break"], f"actions={actions}")
    for name in ("503 no healthy deployments", "503 provider overloaded", "read timeout of a slow model"):
        agent = make_agent()
        actions, _ = drive(agent, model_side[name])
        check(f"model/provider error is not held for the outage budget: {name}",
              agent._try_activate_fallback.call_count == 1 and (clock.t - 1000.0) < 30.0,
              f"actions={actions}, spent={clock.t - 1000.0:.1f}s")

    # 2e. nothing to hold back: no fallback configured, or the budget switched off
    agent = make_agent(chain=False)
    actions, first_max = drive(agent, gateway_down["APIConnectionError"], limit=1)
    check("no fallback configured: the retry budget is left alone", first_max == 3, f"max_retries={first_max}")
    agent = make_agent()
    actions, _ = drive(agent, gateway_down["APIConnectionError"], budget_env="0")
    check("HERMES_GATEWAY_OUTAGE_BUDGET_S=0 gives the upstream behaviour back (fallback after 2 failures)",
          agent._try_activate_fallback.call_count == 1 and len(actions) <= 3 and (clock.t - 1000.0) < 30.0,
          f"actions={actions}, spent={clock.t - 1000.0:.1f}s")

    # ---------------------------------------------------------------- 3. coming back to the primary
    def probe_agent(restored=True, activated=True):
        agent = MagicMock()
        agent._fallback_activated = activated
        agent._fallback_calls_since_switch = 0
        agent._restore_primary_runtime = MagicMock(return_value=restored)
        return agent

    def probe_calls(agent, n):
        from agent.gateway_outage import probe_primary_runtime
        return [probe_primary_runtime(agent) for _ in range(n)]

    if outage is None:
        for name in ("probe: every 10th call on a fallback tries the primary",
                     "probe: nothing on the primary", "probe: HERMES_FALLBACK_PROBE_EVERY=0 never probes",
                     "probe: a gated restore is retried after the next 10 calls",
                     "probe: a real agent is back on its primary model"):
            check(name, False, "agent.gateway_outage does not exist")
    else:
        agent = probe_agent()
        results = probe_calls(agent, 25)
        check("probe: every 10th call on a fallback tries the primary",
              [i + 1 for i, r in enumerate(results) if r] == [10, 20]
              and agent._restore_primary_runtime.call_count == 2, f"results={results}")
        agent = probe_agent(activated=False)
        probe_calls(agent, 30)
        check("probe: nothing on the primary", agent._restore_primary_runtime.call_count == 0)
        os.environ["HERMES_FALLBACK_PROBE_EVERY"] = "0"
        agent = probe_agent()
        probe_calls(agent, 30)
        os.environ.pop("HERMES_FALLBACK_PROBE_EVERY", None)
        check("probe: HERMES_FALLBACK_PROBE_EVERY=0 never probes", agent._restore_primary_runtime.call_count == 0)
        agent = probe_agent(restored=False)
        results = probe_calls(agent, 25)
        check("probe: a gated restore is retried after the next 10 calls",
              not any(results) and agent._restore_primary_runtime.call_count == 2, f"calls={agent._restore_primary_runtime.call_count}")

        # the real restore on a real agent that was moved to a fallback
        real = make_agent()
        real._fallback_activated = True
        real.model = "fallback-model"
        results = probe_calls(real, 10)
        check("probe: a real agent is back on its primary model",
              results[-1] is True and real.model == "custom/primary" and real._fallback_activated is False,
              f"model={real.model}, activated={real._fallback_activated}")

    # the hook is wired into the turn loop, right after the iteration starts
    import agent.conversation_loop as conversation_loop

    source = inspect.getsource(conversation_loop)
    begin = source.find("_run_phase(begin_iteration, agent, s)")
    hook = source.find("probe_primary_runtime(agent)")
    prepare = source.find("_run_phase(prepare_iteration, agent, s)")
    check("probe is called by the turn loop between begin_iteration and prepare_iteration",
          0 < begin < hook < prepare, f"begin={begin} hook={hook} prepare={prepare}")

    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
