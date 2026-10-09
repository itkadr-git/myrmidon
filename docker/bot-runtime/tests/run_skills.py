# myrmidon(G1): build-time regression for 13-run-scoped-paperclip-skills.patch
# (1.6.5-HERMES-SKILLS-A). The board's hermes_gateway adapter ships the run's
# Paperclip-managed skills as the ``paperclip_skills`` body field. This proves
# the receiving half: entries land only under this profile's paperclip-managed
# segment, a path that would escape it is never written (and fails the run
# through verify), an empty list clears only the managed segment (unassign),
# a malformed field is refused at the door, verify re-reads the disk instead of
# trusting the in-memory map, colliding names fail loudly, and the per-run
# env bridge sets/strips MYRMIDON_RUN_SKILLS_DIR without touching os.environ.

import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

import tools.skills_tool as skills_tool
from tools.environments.local import _inject_session_context_env
from tools.run_skills import (
    materialize_run_skills,
    reset_run_skills_dir,
    run_skills_env,
    run_skills_env_name,
    set_run_skills_dir,
    validate_paperclip_skills_field,
    verify_run_skills,
)


def entry(path, name=None, content=None):
    return {"path": path, "name": name or path, "content": content or f"---\nname: {name or path}\n---\nbody of {path}\n"}


def main():
    tmp = Path(tempfile.mkdtemp(prefix="run-skills-"))
    skills_root = tmp / "profile" / "skills"
    skills_root.mkdir(parents=True)
    managed = skills_root / "paperclip-managed"
    skills_tool._skills_dir = lambda: skills_root
    try:
        # Happy path: both entries land, verify passes.
        entries = [entry("alpha--ab12"), entry("beta--cd34")]
        written = materialize_run_skills(entries)
        assert written == {"alpha--ab12": "alpha--ab12", "beta--cd34": "beta--cd34"}, written
        assert (managed / "alpha--ab12" / "SKILL.md").read_text(encoding="utf-8") == entries[0]["content"]
        assert verify_run_skills(entries, written) is None

        # Sibling content outside the managed segment (the user's own skills)
        # and an unlisted managed directory: only the latter is removed.
        own = skills_root / "my-own-skill"
        own.mkdir()
        (own / "SKILL.md").write_text("mine", encoding="utf-8")
        written = materialize_run_skills([entry("alpha--ab12")])
        assert not (managed / "beta--cd34").exists(), "stale managed entry must be removed"
        assert (managed / "alpha--ab12" / "SKILL.md").exists()
        assert (own / "SKILL.md").read_text(encoding="utf-8") == "mine"

        # Unassign: the empty list clears the managed segment, nothing else.
        written = materialize_run_skills([])
        assert written == {}
        assert verify_run_skills([], written) is None
        assert not any(managed.iterdir()), list(managed.iterdir())
        assert (own / "SKILL.md").read_text(encoding="utf-8") == "mine"

        # Path escape: never written, verify names the skill so the run fails.
        sentinel = tmp / "profile" / "escaped"
        for bad in ("..", "../escaped", "a/../../escaped", "/etc/evil", "", "  ", "a b", "x\\..\\y", "a//b", "a/", ".", None, 7):
            bad_entries = [entry("ok-one"), {"path": bad, "name": "evil", "content": "x"}]
            written = materialize_run_skills(bad_entries)
            assert "evil" not in written, (bad, written)
            assert verify_run_skills(bad_entries, written) == "evil", bad
            assert not sentinel.exists(), f"path {bad!r} escaped the managed root"
            assert sorted(p.name for p in managed.iterdir()) == ["ok-one"], (bad, list(managed.iterdir()))
        assert not (tmp / "profile" / "SKILL.md").exists()
        assert (own / "SKILL.md").exists()

        # Invalid name/content: skipped, verify fails on it.
        for bad_entry in ({"path": "p1", "name": "", "content": "x"},
                          {"path": "p1", "name": "n1", "content": ""},
                          {"path": "p1", "name": "n1", "content": "x" * (512 * 1024 + 1)}):
            written = materialize_run_skills([bad_entry])
            assert verify_run_skills([bad_entry], written) is not None, bad_entry

        # Verify re-reads the disk: a file that vanishes or changes after the
        # write is a failure, even though the in-memory map still has it.
        entries = [entry("gamma--ef56")]
        written = materialize_run_skills(entries)
        assert verify_run_skills(entries, written) is None
        (managed / "gamma--ef56" / "SKILL.md").write_text("tampered", encoding="utf-8")
        assert verify_run_skills(entries, written) == "gamma--ef56"
        (managed / "gamma--ef56" / "SKILL.md").unlink()
        assert verify_run_skills(entries, written) == "gamma--ef56"

        # Collisions: same name or same path twice - the second would overwrite
        # the first, so verify refuses.
        same_name = [entry("dir-a", name="dup"), entry("dir-b", name="dup")]
        written = materialize_run_skills(same_name)
        assert verify_run_skills(same_name, written) == "dup"
        same_path = [entry("dir-c", name="one"), entry("dir-c", name="two")]
        written = materialize_run_skills(same_path)
        assert verify_run_skills(same_path, written) in ("one", "two")

        # Door validation (HTTP 400 family): a list of objects, within the cap.
        assert validate_paperclip_skills_field([]) == []
        good = [entry("alpha")]
        assert validate_paperclip_skills_field(good) is good
        for bad_field in ("alpha", {"path": "a"}, 5, True, [1], ["alpha"], [entry("a"), None],
                          [entry(f"s{i}") for i in range(201)]):
            try:
                validate_paperclip_skills_field(bad_field)
                raise AssertionError(f"accepted malformed field: {bad_field!r}")
            except ValueError:
                pass

        # Per-run env bridge: set/strip, never os.environ.
        assert run_skills_env() == {}
        env = {"FOO": "1", run_skills_env_name(): "stale"}
        _inject_session_context_env(env)
        assert run_skills_env_name() not in env, "unbound run must strip an inherited value"
        token = set_run_skills_dir(str(managed))
        try:
            assert run_skills_env() == {"MYRMIDON_RUN_SKILLS_DIR": str(managed)}
            env = {"FOO": "1", "MYRMIDON_RUN_SKILLS_DIR": "stale"}
            _inject_session_context_env(env)
            assert env["MYRMIDON_RUN_SKILLS_DIR"] == str(managed)
            assert "MYRMIDON_RUN_SKILLS_DIR" not in os.environ
        finally:
            reset_run_skills_dir(token)
        assert run_skills_env() == {}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("run-skills regression: ok")


if __name__ == "__main__":
    main()
