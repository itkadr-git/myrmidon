# myrmidon(G1): build-time regression for 11-run-scoped-github-launcher.patch
# (NONCONTAINER-GITHUB-LAUNCHER). The board's hermes_gateway adapter ships the
# managed Git launcher as request content because a gateway run has no execution
# target for prepareGitHubOperationLaunchers to stage into. This proves the
# gateway half: the bodies land in the gateway's own temp root, exactly one
# run's children get that directory first on PATH (through the same
# tools/environments/local.py bridge every terminal child goes through), the
# staged helper really resolves the run's broker capability, and a run without a
# launcher — or with a malformed payload — stages nothing and inherits nothing.

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.environments.local import _inject_session_context_env
from tools.github_broker_context import set_github_broker_vars
from tools.github_launcher_context import (
    GITHUB_LAUNCHER_DIR_NAME,
    GITHUB_LAUNCHER_PAYLOAD_VERSION,
    github_launcher_bound,
    github_launcher_env,
    github_launcher_root,
    set_github_launcher_vars,
)

RUN_ID = "run-launcher-abc"
BROKER_TOKEN = "cap-token-123"
BROKER_REPLY_TOKEN = "ghs_from-broker"
STUB_GIT = "#!/bin/sh\necho \"staged git $*\"\n"
STUB_GH = "#!/bin/sh\necho \"staged gh $*\"\n"
STUB_HELPER = (
    "#!/usr/bin/env python3\n"
    "import json, os, sys, urllib.request\n"
    "sys.stdin.read()\n"
    "url = os.environ['PAPERCLIP_GITHUB_BROKER_URL'] + '/credential'\n"
    "request = urllib.request.Request(url, headers={\n"
    "    'Authorization': 'Bearer ' + os.environ['PAPERCLIP_GITHUB_BROKER_TOKEN']})\n"
    "with urllib.request.urlopen(request, timeout=5) as response:\n"
    "    token = json.load(response)['token']\n"
    "sys.stdout.write('username=x-access-token\\npassword=%s\\n' % token)\n"
)


def payload(**overrides):
    body = {
        "version": GITHUB_LAUNCHER_PAYLOAD_VERSION,
        "files": {
            "git": STUB_GIT,
            "gh": STUB_GH,
            "git-credential-paperclip": STUB_HELPER,
            "package.json": '{"type":"commonjs"}\n',
        },
    }
    body.update(overrides)
    return body


def start_broker(seen):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
            seen.append((self.path, self.headers.get("Authorization")))
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"token": BROKER_REPLY_TOKEN}).encode())

        def log_message(self, *args):  # keep the build log clean
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


