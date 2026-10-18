"""Tests for the reporter's uv-cache self-check passthrough (1.6.5-BOT-DISK-UV-B).

The reporter only reads $HERMES_HOME/.myrmidon/uv-cache-check.json (written by
the entrypoint at container start) and copies it into the report as
`uvCacheCheck`; it never interprets the payload. A missing or corrupt file
must degrade to null, never to a crash that loses the whole report.

Run: python3 clone_hygiene_uv_cache.py
"""

import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "git-reference" / "bot-clone-hygiene"
loader = importlib.machinery.SourceFileLoader("bot_clone_hygiene", str(MODULE_PATH))
spec = importlib.util.spec_from_loader("bot_clone_hygiene", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)


def check(name, cond):
    print(("ok  " if cond else "FAIL") + " " + name)
    if not cond:
        sys.exit(1)


with tempfile.TemporaryDirectory() as home:
    os.environ["HERMES_HOME"] = home
    myrmidon = Path(home) / ".myrmidon"

    # No file at all -> null, no exception.
    check("missing file reports null", mod.read_uv_cache_check() is None)

    # A well-formed file comes through unchanged (the server owns the schema).
    payload = {
        "version": 1,
        "method": "clone",
        "checkedAt": "2026-10-08T11:58:12Z",
        "cache": "/cache/uv",
        "ok": False,
        "roots": [
            {"root": "/workspace", "ok": False, "error": "cannot create file: Permission denied"},
        ],
    }
    myrmidon.mkdir(parents=True)
    (myrmidon / "uv-cache-check.json").write_text(json.dumps(payload))
    check("well-formed file passes through", mod.read_uv_cache_check() == payload)

    # Corrupt JSON -> null, no exception.
    (myrmidon / "uv-cache-check.json").write_text("{not json")
    check("corrupt file reports null", mod.read_uv_cache_check() is None)

    # A non-object payload -> null.
    (myrmidon / "uv-cache-check.json").write_text("[1, 2]")
    check("non-object payload reports null", mod.read_uv_cache_check() is None)

print("clone_hygiene_uv_cache: all tests passed")
