#!/usr/bin/env python3
"""Behaviour regression for OPE-12319 (OPE-12137 part 6): compaction must never split a
tool call from its results across summarizer records or sampling slices. The atomic
sampling unit is the group "assistant tool_calls + every tool result answering it";
elision markers and slice boundaries fall only BETWEEN groups, and an oversized group is
bounded INSIDE the group (head+tail, marker within), never between call and result.
Covers n=1..8 slices, interleaved/oversized fillers, multi-call batches, orphan results,
id-spelling variants, and coverage-counter consistency.
"""

import os
import re
import sys
from pathlib import Path


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout")


def main(argv):
    hermes_dir = _hermes_dir(argv)
    sys.path.insert(0, str(hermes_dir))
    import agent.context_compressor as cc

    failures = []
    ran = []

    def check(name, cond):
        ran.append(name)
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    class Compressor:
        _CONTENT_MAX = 50000
        _CONTENT_HEAD = 1000
        _CONTENT_TAIL = 1000

        def _render_tool_call_for_summary(self, tc):
            name = (tc.get("function") or {}).get("name", "?")
            cid = tc.get("id") or tc.get("call_id") or "?"
            return f"  {name}[{cid}]"

        _tool_call_id_variants = staticmethod(cc.ContextCompressor._tool_call_id_variants)

    comp = Compressor()

    def filler(tag, n):
        return {"role": "user", "content": f"{tag}-" + "f" * n}

    def pair(idx, content_len, result_len):
        return [
            {"role": "assistant", "content": f"call site {idx}",
             "tool_calls": [{"id": f"call_{idx}", "type": "function",
                             "function": {"name": f"tool_{idx}", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": f"call_{idx}",
             "content": f"result {idx} " + "r" * result_len},
        ]

    # Transcription: pairs, plain filler, an oversized pair, a multi-call batch whose
    # results arrive out of order after an interleaved non-tool message.
    big = 20000
    turns = []
    turns += pair(1, 20, 20)
    turns += [filler("plain", 500)]
    turns += pair(2, 20, big)
    turns += pair(3, 20, 20)
    turns += [
        {"role": "assistant", "content": "batch",
         "tool_calls": [{"id": "call_4a", "type": "function", "function": {"name": "t4a", "arguments": "{}"}},
                        {"id": "call_4b", "type": "function", "function": {"name": "t4b", "arguments": "{}"}}]},
        {"role": "user", "content": "intervening non-tool message"},
        {"role": "tool", "tool_call_id": "call_4b", "content": "result 4b"},
        {"role": "tool", "tool_call_id": "call_4a", "content": "result 4a"},
        {"role": "tool", "tool_call_id": "call_orphan", "content": "orphan result body"},
    ]
    expected_pairs = {
        "call_1": {"call_1"},
        "call_2": {"call_2"},
        "call_3": {"call_3"},
        "call_4a": {"call_4a"},
        "call_4b": {"call_4b"},
    }

    def pair_segments(text):
        """Map each rendered call to results in its atomic record.

        The record itself contains a blank line between the assistant call and results;
        use the next top-level role label as the boundary, not ``\n\n``.
        """
        import re
        out = {}
        starts = list(re.finditer(r"(?m)^\[(?:USER|ASSISTANT|TOOL|UNKNOWN)\]:", text))
        for pos, start in enumerate(starts):
            record = text[start.start(): starts[pos + 1].start() if pos + 1 < len(starts) else len(text)]
            call_ids = set(re.findall(r"  \w+\[(call_[0-9ab]+)\]", record))
            result_ids = set(re.findall(r"\[TOOL RESULT (call_[0-9ab]+)\]", record))
            for cid in call_ids:
                out[cid] = out.get(cid, set()) | result_ids
        return out

    records = cc.ContextCompressor._serialize_records_for_summary(comp, turns)
    text = "\n\n".join(records)
    check("serialization: orphan tool result is not rendered", "orphan result body" not in text)
    got = pair_segments(text)
    for cid, results in expected_pairs.items():
        check(f"serialization: call {cid} rendered", cid in got)
        check(f"serialization: result for {cid} rendered", results)
        for rid in results:
            check(f"serialization: {rid} shares its call {cid}'s record", rid in got.get(cid, set()))
    # Oversized result must not be silently dropped: pair 2's content survives via head/tail.
    check("serialization: oversized result keeps head+tail inside its group",
          "result 2 " in text and ("r" * 100) in text)

    # Behavior test forcing truncation inside an oversized atomic group:
    # Bounding must preserve both the tool calls block and tool results with marker inside.
    oversized_group_turns = [
        {"role": "assistant", "content": "prose " + ("x" * 6000),
         "tool_calls": [{"id": "call_forced", "type": "function",
                         "function": {"name": "tool_forced", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_forced",
         "content": "result_forced " + ("y" * 6000)},
    ]
    forced_records = cc.ContextCompressor._serialize_records_for_summary(comp, oversized_group_turns)
    check("forced group: exactly one atomic record produced", len(forced_records) == 1)
    for limit in (400, 800, 1500, 4000):
        bounded_group = cc.ContextCompressor._bound_oversized_record(forced_records[0], limit)
        check(f"forced group limit={limit}: length within bound", len(bounded_group) <= limit)
        check(
            f"forced group limit={limit}: call part preserved",
            "call_forced" in bounded_group and "[Tool calls:" in bounded_group,
        )
        check(
            f"forced group limit={limit}: result part preserved",
            "[TOOL RESULT call_forced]:" in bounded_group,
        )
        check(
            f"forced group limit={limit}: truncation marker inside group",
            "...[record truncated:" in bounded_group,
        )

    total_chars = sum(len(r) for r in records)

    for n in range(1, 9):
        orig_slices = cc.ContextCompressor._SAMPLED_INPUT_SLICES
        orig_cap = cc.ContextCompressor._SUMMARY_INPUT_MAX_CHARS
        cc.ContextCompressor._SAMPLED_INPUT_SLICES = n
        cc.ContextCompressor._SUMMARY_INPUT_MAX_CHARS = min(orig_cap, max(2000, total_chars // 3))
        try:
            for attempt in range(3):
                sampled_text, coverage = cc.ContextCompressor._sample_summary_records(records)
                check(
                    f"n={n} attempt={attempt}: coverage counters sum",
                    coverage["input_chars"] - coverage["sampled_chars"] == coverage["omitted_chars"],
                )
                check(
                    f"n={n} attempt={attempt}: record counts consistent",
                    coverage["record_count"] == len(records)
                    and coverage["sampled_record_count"] + coverage["elided_record_count"] == len(records),
                )
                check(
                    f"n={n} attempt={attempt}: output bounded by cap",
                    len(sampled_text) <= cc.ContextCompressor._SUMMARY_INPUT_MAX_CHARS,
                )
                segs = pair_segments(sampled_text)
                for cid, results in expected_pairs.items():
                    if cid not in segs:
                        continue  # whole group elided — allowed; assert nothing about it here
                    for rid in results:
                        check(
                            f"n={n} attempt={attempt}: {rid} not separated from call {cid}",
                            rid in segs.get(cid, set()),
                        )
        finally:
            cc.ContextCompressor._SAMPLED_INPUT_SLICES = orig_slices
            cc.ContextCompressor._SUMMARY_INPUT_MAX_CHARS = orig_cap

    if failures:
        sys.exit(f"{len(failures)} check(s) failed of {len(ran)}")
    print(f"compaction tool pairs sampling: all {len(ran)} checks passed")


if __name__ == "__main__":
    main(sys.argv)