def main() -> None:
    shutil.rmtree(github_launcher_root(), ignore_errors=True)
    seen = []
    server, broker_url = start_broker(seen)
    broker = {"broker_url": broker_url, "capability": BROKER_TOKEN}

    # Unbound: no launcher names survive into a child, and a directory another
    # surface left on PATH is stripped rather than inherited.
    stale_dir = os.path.join(github_launcher_root(), "run-stale")
    env = {"FOO": "1", GITHUB_LAUNCHER_DIR_NAME: stale_dir,
           "PATH": os.pathsep.join([stale_dir, "/usr/local/bin", "/usr/bin"])}
    _inject_session_context_env(env)
    assert GITHUB_LAUNCHER_DIR_NAME not in env
    assert stale_dir not in env["PATH"]
    assert env["PATH"] == "/usr/local/bin:/usr/bin"
    assert github_launcher_env() == {}

    # Malformed payloads and unusable run ids bind nothing (no half staging).
    for bad in (
        None,
        "not-a-payload",
        payload(version=GITHUB_LAUNCHER_PAYLOAD_VERSION + 1),
        payload(files={"git": STUB_GIT}),
        payload(files={**payload()["files"], "extra.sh": STUB_GIT}),
        payload(files={**payload()["files"], "git": ""}),
        payload(files={**payload()["files"], "git": 42}),
        payload(files={**payload()["files"], "git": "x" * 65537}),
    ):
        marker, reset = set_github_launcher_vars(bad, RUN_ID)
        assert github_launcher_env() == {}, bad
        reset(marker)
    marker, reset = set_github_launcher_vars(payload(), "../../etc")
    assert github_launcher_env() == {}
    reset(marker)
    assert not os.path.exists(os.path.join(github_launcher_root(), RUN_ID))

    # The launcher serves the run's broker capability: without one, nothing is
    # staged even for a well-formed payload.
    marker, reset = set_github_launcher_vars(payload(), RUN_ID)
    assert github_launcher_env() == {}
    reset(marker)
    assert not os.path.exists(os.path.join(github_launcher_root(), RUN_ID))

    # Bound broker + launcher: the fragment is the run's own, and only its.
    broker_marker, broker_reset = set_github_broker_vars(broker)
    launcher_marker, launcher_reset = set_github_launcher_vars(payload(), RUN_ID)
    try:
        directory = os.path.join(github_launcher_root(), RUN_ID)
        fragment = github_launcher_env()
        assert fragment[GITHUB_LAUNCHER_DIR_NAME] == directory
        assert fragment["PATH"].split(os.pathsep)[0] == directory
        assert fragment["ZDOTDIR"] == directory
        assert fragment["BASH_ENV"] == os.path.join(directory, ".bashrc")
        assert fragment["GH_CONFIG_DIR"] == os.path.join(directory, "gh-config")
        # Staged files: the payload bodies verbatim, plus the login-shell
        # profiles that restore the managed PATH, all owner-only.
        for name in ("git", "gh", "git-credential-paperclip", "package.json",
                     ".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"):
            path = os.path.join(directory, name)
            assert os.path.isfile(path), name
            assert os.stat(path).st_mode & 0o777 == 0o700, name
        assert open(os.path.join(directory, "package.json")).read() == '{"type":"commonjs"}\n'
        for name in (".zshenv", ".zshrc", ".profile"):
            assert open(os.path.join(directory, name)).read().startswith("export PATH='%s:" % directory)
        assert os.path.isdir(fragment["GH_CONFIG_DIR"])

        # A terminal child of THIS run resolves git/gh to the staged directory
        # (its PATH is the run's, not the gateway's), and the staged helper
        # reaches the broker with the run's capability.
        child = {"FOO": "1", "PATH": "/usr/bin:/bin"}
        _inject_session_context_env(child)
        assert child["PAPERCLIP_GITHUB_BROKER_URL"] == broker_url
        assert child[GITHUB_LAUNCHER_DIR_NAME] == directory
        resolved = subprocess.run(["git", "--version"], env=child, capture_output=True, text=True,
                                  cwd=tempfile.gettempdir())
        assert resolved.returncode == 0, resolved.stderr
        assert resolved.stdout.strip() == "staged git --version", resolved.stdout
        credential = subprocess.run(
            [os.path.join(directory, "git-credential-paperclip")],
            input="protocol=https\nhost=github.com\npath=itkadr-git/myrmidon.git\n\n",
            env=child, capture_output=True, text=True, cwd=tempfile.gettempdir())
        assert credential.returncode == 0, credential.stderr
        assert "password=%s" % BROKER_REPLY_TOKEN in credential.stdout, credential.stdout
        assert seen and seen[-1][1] == "Bearer %s" % BROKER_TOKEN, seen

        # A login shell picks the managed directory back up through the profiles
        # (BASH_ENV for non-interactive bash); other shells keep the PATH the
        # fragment set.
        bash = shutil.which("bash")
        if bash:
            login = subprocess.run(
                [bash, "-lc", "command -v git"], env={**child, "HOME": tempfile.gettempdir()},
                capture_output=True, text=True)
            assert login.stdout.strip() == os.path.join(directory, "git"), login.stdout + login.stderr

        # Concurrent runs do not share the fragment: the outer run's launcher
        # comes back when the inner one resets, in the same thread and context.
        inner_marker, inner_reset = set_github_launcher_vars(payload(), "run-inner-xyz")
        try:
            assert github_launcher_env()[GITHUB_LAUNCHER_DIR_NAME] == os.path.join(github_launcher_root(), "run-inner-xyz")
            assert os.path.isdir(os.path.join(github_launcher_root(), "run-inner-xyz"))
        finally:
            inner_reset(inner_marker)
        assert github_launcher_env()[GITHUB_LAUNCHER_DIR_NAME] == directory
        assert GITHUB_LAUNCHER_DIR_NAME not in os.environ
    finally:
        launcher_reset(launcher_marker)
        broker_reset(broker_marker)
    assert github_launcher_env() == {}
    assert github_launcher_bound() is False

    # After the run, its children go back to a launcher-free PATH.
    env = {"FOO": "1"}
    _inject_session_context_env(env)
    assert GITHUB_LAUNCHER_DIR_NAME not in env
    assert github_launcher_root() not in env.get("PATH", "")

    server.shutdown()
    shutil.rmtree(github_launcher_root(), ignore_errors=True)
    print("github-launcher run-scope regression: ok")


if __name__ == "__main__":
    main()