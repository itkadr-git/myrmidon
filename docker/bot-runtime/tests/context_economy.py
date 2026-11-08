#!/usr/bin/env python3
"""Behaviour regression for 16-context-economy.patch (request-time measures A and B, wake handling at a
compaction, and the settings of the whole context economy).

The provider prompt cache hits only on a byte-identical prefix, so a rewrite of an earlier message turns
the rest of the context into fresh input. Measures A and B rewrite earlier rows of the per-call API copy:

A. every wake message (the board's task package) except the newest becomes a one-line note;
B. a tool result of at least stale_tool_min_chars (default 8000) that lies below a boundary which moves
   in steps becomes a note with a ref, and the tool read_stale_tool_result returns the original.

Both are therefore OFF by default (context_economy.stale_wakes / stale_tool_results in config.yaml) and
this test first pins that: with the defaults the request is byte for byte the one built without the
patch and the reader is not in the tool schema. Then it switches them on and pins what they do: what is
replaced and what is not (newest wake, one-wake sessions, recent and small results, the reader's own
results, exempt tools, and instruction loads - skill_view and read_file of SKILL.md or of anything under a
skills directory - which are never replaced, whatever their size), that the notes are deterministic and
the prefix is stable between boundary moves, that the reader returns the exact original, and that the
settings come from config.yaml (context_economy block) and from the environment.

The wake fixtures are written in the shape the hermes_gateway adapter produces TODAY ("Myrmidon runtime
identity:" head, "## Myrmidon Wake Payload" section) and in the shape it produced before the product
rename ("Paperclip runtime identity:"). A fixture frozen at the old shape let measure A go dead
unnoticed once the adapter changed its head; scripts/myrmidon/bot-runtime/dockerfile.test.mjs now also
checks that the adapter's head and section markers are the ones this patch recognises.

At a compaction (which breaks the cache anyway) wake packages are not quoted into the summary: the
summarizer input keeps only the newest wake of the region in full (compaction_stub_wakes, default on).

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


def _clean_env():
    for name in list(os.environ):
        if name.startswith("HERMES_CONTEXT_ECONOMY_") or name in (
            "HERMES_KEEP_STALE_WAKES", "HERMES_KEEP_STALE_TOOL_RESULTS", "HERMES_STALE_TOOL_MIN_CHARS",
            "HERMES_STALE_TOOL_KEEP_MESSAGES", "HERMES_STALE_TOOL_STEP", "HERMES_STALE_TOOL_EXEMPT",
        ):
            os.environ.pop(name, None)


def wake_text(n, body_chars=6000, head="Myrmidon", resumed=False, contract=True, payload=True):
    """The shape buildInput() in the hermes_gateway adapter produces (head = product name)."""
    payload_json = json.dumps({
        "reason": "issue_commented",
        "issue": {"id": f"id-{n}", "identifier": f"OPE-{100 + n}", "title": f"Task number {n}", "description": None},
        "comments": [{"id": f"c{n}", "body": "z" * 300}],
    })
    parts = [
        f"You are eng-2, an AI agent employee in a {head}-managed company.", "",
        f"{head} runtime identity:", "- Agent ID: a-1", "- Company ID: c-1", f"- Run ID: run-{n}",
        "- Paperclip API URL: http://board:3100 (as configured for the Hermes host)", "- Issue work mode: standard", "",
    ]
    if contract:
        parts += ["Execution contract:", "- Take concrete action in this run when the task is actionable.", ""]
    parts += [
        f"## {head} {'Resume Delta' if resumed else 'Wake Payload'}", "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.", "",
        "## Current request and continuation context", "w" * body_chars,
    ]
    if payload:
        parts += ["", "Structured wake payload JSON:", "```json", payload_json, "```"]
    return "\n".join(parts)


def main(argv):
    hermes_dir = _hermes_dir(argv)
    home = tempfile.mkdtemp(prefix="context-economy-")
    os.environ["HERMES_HOME"] = home
    _clean_env()
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

    clock = [10**18]

    def set_config(text):
        """Write the profile's config.yaml (None removes it); the mtime moves on every write."""
        path = Path(home, "config.yaml")
        if text is None:
            path.unlink(missing_ok=True)
            return
        path.write_text(text, encoding="utf-8")
        clock[0] += 5_000_000_000
        os.utime(path, ns=(clock[0], clock[0]))

    def switch_on():
        os.environ["HERMES_CONTEXT_ECONOMY_STALE_WAKES"] = "1"
        os.environ["HERMES_CONTEXT_ECONOMY_STALE_TOOL_RESULTS"] = "1"

    agent = SimpleNamespace(session_id="sess-1", valid_tool_names={"terminal", "read_stale_tool_result"})

    def tool_history(n_extra=0, specs=None):
        """system, user, then one assistant tool call plus its tool result per round, then n_extra plain
        assistant rows. specs: list of (tool name, arguments, result size); default six `terminal` rounds."""
        specs = specs or [("terminal", {"command": f"make test-{i}"}, None) for i in range(6)]
        msgs = [{"role": "system", "content": "system prompt"}, {"role": "user", "content": "do the thing"}]
        for i, (name, args, result_size) in enumerate(specs):
            result = f"line {i}\n" * 3000 + '{"exit_code": 0}' if result_size is None else "r" * result_size
            msgs.append({"role": "assistant", "content": "", "tool_calls": [
                {"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]})
            msgs.append({"role": "tool", "tool_call_id": f"call_{i}", "name": name, "content": result})
        for i in range(n_extra):
            msgs.append({"role": "assistant", "content": f"thinking {i}"})
        return msgs

    wakes = [wake_text(n) for n in range(1, 6)]
    history = []
    for n, text in enumerate(wakes):
        history += [
            {"role": "user", "content": text},
            {"role": "assistant", "content": f"working on {n}"},
        ]
    history.append({"role": "user", "content": "short follow-up from a human"})
    before = copy.deepcopy(history)
    longer = tool_history(n_extra=6)  # 20 rows: eight kept, step 8 -> boundary 8
    both = copy.deepcopy(history) + copy.deepcopy(longer)

    # ---- the defaults: nothing is rewritten, the reader is not offered ---------------------------
    for label, msgs in (("wakes", history), ("tool results", longer), ("both", both)):
        got = copy.deepcopy(msgs)
        stats = ce.apply_context_economy(agent, got)
        check(f"default: {label} are not rewritten, byte for byte", dump(got) == dump(msgs)
              and stats == {"wakes": 0, "tool_results": 0, "saved_chars": 0})
    import model_tools  # noqa: F401  (tool discovery)
    defs_default = {d["function"]["name"] for d in model_tools.get_tool_definitions(enabled_toolsets=["file"], quiet_mode=True)}
    check("default: the reader is not in the tool schema", "read_stale_tool_result" not in defs_default)

    # ---- A: wake messages (switched on) -----------------------------------------------------------
    os.environ["HERMES_CONTEXT_ECONOMY_STALE_WAKES"] = "1"
    check("A fixture: the head is the adapter's current one", wakes[0].count("Myrmidon runtime identity:") == 1
          and "Paperclip runtime identity:" not in wakes[0])
    out = copy.deepcopy(history)
    stats = ce.apply_context_economy(agent, out)
    check("A: four of five wakes replaced", stats["wakes"] == 4)
    check("A: newest wake kept in full", out[8]["content"] == wakes[4])
    check("A: non-wake user row untouched", out[10] == before[10])
    check("A: assistant rows untouched", all(out[i] == before[i] for i in range(1, 10, 2)))
    check("A: note names run and issue", "run-1" in out[0]["content"] and "OPE-101" in out[0]["content"]
          and "Task number 1" in out[0]["content"] and "issue_commented" in out[0]["content"])
    check("A: note carries no task body", "w" * 50 not in out[0]["content"])
    check("A: note is one line", "\n" not in out[0]["content"])
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

    # every shape of the adapter's wake message is recognised
    legacy = [{"role": "user", "content": wake_text(n, head="Paperclip")} for n in (1, 2)]
    check("A: the pre-rename head is still a wake", all(ce.is_wake_message(m) for m in legacy))
    resumed = wake_text(3, resumed=True, contract=False)
    conversation = wake_text(4, contract=False, payload=False)
    check("A: a resume-delta wake is a wake", ce.is_wake_message({"role": "user", "content": resumed}))
    check("A: a wake without contract and payload is a wake", ce.is_wake_message({"role": "user", "content": conversation}))
    mixed_wakes = [
        {"role": "user", "content": wake_text(1, head="Paperclip")}, {"role": "assistant", "content": "a"},
        {"role": "user", "content": resumed}, {"role": "assistant", "content": "b"},
        {"role": "user", "content": conversation}, {"role": "assistant", "content": "c"},
        {"role": "user", "content": wake_text(5)},
    ]
    mw = copy.deepcopy(mixed_wakes)
    stats = ce.apply_context_economy(agent, mw)
    check("A: old and new heads and all shapes are replaced but the newest",
          stats["wakes"] == 3 and mw[6] == mixed_wakes[6] and all(mw[i]["content"].startswith("[Earlier wake message")
                                                                    for i in (0, 2, 4)))
    plain = [{"role": "user", "content": "hello " * 4000}, {"role": "user", "content": "Execution contract: x"}]
    plain_out = copy.deepcopy(plain)
    ce.apply_context_economy(agent, plain_out)
    check("A: a user row without the identity head is not a wake", dump(plain_out) == dump(plain))
    quoted = [{"role": "user", "content": "x" * 3000 + "\nMyrmidon runtime identity:\n- Run ID: r-1\n" + "q" * 4000}] * 2
    quoted_out = copy.deepcopy(quoted)
    ce.apply_context_economy(agent, quoted_out)
    check("A: a quoted identity block far from the head is not a wake", dump(quoted_out) == dump(quoted))
    multimodal = [{"role": "user", "content": [{"type": "text", "text": wakes[0]}]}] + copy.deepcopy(history[2:])
    mm_out = copy.deepcopy(multimodal)
    ce.apply_context_economy(agent, mm_out)
    check("A: multi-part content is left alone", mm_out[0] == multimodal[0])
    os.environ["HERMES_KEEP_STALE_WAKES"] = "1"
    off = copy.deepcopy(history)
    ce.apply_context_economy(agent, off)
    check("A: HERMES_KEEP_STALE_WAKES forces it off, byte for byte", dump(off) == dump(before))
    os.environ.pop("HERMES_KEEP_STALE_WAKES")
    os.environ.pop("HERMES_CONTEXT_ECONOMY_STALE_WAKES")
    set_config("context_economy:\n  stale_wakes: true\n")
    cfg_on = copy.deepcopy(history)
    check("A: config key stale_wakes=true switches it on", ce.apply_context_economy(agent, cfg_on)["wakes"] == 4)
    set_config(None)

    # ---- the compaction input: superseded wakes are not summarized (default on) -----------------
    turns = [m for m in copy.deepcopy(history) if m["role"] != "assistant"][:5]
    stubbed = ce.stub_superseded_wakes(turns)
    check("compaction: older wakes become notes, the last one of the input is kept",
          stubbed[4] == turns[4] and all(stubbed[i]["content"].startswith("[Board wake message") for i in range(4))
          and stubbed is not turns and turns[0]["content"] == wakes[0])
    check("compaction: a wake quoted into the summary becomes a note", ce.wake_note_for_summary(wakes[0]).startswith(
        "[Board wake message") and ce.wake_note_for_summary("a human message") == "a human message")
    os.environ["HERMES_CONTEXT_ECONOMY_COMPACTION_STUB_WAKES"] = "0"
    check("compaction: compaction_stub_wakes=0 gives the input back", ce.stub_superseded_wakes(turns) is turns
          and ce.wake_note_for_summary(wakes[0]) == wakes[0])
    os.environ.pop("HERMES_CONTEXT_ECONOMY_COMPACTION_STUB_WAKES")

    # ---- B: tool results (switched on) -------------------------------------------------------------
    os.environ["HERMES_CONTEXT_ECONOMY_STALE_TOOL_RESULTS"] = "1"
    base = tool_history()
    b_out = copy.deepcopy(base)
    stats = ce.apply_context_economy(agent, b_out)
    # 14 rows, keep 8, step 8 -> boundary 0: nothing yet (protected tail covers it)
    check("B: nothing is stale inside the protected tail", stats["tool_results"] == 0 and dump(b_out) == dump(base))
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

    # a result that was already spilled to a file keeps the way to that file in its note
    spilled = tool_history(n_extra=6)
    spilled[3]["content"] = ("<persisted-output>\nThis tool result was too large (50,000 characters, 48.8 KB).\n"
                             "Full output saved to: /data/cache/spillover/call_0.txt\nUse the read_file tool ...\n"
                             + "p" * 9000 + "\n</persisted-output>")
    sp = copy.deepcopy(spilled)
    ce.apply_context_economy(agent, sp)
    check("B: a spilled result's note keeps the file path", "/data/cache/spillover/call_0.txt" in sp[3]["content"]
          and "read_stale_tool_result" not in sp[3]["content"] and len(sp[3]["content"]) < 700)

    # instruction loads are never replaced, whatever their size: skill_view, and read_file or a terminal
    # command that targets a SKILL.md or anything under a skills directory; other reads and commands still are
    specs = [
        ("skill_view", {"name": "myrmidon"}, 70_000),
        ("read_file", {"path": "/data/profile/skills/paperclip-managed/paperclip/SKILL.md"}, 30_000),
        ("read_file", {"path": "/data/profile/skills/paperclip-managed/paperclip/references/api.md"}, 30_000),
        ("terminal", {"command": "cat /data/profile/skills/x/SKILL.md"}, 30_000),
        ("read_file", {"path": "/workspace/src/app.py"}, 30_000),
        ("terminal", {"command": "git log"}, 30_000),
        ("terminal", {"command": "make test"}, 30_000),
    ]
    skills = tool_history(n_extra=12, specs=specs)  # 28 rows -> boundary 16: all seven results are old enough
    del skills[3]["name"]  # the name comes from the call when the row has none
    sk = copy.deepcopy(skills)
    stats = ce.apply_context_economy(agent, sk)
    check("skills: skill_view is kept in full, with or without a name on the row", sk[3] == skills[3])
    check("skills: read_file of a SKILL.md is kept in full", sk[5] == skills[5])
    check("skills: read_file under a skills directory is kept in full", sk[7] == skills[7])
    check("skills: a terminal command that reads a SKILL.md is kept in full", sk[9] == skills[9])
    check("skills: a read of an ordinary file is replaced", sk[11]["content"] != skills[11]["content"])
    check("skills: other command outputs are replaced", sk[13]["content"] != skills[13]["content"]
          and sk[15]["content"] != skills[15]["content"] and stats["tool_results"] == 3)
    check("skills: is_instruction_load", ce.is_instruction_load("skill_view") and not ce.is_instruction_load("terminal")
          and ce.is_instruction_load("read_file", "C:\\data\\skills\\x\\notes.md")
          and ce.is_instruction_load("read_file", "docs/SKILL.md") and not ce.is_instruction_load("read_file", "/w/a.py")
          and not ce.is_instruction_load("read_file", "") and not ce.is_instruction_load("terminal", "git log")
          and ce.is_instruction_load("terminal", "cat /x/skills/a/SKILL.md")
          and not ce.is_instruction_load("web_extract", "https://example.test/skills/x"))
    os.environ["HERMES_CONTEXT_ECONOMY_STALE_TOOL_EXEMPT"] = "terminal"
    ex_skills = copy.deepcopy(skills)
    ce.apply_context_economy(agent, ex_skills)
    check("skills: stale_tool_exempt adds to the instruction loads", ex_skills[13] == skills[13] and ex_skills[15] == skills[15]
          and ex_skills[11]["content"] != skills[11]["content"])
    os.environ.pop("HERMES_CONTEXT_ECONOMY_STALE_TOOL_EXEMPT")

    # the reader: exact original, windows, unknown ref (the store holds the refs of the LAST request build)
    ce.apply_context_economy(agent, copy.deepcopy(longer))
    from tools.registry import registry
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
    check("B: threshold is configurable by the legacy environment variable", dump(high) == dump(longer))
    os.environ.pop("HERMES_STALE_TOOL_MIN_CHARS")
    os.environ["HERMES_STALE_TOOL_KEEP_MESSAGES"] = "100"
    kept = copy.deepcopy(longer)
    ce.apply_context_economy(agent, kept)
    check("B: the protected tail is configurable by the legacy environment variable", dump(kept) == dump(longer))
    os.environ.pop("HERMES_STALE_TOOL_KEEP_MESSAGES")

    # settings from the profile's config.yaml
    set_config("context_economy:\n  stale_tool_min_chars: 100000\n")
    high = copy.deepcopy(longer)
    ce.apply_context_economy(agent, high)
    check("B: stale_tool_min_chars is read from config.yaml", dump(high) == dump(longer))
    set_config("context_economy:\n  stale_tool_keep_messages: 2\n  stale_tool_step_messages: 1\n")
    tight = copy.deepcopy(longer)
    stats = ce.apply_context_economy(agent, tight)
    check("B: stale_tool_keep_messages and stale_tool_step_messages are read from config.yaml",
          stats["tool_results"] == 6 and tight[19] == longer[19])
    os.environ["HERMES_CONTEXT_ECONOMY_STALE_TOOL_KEEP_MESSAGES"] = "14"
    env_wins = copy.deepcopy(longer)
    stats = ce.apply_context_economy(agent, env_wins)
    check("B: the environment overrides config.yaml", stats["tool_results"] == 2)
    os.environ.pop("HERMES_CONTEXT_ECONOMY_STALE_TOOL_KEEP_MESSAGES")
    set_config("context_economy:\n  stale_tool_min_chars: not-a-number\n  stale_tool_keep_messages: [1]\n")
    junk = copy.deepcopy(longer)
    ce.apply_context_economy(agent, junk)
    check("B: unusable config values fall back to the defaults", dump(junk) == dump(l_out))
    set_config("context_economy:\n  stale_tool_results: false\n")
    os.environ.pop("HERMES_CONTEXT_ECONOMY_STALE_TOOL_RESULTS")
    flagged = copy.deepcopy(longer)
    ce.apply_context_economy(agent, flagged)
    check("B: config key stale_tool_results=false keeps it off", dump(flagged) == dump(longer))
    set_config("context_economy:\n  stale_tool_results: true\n")
    cfg_on = copy.deepcopy(longer)
    check("B: config key stale_tool_results=true switches it on", ce.apply_context_economy(agent, cfg_on)["tool_results"] == 3)
    set_config(None)
    os.environ["HERMES_CONTEXT_ECONOMY_STALE_TOOL_RESULTS"] = "1"

    # without the reader in the toolset the note does not promise it
    bare = SimpleNamespace(session_id="sess-2", valid_tool_names={"terminal"})
    nb = copy.deepcopy(longer)
    ce.apply_context_economy(bare, nb)
    check("B: no reader in the toolset, no promise", "read_stale_tool_result" not in nb[stale_idx[0]]["content"]
          and "repeat the original call" in nb[stale_idx[0]]["content"])

    # switched on: the reader is in the tool schema; HERMES_KEEP_STALE_TOOL_RESULTS takes it out again
    model_tools._clear_tool_defs_cache()
    defs_on = {d["function"]["name"] for d in model_tools.get_tool_definitions(enabled_toolsets=["file"], quiet_mode=True)}
    check("B: reader is in the schema while B is on", "read_stale_tool_result" in defs_on)
    os.environ["HERMES_KEEP_STALE_TOOL_RESULTS"] = "1"
    off = copy.deepcopy(longer)
    ce.apply_context_economy(agent, off)
    check("B: HERMES_KEEP_STALE_TOOL_RESULTS forces it off, byte for byte", dump(off) == dump(longer))
    model_tools._clear_tool_defs_cache()
    defs_off = {d["function"]["name"] for d in model_tools.get_tool_definitions(enabled_toolsets=["file"], quiet_mode=True)}
    check("B: switched off, the reader leaves the schema", "read_stale_tool_result" not in defs_off
          and defs_off == defs_on - {"read_stale_tool_result"} and defs_off == defs_default)
    os.environ["HERMES_KEEP_STALE_WAKES"] = "1"
    both_out = copy.deepcopy(both)
    ce.apply_context_economy(agent, both_out)
    check("both forced off: byte for byte", dump(both_out) == dump(both))
    _clean_env()

    # the hook sits in the request assembly
    src = Path(hermes_dir, "agent", "turn_request_assembly.py").read_text()
    check("hook: apply_context_economy is called by assemble_api_request",
          "apply_context_economy(agent, api_messages)" in src)

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("context economy: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
