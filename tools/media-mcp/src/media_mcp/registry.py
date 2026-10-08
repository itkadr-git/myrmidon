"""Build the media service bot registry (bots.json) from the bots' cards.

The deploy side exports the board's bot cards (each card that should get media
carries its issued token in the environment, one variable per bot); this module
turns that list into the registry file the facade loads. The file itself holds
no usable credential: each entry names the environment variable that carries
the live token (`token_env`), and the facade resolves the sha256 at load time.
A bot whose token variable is unset keeps its seat in the registry (peer rules
may still authenticate it) but no bearer token matches, so it reads as
"media not connected" instead of a hard 401 on every call.

CLI:
  python -m media_mcp.registry cards.json > bots.json
  python -m media_mcp.registry --check bots.json
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from .config import BOT_KEY_RE, load_bots

TOKEN_ENV_PREFIX = "MEDIA_BOT_TOKEN_"
TOKEN_ENV_RE = re.compile(r"^MEDIA_BOT_TOKEN_[A-Z0-9_]+$")


def token_env_name(bot_key: str) -> str:
    """Deterministic environment variable name for a bot's media token."""
    suffix = re.sub(r"[^A-Z0-9]+", "_", bot_key.upper()).strip("_")
    return f"{TOKEN_ENV_PREFIX}{suffix}"


def build_registry(cards: list[dict]) -> dict:
    """cards: [{"key": <bot key>, "peer_host": optional, "tools": optional,
    "quota_bytes": optional, "rate_per_min": optional}]. Every card gets a
    `token_env` entry; cards without an issued token still land in the file so
    the registry always mirrors the card list."""
    bots: dict[str, dict] = {}
    for card in cards:
        key = str(card.get("key") or "").strip()
        if not BOT_KEY_RE.match(key):
            raise ValueError(f"bad bot key {key!r}")
        entry: dict = {"token_env": token_env_name(key)}
        for opt in ("peer_host", "tools", "quota_bytes", "rate_per_min"):
            if card.get(opt) is not None:
                entry[opt] = card[opt]
        bots[key] = entry
    return {"bots": bots}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--check":
        if len(argv) != 2:
            print("usage: registry --check bots.json", file=sys.stderr)
            return 2
        path = Path(argv[1])
        bots = load_bots(path)
        missing = [k for k, b in bots.items() if b.env_token and not b.token_sha256]
        print(f"{len(bots)} bots, {len(missing)} without a live token")
        for key in missing:
            print(f"  {key}: {TOKEN_ENV_PREFIX}… unset (media not connected)")
        return 0
    if len(argv) != 1:
        print("usage: registry <cards.json> | --check <bots.json>", file=sys.stderr)
        return 2
    cards = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    registry = build_registry(cards if isinstance(cards, list) else cards.get("bots") or [])
    json.dump(registry, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
