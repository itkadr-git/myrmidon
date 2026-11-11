# myrmidon(OPE-12719): build-time regression for 34-skill-view-managed-name.patch.
# Board-managed skills materialize at <skills>/paperclip-managed/<slug>--<hash>/SKILL.md
# (14-run-scoped-paperclip-skills.patch) while the skills index renders the entry as
# "paperclip-managed:<slug>" (category = first path segment, name = frontmatter `name:`),
# so agents called skill_view with the index name and every call failed with
# "Skill '...' not found". The patch adds a zero-candidate fallback that accepts the
# qualified alias; this proves: the alias resolves to the hashed directory, exact bare
# names still resolve, an unknown namespace still fails, two same-slug board skills from
# different keys refuse as ambiguous, and the skills index is unchanged.

import json
import os
import sys
import tempfile

HOME = tempfile.mkdtemp(prefix="skill-view-")
os.environ["HERMES_HOME"] = HOME
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.skills_tool import _skills_dir, skill_view, skills_list

MANAGED = _skills_dir() / "paperclip-managed"
MANAGED.mkdir(parents=True)


def install(segment, frontmatter_name):
    (MANAGED / segment).mkdir(parents=True)
    (MANAGED / segment / "SKILL.md").write_text(
        f"---\nname: {frontmatter_name}\ndescription: {frontmatter_name} description\n---\nbody",
        encoding="utf-8")


def check(cond, msg):
    if not cond:
        print("FAIL:", msg)
        sys.exit(1)


def payload(name):
    return json.loads(skill_view(name))

# 1. The production shape: hashed directory + bare frontmatter name; the direct
#    materialized path resolves, then the index name resolves through the fallback.
install("dev-worktree-disk--3492fcbe65", "dev-worktree-disk")
result = payload("paperclip-managed/dev-worktree-disk--3492fcbe65")
check(result.get("success") is True, "direct hashed path resolves")
result = payload("paperclip-managed:dev-worktree-disk")
check(result.get("success") is True, "qualified alias resolves")
check(result.get("name") == "dev-worktree-disk", f"resolved name, got {result.get('name')!r}")

# 2. Bare name keeps resolving through the ordinary recursive scan (no regression).
result = payload("dev-worktree-disk")
check(result.get("success") is True, "bare name still resolves")
check(result.get("name") == "dev-worktree-disk", "bare name resolves to same skill")


# 4. An unknown namespace still fails with not found (no wildcard aliasing).
result = payload("no-such-ns:dev-worktree-disk")
check(result.get("success") is False, "unknown namespace fails")
check("not found" in result.get("error", ""), f"error is not-found, got {result.get('error')!r}")

# 5. Two board skills with the same slug from different keys: both install as
#    paperclip-managed/<slug>--<different-hash>/ with identical frontmatter names;
#    the alias must refuse as ambiguous instead of silently picking one.
install("doc-maintenance--5566778899", "doc-maintenance")
install("doc-maintenance--aabbccdd00", "doc-maintenance")
result = payload("paperclip-managed:doc-maintenance")
check(result.get("success") is False, "same-slug collision refuses")
check("Ambiguous skill name" in result.get("error", ""),
      f"collision is ambiguous, got {result.get('error')!r}")

# 6. skills_list output shape is unchanged: the entry still renders as the bare
#    frontmatter name under the paperclip-managed category (no index change).
listing = json.loads(skills_list())
names = {s["name"] for s in listing.get("skills", [])}
check("dev-worktree-disk" in names, "frontmatter name listed")
categories = {s.get("category") for s in listing.get("skills", [])}
check("paperclip-managed" in categories, "managed category listed")
print("skill_view_managed_name: ok")
