#!/usr/bin/env python3
"""Behaviour regression for 11-stranded-run-turn-replace.patch.

A run that fails after its turn-start persist leaves its prompt as the transcript's unanswered
tail user row. The board re-dispatches a fresh (not byte-identical) prompt for the same session,
and before the patch every attempt added one more user row, which the live-replay merge then sent
as ONE ever-growing user message. This test pins the contract against a real SessionDB:

* stranded prompts that share the new prompt's head are soft-deleted and dropped from the history,
  so the new prompt becomes the only unanswered tail row;
* an answered turn, an unrelated prompt, multimodal rows and a compaction carrier are untouched;
* HERMES_KEEP_STRANDED_RUN_TURNS=1 disables the replacement;
* a failing rewind still drops the rows from the in-memory history.

    python3 tests/stranded_run_turn.py [hermes-checkout-dir]
"""

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


def main(argv):
    hermes_dir = _hermes_dir(argv)
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="stranded-run-turn-")
    os.environ.pop("HERMES_KEEP_STRANDED_RUN_TURNS", None)
    sys.path.insert(0, str(hermes_dir))
    from agent.session_persistence import replace_stranded_run_turn
    from hermes_state import SessionDB

    db = SessionDB(Path(os.environ["HERMES_HOME"]) / "state.db")
    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    head = "You are an agent employee. " + "x" * 300
    prompt = lambda n: head + f" attempt {n} " + "y" * 2000  # noqa: E731 - same head, different tail

    def seed(sid, rows):
        db.create_session(sid, "api_server")
        for role, content, *extra in rows:
            db.append_message(sid, role, content, **(extra[0] if extra else {}))
        return SimpleNamespace(_session_db=db, session_id=sid)

    def history(sid):
        return db.get_messages_as_conversation(sid)

    def roles(sid):
        return [m["role"] for m in history(sid)]

    # 1. Three failed attempts stacked behind an answered turn are all superseded.
    agent = seed("s1", [("user", "first"), ("assistant", "done"),
                        ("user", prompt(1)), ("user", prompt(2)), ("user", prompt(3))])
    hist = history("s1")
    n = replace_stranded_run_turn(hist, prompt(4), agent)
    check("stranded rows removed from the in-memory history", n == 3 and [m["role"] for m in hist] == ["user", "assistant"])
    check("stranded rows soft-deleted in the store", roles("s1") == ["user", "assistant"])

    # 2. Failed attempts that left tool scaffolding behind them are superseded too.
    agent = seed("s2", [
        ("user", prompt(1)),
        ("assistant", "", {"tool_calls": [{"id": "c1", "type": "function", "function": {"name": "t", "arguments": "{}"}}]}),
        ("tool", "out", {"tool_call_id": "c1"}),
    ])
    hist = history("s2")
    n = replace_stranded_run_turn(hist, prompt(2), agent)
    check("tool scaffolding of the failed attempt is dropped", n >= 1 and hist == [])
    check("store has no stranded prompt left", [m for m in history("s2") if m["role"] == "user"] == [])

    # 3. An answered turn is never touched, even with an identical prompt.
    agent = seed("s3", [("user", prompt(1)), ("assistant", "answer")])
    hist = history("s3")
    check("answered turn kept (history)", replace_stranded_run_turn(hist, prompt(2), agent) == 0 and len(hist) == 2)
    check("answered turn kept (store)", roles("s3") == ["user", "assistant"])

    # 4. An unrelated unanswered prompt is not swallowed.
    agent = seed("s4", [("user", "something a person typed"), ])
    hist = history("s4")
    check("unrelated tail kept", replace_stranded_run_turn(hist, prompt(1), agent) == 0 and len(hist) == 1)
    check("unrelated tail kept in the store", roles("s4") == ["user"])

    # 5. Multimodal stranded rows are left alone.
    agent = seed("s5", [("user", prompt(1))])
    hist = [{"role": "user", "content": [{"type": "text", "text": prompt(1)}]}]
    check("multimodal tail kept", replace_stranded_run_turn(hist, prompt(2), agent) == 0 and len(hist) == 1)

    # 6. The opt-out switch.
    agent = seed("s6", [("user", prompt(1))])
    hist = history("s6")
    os.environ["HERMES_KEEP_STRANDED_RUN_TURNS"] = "1"
    try:
        check("opt-out keeps the stranded row", replace_stranded_run_turn(hist, prompt(2), agent) == 0 and roles("s6") == ["user"])
    finally:
        del os.environ["HERMES_KEEP_STRANDED_RUN_TURNS"]

    # 7. A rewind that fails still drops the rows from this turn's history.
    agent = seed("s7", [("user", prompt(1)), ("user", prompt(2))])
    hist = history("s7")
    agent._session_db = SimpleNamespace(rewind_user_turn=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    n = replace_stranded_run_turn(hist, prompt(3), agent)
    check("failed rewind still trims the in-memory history", n == 2 and hist == [])

    # 8. Empty history and empty prompt are no-ops.
    check("empty history is a no-op", replace_stranded_run_turn([], prompt(1), agent) == 0)
    check("empty prompt is a no-op", replace_stranded_run_turn(history("s1"), "  ", agent) == 0)

    if failures:
        sys.exit(f"{len(failures)} check(s) failed: {failures}")
    print("stranded_run_turn: ok")


if __name__ == "__main__":
    main(sys.argv)
