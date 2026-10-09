# myrmidon(G1): build-time regression for 12-redact-pcp-patterns.patch and
# 13-delegation-live-log-mode-0600.patch (LIVE-TRANSCRIPT-PCP-LEAK). A board
# key written into a delegation live transcript had no bare-token pattern in
# agent/redact.py, so the world-default 0o644 transcript leaked it to every
# co-tenant process in the container. This pins both fixes against the patched
# tree: the ``pcp_`` key family is masked wherever it appears (bare, in prose,
# in a header, in a JSON dump), the transcript lands 0o600 from creation, and
# the masking is provably the patches' doing — a control first shows the value
# flowing through the unprefixed prose path when the family is absent, so the
# suite can never go green because a recording was missing.
#
# Usage: delegation_live_log_redact.py <hermes-src>   (e.g. /opt/hermes-src)
#
# Only synthetic keys are used, never real ones: ``pcp_`` + 48 hex (len 52),
# family variants ``pcp_<family>_`` + 48 hex, and one fixed base64url-shaped
# invite token (``pcp_invite_`` + 43 chars of [A-Za-z0-9_-] with ``-``/``_``
# inside the first 20), per the board-key corpus shapes.

import os
import re
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from agent.redact import (  # noqa: E402
    _PREFIX_PATTERNS,
    _extract_literal_prefix,
    _PATTERN_REJECT_RULES,
    redact_sensitive_text,
)
from tools.delegation_live_log import LiveTranscriptWriter  # noqa: E402

SYNTH = "pcp_" + "0123456789abcdef" * 3  # pcp_ + 48 hex, len 52 — synthetic
FAMILIES = ["pcp_board", "pcp_cli_auth", "pcp_invite", "pcp_claim", "pcp_bootstrap"]
MASK_MARKERS = ("***", "…", "...")  # mask_secret() sentinel or head...tail mask
# Invite tokens are base64url(32 bytes) = 43 chars of [A-Za-z0-9_-]; the body
# can carry ``-``/``_`` anywhere. Fixed synthetic fixtures: one with -/_ inside
# the first 20 body chars, one with the separators late in the token.
INVITE_B64_EARLY = "pcp_invite_AbCdEf-_gh9xKlMnOp1234567890abcdefghi-QRStU"
INVITE_B64_LATE = "pcp_invite_Lg75g7qIesobkFR6uHNO7dyjL4GFZ4zLiie29lkZ-3E"
# The registered pattern set, spelled out so the gate checks the exact bodies:
# invite alone gets the [A-Za-z0-9_-] class; every other family stays hex-only.
PATTERNS = [
    r"pcp_[A-Za-z0-9]{20,}",
    r"pcp_board_[A-Za-z0-9]{20,}",
    r"pcp_cli_auth_[A-Za-z0-9]{20,}",
    r"pcp_invite_[A-Za-z0-9_-]{20,}",
    r"pcp_bootstrap_[A-Za-z0-9]{20,}",
    r"pcp_claim_[A-Za-z0-9]{20,}",
]

failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if not ok:
        failures.append(f"{name}: {detail}")
        print(f"FAIL {name}: {detail}")
    else:
        print(f"ok   {name}")


def masked(value: str, out: str) -> bool:
    return value not in out and any(m in out for m in MASK_MARKERS)


# --- pattern-engine gate: the family passes upstream's own reject rules ---
for pattern in PATTERNS:
    rejected = [msg for reject, msg in _PATTERN_REJECT_RULES if reject(pattern)]
    check(f"gate accepts {pattern}", not rejected, "; ".join(r % pattern for r in rejected))
    check(f"literal prefix >= 2 for {pattern}", len(_extract_literal_prefix(pattern)) >= 2)
for pattern in PATTERNS:
    check(f"registered in _PREFIX_PATTERNS: {pattern}", pattern in _PREFIX_PATTERNS,
          str([p for p in _PREFIX_PATTERNS if p.startswith('pcp_')][:7]))

# --- 1. redact_sensitive_text(force=True) masks the synthetic key ---
for ctx in (f"echo done: {SYNTH}",
            f"board key {SYNTH} leaked",
            f"Authorization: Bearer {SYNTH}",
            f'{{"token": "{SYNTH}"}}'):
    out = redact_sensitive_text(ctx, force=True)
    check(f"masked in prose/header/repr: {ctx[:28]!r}", masked(SYNTH, out), repr(out))
for family in FAMILIES:
    key = f"{family}_" + "0123456789abcdef" * 3
    out = redact_sensitive_text(f"plain prose {key} tail", force=True)
    check(f"family masked bare: {family}", masked(key, out), repr(out))
# base64url invite bodies: the [A-Za-z0-9] class alone does NOT match a token
# whose first 20 body chars contain ``-``/``_`` (the compiled matcher's trailing
# lookahead forbids ending the run before a separator), so these two fixtures
# are the real regression for the invite-family body class.
for tok in (INVITE_B64_EARLY, INVITE_B64_LATE):
    for ctx in (f"link: {tok}", f"{tok}", f'{{"invite": "{tok}"}}'):
        out = redact_sensitive_text(ctx, force=True)
        check(f"base64url invite masked: {ctx[:34]!r}", masked(tok, out), repr(out))

# --- RED control for "green because nothing was recorded" ---
# The redaction pass reads the module-level _PREFIX_RE at call time, so compiling
# it from the same list WITHOUT the pcp_ family simulates the unpatched engine
# exactly: the same prose line must leak there and must mask in the real one.
# That binds the assertions above to the records the patch actually made.
import agent.redact as _r_mod
from agent.redact import _compile_prefix_matcher  # noqa: E402

