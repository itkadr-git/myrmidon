#!/usr/bin/env python3
"""Behaviour regression for 32-compaction-summary-9-sections.patch.

Checks that context compaction summary templates (fresh and iterative)
and deterministic fallback summaries contain all 9 standardized sections:
USER_CONTEXT, TASK_TRACKING, COMPLETED, PENDING, CURRENT_STATE,
CODE_STATE, TESTS, CHANGES, VERSION_CONTROL_STATUS;
that TASK_TRACKING requires verbatim task/ticket IDs;
and that legacy task snapshot heading parsers remain backwards-compatible.
"""

import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace


def _hermes_dir(argv):
    if len(argv) > 1 and Path(argv[1]).is_dir():
        return Path(argv[1])
    for cand in ("/opt/hermes-src", "/opt/hermes-agent/src"):
        if Path(cand).is_dir():
            return Path(cand)
    sys.exit("usage: compaction_summary_9_sections.py <path-to-hermes-root>")


def main(argv):
    hdir = _hermes_dir(argv)
    sys.path.insert(0, str(hdir))

    import agent.context_compressor as cc

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)
        else:
            print("ok:", name)

    required_sections = [
        "USER_CONTEXT",
        "TASK_TRACKING",
        "COMPLETED",
        "PENDING",
        "CURRENT_STATE",
        "CODE_STATE",
        "TESTS",
        "CHANGES",
        "VERSION_CONTROL_STATUS",
    ]

    # 1. Fresh template sections
    sections = cc.ContextCompressor._summary_template_sections(cc._SECTION_INSTRUCTIONS[True], 2000, "")
    for sec in required_sections:
        check(f"fresh template contains ## {sec}", f"## {sec}" in sections)

    # 2. TASK_TRACKING verbatim requirements
    check("TASK_TRACKING mentions ticket IDs (OPE-)", "OPE-" in sections)
    check("TASK_TRACKING mentions PR numbers", "PR" in sections)
    check("TASK_TRACKING requires verbatim preservation", "verbatim" in sections.lower())

    # 3. Iterative prompt contains all 9 sections
    fake = SimpleNamespace(
        _previous_summary="[CONTEXT COMPACTION — REFERENCE ONLY]\n## USER_CONTEXT\nPrior work\n",
        tail_mode="lean",
        _summary_template_sections=cc.ContextCompressor._summary_template_sections,
        _bound_summary_input=cc.ContextCompressor._bound_summary_input,
    )
    iter_prompt = cc.ContextCompressor._build_summary_prompt(fake, "NEW TURNS", 2000, None, "", True)
    for sec in required_sections:
        check(f"iterative prompt contains ## {sec}", f"## {sec}" in iter_prompt)

    # 4. Fallback summary contains all 9 sections
    compressor = SimpleNamespace(
        _previous_summary=None,
        _fallback_anchors=lambda turns: cc.ContextCompressor._fallback_anchors(compressor, turns),
        _is_synthetic_compression_user_turn=lambda msg: False,
        _with_summary_prefix=cc.ContextCompressor._with_summary_prefix,
        _augment_summary_lean=lambda s, t: s,
    )
    turns = [{"role": "user", "content": "Fix OPE-12317 and open PR #2687"}]
    fallback = cc.ContextCompressor._build_static_fallback_summary(compressor, turns)
    for sec in required_sections:
        check(f"fallback summary contains ## {sec}", f"## {sec}" in fallback)
    tt_match = re.search(r"(?ms)^## TASK_TRACKING\s*\n(.*?)(?=^## |\Z)", fallback)
    tt_text = tt_match.group(1) if tt_match else ""
    check("fallback TASK_TRACKING section found", bool(tt_match))
    check("fallback TASK_TRACKING preserves exact ticket ID OPE-12317", "OPE-12317" in tt_text)
    check("fallback TASK_TRACKING preserves exact PR number PR #2687", "PR #2687" in tt_text)

    # 4b. Fallback summary preserves task tracking IDs from previous summary
    compressor_prev = SimpleNamespace(
        _previous_summary="## TASK_TRACKING\n- OPE-9999\n",
        _fallback_anchors=lambda turns: cc.ContextCompressor._fallback_anchors(compressor_prev, turns),
        _is_synthetic_compression_user_turn=lambda msg: False,
        _with_summary_prefix=cc.ContextCompressor._with_summary_prefix,
        _augment_summary_lean=lambda s, t: s,
    )
    fallback_prev = cc.ContextCompressor._build_static_fallback_summary(compressor_prev, turns)
    tt_prev_matches = re.findall(r"(?ms)^## TASK_TRACKING\s*\n(.*?)(?=^## |\Z)", fallback_prev)
    tt_prev_text = tt_prev_matches[-1] if tt_prev_matches else ""
    check("fallback TASK_TRACKING preserves ticket ID from previous summary", "OPE-9999" in tt_prev_text)
    check("fallback TASK_TRACKING preserves ticket ID from current turns", "OPE-12317" in tt_prev_text)
    check("fallback TASK_TRACKING preserves PR number from current turns", "PR #2687" in tt_prev_text)

    # 4c. Fallback summary extracts task IDs from tool call args and ignores technical tokens
    turns_tc = [
        {
            "role": "assistant",
            "content": "Checking UTF-8 and SHA-256 checksums",
            "tool_calls": [
                {"id": "c1", "function": {"name": "read_ticket", "arguments": '{"ticket": "OPE-4242", "pr": "PR #999"}'}}
            ],
        }
    ]
    fallback_tc = cc.ContextCompressor._build_static_fallback_summary(compressor, turns_tc)
    tt_tc_match = re.search(r"(?ms)^## TASK_TRACKING\s*\n(.*?)(?=^## |\Z)", fallback_tc)
    tt_tc_text = tt_tc_match.group(1) if tt_tc_match else ""
    check("fallback TASK_TRACKING preserves ticket ID from tool args", "OPE-4242" in tt_tc_text)
    check("fallback TASK_TRACKING preserves PR number from tool args", "PR #999" in tt_tc_text)
    check("fallback TASK_TRACKING excludes technical tokens like UTF-8", "UTF-8" not in tt_tc_text)
    check("fallback TASK_TRACKING excludes technical tokens like SHA-256", "SHA-256" not in tt_tc_text)
    # 5. Legacy heading parser backwards-compatibility
    test_new = "## USER_CONTEXT\nActive user request\n\n## TASK_TRACKING\nOPE-123\n"
    match_new = cc._HISTORICAL_TASK_SECTION_RE.search(test_new)
    check("regex matches ## USER_CONTEXT", match_new is not None and "Active user request" in match_new.group(0))

    test_legacy = "## Historical Task Snapshot\nLegacy user request\n\n## Other\n"
    match_legacy = cc._HISTORICAL_TASK_SECTION_RE.search(test_legacy)
    check("regex matches ## Historical Task Snapshot", match_legacy is not None and "Legacy user request" in match_legacy.group(0))

    test_ancient = "## Active Task\nAncient user request\n\n## Other\n"
    match_ancient = cc._HISTORICAL_TASK_SECTION_RE.search(test_ancient)
    check("regex matches ## Active Task", match_ancient is not None and "Ancient user request" in match_ancient.group(0))

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("compaction summary 9 sections: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
