# WAKE-9.2: isolated reviewer context prototype

This is an opt-in subprocess prototype, not a change to the production gateway.
It proves a reviewer process can consume an explicit task and diff without
reading the executor checkout, HOME, or transcript. It does not start or resume
a production agent session. Gateway integration is a separate rollout step.

Run on Linux with Landlock enabled (ABI 1+, x86_64 or aarch64):

```sh
python3 scripts/myrmidon/reviewer-isolation.py \
  --task /path/to/submitted-task.txt --diff /path/to/submitted-change.diff \
  -- /usr/bin/python3 -I /usr/local/lib/reviewer/entrypoint.py
```

The reviewer entrypoint must live in the trusted runtime, not the executor's
checkout. It receives a JSON object with `task` and `diff` on stdin, and the same
artifacts as `task.txt` and `change.diff` in its fresh working directory. Write the
review to stdout: the temporary workspace is deleted after exit. The exit status
is propagated. No inherited environment, session ID, credentials, agent history,
or executor workspace is forwarded. HOME/HERMES_HOME and TMPDIR are fresh.

Landlock applies a read/execute allowlist for system runtime directories and the
launcher's Python prefixes, and permits writes only in the temporary review root.
All other filesystem reads (including absolute paths and symlinks into an
executor workspace) fail with EACCES, also for child processes. Existing file
descriptors are closed except explicit stdin/stdout/stderr pipes. Unsupported
kernels/architectures and sandbox setup errors fail closed, never silently run an
unconfined reviewer.

Trust boundary: this is filesystem/context isolation, not a hostile-code VM.
The system runtime and Python installation must contain only trusted runtime
files, never executor artifacts or transcripts. Network, process inspection and
other IPC are not isolated by this prototype. Do not enable network retrieval,
resume tools or board tools with access to executor histories when using it.
A production adapter needs separate network/IPC isolation, minimal scoped
credentials, resource limits and trusted reviewer runtime provisioning. Existing
reviewer wakes remain unchanged until that integration is implemented.

## Verification

`python3 scripts/myrmidon/reviewer-isolation.test.py` runs a real subprocess
that reads the submitted task/diff, writes its own result, and tries to read an
executor-only canary, executor transcript and a symlink alias. All three reads
must raise PermissionError. The test also asserts an empty HOME, no inherited
session variable and only submitted artifacts in cwd. The `.test.mjs` wrapper
runs these tests in the existing Myrmidon CI Script tests lane; unsupported
kernels fail rather than skip the acceptance test.
