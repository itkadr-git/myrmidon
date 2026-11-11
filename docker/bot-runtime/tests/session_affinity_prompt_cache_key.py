#!/usr/bin/env python3
"""Behaviour regression for 28-session-affinity-prompt-cache-key.patch.

A providers entry that names a `session_affinity_header` asks Hermes for the conversation key on every
request to its endpoint (upstream: the header only). The pool of ChatGPT accounts behind a gateway
spreads its prompt cache by that key, so the chat-completions body now carries it as `prompt_cache_key`
too - the header's own value, so one conversation is one key on both - and only for such an endpoint:

* the body key equals the header value for the same conversation, and differs between conversations;
* it is stable across the calls of one conversation (different messages, same key);
* a conversation id longer than OpenAI's 64-character cap is bounded the way every other key is;
* the ambient conversation root (stable across compaction rotation) wins over the physical session id;
* a key the caller pinned stays, and an endpoint without the option, or without any session, gets none;
* api.openai.com keeps the content-addressed key it always had.

Runs as a script against the patched tree and, from inside a hermes checkout, under pytest:

    python3 tests/session_affinity_prompt_cache_key.py [hermes-checkout-dir]
    cd <hermes-checkout> && python3 -m pytest tests/session_affinity_prompt_cache_key.py
"""

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getenv("HERMES_SRC"), os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


HERMES_DIR = _hermes_dir(sys.argv if __name__ == "__main__" else [])
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="affinity-cache-key-"))
sys.path.insert(0, str(HERMES_DIR))

from agent.opencode_affinity import merge_session_affinity_headers  # noqa: E402
from agent.portal_tags import set_conversation_context  # noqa: E402
from agent.transports.chat_completions import ChatCompletionsTransport  # noqa: E402

BASE = "http://gateway.example.test:4000/v1"
HEADER = "x-litellm-session-id"
MESSAGES = [{"role": "system", "content": "You are a bot."}, {"role": "user", "content": "hello"}]
BOARD_KEY = "paperclip:company:11111111-1111-1111-1111-111111111111:agent:22222222-2222-2222-2222-222222222222:issue:33333333-3333-3333-3333-333333333333"


def _entries(header=HEADER, base_url=BASE):
    entry = {"name": "myrmidon-gateway", "provider_key": "myrmidon-gateway", "base_url": base_url}
    if header:
        entry["session_affinity_header"] = header
    return patch("hermes_cli.config.get_compatible_custom_providers", return_value=[entry])


def _body(session_id, base_url=BASE, messages=MESSAGES, **extra):
    """The chat-completions kwargs the transport builds for a custom endpoint (the legacy flag path)."""
    return ChatCompletionsTransport().build_kwargs(
        "chatgpt-pool/gpt-6.1-sol", messages, None,
        base_url=base_url, session_id=session_id, is_custom_provider=True, **extra,
    )


def _header(session_id, base_url=BASE):
    kwargs = merge_session_affinity_headers({}, "custom", base_url, session_id)
    return (kwargs.get("extra_headers") or {}).get(HEADER)


def _clean_ambient():
    set_conversation_context(None)


def test_body_key_is_the_header_value_of_the_same_conversation():
    _clean_ambient()
    with _entries():
        assert _header("sess-A") == "sess-A"
        assert _body("sess-A")["prompt_cache_key"] == "sess-A"
        assert _body("sess-B")["prompt_cache_key"] == "sess-B"


def test_key_is_stable_across_the_calls_of_one_conversation():
    _clean_ambient()
    with _entries():
        first = _body("sess-A", messages=MESSAGES)["prompt_cache_key"]
        later = _body("sess-A", messages=MESSAGES + [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "more"}])
        assert later["prompt_cache_key"] == first


def test_a_long_conversation_id_is_bounded_like_every_other_key():
    _clean_ambient()
    with _entries():
        key = _body(BOARD_KEY)["prompt_cache_key"]
        other = _body(BOARD_KEY.replace("3333", "4444"))["prompt_cache_key"]
        assert key.startswith("pck_") and len(key) <= 64
        assert key == _body(BOARD_KEY)["prompt_cache_key"]
        assert key != other
        # the header keeps the whole id; the body key is its bounded form
        assert _header(BOARD_KEY) == BOARD_KEY


def test_ambient_conversation_root_wins_over_the_physical_session_id():
    try:
        set_conversation_context("root-1")
        with _entries():
            assert _body("rotated-session-7")["prompt_cache_key"] == "root-1"
            assert _header("rotated-session-7") == "root-1"
    finally:
        _clean_ambient()


def test_a_key_the_caller_pinned_stays():
    _clean_ambient()
    with _entries():
        pinned = _body("sess-A", request_overrides={"prompt_cache_key": "pinned-by-caller"})
        assert pinned["prompt_cache_key"] == "pinned-by-caller"
        in_body = _body("sess-A", request_overrides={"extra_body": {"prompt_cache_key": "pinned-in-body"}})
        assert in_body["extra_body"]["prompt_cache_key"] == "pinned-in-body"
        assert "prompt_cache_key" not in in_body


def test_an_endpoint_without_the_option_gets_no_key():
    _clean_ambient()
    with _entries(header=None):
        assert "prompt_cache_key" not in _body("sess-A")
        assert _header("sess-A") is None
    with _entries(base_url="http://other.example.test:4000/v1"):
        assert "prompt_cache_key" not in _body("sess-A")
    with patch("hermes_cli.config.get_compatible_custom_providers", return_value=[]):
        assert "prompt_cache_key" not in _body("sess-A")


def test_no_session_means_no_key():
    _clean_ambient()
    with _entries():
        assert "prompt_cache_key" not in _body(None)
        assert "prompt_cache_key" not in _body("")


def test_openai_keeps_its_content_addressed_key():
    _clean_ambient()
    with patch("hermes_cli.config.get_compatible_custom_providers", return_value=[]):
        key = _body("sess-A", base_url="https://api.openai.com/v1")["prompt_cache_key"]
        assert key.startswith("pck_") and len(key) <= 64
        assert key != "sess-A"


def main(argv):
    failures = []
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - a script, every failure is reported
            failures.append(name)
            print(f"FAIL: {name}: {type(exc).__name__}: {exc}")
    if failures:
        sys.exit(f"{len(failures)} of {len(tests)} check(s) failed")
    print(f"session affinity prompt_cache_key: all {len(tests)} checks passed")


if __name__ == "__main__":
    main(sys.argv)
