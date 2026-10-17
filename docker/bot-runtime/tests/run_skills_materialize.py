# myrmidon(1.6.6-HERMES-SKILLS-A): build-time regression for
# 14-run-scoped-paperclip-skills.patch. The import smoke proves the patched
# modules import; this proves the behaviour the board depends on: every
# {path, name, content} entry of the run body's paperclip_skills lands at
# <profile skills root>/paperclip-managed/<path>/SKILL.md (hashed runtime names
# `slug--hash` and the ~60 KB operational skill included), stale managed
# entries are removed and nothing outside the segment is touched, an entry the
# guards skip is reported as missing WITH its reason (the rc.1 incident: the
# board serialized content as a Node Buffer object and the only symptom was a
# bare "not materialized").

import os
import sys
import tempfile

HOME = tempfile.mkdtemp(prefix="run-skills-")
os.environ["HERMES_HOME"] = HOME
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.run_skills import materialize_run_skills, skip_reason, verify_run_skills
from tools.skills_tool import _skills_dir

ROOT = _skills_dir() / "paperclip-managed"
BIG = "---\nname: paperclip\n---\n" + ("Lorem ipsum dolor. " * 3100)  # ~59 KB like skills/paperclip/SKILL.md


def entry(path, content, name=None):
    return {"path": path, "name": name or path, "content": content}


def check(cond, msg):
    if not cond:
        print("FAIL:", msg)
        sys.exit(1)


# 1. normal delivery: operational skill + hashed runtime names
entries = [
    entry("paperclip", BIG),
    entry("external-calls--a1b2c3d4e5", "---\nname: ec\n---\nbody"),
    entry("doc-maintenance--5566778899", "---\nname: dm\n---\nbody"),
]
written = materialize_run_skills(entries)
check(verify_run_skills(entries, written) is None, "all entries verified")
check((ROOT / "paperclip" / "SKILL.md").read_text(encoding="utf-8") == BIG, "paperclip content intact")
check((ROOT / "external-calls--a1b2c3d4e5" / "SKILL.md").is_file(), "hashed name materialized")

# 2. a file outside the managed segment survives; a stale managed entry is removed
foreign = _skills_dir() / "user-own-skill"
foreign.mkdir(parents=True)
(foreign / "SKILL.md").write_text("mine", encoding="utf-8")
written = materialize_run_skills([entry("paperclip", BIG)])
check(verify_run_skills([entry("paperclip", BIG)], written) is None, "second run verified")
check(not (ROOT / "external-calls--a1b2c3d4e5").exists(), "stale managed entry removed")
check((foreign / "SKILL.md").read_text() == "mine", "foreign skill untouched")

# 3. board sent content as a serialized Node Buffer (the rc.1 bug): reported with the reason
bad = [entry("paperclip", {"type": "Buffer", "data": [45, 45, 45]})]
written = materialize_run_skills(bad)
check(verify_run_skills(bad, written) == "paperclip", "Buffer-shaped content is reported missing")
reason = skip_reason(bad, "paperclip")
check("dict" in reason, f"reason names the type, got {reason!r}")

# 4. other guards name themselves
for e, needle in (
    (entry("../x", "c", name="esc"), "path"),
    (entry("ok", "   ", name="blank"), "empty"),
    (entry("ok", "x" * (512 * 1024 + 1), name="huge"), "exceeds"),
):
    w = materialize_run_skills([e])
    check(verify_run_skills([e], w) == e["name"], f"{e['name']} reported missing")
    check(needle in skip_reason([e], e["name"]), f"{e['name']} reason mentions {needle}")

# 5. an empty list is the unassign path: the managed segment is cleared
materialize_run_skills([])
check(not any(ROOT.iterdir()), "managed segment cleared by an empty list")

# 6. the failure message carries the reason (wiring in api_server_runs)
src = open(os.path.join(sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src", "gateway/platforms/api_server_runs.py")).read()
check("skip_reason(run.paperclip_skills, missing)" in src, "run failure message uses skip_reason")
print("run_skills_materialize: ok")
