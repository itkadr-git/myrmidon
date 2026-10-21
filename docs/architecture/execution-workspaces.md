---
title: Execution workspaces and worktrees
summary: Filesystem isolation, measurement, and cleanup around agent runs
---

> Русская версия: [execution-workspaces.ru.md](execution-workspaces.ru.md)

An execution workspace is the filesystem boundary assigned to a run or development task. The control plane stores its identity, source, lifecycle status, and runtime metadata; the execution driver creates and removes the directory or worktree. A workspace is not the agent process itself and is not a substitute for task checkout.

## Lifecycle

A run receives the workspace context through the runtime driver. The driver prepares the requested source, exposes the path to the adapter, and reports status transitions back to the server. Repeated work uses the same explicitly selected workspace; cleanup is safe to retry and must not remove a workspace owned by another active run.

Git worktrees provide inexpensive branch isolation for repository-backed work. The control plane records the worktree path and source metadata, while git operations remain in the execution environment. Operators should treat paths as untrusted metadata and keep workspace access scoped to the company and run.

## Hygiene measurements

The workspace-hygiene service reads stored measurements rather than walking disks on every panel request. A sweep measures workspace size, persists the measurement, and marks over-quota rows. The service resolves limits in this order: saved `instance_settings.general.workspaceHygiene`, then environment defaults, then built-in defaults. Updates are persisted and audited without a restart; the next sweep reads the new values.

Two quota dimensions are supported: a per-workspace limit and an instance total. The view reports source, measured size, quota state, last sweep, and truncation. The bounded view protects the API from unbounded workspace metadata.

## Failure and safety

A failed sweep leaves the last successful measurement visible and must not silently claim that a workspace is healthy. Cleanup and quota enforcement are observable through activity records. Credentials and run prompts never belong in workspace measurement metadata.

## Source map

- `server/src/myrmidon/workspace-hygiene/` — limits, measurements, sweeps, and service endpoints.
- `server/src/services/execution-workspaces.ts` — workspace lifecycle orchestration.
- `server/src/services/execution-workspace-policy.ts` — workspace policy.
- `server/src/services/environment-runtime.ts` — runtime-driver boundary.
- `server/src/myrmidon/workspace-hygiene/service.ts` — live settings and bounded measurements.
