#!/usr/bin/env python3
"""Behaviour regression for 16-context-economy.patch (measures A and B of the input-token economy).

Every model call re-sends the whole session. The patch rewrites the per-call API copy only:

A. every wake message (the board's task package) except the newest becomes a short note;
B. a tool result of at least HERMES_STALE_TOOL_MIN_CHARS that is older than the protected tail
   becomes a note with a ref, and the tool read_stale_tool_result returns the original for that ref.

This test pins: what is replaced and what is not (newest wake, one-wake sessions, recent and small
results, the reader's own results, exempt tools), that the notes are deterministic and the prefix is
stable between boundary moves, that the reader returns the exact original (also in windows), that the
request shrinks by the expected share, and that switching either flag off gives back the request
byte for byte (and the reader leaves the tool schema).

    python3 tests/context_economy.py [hermes-checkout-dir]
"""

import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


FLAGS = ("HERMES_KEEP_STALE_WAKES", "HERMES_KEEP_STALE_TOOL_RESULTS", "HERMES_STALE_TOOL_MIN_CHARS",
         "HERMES_STALE_TOOL_KEEP_MESSAGES", "HERMES_STALE_TOOL_STEP", "HERMES_STALE_TOOL_EXEMPT")


def wake_text(n, body_chars=6000):
    """The shape buildInput() in the hermes_gateway adapter produces."""
    payload = json.dumps({
        "reason": "issue_commented",
        "issue": {"id": f"id-{n}", "identifier": f"OPE-{100 + n}", "title": f"Task number {n}", "description": None},
        "comments": [{"id": f"c{n}", "body": "z" * 300}],
    })
    return "\n".join([
        "You are eng-2, an AI agent employee in a Paperclip-managed company.", "",
        "Paperclip runtime identity:", "- Agent ID: a-1", "- Company ID: c-1", f"- Run ID: run-{n}", "",
        "Execution contract:", "- Take concrete action in this run when the task is actionable.", "",
        "Current request and continuation context", "w" * body_chars, "",
        "Structured wake payload JSON:", "```json", payload, "```",
    ])


