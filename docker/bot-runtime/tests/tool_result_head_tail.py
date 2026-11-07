#!/usr/bin/env python3
"""Behaviour regression for 25-tool-result-head-tail.patch (measure C of the input-token economy).

A single tool result longer than context_economy.tool_result_max_chars (default 16000) is stored and sent as
its first tool_result_head_chars (8000) and last tool_result_tail_chars (4000) characters plus a marker that
names the file holding the whole text and says how to read the middle. The full text goes to the spill
file the upstream persistence already writes (cache/spillover under the profile's home).

This test pins: nothing at or below the cap changes; above it the message has the head, the tail and a
marker whose line range and byte offsets describe exactly the omitted middle; the spill file holds the
whole result; read_file stays pinned (never persisted, so reading the middle cannot loop); the per-turn
budget pass keeps its preview for small results; skill_view results are exempt by default (a half skill
makes the agent load it again and again); the cap, head, tail and exempt tools come from config.yaml
(context_economy block) and the environment; 0 switches the cap off; a spill file that
cannot be written still gives a head and tail with an honest marker.

    python3 tests/tool_result_head_tail.py [hermes-checkout-dir]
"""

import os
import re
import sys
import tempfile
from pathlib import Path


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


def _clean_env():
    for name in list(os.environ):
        if name.startswith("HERMES_CONTEXT_ECONOMY_"):
            os.environ.pop(name, None)


def numbered_lines(count):
    """count lines of exactly 21 characters each (newline included)."""
    return "".join(f"row {i:05d} abcdefghij\n" for i in range(1, count + 1))


