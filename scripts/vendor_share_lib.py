"""Library for scripts/vendor-share.py (AUDIT-PHASE-1 vendor-derived share).

Reuses the merged vendor-share metric (scripts/myrmidon/vendor-share.mjs) as
the classifier of record through its JSON output, so the Python side only
aggregates: one definition of "vendor-derived" in the repository.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

VENDOR_SHARE_MJS = os.path.join("scripts", "myrmidon", "vendor-share.mjs")


class VendorShareError(RuntimeError):
    """A repository/base problem the caller should see as a clean CLI error."""


class Threshold(NamedTuple):
    value: float
    source: str


class Base(NamedTuple):
    sha: str
    source: str


def resolve_threshold(flag_value: Optional[str], env_name: str, default: float) -> Threshold:
    if flag_value is not None and flag_value != "":
        try:
            value = float(flag_value)
        except ValueError:
            raise VendorShareError("threshold must be a number between 0 and 1, got %r" % flag_value)
        if not 0.0 <= value <= 1.0:
            raise VendorShareError("threshold must be a number between 0 and 1, got %r" % flag_value)
        return Threshold(value, "flag")
    env = os.environ.get(env_name, "")
    if env != "":
        try:
            value = float(env)
        except ValueError:
            raise VendorShareError("%s must be a number between 0 and 1, got %r" % (env_name, env))
        if not 0.0 <= value <= 1.0:
            raise VendorShareError("%s must be a number between 0 and 1, got %r" % (env_name, env))
        return Threshold(value, "env")
    return Threshold(default, "default")


def resolve_repo(repo_arg: str) -> str:
    repo = os.path.abspath(repo_arg)
    mjs = os.path.join(repo, VENDOR_SHARE_MJS)
    if not os.path.isfile(mjs):
        raise VendorShareError("not a repository with the metric: %s is missing" % VENDOR_SHARE_MJS)
    return repo


def resolve_base(repo: str, base_arg: Optional[str], base_file: str) -> Base:
    if base_arg:
        return Base(base_arg, "option")
    path = os.path.join(repo, base_file)
    if not os.path.isfile(path):
        raise VendorShareError(
            "vendor base file not found: %s (pass --base <sha>)" % base_file
        )
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            token = line.strip()
            if re.fullmatch(r"[0-9a-f]{7,40}", token):
                return Base(token, base_file)
    raise VendorShareError("no commit sha found in %s" % base_file)


def _run(repo: str, args: Sequence[str], input_text: Optional[str] = None) -> str:
    result = subprocess.run(
        ["git", "-C", repo, *args],
        input=input_text,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise VendorShareError("git %s failed: %s" % (" ".join(args), result.stderr.strip()))
    return result.stdout


def collect_verdicts(repo: str, base: Base, threshold: float) -> List[Dict[str, Any]]:
    """Run the metric of record and return its per-file verdicts.

    The metric excludes lock files, build output, generated files and its own
    bookkeeping, and classifies every remaining tracked file as inherited
    (vendor-derived), modified, new or binary.
    """
    # A bind-mounted or symlinked checkout (the norm in bot workspaces) makes
    # `path.resolve(process.argv[1])` differ from `import.meta.url`, which is
    # the metric's direct-invocation guard: resolve to the physical path.
    script = os.path.realpath(os.path.join(repo, VENDOR_SHARE_MJS))
    try:
        proc = subprocess.run(
            ["node", script, "--repo", repo, "--base", base.sha, "--threshold", repr(threshold), "--json"],
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise VendorShareError("cannot run node: %s" % exc)
    if proc.returncode != 0:
        raise VendorShareError("vendor-share.mjs failed: %s" % proc.stderr.strip())
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise VendorShareError("vendor-share.mjs printed invalid JSON: %s" % exc)
    verdicts = []
    # Measurement bookkeeping is not product code: the audit wrapper itself,
    # its library, and the metric of record with its release-notes builder.
    # Once merged they would sit in every future base commit and silently
    # shift the share (OPE-12084); the metric of record excludes its own
    # bookkeeping (vendor-base.txt, DIVERGENCE.md) the same way.
    self_paths = {
        os.path.join("scripts", "vendor-share.py"),
        os.path.join("scripts", "vendor_share_lib.py"),
        os.path.join("scripts", "myrmidon", "vendor-share.mjs"),
        os.path.join("scripts", "myrmidon", "release", "vendor-share-notes.mjs"),
    }
    for entry in report.get("files", []):
        if entry["kind"] == "excluded" or entry["path"] in self_paths:
            # Lock files, build output and the metric's own bookkeeping stay
            # outside the measurement, exactly as in the metric of record.
            continue
        verdicts.append(
            {
                "path": entry["path"],
                "vendor_derived": entry["kind"] == "inherited",
                "kind": entry["kind"],
                "similarity": entry.get("similarity"),
            }
        )
    return verdicts


def aggregate(
    verdicts: Sequence[Dict[str, Any]], rules: Sequence[Any]
) -> Any:
    """Sum per-file verdicts into audit components and an overall bucket.

    A file lands in the first component whose pattern matches. Everything else
    goes to `other`. Empty components stay present with zero counters (the
    acceptance requires the script not to break on empty subdirectories).
    """
    compiled = [(name, [re.compile(p) for p in patterns]) for name, patterns in rules]
    order: List[str] = [name for name, _ in compiled]
    order.append("other")
    buckets: Dict[str, Dict[str, int]] = {
        name: {"total": 0, "vendor_derived": 0, "unmodified_vendor": 0} for name in order
    }
    for entry in verdicts:
        component = "other"
        for name, patterns in compiled:
            if any(p.search(entry["path"]) for p in patterns):
                component = name
                break
        bucket = buckets[component]
        bucket["total"] += 1
        if entry["vendor_derived"]:
            bucket["vendor_derived"] += 1
            if entry["kind"] == "inherited" and entry.get("similarity") == 1:
                bucket["unmodified_vendor"] += 1
    overall = {
        "total": sum(b["total"] for b in buckets.values()),
        "vendor_derived": sum(b["vendor_derived"] for b in buckets.values()),
        "unmodified_vendor": sum(b["unmodified_vendor"] for b in buckets.values()),
    }
    return buckets, overall