def main(argv):
    hermes_dir = _hermes_dir(argv)
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="context-economy-")
    for flag in FLAGS:
        os.environ.pop(flag, None)
    sys.path.insert(0, str(hermes_dir))
    import agent.context_economy as ce

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    def dump(msgs):
        return json.dumps(msgs, sort_keys=True, ensure_ascii=False)

    def size(msgs):
        return sum(len(m["content"]) for m in msgs if isinstance(m.get("content"), str))

    agent = SimpleNamespace(session_id="sess-1", valid_tool_names={"terminal", "read_stale_tool_result"})

    # ---- A: wake messages -------------------------------------------------------------------
    wakes = [wake_text(n) for n in range(1, 6)]
    history = []
    for n, text in enumerate(wakes):
        history += [
            {"role": "user", "content": text},
            {"role": "assistant", "content": f"working on {n}"},
        ]
    history.append({"role": "user", "content": "short follow-up from a human"})
    before = copy.deepcopy(history)
    out = copy.deepcopy(history)
    stats = ce.apply_context_economy(agent, out)
    check("A: four of five wakes replaced", stats["wakes"] == 4)
    check("A: newest wake kept in full", out[8]["content"] == wakes[4])
    check("A: non-wake user row untouched", out[10] == before[10])
    check("A: assistant rows untouched", all(out[i] == before[i] for i in range(1, 10, 2)))
    check("A: note names run and issue", "run-1" in out[0]["content"] and "OPE-101" in out[0]["content"]
          and "Task number 1" in out[0]["content"] and "issue_commented" in out[0]["content"])
    check("A: note carries no task body", "w" * 50 not in out[0]["content"])
    again = copy.deepcopy(history)
    ce.apply_context_economy(agent, again)
    check("A: deterministic", dump(again) == dump(out))
    grown = copy.deepcopy(history) + [{"role": "assistant", "content": "ok"}, {"role": "user", "content": wake_text(6)}]
    grown_out = copy.deepcopy(grown)
    ce.apply_context_economy(agent, grown_out)
    check("A: older notes keep their bytes when a new wake arrives", dump(grown_out[:8]) == dump(out[:8]))
    check("A: the wake that was newest becomes a note", grown_out[8]["content"] != wakes[4]
          and "run-5" in grown_out[8]["content"])
    ratio = size(out) / size(before)
    print(f"A: request characters {size(before)} -> {size(out)} ({ratio:.0%})")
    check("A: request shrinks by more than half", ratio < 0.5)
    one = copy.deepcopy(history[:2])
    ce.apply_context_economy(agent, one)
    check("A: a single wake is never replaced", dump(one) == dump(history[:2]))
    plain = [{"role": "user", "content": "hello " * 4000}, {"role": "user", "content": "Execution contract: x"}]
    plain_out = copy.deepcopy(plain)
    ce.apply_context_economy(agent, plain_out)
    check("A: a user row without the identity head is not a wake", dump(plain_out) == dump(plain))
    multimodal = [{"role": "user", "content": [{"type": "text", "text": wakes[0]}]}] + copy.deepcopy(history[2:])
    mm_out = copy.deepcopy(multimodal)
    ce.apply_context_economy(agent, mm_out)
    check("A: multi-part content is left alone", mm_out[0] == multimodal[0])

    os.environ["HERMES_KEEP_STALE_WAKES"] = "1"
    off = copy.deepcopy(history)
    ce.apply_context_economy(agent, off)
    check("A: flag off gives the request back byte for byte", dump(off) == dump(before))
    os.environ.pop("HERMES_KEEP_STALE_WAKES")

    # ---- B: tool results ----------------------------------------------------------------------
    big = [("terminal", {"command": f"make test-{i}"}, f"line {i}\n" * 3000 + '{"exit_code": 0}') for i in range(6)]

    def tool_history(n_extra=0):
        msgs = [{"role": "system", "content": "system prompt"}, {"role": "user", "content": "do the thing"}]
        for i, (name, args, result) in enumerate(big):
            msgs.append({"role": "assistant", "content": "", "tool_calls": [
                {"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]})
            msgs.append({"role": "tool", "tool_call_id": f"call_{i}", "name": name, "content": result})
        for i in range(n_extra):
            msgs.append({"role": "assistant", "content": f"thinking {i}"})
        return msgs

    base = tool_history()
    check("B: fixture is long enough", len(base) == 14)
    b_out = copy.deepcopy(base)
    stats = ce.apply_context_economy(agent, b_out)
    # 14 rows, keep 8, step 8 -> boundary 0: nothing yet (protected tail covers it)
    check("B: nothing is stale inside the protected tail", stats["tool_results"] == 0 and dump(b_out) == dump(base))
    longer = tool_history(n_extra=6)  # 20 rows -> boundary 8
    l_out = copy.deepcopy(longer)
    stats = ce.apply_context_economy(agent, l_out)
    stale_idx = [i for i in range(8) if longer[i].get("role") == "tool"]
    check("B: results below the boundary are replaced", stats["tool_results"] == len(stale_idx) and len(stale_idx) == 3)
    check("B: results above the boundary are kept", all(l_out[i] == longer[i] for i in range(8, 20)))
    note = l_out[stale_idx[0]]["content"]
    ref = ce.result_ref(longer[stale_idx[0]]["content"])
    check("B: note names tool, command, size and ref", "terminal" in note and "make test-0" in note
          and str(len(longer[stale_idx[0]]["content"])) in note and ref in note)
    check("B: note points at the reader", "read_stale_tool_result" in note)
    check("B: note keeps the tail (exit status)", '"exit_code": 0' in note)
    check("B: roles, ids and tool calls are untouched", all(
        {k: v for k, v in l_out[i].items() if k != "content"} == {k: v for k, v in longer[i].items() if k != "content"}
        for i in range(20)))
    print(f"B: request characters {size(longer)} -> {size(l_out)} ({size(l_out) / size(longer):.0%})")
    check("B: request shrinks", size(l_out) < size(longer) * 0.8)
    # prefix stability: the next calls keep the same bytes until the boundary moves by a step
    stable = tool_history(n_extra=7)  # 21 rows -> boundary still 8
    s_out = copy.deepcopy(stable)
    ce.apply_context_economy(agent, s_out)
    check("B: prefix is stable between boundary moves", dump(s_out[:20]) == dump(l_out[:20]))
    moved = tool_history(n_extra=14)  # 28 rows -> boundary 16: more results stale, earlier notes unchanged
    m_out = copy.deepcopy(moved)
    ce.apply_context_economy(agent, m_out)
    check("B: earlier notes keep their bytes when the boundary moves", dump(m_out[:8]) == dump(l_out[:8]))
    check("B: the boundary move replaces further results", m_out[9]["content"] != moved[9]["content"])

    # the reader: exact original, windows, unknown ref
    from tools.registry import registry
    import model_tools  # noqa: F401  (tool discovery)
    reader = registry.get_entry("read_stale_tool_result")
    check("B: reader is registered in the file toolset", reader is not None and reader.toolset == "file")
    got = registry.dispatch("read_stale_tool_result", {"ref": ref}, session_id="sess-1")
    check("B: reader returns the original byte for byte", got == longer[stale_idx[0]]["content"])
    win = registry.dispatch("read_stale_tool_result", {"ref": ref, "offset": 10, "limit": 100}, session_id="sess-1")
    check("B: reader windows a result", win.startswith(longer[stale_idx[0]]["content"][10:110]) and "offset=110" in win)
    gone = json.loads(registry.dispatch("read_stale_tool_result", {"ref": "000000000000"}, session_id="sess-1"))
    check("B: unknown ref is a clear error", "error" in gone and "repeat the original call" in gone["error"])
    other = json.loads(registry.dispatch("read_stale_tool_result", {"ref": ref}, session_id="another-session"))
    check("B: a ref is readable only in its own session", "error" in other)

    # what is never replaced
    mixed = tool_history(n_extra=6)
    mixed[3]["content"] = "small"
    mixed[5]["name"] = "read_stale_tool_result"
    mixed[7]["content"] = '<untrusted_tool_result source="web_extract">\nSECRET-INSTRUCTION ' + "q" * 9000 + "\n</untrusted_tool_result>"
    mx = copy.deepcopy(mixed)
    ce.apply_context_economy(agent, mx)
    check("B: small result kept", mx[3] == mixed[3])
    check("B: reader's own result kept", mx[5] == mixed[5])
    check("B: untrusted text is not quoted into a note", "SECRET-INSTRUCTION" not in mx[7]["content"]
          and "Stale tool result" in mx[7]["content"])
    os.environ["HERMES_STALE_TOOL_EXEMPT"] = "terminal"
    ex = copy.deepcopy(mixed)
    ce.apply_context_economy(agent, ex)
    check("B: exempt tool results kept in full", all(ex[i] == mixed[i] for i in (3, 5)))
    os.environ.pop("HERMES_STALE_TOOL_EXEMPT")
    os.environ["HERMES_STALE_TOOL_MIN_CHARS"] = "100000"
    high = copy.deepcopy(longer)
    ce.apply_context_economy(agent, high)
    check("B: threshold is configurable", dump(high) == dump(longer))
    os.environ.pop("HERMES_STALE_TOOL_MIN_CHARS")

    # without the reader in the toolset the note does not promise it
    bare = SimpleNamespace(session_id="sess-2", valid_tool_names={"terminal"})
    nb = copy.deepcopy(longer)
    ce.apply_context_economy(bare, nb)
    check("B: no reader in the toolset, no promise", "read_stale_tool_result" not in nb[stale_idx[0]]["content"]
          and "repeat the original call" in nb[stale_idx[0]]["content"])

    # flag off: request and tool schema as before
    defs_on = {d["function"]["name"] for d in model_tools.get_tool_definitions(enabled_toolsets=["file"], quiet_mode=True)}
    check("B: reader is in the schema while B is on", "read_stale_tool_result" in defs_on)
    os.environ["HERMES_KEEP_STALE_TOOL_RESULTS"] = "1"
    off = copy.deepcopy(longer)
    ce.apply_context_economy(agent, off)
    check("B: flag off gives the request back byte for byte", dump(off) == dump(longer))
    model_tools._clear_tool_defs_cache()
    defs_off = {d["function"]["name"] for d in model_tools.get_tool_definitions(enabled_toolsets=["file"], quiet_mode=True)}
    check("B: flag off removes the reader from the schema", "read_stale_tool_result" not in defs_off
          and defs_off == defs_on - {"read_stale_tool_result"})
    both = copy.deepcopy(history) + copy.deepcopy(longer)
    os.environ["HERMES_KEEP_STALE_WAKES"] = "1"
    both_out = copy.deepcopy(both)
    ce.apply_context_economy(agent, both_out)
    check("both flags off: byte for byte", dump(both_out) == dump(both))
    for flag in FLAGS:
        os.environ.pop(flag, None)

    # the hook sits in the request assembly
    src = Path(hermes_dir, "agent", "turn_request_assembly.py").read_text()
    check("hook: apply_context_economy is called by assemble_api_request",
          "apply_context_economy(agent, api_messages)" in src)

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("context economy: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
