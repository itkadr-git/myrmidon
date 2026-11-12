#!/usr/bin/env python3
"""Behaviour regression for 32-compaction-summary-9-sections.patch and 27-compaction-keep-prefix.patch
(patch 26 dropped at v0.23.1: upstream carries the summary-size cap itself, in agent/context_economy.py,
but deliberately sends no max_tokens wire cap on the summary call).

A compaction already breaks the provider's prompt cache, so everything that makes it small and keeps
the part in front of the messages unchanged is free:

* the summarizer's token target is held to context_economy.compaction_summary_max_chars (default 8000)
  characters (capped_summary_tokens, upstream since v0.23.1), the size instruction names the character
  cap, and the text that comes back is held to the cap at a line end;
* a summary that stopped on the output limit (finish_reason=length) is kept - cut at a line end and
  marked - instead of failing the compression (compaction_accept_truncated=0 gives the failure back);
* the mechanical sections appended to the summary are bounded (anchor index, verbatim user messages) and
  board wake packages are not quoted into them;
* the system prompt and the tool schemas are not rebuilt at the compaction (compaction_keep_prefix, the
  27 patch, in agent/conversation_compression.py), so what the provider cached in front of the messages
  is still the prefix after it.

    python3 tests/compaction_summary_cap.py [hermes-checkout-dir]
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


def _clean_env():
    for name in list(os.environ):
        if name.startswith("HERMES_CONTEXT_ECONOMY_") or name == "HERMES_KEEP_STALE_WAKES":
            os.environ.pop(name, None)


def wake_text(n, body_chars=50_000):
    payload_json = json.dumps({
        "reason": "issue_commented",
        "issue": {"id": f"id-{n}", "identifier": f"OPE-{100 + n}", "title": f"Task number {n}"},
    })
    return "\n".join([
        "You are eng-2, an AI agent employee in a Myrmidon-managed company.", "",
        "Myrmidon runtime identity:", "- Agent ID: a-1", "- Company ID: c-1", f"- Run ID: run-{n}", "",
        "Execution contract:", "- Take concrete action in this run when the task is actionable.", "",
        "## Myrmidon Wake Payload", "", "## Current request and continuation context", "w" * body_chars, "",
        "Structured wake payload JSON:", "```json", payload_json, "```",
    ])


def main(argv):
    hermes_dir = _hermes_dir(argv)
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="compaction-cap-")
    _clean_env()
    sys.path.insert(0, str(hermes_dir))
    import agent.context_compressor as cc
    import agent.context_economy as ce
    import agent.conversation_compression as conv

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    cap_env = "HERMES_CONTEXT_ECONOMY_COMPACTION_SUMMARY_MAX_CHARS"

    # ---- the summarizer's token target ---------------------------------------------------------
    big_turns = [{"role": "user", "content": "x" * 400_000}]
    budget_self = SimpleNamespace(max_summary_tokens=10_000)
    check("budget: capped to the character cap (8000 chars = 2000 tokens)",
          cc.ContextCompressor._compute_summary_budget(budget_self, big_turns) == 2000)
    os.environ[cap_env] = "20000"
    check("budget: follows a configured cap", cc.ContextCompressor._compute_summary_budget(budget_self, big_turns) == 5000)
    os.environ[cap_env] = "0"
    check("budget: cap 0 gives the upstream budget back", cc.ContextCompressor._compute_summary_budget(budget_self, big_turns) == 10_000)
    os.environ.pop(cap_env)

    # ---- the prompt -----------------------------------------------------------------------------
    sections = cc.ContextCompressor._summary_template_sections(cc._SECTION_INSTRUCTIONS[True], 2000, "")
    check("prompt: the size target carries the character-cap instruction",
          "Target ~2000 tokens." in sections and ce.summary_cap_instruction() in sections)
    fake = SimpleNamespace(
        _previous_summary=None, tail_mode="lean",
        _summary_template_sections=cc.ContextCompressor._summary_template_sections,
        _bound_summary_input=cc.ContextCompressor._bound_summary_input,
    )
    prompt = cc.ContextCompressor._build_summary_prompt(fake, "TURNS", 2000, None, "", True)
    check("prompt: the cap instruction is in the assembled prompt", ce.summary_cap_instruction() in prompt)
    os.environ[cap_env] = "0"
    sections_off = cc.ContextCompressor._summary_template_sections(cc._SECTION_INSTRUCTIONS[True], 2000, "")
    check("prompt: cap 0 drops the cap instruction", ce.summary_cap_instruction() == ""
          and "Target ~2000 tokens." in sections_off)
    os.environ.pop(cap_env)

    # ---- the summarizer call --------------------------------------------------------------------
    body = "## Goal\n" + "".join(f"- item {i}: something that happened\n" for i in range(2000))  # ~60,000 chars
    captured = {}
    state = {"finish": "stop", "text": body}

    def fake_call_llm(**kwargs):
        captured.clear()
        captured.update(kwargs)
        return {"choices": [{"message": {"content": state["text"]}, "finish_reason": state["finish"]}]}

    real_call_llm = cc.call_llm
    cc.call_llm = fake_call_llm
    summarizer = SimpleNamespace(
        model="m", provider="p", base_url="http://llm.test/v1", api_key="k", api_mode="chat_completions",
        summary_model="", context_length=100_000,
        _record_aux_compression_call=lambda **kwargs: None, _compression_cancelled=lambda: False,
    )

    def call(prompt_text="prompt"):
        return cc.ContextCompressor._call_summary_llm(summarizer, prompt_text, time.monotonic())

    try:
        out = call()
        check("call: no max_tokens wire cap is sent (upstream v0.23.1 policy)", "max_tokens" not in captured)
        check("call: a long summary is held to the cap at a line end",
              len(out) <= 8000 and out.endswith("recover details with session_search]") and out.startswith("## Goal\n- item 0:")
              and "\n- item" in out[-200:])
        state["text"] = "## Goal\nshort and complete\n"
        check("call: a summary within the cap passes unchanged", call() == state["text"].strip())

        state.update(finish="length", text=body[:5000])
        out = call()
        check("truncated: a summary that stopped on the output limit is kept, not failed",
              out.startswith("## Goal\n- item 0:") and out.endswith("recover details with session_search]")
              and "output limit" in out and len(out) <= 8000)
        check("truncated: the unfinished last line is dropped",
              out.split("\n[summary cut")[0].endswith("something that happened"))
        state.update(finish="length", text=body)
        out = call()
        check("truncated: a long truncated summary is also held to the cap", len(out) <= 8000)

        os.environ["HERMES_CONTEXT_ECONOMY_COMPACTION_ACCEPT_TRUNCATED"] = "0"
        state.update(finish="length", text=body[:5000])
        try:
            call()
            raised = None
        except RuntimeError as exc:
            raised = str(exc)
        check("truncated: compaction_accept_truncated=0 gives the failure back (and its marker)",
              raised is not None and "finish_reason=length" in raised)
        os.environ.pop("HERMES_CONTEXT_ECONOMY_COMPACTION_ACCEPT_TRUNCATED")

        os.environ[cap_env] = "0"
        state.update(finish="stop", text=body)
        out = call()
        check("call: cap 0 keeps the whole text", out == body.strip())
        os.environ.pop(cap_env)
    finally:
        cc.call_llm = real_call_llm

    # ---- the mechanical sections ----------------------------------------------------------------
    human = "please fix the build, it fails on CI since yesterday"
    turns = [{"role": "user", "content": wake_text(n)} for n in (1, 2, 3)] + [{"role": "user", "content": human}]
    section = cc._build_verbatim_user_section(turns)
    check("verbatim: the human message is quoted, wake packages are one-line notes", human in section
          and section.count("Board wake message") == 3 and "w" * 100 not in section and len(section) < 3000)
    os.environ["HERMES_CONTEXT_ECONOMY_COMPACTION_STUB_WAKES"] = "0"
    quoted = cc._build_verbatim_user_section(turns)
    check("verbatim: compaction_stub_wakes=0 quotes the wake packages again, within the budget",
          "w" * 100 in quoted and 3000 < len(quoted) <= 6000 + 1500)
    os.environ.pop("HERMES_CONTEXT_ECONOMY_COMPACTION_STUB_WAKES")
    os.environ[cap_env] = "0"
    uncapped = cc._build_verbatim_user_section(
        [{"role": "user", "content": "q" * 9000}, {"role": "user", "content": "r" * 9000}, {"role": "user", "content": "s" * 9000}])
    os.environ.pop(cap_env)
    capped = cc._build_verbatim_user_section(
        [{"role": "user", "content": "q" * 9000}, {"role": "user", "content": "r" * 9000}, {"role": "user", "content": "s" * 9000}])
    check("verbatim: the budgets shrink under the cap", len(uncapped) > 10_000 and len(capped) < 6_500)

    anchors = [{"role": "assistant", "content": " ".join([
        " ".join(f"#{n}" for n in range(1000, 1400)),
        " ".join(f"{n:012x}" for n in range(100, 160)),
        " ".join(f"src/mod{n}/file{n}.py" for n in range(100)),
        " ".join(f"https://example.test/path/number/{n}/resource" for n in range(60)),
    ])}]
    os.environ[cap_env] = "0"
    anchor_off = cc._build_anchor_index(anchors)
    os.environ.pop(cap_env)
    anchor_on = cc._build_anchor_index(anchors)
    check("anchors: the index shrinks under the cap", len(anchor_off) > 3500 and 0 < len(anchor_on) <= 2400)

    # the summarizer input: older wake packages of the region are notes, the newest stays
    region = [{"role": "user", "content": wake_text(n, 5000)} for n in (1, 2, 3)]
    stubbed = ce.stub_superseded_wakes(region)
    check("input: older wake packages are notes, the newest of the region stays in full",
          stubbed[2] == region[2] and stubbed[0]["content"].startswith("[Board wake message")
          and stubbed[1]["content"].startswith("[Board wake message") and region[0]["content"].startswith("You are"))

    # ---- the prefix at a compaction --------------------------------------------------------------
    calls = []

    def make_agent():
        agent = SimpleNamespace(session_id="sess-9", _cached_system_prompt="SYSTEM PROMPT")

        def invalidate():
            calls.append("invalidate")
            agent._cached_system_prompt = None

        def build(message):
            calls.append("build")
            return "REBUILT PROMPT"

        agent._invalidate_system_prompt = invalidate
        agent._build_system_prompt = build
        return agent

    real_refresh = conv._refresh_agent_tool_definitions
    conv._refresh_agent_tool_definitions = lambda agent: calls.append("refresh")
    try:
        agent = make_agent()
        result = conv._rebuild_system_prompt_at_boundary(agent, "system message")
        check("prefix: the cached system prompt is kept and nothing is rebuilt or refreshed",
              result == "SYSTEM PROMPT" and agent._cached_system_prompt == "SYSTEM PROMPT" and calls == [])
        os.environ["HERMES_CONTEXT_ECONOMY_COMPACTION_KEEP_PREFIX"] = "0"
        agent = make_agent()
        result = conv._rebuild_system_prompt_at_boundary(agent, "system message")
        check("prefix: compaction_keep_prefix=0 gives the upstream rebuild back",
              result == "REBUILT PROMPT" and calls == ["invalidate", "refresh", "build"])
        os.environ.pop("HERMES_CONTEXT_ECONOMY_COMPACTION_KEEP_PREFIX")
        calls.clear()
        agent = make_agent()
        agent._cached_system_prompt = None
        result = conv._rebuild_system_prompt_at_boundary(agent, "system message")
        check("prefix: with no cached prompt there is nothing to keep, the prompt is built",
              result == "REBUILT PROMPT" and calls == ["invalidate", "refresh", "build"])
    finally:
        conv._refresh_agent_tool_definitions = real_refresh

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("compaction summary cap and keep-prefix: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
