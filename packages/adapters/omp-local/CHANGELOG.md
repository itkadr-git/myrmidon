# @myrmidon/adapter-omp-local

## Unreleased

### Patch Changes

- OPE-12287: fix session resume for omp >= 18.9.2 session files. omp 18.9.2 writes `{"type":"title",…}` as the first line of the session file and the `{"type":"session",…,"cwd":…}` header on the second line, but `readSessionHeaderCwd` only inspected the first non-empty line, so the saved cwd was never matched and every next heartbeat started a fresh `--session-dir` run. The header is now searched among the first 10 lines of the session file (remote path reads `head -n 10` too), so both the old (session-first) and the new (title-first) formats resume with `--session <file>`.