def main(argv):
    hermes_dir = _hermes_dir(argv)
    home = tempfile.mkdtemp(prefix="head-tail-")
    os.environ["HERMES_HOME"] = home
    _clean_env()
    sys.path.insert(0, str(hermes_dir))
    import model_tools  # noqa: F401  (tool discovery: the tools register their result sizes)
    import tools.tool_result_storage as trs

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    clock = [10**18]

    def set_config(text):
        path = Path(home, "config.yaml")
        if text is None:
            path.unlink(missing_ok=True)
            return
        path.write_text(text, encoding="utf-8")
        clock[0] += 5_000_000_000
        os.utime(path, ns=(clock[0], clock[0]))

    def persist(content, tool="terminal", call_id="call_1", **kw):
        return trs.maybe_persist_tool_result(content, tool, call_id, **kw)

    content = numbered_lines(2000)  # 42,000 characters, 2,000 lines
    lines = content.splitlines()
    out = persist(content)
    check("a 42,000-character result becomes a persisted-output block",
          out.startswith("<persisted-output>") and out.rstrip().endswith("</persisted-output>"))
    check("the block is far smaller than the result", len(out) < 15_000)
    path_match = re.search(r"^Full output saved to: (.+)$", out, re.MULTILINE)
    check("the marker names the spill file", path_match is not None)
    spill = Path(path_match.group(1)) if path_match else None
    check("the spill file lies under the profile's spillover directory",
          spill is not None and Path(home, "cache", "spillover") in spill.parents)
    check("the spill file holds the whole result", spill is not None and spill.read_text(encoding="utf-8") == content)
    check("the upstream helper still extracts the path from the block", trs.extract_persisted_path(out) == str(spill))
    check("the head is shown", content[:5000] in out)
    check("the tail is shown", content[-3000:] in out)
    range_match = re.search(r"\(lines (\d+)-(\d+)\)", out)
    check("the marker gives the omitted line range", range_match is not None)
    if range_match:
        first, last = int(range_match.group(1)), int(range_match.group(2))
        check("the last head line is shown and the first omitted line is not", lines[first - 2] in out
              and lines[first - 1] not in out)
        check("the last omitted line is not shown and the first tail line is", lines[last - 1] not in out
              and lines[last] in out)
    byte_match = re.search(r"tail -c \+(\d+) (\S+) \| head -c (\d+)", out)
    check("the marker gives a byte-exact way to read the middle", byte_match is not None)
    if byte_match:
        start, size = int(byte_match.group(1)), int(byte_match.group(3))
        data = content.encode("utf-8")
        middle = data[start - 1:start - 1 + size].decode("utf-8")
        check("the byte range is the omitted middle exactly",
              data[:start - 1].decode("utf-8") in out and data[start - 1 + size:].decode("utf-8") in out
              and middle not in out and len(middle) > 20_000)
    check("the marker tells how to read the middle", "read_file" in out and "offset=" in out and "filter" in out)

    # the cap itself: at the cap nothing changes, one character over it does
    at_cap = "a" * 16_000
    check("a result of exactly 16,000 characters is untouched", persist(at_cap, call_id="call_cap") == at_cap)
    over = persist("a" * 16_001, call_id="call_over")
    check("a result of 16,001 characters is cut", over.startswith("<persisted-output>") and len(over) < 15_000)
    check("a small result is untouched", persist("short result", call_id="call_small") == "short result")

    # read_file is pinned by upstream (persist -> read -> persist would loop) and stays so
    huge = "z" * 120_000
    check("read_file results are never persisted", persist(huge, tool="read_file", call_id="call_rf") == huge)

    # instructions are not cut: skill_view is exempt by default (an agent that gets half of a skill reloads it)
    check("skill_view results are exempt by default", persist(content, tool="skill_view", call_id="call_sv") == content)
    check("other tools are cut by default", persist(content, tool="execute_code", call_id="call_ec").startswith("<persisted-output>"))

    # the per-turn budget pass forces persistence (threshold 0): small results keep the preview shape
    forced = persist("b" * 5000, tool="__budget_enforcement__", call_id="call_budget", threshold=0)
    check("a forced small result keeps the upstream preview", forced.startswith("<persisted-output>")
          and "Preview (first" in forced and "[first " not in forced)
    forced_big = persist(content, tool="__budget_enforcement__", call_id="call_budget2", threshold=0)
    check("a forced huge result gets the head and tail", "[first " in forced_big and len(forced_big) < 15_000)

    # settings from config.yaml
    set_config("context_economy:\n  tool_result_max_chars: 6000\n  tool_result_head_chars: 1000\n"
               "  tool_result_tail_chars: 500\n")
    small_cap = persist(numbered_lines(334), call_id="call_cfg")  # 7,014 characters
    check("config.yaml sets the cap, head and tail", small_cap.startswith("<persisted-output>")
          and len(small_cap) < 3_500 and numbered_lines(334)[:900] in small_cap
          and numbered_lines(334)[-400:] in small_cap and numbered_lines(334)[3000:3100] not in small_cap)
    check("below the configured cap nothing changes", persist(numbered_lines(280), call_id="call_cfg2") == numbered_lines(280))
    set_config("context_economy:\n  tool_result_max_chars: 1000\n")
    scaled = persist(numbered_lines(240), call_id="call_scaled")  # 5,040 characters, default head/tail too big
    check("head and tail are scaled down to fit under a small cap", scaled.startswith("<persisted-output>")
          and len(scaled) < 2_600)
    set_config("context_economy:\n  tool_result_max_chars: 0\n")
    check("tool_result_max_chars 0 gives the upstream behaviour back", persist(content, call_id="call_off") == content)
    set_config("context_economy:\n  tool_result_exempt: terminal\n")
    check("an exempt tool is never cut", persist(content, call_id="call_ex") == content)
    check("other tools still are, skill_view too once the list is replaced",
          persist(content, tool="execute_code", call_id="call_ex2").startswith("<persisted-output>")
          and persist(content, tool="skill_view", call_id="call_ex3").startswith("<persisted-output>"))
    set_config("context_economy:\n  tool_result_exempt: \"\"\n")
    check("an empty exempt list cuts every tool but the pinned ones",
          persist(content, tool="skill_view", call_id="call_ex4").startswith("<persisted-output>"))
    set_config("context_economy:\n  tool_result_max_chars: 99999999\n")
    os.environ["HERMES_CONTEXT_ECONOMY_TOOL_RESULT_MAX_CHARS"] = "3000"
    env_cut = persist(numbered_lines(200), call_id="call_env")  # 4,200 characters
    check("the environment overrides config.yaml", env_cut.startswith("<persisted-output>") and len(env_cut) < 4_000)
    os.environ.pop("HERMES_CONTEXT_ECONOMY_TOOL_RESULT_MAX_CHARS")
    set_config("context_economy:\n  tool_result_max_chars: [nonsense]\n")
    check("an unusable value falls back to the default cap", persist(content, call_id="call_junk").startswith("<persisted-output>"))
    set_config(None)

    # a spill file that cannot be written still gives head and tail, with an honest marker
    original_write = trs._write_to_spillover
    trs._write_to_spillover = lambda *args, **kwargs: None
    try:
        unsaved = persist(content, call_id="call_nosave")
    finally:
        trs._write_to_spillover = original_write
    check("no spill file: head and tail with a marker that says so", "could not be saved" in unsaved
          and content[:3000] in unsaved and content[-3000:] in unsaved and "<persisted-output>" not in unsaved
          and len(unsaved) < 13_500)

    # the patch must not touch the 8 KB..16 KB band's neighbours: a 12,000-character result is untouched
    mid = numbered_lines(571)  # 11,991 characters
    check("a result between 8,000 and 16,000 characters is untouched", persist(mid, call_id="call_mid") == mid)

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("tool result head/tail: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