check("the pcp_ family is registered in _PREFIX_PATTERNS",
      any(p.startswith("pcp_") for p in _PREFIX_PATTERNS),
      str([p for p in _PREFIX_PATTERNS if p.startswith("pcp_")]))

_line = f"plain prose {SYNTH} tail"
_real_re = _r_mod._PREFIX_RE
try:
    _r_mod._PREFIX_RE = _compile_prefix_matcher(
        [p for p in _PREFIX_PATTERNS if not p.startswith("pcp_")])
    check("RED control: without the pcp_ patterns the key leaks",
          SYNTH in _r_mod.redact_sensitive_text(_line, force=True),
          "another pass masked it — the binding below proves nothing")
finally:
    _r_mod._PREFIX_RE = _real_re
check("control line is masked by the patched engine",
      masked(SYNTH, _r_mod.redact_sensitive_text(_line, force=True)))

# --- RED controls for the invite body class and the bootstrap family ---
# (a) the pre-fix invite pattern (alphanumeric body only) must NOT mask a
# base64url token with separators in the first 20 body chars — this pins the
# reason the body class is [A-Za-z0-9_-].
_r_pre = _compile_prefix_matcher(
    [p for p in _PREFIX_PATTERNS if not p.startswith("pcp_invite_")]
    + [r"pcp_invite_[A-Za-z0-9]{20,}"])
_real_re2 = _r_mod._PREFIX_RE
try:
    _r_mod._PREFIX_RE = _r_pre
    _b64 = f"link: {INVITE_B64_EARLY}"
    check("RED control: alphanumeric-only invite body leaks the base64url token",
          INVITE_B64_EARLY in _r_mod.redact_sensitive_text(_b64, force=True),
          "something else masked it — the binding below proves nothing")
finally:
    _r_mod._PREFIX_RE = _real_re2
check("fixed invite pattern masks the same token",
      masked(INVITE_B64_EARLY,
             _r_mod.redact_sensitive_text(_b64, force=True)))

# (b) without the pcp_bootstrap_ pattern the bootstrap key must leak even with
# the short form registered — pins that the short form cannot span the
# family-name underscore.
BOOTSTRAP = "pcp_bootstrap_" + "0123456789abcdef" * 3
_r_nob = _compile_prefix_matcher(
    [p for p in _PREFIX_PATTERNS if not p.startswith("pcp_bootstrap_")])
try:
    _r_mod._PREFIX_RE = _r_nob
    _b2 = f"bootstrap invite key {BOOTSTRAP} issued"
    check("RED control: without pcp_bootstrap_ the bootstrap key leaks",
          BOOTSTRAP in _r_mod.redact_sensitive_text(_b2, force=True),
          "another pass masked it — the short form does not cover this family")
finally:
    _r_mod._PREFIX_RE = _real_re2
check("bootstrap key masked by the patched engine",
      masked(BOOTSTRAP, _r_mod.redact_sensitive_text(_b2, force=True)))

# --- 2. LiveTranscriptWriter path: task-N.log carries markers, never the value ---
root = Path(tempfile.mkdtemp(prefix="patch-test-"))
os.umask(0o022)  # the world-readable default that made the leak visible
writer = LiveTranscriptWriter("deleg-redact-test", 0, goal=f"goal {SYNTH}", root=root)
log_path = root / "deleg-redact-test" / "task-0.log"
check("task-0.log was created", log_path.exists(), str(log_path))
writer.tool_result("terminal", f"leaked: {SYNTH}")
writer.event("assistant", f"the key is {SYNTH}")
writer.event("assistant", f"invite url {INVITE_B64_EARLY} sent")
writer.tool_result("terminal", f"bootstrap key {BOOTSTRAP}")
body = log_path.read_text(encoding="utf-8")
check("carrier lines present (log not empty/skipped)",
      "leaked:" in body and "the key is" in body
      and "invite url" in body and "bootstrap key" in body, repr(body[:120]))
check("synthetic value absent from the log", SYNTH not in body)
check("base64url invite value absent from the log", INVITE_B64_EARLY not in body)
check("bootstrap key value absent from the log", BOOTSTRAP not in body)
check("mask marker present in the log",
      any(m in body for m in MASK_MARKERS), repr(body[:120]))

# --- 4. the transcript is owner-only from creation ---
mode = stat.S_IMODE(log_path.stat().st_mode)
check("task-0.log mode is 600", oct(mode) == "0o600", oct(mode))
writer.marker("final")
check("mode stays 600 after appends",
      oct(stat.S_IMODE(log_path.stat().st_mode)) == "0o600")

# --- 3. regressions: unrelated text keeps upstream behaviour ---
plain = "normal prose, path /opt/hermes-src/tools/x.py, commit c0ffee123456"
check("plain text and paths/sha12 untouched",
      redact_sensitive_text(plain, force=True) == plain,
      repr(redact_sensitive_text(plain, force=True)))
sk_key = "sk-" + "Ab3dEf6gHi9jKl2mNp4qRs7tUv0wXy"
check("sk- family still masked", masked(sk_key, redact_sensitive_text(f"key {sk_key}", force=True)))
ghp = "ghp_" + "A" * 36
check("ghp_ family still masked", masked(ghp, redact_sensitive_text(f"token {ghp}", force=True)))
near_misses = ("pcp_short123",                 # under the 20-char floor
               "config key pcp_board_profile_list enabled",  # prose with a family prefix
               "pcp_board_api_key_names")      # env-name-shaped, no secret body
for text in near_misses:
    check(f"near-miss unchanged: {text[:32]}",
          redact_sensitive_text(text, force=True) == text,
          repr(redact_sensitive_text(text, force=True)))

if failures:
    print(f"\n{len(failures)} FAILURE(S):")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("\ndelegation live-log pcp redaction + 0600 mode: all checks pass")
