"""Behavior check for registered workspaces using local Git fixtures only."""
from io import StringIO
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from tools import run_workspace as ws

company = "11111111-1111-4111-8111-111111111111"
issue = "22222222-2222-4222-8222-222222222222"
bot = "33333333-3333-4333-8333-333333333333"


def rejects_operation(operation, message=None):
    try:
        operation()
    except (ValueError, OSError) as exc:
        if message is not None:
            assert message in str(exc), str(exc)
        return
    raise AssertionError("invalid offline workspace accepted")


def rejects(field):
    rejects_operation(lambda: ws.open_task_workspace(field))


def git(cwd, *args):
    subprocess.run(["/usr/bin/git", "-C", str(cwd), *args], check=True, capture_output=True,
                   env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})


with TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    cwd = home / "offline-workspaces" / company / issue
    cwd.mkdir(parents=True, mode=0o700)
    (cwd / ".git").mkdir()
    (cwd / ".git/objects").mkdir()
    (cwd / ".git/HEAD").write_text("ref: refs/heads/main\n")
    device = home.stat().st_dev
    mount_identity = [f"{os.major(device)}:{os.minor(device)}", "/fixture", "xfs", "/dev/bots"]
    with patch.object(ws, "_offline_volume", return_value=(home, ["mount", mount_identity, []])), \
         patch.dict(os.environ, {"MYRMIDON_BOT_KEY": bot}), \
         patch.object(ws, "_myr_ws_bin", side_effect=AssertionError("must not open a managed checkout")):
        try:
            ws.offline_workspace_identity(company, issue)
        except ValueError:
            pass
        else:
            raise AssertionError("registration attested an unborn HEAD")
        git(cwd, "init", "--quiet")
        (cwd / "tracked.txt").write_text("offline checkout\n")
        git(cwd, "add", "tracked.txt")
        git(cwd, "-c", "user.name=Offline test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture")
        fingerprint = ws.offline_workspace_fingerprint(company, issue)
        field = {"offlineCompanyId": company, "offlineIssueId": issue, "offlineBotId": bot,
                 "offlineFingerprint": fingerprint, "offlineCwd": str(cwd),
                 "offlineWorkspaceId": "44444444-4444-4444-8444-444444444444"}
        for _ in range(2):
            assert ws.open_task_workspace(field)["path"] == str(cwd)
        rejects({**field, "offlineBotId": company})
        rejects({**field, "offlineIssueId": company})
        rejects({**field, "offlineCwd": str(cwd.parent)})
        with patch.object(ws, "_offline_volume", return_value=(home, ["mount", [mount_identity[0], "/other", *mount_identity[2:]], []])):
            rejects(field)
        with patch.object(ws, "_offline_volume", return_value=(home, ["mount", mount_identity, [str(cwd)]])):
            rejects(field)
        different_uid = os.geteuid() + 1
        with patch.object(ws.os, "geteuid", return_value=different_uid):
            rejects(field)
        cwd.chmod(0o755)
        rejects(field)
        cwd.chmod(0o700)
        (cwd / ".git/objects/info").mkdir(exist_ok=True)
        (cwd / ".git/objects/info/alternates").write_text("/other/objects\n")
        rejects(field)
        (cwd / ".git/objects/info/alternates").unlink()
        git(cwd, "config", "core.bare", "true")
        rejects(field)
        git(cwd, "config", "core.bare", "false")
        git(cwd, "config", "core.worktree", str(cwd.parent))
        rejects(field)
        git(cwd, "config", "--unset", "core.worktree")
        replacement = cwd.with_name("replacement")
        cwd.rename(replacement)
        cwd.symlink_to(replacement, target_is_directory=True)
        rejects(field)
        cwd.unlink()
        cwd.mkdir(mode=0o700)
        rejects(field)


# Exercise the real mountinfo parser. A same-device mount must be rejected too.
for layout in ("dedicated", "scope", "legacy"):
    with TemporaryDirectory() as tmp:
        root = Path(tmp).resolve() / "managed volume"
        relative_homes = {"dedicated": Path("hermes"), "scope": Path(bot) / "hermes", "legacy": Path(".")}
        home = root / relative_homes[layout]
        home.mkdir(parents=True, exist_ok=True)
        cwd = ws.offline_workspace_path(home, company, issue)
        device = root.stat().st_dev
        dev = f"{os.major(device)}:{os.minor(device)}"

        def mount(mid, parent, source_root, target):
            target = str(target).replace(" ", r"\040")
            return f"{mid} {parent} {dev} {source_root} {target} rw - xfs /dev/bots rw\n"

        root_mount = mount(10, 1, "/bots", root)
        with patch.object(ws, "_offline_home_and_root", return_value=(home, str(root))), \
             patch.dict(os.environ, {"MYRMIDON_BOT_KEY": bot}), \
             patch.object(ws, "_myr_ws_bin", side_effect=AssertionError("must not fall back to a managed checkout")):
            with patch.object(ws, "open", side_effect=lambda *a, **kw: StringIO(root_mount), create=True):
                assert ws.reserve_offline_workspace(company, issue) == cwd
                git(cwd, "init", "--quiet")
                git(cwd, "-c", "user.name=Offline test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "fixture")
                fingerprint = ws.offline_workspace_fingerprint(company, issue)
                field = {"offlineCompanyId": company, "offlineIssueId": issue, "offlineBotId": bot,
                         "offlineFingerprint": fingerprint, "offlineCwd": str(cwd),
                         "offlineWorkspaceId": "44444444-4444-4444-8444-444444444444"}
                for _ in range(2):
                    assert ws.open_task_workspace(field)["path"] == str(cwd)

            targets = [home, cwd.parent.parent, cwd, cwd / ".git"]
            if layout == "scope":
                targets.append(home.parent)
            for target in targets:
                overridden = root_mount + mount(12, 10, "/other", target)
                with patch.object(ws, "open", side_effect=lambda *a, **kw: StringIO(overridden), create=True):
                    rejects_operation(lambda: ws.reserve_offline_workspace(company, issue), "mount")
                    rejects_operation(lambda: ws.offline_workspace_identity(company, issue), "mount")
                    rejects_operation(lambda: ws.open_task_workspace(field), "mount")
