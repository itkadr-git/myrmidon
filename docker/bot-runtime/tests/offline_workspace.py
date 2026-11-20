"""Behavior check for registered workspaces; no Git executable is needed."""
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from tools import run_workspace as ws

company = "11111111-1111-4111-8111-111111111111"
issue = "22222222-2222-4222-8222-222222222222"
bot = "33333333-3333-4333-8333-333333333333"


def rejects(field):
    try:
        ws.open_task_workspace(field)
    except (ValueError, OSError):
        return
    raise AssertionError("invalid offline workspace accepted")


with TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    cwd = home / "offline-workspaces" / company / issue
    cwd.mkdir(parents=True, mode=0o700)
    (cwd / ".git").mkdir()
    (cwd / ".git/objects").mkdir()
    (cwd / ".git/HEAD").write_text("ref: refs/heads/main\n")
    with patch.object(ws, "_offline_volume", return_value=(home, ["mount", "fixture-volume", []])), \
         patch.dict(os.environ, {"MYRMIDON_BOT_KEY": bot}), \
         patch.object(ws.subprocess, "run", side_effect=AssertionError("must not spawn Git")):
        fingerprint = ws.offline_workspace_fingerprint(company, issue)
        field = {"offlineCompanyId": company, "offlineIssueId": issue, "offlineBotId": bot,
                 "offlineFingerprint": fingerprint}
        for _ in range(2):
            assert ws.open_task_workspace(field)["path"] == str(cwd)
        rejects({**field, "offlineBotId": company})
        rejects({**field, "offlineIssueId": company})
        with patch.object(ws, "_offline_volume", return_value=(home, ["mount", "other-volume", []])):
            rejects(field)
        cwd.chmod(0o755)
        rejects(field)
        cwd.chmod(0o700)
        (cwd / ".git/objects/info").mkdir()
        (cwd / ".git/objects/info/alternates").write_text("/other/objects\n")
        rejects(field)
        (cwd / ".git/objects/info/alternates").unlink()
        replacement = cwd.with_name("replacement")
        cwd.rename(replacement)
        cwd.symlink_to(replacement, target_is_directory=True)
        rejects(field)
        cwd.unlink()
        cwd.mkdir(mode=0o700)
        rejects(field)
