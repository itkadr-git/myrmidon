# Manual CI timeout smoke

> Русская версия: [Ci-timeout-smoke.ru](Ci-timeout-smoke.ru)

Repository maintainers can use an isolated manual workflow to check a self-hosted CI job timeout and runner cleanup. Coordinate an idle runner and host access first; the generic `self-hosted` label does not pin a host. Only the designated operator dispatches once. Check the job conclusion `timed_out`, timestamps and runner identity, then verify cleanup on the actual host. A run-level failure or a merged workflow alone is not proof.

See the [English runbook](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/ci-timeout-smoke.md) for the precheck, evidence and postcheck procedure.
