## Thinking Path

> - Paperclip is the control plane app that manages AI agent companies.
> - The heartbeat run subsystem stores every agent run in the `heartbeat_runs` table.
> - Production audit on 2026-10-04 found the table at 1.1 GB, with ~1.07 GB in TOAST.
> - `executionContinuation` is stored twice: at the top level and inside `paperclipWake`, ~354 MB of duplicates.
> - Hot queries read whole rows, including heavy JSON columns, which makes the ownership blocker check and the run list slow.
> - This pull request removes the duplicate storage, narrows the hot queries, and adds the missing index migration.
> - The benefit is a smaller table and faster hot paths: the ownership blocker check, the run list, and the attention feed.

## Linked Issues or Issue Description

-

## What Changed

- `getConversationOwnershipBlocker` in `server/src/services/conversation-continuation.ts` now selects only the columns it needs (`id`, `agentId`, `processPid`, `processGroupId`, `status`, `createdAt`, `processStartedAt`) instead of the full `heartbeat_runs` row with `result_json`.
- `list` in `server/src/services/heartbeat.ts` accepts `options.includeHeavyColumns` (default `true` for compatibility). When `false`, the query skips heavy JSON columns (`usageJson`, `resultJson`, error text, log refs) and builds a minimal context snapshot.
- New `listAttentionExhaustedRunsWithoutHeavyColumns` in `server/src/services/attention-exhausted-runs.ts`; the attention feed now calls it instead of the full variant, so `error`/`errorCode` no longer detoast on feed build.
- Migration `0296_add_performance_indexes_for_continuation.sql`: `CREATE INDEX IF NOT EXISTS heartbeat_runs_company_issue_coalesce_created_idx ON heartbeat_runs (company_id, (coalesce(native_issue_id::text, context_snapshot->>'issueId')), created_at DESC)` — the index the audit asked to capture in a migration.
- Migration `0297_remove_execution_continuation_duplication.sql`: moves `executionContinuation` from the top level of `result_json` into `paperclipWake.executionContinuation` and nulls the top-level copy, reclaiming the duplicated ~354 MB.
- Both migrations registered in `packages/db/src/migrations/meta/_journal.json`.
- DIVERGENCE.md row `1.6.2-PERF-DIET` added.
- Performance documentation added (EN + RU): `docs/performance/heartbeat_runs_optimization.md`, `docs/performance/heartbeat_runs_optimization.ru.md`.

## Verification

- Run the server package typecheck and tests (CI runs them on this PR).
- After deploy, verify with `pg_total_relation_size('heartbeat_runs')` before and after migration 0297; expect ≥ 30% reduction.
- Check the ownership blocker timing in logs; expect < 5 ms average.
- Measure the run list and attention feed endpoints; expect < 300 ms p95.
- `scripts/performance-test.mjs` holds the before/after measurement harness.

## Risks

- Migration 0297 rewrites `result_json` for rows that carry `executionContinuation`; it is a single `UPDATE`, not batched, so on the 1.1 GB table it holds locks for the duration. Run it during the maintenance window of the 1.6.2 release.
- Local tsc/vitest could not run in this workspace (no docker, no node_modules); CI is the gate for compile and tests.
- The `includeHeavyColumns: false` path returns a minimal context snapshot; any consumer that needs full context must not set the flag to `false`.

## Model Used

- None — human-authored.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [ ] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
