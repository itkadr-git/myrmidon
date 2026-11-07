#!/usr/bin/env python3
"""Opt-in Linux review launcher: explicit task/diff input, no executor filesystem."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


def landlock_syscalls(machine):
    if machine not in {"x86_64", "aarch64"}:
        raise RuntimeError("Unsupported architecture for reviewer isolation")
    return 444, 445, 446


def confine(workspace, runtime_paths):
    """Apply a filesystem allowlist, inherited by the reviewer and its children."""
    create, add, restrict = landlock_syscalls(platform.machine())
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(create, 0, 0, 1)
    if abi < 1:
        raise RuntimeError("Landlock unavailable; refusing unrestricted review")
    # ABI 2 adds REFER, ABI 3 TRUNCATE, ABI 5 IOCTL_DEV.
    handled = (1 << 13) - 1
    if abi >= 2:
        handled |= 1 << 13
    if abi >= 3:
        handled |= 1 << 14
    if abi >= 5:
        handled |= 1 << 15

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    def checked(result):
        if result < 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        return result

    attr = Ruleset(handled)
    fd = checked(libc.syscall(create, ctypes.byref(attr), ctypes.sizeof(attr), 0))
    try:
        read_execute = (1 << 0) | (1 << 2) | (1 << 3)
        for path, access in [(workspace, handled), *[(p, read_execute) for p in runtime_paths]]:
            parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(access, parent)
                checked(libc.syscall(add, fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(parent)
        checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(libc.syscall(restrict, fd, 0))
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--diff", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a reviewer command is required after --")
    executable = shutil.which(command[0])
    if not executable:
        parser.error("reviewer executable not found")
    command[0] = executable
    # Read only explicitly submitted artifacts, never copy the executor's checkout or HOME.
    context = {"task": args.task.read_text(), "diff": args.diff.read_text()}
    runtime = [Path(p).resolve() for p in ("/usr", "/bin", "/lib", "/lib64", sys.prefix, sys.base_prefix)
               if Path(p).is_dir()]
    runtime = sorted(set(runtime))
    landlock_syscalls(platform.machine())
    with tempfile.TemporaryDirectory(prefix="review-", dir=os.environ.get("TMPDIR")) as directory:
        root = Path(directory).resolve()
        home = root / "home"
        workspace = root / "workspace"
        temporary = root / "tmp"
        for path in (home, workspace, temporary):
            path.mkdir()
        for key, name in (("task", "task.txt"), ("diff", "change.diff")):
            (workspace / name).write_text(context[key])
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
               "HERMES_HOME": str(home), "TMPDIR": str(temporary), "LANG": "C.UTF-8"}
        result = subprocess.run(command, cwd=workspace, env=env, input=json.dumps(context),
                                text=True, close_fds=True,
                                preexec_fn=lambda: confine(root, runtime))
        return result.returncode


if __name__ == "__main__":
    sys.exit(main())
