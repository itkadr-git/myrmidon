#!/usr/bin/env python3
"""AUDIT-PHASE-1 (1.7): vendor-derived file share per product component.

Roadmap-v1 §3.3 / NEW AUDIT-PHASE-1 / VENDOR-SHARE-METRIC. Read-only
measurement over a repository checkout: a file counts as vendor-derived when
its path existed in the vendor base commit (git renames are followed through
`git diff -M`) and its line similarity against the base version is at or above
the threshold (default 0.5). The classification itself is delegated to the
merged metric `scripts/myrmidon/vendor-share.mjs`; this script aggregates its
per-file verdicts into the product components named by the audit: server, ui,
mcp, worker, fleet, plus `other` for everything outside them.

Acceptance (OPE-12084): the script prints JSON with `overall_percent` and
`by_component`, exits 0, and works on empty subdirectories. Pure stdlib.

Usage:
    python3 scripts/vendor-share.py [--repo <dir>] [--base <sha>]
        [--threshold <0..1>] [--json|--compact] [--help]

Environment:
    MYRMIDON_VENDOR_SHARE_THRESHOLD  fallback threshold (the flag wins)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

if __package__:
    from . import vendor_share_lib
else:  # script run from anywhere: import the sibling module by path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import vendor_share_lib  # noqa: E402

DEFAULT_THRESHOLD = 0.5
THRESHOLD_ENV = "MYRMIDON_VENDOR_SHARE_THRESHOLD"

# AUDIT-PHASE-1 component map (order is the output order of --compact).
# Patterns are start-anchored (`^...`): `server/` must not swallow
# `packages/mcp-server/...` by substring. Longest/most specific first.
COMPONENT_RULES: List[Any] = [
    ("server", (r"^server/",)),
    ("ui", (r"^ui/",)),
    (
        "mcp",
        (
            r"^packages/mcp-server/",
            r"^packages/google-sheets-mcp-server/",
            r"^packages/kv-demo-mcp-server/",
            r"^packages/tailscale-https-broker/",
            r"^tools/image-mcp/",
            r"^tools/media-mcp/",
            r"^tools/document-parser/",
        ),
    ),
    ("worker", (r"^packages/paperclip-runner/",)),
    (
        "fleet",
        (
            r"^tools/fleetd/",
            r"^docker/fleetd/",
            r"^docker/dockergate/",
            r"^tools/dockergate/",
            r"^packages/agents-fleet/",
            r"^packages/fleetd-protocol/",
            r"^packages/ws-protocol/",
            r"^packages/ws-shared/",
        ),
    ),
]

DEFAULT_BASE_FILE = "scripts/myrmidon/vendor-base.txt"


def _rules() -> List[Any]:
    """Component rules with env overrides folded in (MYRMIDON_VENDOR_SHARE_COMPONENTS)."""
    overrides = os.environ.get("MYRMIDON_VENDOR_SHARE_COMPONENTS", "").strip()
    if not overrides:
        return COMPONENT_RULES
    extra: List[Any] = []
    for chunk in overrides.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, sep, pattern = chunk.partition("=")
        if not sep or not name or not pattern:
            raise SystemExit(
                "MYRMIDON_VENDOR_SHARE_COMPONENTS: expected comma-separated "
                "name=regex pairs, got %r" % chunk
            )
        try:
            re.compile(pattern)
        except re.error as exc:
            raise SystemExit(
                "MYRMIDON_VENDOR_SHARE_COMPONENTS: bad regex %r: %s" % (pattern, exc)
            )
        extra.append((name, (pattern,)))
    return list(COMPONENT_RULES) + extra


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="scripts/vendor-share.py",
        description="Vendor-derived file share per product component (AUDIT-PHASE-1).",
    )
    parser.add_argument("--repo", default=".", help="repository checkout (default: cwd)")
    parser.add_argument("--base", default=None, help="vendor base commit (default: scripts/myrmidon/vendor-base.txt)")
    parser.add_argument("--threshold", default=None, help="similarity threshold 0..1 (default: 0.5)")
    parser.add_argument(
        "--compact",
        action="store_true",
        help="print only overall_percent and by_component (stable acceptance view)",
    )
    args = parser.parse_args(argv)

    threshold = vendor_share_lib.resolve_threshold(args.threshold, THRESHOLD_ENV, DEFAULT_THRESHOLD)

    repo = vendor_share_lib.resolve_repo(args.repo)
    base = vendor_share_lib.resolve_base(repo, args.base, DEFAULT_BASE_FILE)

    verdicts = vendor_share_lib.collect_verdicts(repo, base, threshold.value)
    by_component, overall = vendor_share_lib.aggregate(verdicts, _rules())

    overall_percent = round(overall["vendor_derived"] * 100.0 / overall["total"], 4) if overall["total"] else 0.0
    payload: Dict[str, Any] = {
        "schema": 1,
        "repo": repo,
        "base_commit": base.sha,
        "base_source": base.source,
        "threshold": threshold.value,
        "threshold_source": threshold.source,
        "total_files": overall["total"],
        "vendor_derived_files": overall["vendor_derived"],
        "unmodified_vendor_files": overall["unmodified_vendor"],
        "overall_percent": overall_percent,
        "by_component": {
            name: {
                "total": bucket["total"],
                "vendor_derived": bucket["vendor_derived"],
                "percent": round(bucket["vendor_derived"] * 100.0 / bucket["total"], 4) if bucket["total"] else 0.0,
            }
            for name, bucket in by_component.items()
        },
    }
    if not args.compact:
        payload["files"] = verdicts

    json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except vendor_share_lib.VendorShareError as error:
        print("vendor-share: %s" % error, file=sys.stderr)
        sys.exit(1)
