# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## Unreleased

## 1.6.9

### A run queued while its agent was paused is not cancelled as stale right after the resume (RESUME-QUEUE-AGE)

- Runs that stood in the queue while their agent was paused (waiting for a slot, `execution_changes_requested`) were cancelled by the queue-age sweep (`queued_run_stale_timeout`) in the second the pause was lifted: the pause counted as waiting time, the first resumed run had not reached `running` yet, so the slot-wait protection saw nothing. The replacement wake lost the original wake reason.
- Resuming an agent now stamps its queued runs with `queueWaitResumedAtMs` (epoch milliseconds; a value that does not fit is ignored, never an error); the wait of such a run counts from the resume (later of the stamp, the creation time or the retry due time), in the sweep's selection and in the cancellation check.
- The service keys the sweep writes onto a queued run (wait reason and detail, queue position and length) are now merged on the database side, so they cannot erase the stamp. A failed stamp is logged as a warning and does not stop the queue from being promoted.
- Known limits: runs that waited while the board was down or in a maintenance window longer than the threshold, and the pause of a whole company, do not get the stamp.
- Unchanged: a run whose slot stays free longer than the threshold after the resume is still cancelled; other reasons (task closed, assignee changed) and the pause protection of RESUME-AFTER-CANCEL are untouched.

### An agent card edit no longer recreates the bot container under a running run (BOT-PROFILE-NO-RUN-INTERRUPT)

- A change that has to stop a bot gateway (restart-class profile change, image or resource drift) used to open a maintenance window, wait for the agent's run to drain and, at the drain deadline, interrupt it ("Interrupted by maintenance mode" / "Gateway shutdown interrupted the run."). The reconciler now looks at the agent's live runs first: with a run in flight the pass returns `deferred` without opening a window, and the existing deferred-rollout watcher (`myrmidonBotRolloutDeferred`) applies it after the run ended. The check is repeated under the window to close the race with a run admitted in between.
- The watcher's busy gate now reads the run table; before it read the window view, which reports 0 for an agent with no window.
- Who defers: the periodic pass (card edits, including a card image edit by `bot-image-rollout.sh`), "Apply now", key rotation and the chat command. Who still drains and applies as before: the image rollout wave, the canary and the rollback (`canary-index.ts`, `drainBusy: true`) - operator actions with their own step timeout, where a deferral would be retried forever. A record's clock (`firstDeferredAt`) now survives a change of its target image.
- Only a record that waited past `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (6 h by default) still drains and interrupts, so a bot that never frees up converges. An unhealthy gateway is recovered at once, not deferred.
- `runtimeConfig.heartbeat.*` is read by the board only, except `maxConcurrentRuns`, which is written to the gateway's `config.yaml`; pinned by tests. A change of that one field is still a restart-class change, but it is now deferred under a running run.

### Checks of a cancelled, superseded CI run no longer turn the board's CI summary red (CI-SNAPSHOT-CANCELLED)

- The CI summary the board gives agents (`ciResult` / `pullRequestsCi`) now counts, for each check name, only its latest record on the head (latest start, then completion time, then larger id). The last completed record with a verdict represents the check; earlier records of it (cancelled by a replaced run, or failed before a re-run) no longer take part. This fixes a false FAILURE on pull requests where adding `full-ci` or a re-run replaced the running CI.
- A check whose latest record is `cancelled` and has no replacement is reported as "cancelled, not a test failure": the overall conclusion is `cancelled` (neither `failure` nor `success`), the new `cancelledJobs` field lists it, and `failedJobs` is left for real `failure` / `timed_out` / `action_required`.
- A later `skipped`, `neutral` or `cancelled` record never hides an earlier verdict (`success` / `failure` / ...) of the same check: a real failure stays FAILURE.
- A successful `CI result` with no real failures gives `success` and absorbs only cancelled required checks of its own workflow run; other cancelled required checks keep the summary `cancelled`.

### One content-filtered model reply no longer fails the whole run (CONTENT-FILTER-RETRY)

- When the model provider answered a bot's call with `finish_reason: content_filter` (an HTTP 200 reply cut off by the provider's safety filter, even for harmless work text), the bot ended the run at once with `content_policy_blocked`, and the board restarted the task from the beginning. Over 7 days 58 engineer runs (675 minutes) failed this way, five of the last 72 hours' runs after more than 10 minutes of work. The bot now re-issues the same model call up to twice per run (the session and the work done so far are kept), but only where the run used to fail at once: bots with a configured fallback model still switch to it as before, and the re-issues leave room for those switches; a refusal that outlasts them ends the run as before, and the failure text says it repeated after the re-issued calls. Shipped as hermes patch 36; it takes effect when the bot image is rolled out.

### A run that waited for its own agent's slot starts at slot release instead of being cancelled as stale (EMPTY-RUNS-6C)

- EMPTY-RUNS-6 and 6B spared a queued run that waits for its own agent's concurrency slot from the age expiry,
  but only while its wait reason was `agent_concurrency`. In the pass that frees the slot the start sweep takes
  the heaviest waiting run and renames the wait of the other ready runs of the agent to `priority`; the age
  sweep of the same second then cancelled them with `queued_run_stale_timeout` and queued replacements whose
  wake reason was `queued_run_stale_timeout`, so the original reason (`pause_resume`,
  `execution_changes_requested`) and context were lost.
- Now `priority` counts as the same wait for the agent's own slot. Such a run is kept while the agent has a
  `running` run and for the threshold after the end of any started run of the agent (succeeded, failed or
  cancelled), and starts with its own wake reason and data. A run that does not start with a free slot for the
  whole threshold, and every other cancellation reason (reassignment, closed task), are unchanged.

### Reviewers are not woken on a non-final or already-seen CI result (EMPTY-RUNS-3B, EMPTY-RUNS-2C)

- EMPTY-RUNS-3B: a CI delivery wakes the task only on the result of the current head. When a head has a `CI result` check, only a finished one that is not skipped, cancelled or stale counts; the "every check has finished" fallback is used only for a head that has no `CI result` at all. A partial run (a label event, an auxiliary workflow) whose `CI result` is skipped no longer produces a `ci_completed` wake.
- EMPTY-RUNS-3B: one result of one head wakes once, whatever kind of event carries it (`check_run`, `check_suite`, `workflow_run`). The handled result is kept as `ciVerdictHandled` (head and verdict) on the pull request work product and is not cleared when a job of the head starts, as `lastCompletedCi` is; a failed result clears it, so a green result after a re-run is news again.
- EMPTY-RUNS-2C: the idle pickup of a review participant reads the head CI as it is now and applies the same admission rule as the hand-off to review and the executor's comment: while the head CI is unfinished, unreadable or red the reviewer is not picked up (a critical issue is). A failed read wakes as before. Switch: `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED`.
- EMPTY-RUNS-3B: the `ci_completed` wake for a task in review goes to the participant of its pending stage, not to the assignee; a task in review without a pending stage wakes nobody.

### A task whose run the operator cancelled resumes when its agent is resumed (RESUME-AFTER-CANCEL)

- After an operator cancelled runs and the board restarted, the board closed the recovery actions with a "do not replay" outcome, and lifting the agent's pause woke the tasks as system wakes: they were parked as `execution_reconciliation_required` and each task needed a manual wake.
- Lifting a pause is an explicit operator action, but the wake it issues stays a system wake (no user-requester bypasses: rewake freeze, wake-storm guard, worktree cutoff, `agent.not_invokable` record). The user who lifted the pause travels as `resumedByUserId` on the wake options, and only the settled-hold check reads it: a `pause_resume` wake passes the hold, and then retires it, only when the run holding it is `cancelled` (operator cancel, queue removal).
- Unchanged: a hold of a `failed` / `timed_out` / `interrupted` run (unknown outcome), a hold that names no run or a purged one, a run still running, automatic and system wakes and `retry_failed_run` stay held; the "do not replay" protection is not touched.
- A queued run of an agent the operator has paused is no longer expired by the queue-age sweep (`queued_run_stale_timeout`): it waits for the resume, which promotes it with its own wake reason. Before, the sweep cancelled it and the replacement wake failed with 409 "Agent is not invokable", logged at error level, so nothing continued the task after the resume. The sweep's selection (`listStaleQueuedRuns`) also leaves the runs of paused agents out of its 200-row page, so a mass pause does not crowd out the expired runs of other agents.
- Not changed here: the recovery action closed with outcome `blocked` while the task stays `in_progress`, and `recovery-actions/resolve` with `restored` answering 200 without effect.

### The review stage participant's approval is recorded whichever wake started the run (REVIEW-APPROVAL-RECORDED)

- On 14.11 (candidate 1.6.9-rc.2) the approval of a reviewer was refused with HTTP 409 (`issue_done_pull_request_gate`), the stage stayed
  `pending` or fell to `idle`, and recovery blocked the task (OPE-13059, OPE-13061). Cause: when the PATCH to `in_review` routed a
  reviewer immediately and then deferred the reviewer wake (CI wait or the per-tick wake quota), the admission monitor policy was built
  from the policy as it was before the routing, so it overwrote the stored policy with `stages: []`. The stage in the execution state
  no longer existed in the policy, the participant's `done` was not a decision and went straight to the PR gate. It did not depend on
  the wake that started the run.
- The monitor policy is now built on the policy as persisted after the update and the routing, so the routed stage survives.
- The approval of the current participant of a pending review stage is also recorded when the policy has lost the stage (or the whole
  policy): the stage completes with an approved decision, and with an open PR the task waits for the merge as usual. Tasks already
  in that state need no manual repair.

### The review stage participant sees the stage in the task context whatever woke the run (REVIEW-STAGE-IN-CONTEXT)

- On 13-14.11 (candidate 1.6.9-rc.2) reviewers woken by CI, an idle pickup or an operator answered "executionStage=null, there
  is no active participant" and refused to record the decision, although the stage was pending and they were its participant
  (OPE-12886, OPE-12906, OPE-12941). `executionStage` was built only for the wakes of the stage itself
  (`execution_review_requested` and similar); `GET /api/issues/:id/heartbeat-context` carried no stage at all.
- The response now has a top-level `executionStage`, built by the same function as the stage wake context: stage id and type,
  state, current participant, return assignee, last decision, allowed actions, plus `isCurrentParticipant` and a one-line
  `youAre`. The current participant gets `wakeRole: "reviewer"` (`"approver"`) and the actions `approve` / `request_changes`;
  the executor of a returned stage gets `"executor"`; any other caller gets `wakeRole: "observer"`, no actions and the text
  "You are not a participant of the review stage". The field is `null` only when no stage is in flight.

### A queued assignment run whose task was closed before it started is cancelled cleanly instead of failing setup (RUN-SETUP-STALE-TASK)

- On 14.11 (candidate 1.6.9-rc.2) a run queued by `issue_assigned` waited for the agent's slot while the task was closed
  and its PR merged. At start it failed with `setup_failed` / `continuation_task_ownership_changed` and an error-level log
  line; 17 such failures in 7 days. The claim-time staleness check let it through because the assignment wake carries the
  hand-off comment, and any wake with a comment bypassed the terminal-status check.
- The comment bypass no longer applies to `issue_assigned` wakes: such a run on a `done`/`cancelled` task is cancelled at
  claim with `issue_terminal_status` (info log, no `failed`). Comment wakes, resume intents and pending-card addressees
  behave as before; genuine setup failures stay `failed` with an error log.

### The stale-block sweep returns an unassigned task with a dead block to todo instead of failing on every pass (STALE-BLOCK-UNASSIGNED)

- On 13.11 (candidate 1.6.9-rc.2) a task created straight in `blocked` with a closed blocker and no assignee made the sweep log
  "stale block sweep failed for one task" (HttpError 422) on every pass and stay blocked for good. The block had a named
  reason (the edge to the blocker), so the sweep chose `in_progress`, and the issue service refuses `in_progress` for a
  task with neither an agent nor a user assignee ("in_progress issues require an assignee").
- A task without an assignee now goes to `todo` (the dead edge is removed, the comment says "without assignee"). A task with
  an assignee returns to `in_progress` as before; a bare block still goes to `todo`.
- The failure warning now also carries `errorMessage`: the fixed refusal sentence of the issue service for a 4xx
  HttpError (plain words only, at most 120 characters), so the cause of a repeated 422 reads from the log. Messages of
  other errors are still not logged.

### A run that waited for its own agent's slot starts when the slot frees instead of expiring by age (EMPTY-RUNS-6B)

- EMPTY-RUNS-6 spared a queued run that waits for its own agent's concurrency slot
  (`waitReason = agent_concurrency`) from the age expiry only while the agent had a `running` run. In the
  second that run ended the age sweep cancelled the waiting run with `queued_run_stale_timeout`, a
  replacement with another wake reason started, and the rest of the agent's waiting runs were expired one
  after another without starting, which froze the task with "N runs without progress".
- Now such a wait is counted from the end of the agent's last started run when that is later than the start of the
  wait. A slot freed just now leaves the age near zero: the run is kept and starts with its own wake reason
  and data. A slot free for the whole threshold without the run starting is a lost start and expires as
  before. While the agent has a `running` run nothing changes. Reassignment, task closure and the other
  task-state checks still cancel the run.

### Gateway slot reconcile ends its pass at the first unreachable probe (OPE-12984)

- When the gateway was down, the `gateway-slot-reconcile` pass probed all of up to 64 finished runs one after another, one timeout per run, and the start of a run waited for all of them (OPE-12964).
- The first `unreachable` answer now ends the pass; `unreachable` is counted once. The memory of runs confirmed closed (OPE-12890) is unchanged, and an unreachable answer is not remembered, so the next pass tries again.

### A CI delivery is handled by the final result of the head; a failed result does not return a task while main is red (EMPTY-RUNS-3)

- The GitHub connection events treated every finished job, and every finished run of an auxiliary workflow, as a finished CI of the pull request: the monitor of the task was disarmed, its assignee was to be woken (`ci_completed`), and a task in review went back to its executor — all on the first job that ended. On 13.11, the first day the App delivered check events, that was 48 returns from review (45 of them on a single `check_run`); after main went red, 13 more, 6 of them on the very shards that were red on main; one such run made 139 model calls on 5.88M input tokens to answer "main is red, nothing to change". A task whose monitor had been disarmed by the first job was picked up minutes later by the stranded-task recovery: one such run cost 888K input tokens to report "4 jobs still running".
- Now only the delivery that carries the final result of the current head counts: the finished `CI result` check (a cancelled, skipped or stale one is not a result), or — for a pull request that has no such check — the moment GitHub shows every check finished. A job that ends changes nothing: the monitor stays armed, nobody is woken, `lastCompletedCi` is not written. The final result is recorded as `lastCompletedCi` of the pull request rows, announces a possible merge when green, disarms the monitor and wakes the assignee once per result; the same result delivered again wakes nobody, and a result of an older head decides nothing. A job that starts after the result of the head (the re-run of a gate, an auxiliary workflow) does not reopen it; the final check does. The wake goes to a task that is being worked on or reviewed, or whose agent armed a monitor; a parked task without a monitor and a closed task are not woken.
- A task in a pending review stage goes back to its executor on a failed final result, with the failed checks named in the comment. A failed result with `main-green` red on the head is a failure on a red base branch: the task stays in review, the executor is not woken, a system note says why and the `ci_infra_retry_needed` row is written, once per head. When main is green again the "Main green gate" workflow re-runs `main-green` on open pull requests; that delivery brings the head back, and a head that is still red is returned to its executor with the instruction to re-run the failed jobs first. A head on which only `CI result` failed is held the same way as an infrastructure failure.
- The wakes of a delivery really reach the queue now. The App webhook is served by the api processes, where the event service had been given a stub instead of a wake function: not one `ci_completed` wake was recorded for 54 returns from review. An api process now enqueues the wake through a heartbeat service of its own role (it executes nothing itself and announces the queued run to the worker over the process bus), and every wake of a delivery — `ci_completed`, the merge-conflict return, the merged-PR confirmation — is sent after the transaction of the delivery has committed: the admission of a wake locks the task row the delivery has just written, so a wake sent from inside the transaction would wait for its own caller.
- The name of the check is kept in the stored record of a `check_run` delivery (`checkName`).
- `MYRMIDON_GITHUB_CI_FINAL_ONLY_ENABLED=off` brings back the old handling (and, in an api process, the dropped wake); `MYRMIDON_REVIEW_RETURN_GUARD_ENABLED=off` removes the holds — every failed final result returns the task; `MYRMIDON_REVIEW_INFRA_CHECK_NAMES` without `main-green` removes the base-branch hold. When GitHub cannot be read a failed final result returns the task without the list of checks.

### An agent no longer re-picks its own parked task every sweep (EMPTY-RUNS-1)

- On 13.11 a third of all runs (258 of 780 in eight hours) were `swarm_matched` / `idle_pickup` pickups, and 217 of
  them changed nothing: three service bots took their own `todo` tasks 176 times (ten tasks, about 40 M input tokens),
  wrote "no new data, leaving it in todo" and handed the task back. Both guards that exist for this loop were blind to
  it. The task cooling (`wake-task-guard`) trusts run liveness, and liveness marks a run "advanced" for any activity
  row attributed to it, the board's own included (the checkout claim, the tool delivery, the echo of the final text):
  500 of 539 succeeded runs without a result were "advanced", so the cooling never started. The rewake throttle read
  the PATCH `in_progress -> todo` and the note next to it as issue-visible progress, so its no-progress streak never
  started either.
- The rewake throttle no longer counts a hand-back of the task to the queue as progress: an `issue.updated` that moves
  the task `in_progress -> todo` and changes nothing but the execution lock and the assignment bookkeeping, and the
  comment the same run leaves next to it. A run that hands the task back but leaves a document, a work product, a
  sub-task, a blocker, a monitor, an interaction or a real field change still counts, and so does a comment of a run
  that did not hand the task back. After two such runs the escalating pause starts, after six in the lookback window
  the task is frozen and the lead is asked, as for every other no-progress streak.
- The task cooling no longer takes "advanced" as proof for a task that sits in `todo`: an automatic run that left no
  issue-visible progress there (the same read as the throttle's) is stale, so the task cools for 30 minutes, then 60,
  120 and so on up to `general.swarm.cooldownCeilingHours`. The cooling list shows such tasks with the reason
  `no_progress`. A user or another agent moving the task lifts the cooling as before; tasks in `in_progress`,
  `in_review` or `blocked` are judged exactly as before.
- Run liveness itself is not changed: it also drives continuations, the successful-run hand-off and stranded-task
  recovery.

### A monitor that waits for a review or a merge no longer wakes its agent every 30 minutes (EMPTY-RUNS-4)

- A due issue monitor that waits for a pull request is judged by the board (PR-WAIT-MONITOR, OPE-11949). When nothing was news it had two states: CI is running, or the board holds no check data — and the second one wakes the agent with a `no_signal` note after 30 quiet minutes. A pull request whose CI had finished, with the result already seen by the agent, fell into that second state as well. So every "wait for the merge" monitor woke its agent each time it came due, only to answer "still open": 32 such `no_signal` runs of engineers in 19 hours on the release board, one task at its 36th monitor attempt and another at its 59th.
- That state is now told apart as `settled`: CI of the current head finished, the agent has seen it, nothing is running. The monitor re-arms silently (`issue.monitor_deferred`, reason `pr_wait_unchanged`, `ciState: "settled"`) with the same growing interval, capped at 60 minutes.
- The agent is still woken at once for news the board records — the pull request was merged or closed, a review was submitted, a merge conflict appeared, CI completed again — at its own `timeoutAt` / `maxAttempts`, and after 6 quiet hours as the last backstop, with a note that names the finished CI.
- Several work product rows of one pull request (the ones an agent registered and the one the board linked from the GitHub event) are judged as one pull request, by the row that carries the finished CI of its head. A second pull request of the task without check data keeps the whole wait in the old 30-minute state.
- Unchanged: a pull request the board holds no check data for is still woken after 30 minutes; a monitor that does not wait for a pull request is not touched.

### A run waiting in its own agent's queue is no longer expired and the task is no longer frozen for it (EMPTY-RUNS-6)

- A queued run older than `general.processes.queuedRunStaleAfterSec` (30 minutes) is cancelled with
  `queued_run_stale_timeout` and the agent is woken for the task again. For a run that simply stood behind its own
  agent's running runs this bought nothing: the wake queued the same run behind the same ceiling, and after the second
  expiry the rewake throttle froze the task and told the lead that the agent "made 2 runs on the task without
  progress" although no run of it had ever started. On 13.11 seven tasks were assigned to one engineer with two slots
  at once; two high-priority tasks that block four others were frozen that way while the engineer was working. 46 of
  the 50 expiries of the last 72 hours carried the wait reason `agent_concurrency`.
- The age check now leaves such a run in the queue: the start sweep has named its wait `agent_concurrency` (the
  agent's own concurrency ceiling is full) and the agent has a run in `running` at this moment. It starts when a slot
  frees, as any queued run does. The task-state checks still apply to it: a reassigned or closed task cancels
  the run as before.
- Nothing else changes. A run with that wait reason but no running run behind it (a lost start), a run held for
  another reason or for none, and a run behind another agent expire as before, and two expiries in a row still freeze
  the task (OPE-12290).

### The "Review CI wait" monitor no longer wakes the reviewer onto a red head (EMPTY-RUNS-2B)

- The hand-off to review does not wake a reviewer while the pull request head is red (`wait_red`, OPE-12176) and arms the board's "Review CI wait" monitor instead. The tick of that monitor only asked whether CI was still running, so ten minutes later it woke the reviewer onto the same red head with "do not wait for CI, submit the decision now". When the head was red because main was red, the reviewer could only return the task and the executor then ran to find nothing to fix (13.11: one such executor run took 139 model calls and 5.9 M input tokens).
- The tick now applies the admission rule of the hand-off. While CI runs or cannot be read the monitor is re-armed as before; while the finished head is red it is re-armed too (`issue.monitor_deferred` with the reason `review_head_red`, next check in ten minutes). A green head, a critical issue, a task without a pull request or without hosted CI wake the reviewer as before.
- The wait on a red head is bounded by the CI-wait budget of a review stage (`REVIEW_CI_WAIT_MAX_ATTEMPTS`, 18 ticks of the monitor): past it the reviewer is woken as before, so a red head nobody fixes does not park the task for good.

### The executor's comment does not wake the reviewer while the review stage waits for green CI (EMPTY-RUNS-2)

- A hand-off to review goes through the green-CI admission gate: while the `CI result` of the pull request head is not green the reviewer is not woken, and the board arms its "Review CI wait" monitor, whose tick wakes the reviewer once the head CI is final. The comment path did not know about the gate: the executor's closing note, posted as a separate request seconds after the hand-off, woke the reviewer with `issue_commented` past it. The reviewer run found an unfinished CI, could not record a verdict and ended with one more comment. On the release board (12–13.11.2026) 111 of 136 reviewer comment wakes came from an engineer's comment, 89 of them while the monitor was armed.
- Both comment paths (`POST /issues/:id/comments` and `PATCH /issues/:id` with a comment) now apply the same admission decision as the status change. The wake is held back only when all of this holds: the task is `in_review` with a pending review stage, the wake would go to the stage reviewer, the author is the agent that handed the task over, the "Review CI wait" monitor is armed, and the head is not admitted yet (CI pending or unreadable, or the head is red). The comment stays in the thread and the reviewer reads it when the monitor wakes it; the board writes an `issue.review_comment_wake_deferred` activity row.
- Everything else wakes the reviewer as before: a person's comment, another agent's comment, an explicit resume, an @-mention, a critical task, a green head, and any comment after the reviewer was admitted (no armed monitor).
- The gate ships enabled. `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED=off` turns it off: every comment then wakes the assignee exactly as before.

### Deliveries of one GitHub pull request no longer kill each other with deadlocks; the reason of a failed query is logged (EMPTY-RUNS-3)

- On 13.11 a dozen jobs of one pull request finished within a second. Their deliveries updated the work-product rows of the pull request in their own order, Postgres killed one of each pair (`ERROR: deadlock detected` on `update "issue_work_products" set "metadata"`, 15 times in an hour), `POST /api/myrmidon/github-app/webhook` answered 500 (14 times in the same seconds) and the event was lost.
- Deliveries of one pull request now run one after another: the transaction of a delivery takes a transaction-level advisory lock of the pull request first, and locks the rows of the pull request in one order (by id) before it writes. A transaction that Postgres rolled back for a deadlock (40P01) or a serialization failure (40001) is run again, up to 4 runs in all, with a growing pause; the wakes and live events of a rolled-back run are dropped with it. The `metadata` of a work product is merged by Postgres on the row as it is at the moment of the write (`metadata || patch`), not written from an object put together from an earlier read, so a key written by another writer is kept.
- The reason of a failed query is in the log now. The query builder wraps the driver's error and its text is the statement; the 500 line of the request log and the stored `lastError` of the delivery carry the Postgres code and text (`postgres 40P01: deadlock detected`), and the error context has a `db` object with the code, the text and the table (never the statement, its parameters or the row detail).
- The writes of the CI return — the system comment, the `issue.ci_failed` and `issue.ci_infra_retry_needed` rows, the return of the task — go through the transaction of the delivery (a savepoint inside it), not through a connection of their own; a delivery rolled back by a deadlock and run again therefore writes them once, and the lock the delivery holds on the work-product rows is no longer waited on by a second connection that wants the task row. What must happen once — the activity publications and the notice to the board merge — is queued and sent after the commit; a failure of such an action is logged with its reason and does not fail the delivery.

### Cancelling an omp_local SSH run no longer depends on the board reaching the process first (1.6.8 OMP-RUN-GUARD-2)

- On 13.11.2026 two omp sessions kept running on the runner after their run was cancelled because of a task reassignment: 46 and 22 minutes, 337 model calls, 28.6M input tokens. OPE-12801 (#2980) made the SSH lane stop the runner's processes once the local ssh client ends on a signal; that part is a prerequisite and is unchanged.
- What was still missing: the board stops the local ssh client only if the client is registered in `runningProcesses` at the moment of the cancellation. A cancellation that came while the client was being started found nothing to stop, and the adapter looked at the aborted signal only after the process ended on its own (up to `timeoutSec`, 3 hours).
- The `omp_local` adapter now listens to the run's cancellation signal while OMP runs (SSH runs, which opt into signal cancellation) and signals the local client itself (SIGTERM, SIGKILL after `graceSec`); an abort that came before the client was registered is applied when it starts. The client ending on a signal makes the target stop OMP and its tools on the runner, as before.

### Model call limit for omp_local runs (1.6.8 OMP-RUN-GUARD-1)

- An `omp_local` run had no limit on model calls, only `timeoutSec` (3 hours). On 13.11.2026 omp sessions averaged 101 model calls (median 60, 90th percentile 239, maximum 494); 41% of all omp calls were made after the 100th call of a session and 27% after the 150th.
- The adapter now feeds the board's run guard from omp's JSON event stream: every `turn_start` is one model call, every `tool_execution_start` is one tool call. The limit is the same as for hermes: 150 calls by default, overridden by the same settings (agent card `runGuard.modelCallLimit`, team liveness `runGuard`, `MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT`).
- 15 model calls before the limit the agent gets the wrap-up message (commit, push, write a comment on the task). The adapter leaves it in a steer file and a small omp extension loaded with the run (`--extension`) hands it to the session at the next step boundary.
- On the first call past the limit the adapter stops the omp process (SIGTERM, then SIGKILL after `graceSec`) and reports the stop to the board; the existing run-guard continuation (`run-guard-stop`) decides about the next run. The other guard stops (read-only exploration, repeated call, idle) now apply to omp runs as well.
- The hint text moved from the hermes gateway adapter to `@myrmidon/adapter-utils/run-guard-hint`, so both adapters say the same thing.
- A run the guard stopped over SSH restores its workspace like a run that hit the adapter timeout.

### Fixed: remote runner workspace upload no longer fails with "ssh exited before tar finished" (OPE-13041)

- The workspace upload to a remote runner (`syncDirectoryToSsh`, `packages/adapter-utils/src/ssh.ts`) piped local `tar` into `ssh`. When `ssh` closed with exit code 0 a moment before the local `tar` reported its exit, the transfer was stopped and reported as `ssh exited before tar finished (code 0)`, which failed the whole run although all data had been delivered.
- The outcome is now decided by the exit codes of both processes. After `ssh` exits with code 0 the upload waits for `tar` (up to 10 s) and succeeds when `tar` exits with 0. A failing `tar` is reported with its stderr tail, a failing `ssh` with its own stderr tail or exit code. The transfer protocol and directory layout are unchanged.
- Covered by `packages/adapter-utils/src/ssh-tar-finish-order.myrmidon.test.ts`.

### The stale-block sweep no longer fails forever on a task with a dead cited reason and an open blocker (STALE-BLOCK-LIVE-EDGES)

- On 13.11 the board logged "stale block sweep failed for one task" about 50 times an hour, for the same 14 blocked tasks on
  every pass, with no cause in the log. Each of them had a cited reason (`unblockDescriptor.reasonRef`) that had died —
  a passed date, a passed event deadline or a closed recovery incident — and at the same time a blocked-by edge to a
  task that is still open. With a reasonRef the sweep never looked at the edges, judged the block dead and moved the
  task to `in_progress`; the issue service refused ("Issue is blocked by unresolved blockers"), the transaction rolled
  back and the next pass did the same.
- The sweep now counts an open blocker on an edge the reasonRef does not cover as a live reason: the task stays
  blocked, the pass reports it as `skippedLive`, and the task wakes through the ordinary `issue_blockers_resolved`
  path when that blocker closes. A dead reasonRef whose blockers are all done or cancelled is unblocked as before.
- The failure warning now carries the class of the exception and its HTTP status (`errorName`, `errorStatus`), and
  still nothing of its message, code, cause or stack.

## 1.6.8

### The omp SSH runner's /tmp moves to the data disk and is pruned (OPE-12966)

- The SSH runner compose template (`docker/agent-runtime/omp-ssh/compose.yml`) now binds
  `${OMP_RUNNER_DATA_DIR}/tmp` at `/tmp`. Until now the runner's `/tmp` stayed in the
  container's write layer on the host's root disk: tests and task tooling wrote gigabytes
  there (15.8 GB in two days) and nothing removed them. Create `tmp/` with mode `1777` next
  to `workspace/`, `home/` and `hostkeys/` before the first start; a running runner needs
  the volume added to its compose file and a recreate.
- The host GC (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) removes top-level entries of
  `<runner root>/<runner>/tmp` that nothing inside has changed in for 24 hours
  (`--runner-tmp-ttl`, at least 3). It runs only when a runner root is configured
  (`--runner-root` / `HOST_GC_RUNNER_ROOTS`, set by the repo's systemd unit), never follows a
  symlink or leaves the filesystem, and never removes `tmp` itself. Journal events
  `runner-tmp-removed`, `runner-tmp-remove-failed`, `runner-tmp-skipped`,
  `runner-tmp-scan-failed`; the counter `runnerTmpRemoved`.

### Bots of agents that left the bot runtime are decommissioned (OPE-12654)

- An agent whose card moved from `hermes_gateway` to another adapter, or that was terminated,
  dropped out of every bot-container listing: its container kept running and its data
  directory stayed forever. The reconcile sweep now finds such bots every 10 minutes (from the
  card or its config history) and decommissions them: the container is stopped and deleted,
  with its leftovers.
- A bot is held, not removed, while its agent has a running heartbeat run, while its
  clone-hygiene report shows unpushed work (dirty tree, stash, operation in progress, commits on
  no remote), or when it is running without a usable report; the board log names the reason
  once (`bot_decommission_held`).
- dockergate: new route A22 `DELETE containers/myrmidon-bot-<K>?force=true&v=true&myrmidon-decommission=true`
  for the stopped main container only. Stopped leftovers (`.next`, helper) go first, then the
  main container without a replacement. The gate runs as uid 65532 with the volume root
  read-only, so it does not remove `<volumeRoot>/<K>`: it logs `bot_data_left_for_host_gc`,
  and the quota project waits too (`disk_project_still_has_directory`,
  `quota_left_for_host_gc`).
- The host GC pass (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) removes the data
  directory instead: 24 h after the bot's last change, and only when no `myrmidon-bot-<key>`
  container of any state remains, the board lists no `hermes_gateway` card for the agent (it
  moved away, was terminated or deleted), no heartbeat run of the agent is `running`, and no
  git worktree under the directory holds unpushed work (uncommitted edits, stash, an
  operation in progress, commits on no remote). `.next` and `.helper` directories are not
  worktrees and are not touched. After the removal the pass clears the quota project's
  `/etc/projid` and `/etc/projects` entries and its limits. An unreachable docker daemon or
  board keeps the directories (fail-closed); a directory with unpushed work is held and
  journalled loudly (`bot-data-held-unpushed`).
- Terminating or deleting an agent decommissions its bot through the same route (the old
  cleanup's delete was always refused by the gate); a bot on a fleetd site still goes through
  the site's cleanup.

### GitHub App disabled-webhook attention card and addressable silence alarms (1.6.8 OPE-12868)

- Added the `github_app_webhook_disabled` critical operator attention card: when `POST /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/webhook-sync` gets HTTP 404 from GitHub on the hook-config `PATCH` (meaning **Settings → Developer settings → GitHub Apps → Webhook → Active** is off on GitHub), the server latches a process-local signal (`companyId`, `entryId`, `appId`, `webhookHost`, timestamps — no secrets) and clears it automatically once a later `webhook-sync` succeeds.
- `githubConnectionEventService.sweepWatchdog` now mints the company `issueNumber` and `identifier` (`<prefix>-N`) in a transaction when creating a `github_events_silence` alarm issue, making the alarm addressable like any other task.

### One shared pnpm store for all bots again, on the bots' filesystem (OPE-12869)

- OPE-12720 moved the pnpm store into each bot's own tree (`/workspace/.pnpm-store`). On the
  bots disk that cost 2.4-2.6 GB per bot, the bots volume ran out of space and the bot rollout
  stopped. The store is back to ONE store for all bots: the host directory
  `<sharedPackageCachePath>/pnpm-store` bound read-write at `/cache/pnpm-store`, the sixth pair
  of the package cache mounts (dockergate's `PackageCacheMounts` and its prepare scripts list it
  again). The default `pnpmStoreDir` is `/cache/pnpm-store`; a stored `/workspace/.pnpm-store`
  reads as that default, and a path inside the bot's own tree stays allowed with a warning (a
  store per bot).
- Why this one shares: pnpm imports `node_modules` by reflink (`clone`), and a reflink works
  between mount points of ONE filesystem. The 1.6.5 shared store sat on the root disk, another
  filesystem than the bot volumes, so pnpm copied ~3 GB into every clone. The cache root must
  now be on the same XFS filesystem as the bot volumes (outside `MYRMIDON_BOT_VOLUME_ROOT`), for
  example `/srv/myrmidon-xfs/package-cache`: the store then costs one physical copy for all
  bots. The board cannot see the host filesystems, so this is an operator requirement; the
  start-time reflink self-check of the bot image (`hardlink-check.json`) reports a store on
  another filesystem.
- Operator steps: create `<packageCacheRoot>/pnpm-store` owned by 10001:10001 on the bots
  filesystem, deploy dockergate together with or before the board (the old dockergate refuses
  the `pnpm-store` bind with `mount_source_not_allowed`), then the board. Existing clones have
  the per-bot `storeDir` in `node_modules/.modules.yaml`; the first `pnpm install` there purges
  and reinstalls from the shared store (the pnpm wrapper's
  `--config.confirm-modules-purge=false` from OPE-12720 stays: pnpm 10 aborts the purge without
  a TTY otherwise). The per-bot `workspace/.pnpm-store` directories are unused afterwards and
  can be removed.
- The image's own default `npm_config_store_dir` stays `/workspace/.pnpm-store` (a bot without
  the cache bind has no `/cache/pnpm-store`, and its root filesystem is read-only); the board's
  profile `.env` overrides it for bots with the shared cache.
- Tests: the bot-disk-cache, template, docker-driver and profile-compile suites and the
  dockergate policy and contract fixtures are back to the six-pair list; a new case asserts that
  two bots get the same store mount and the same store variable.

### Stack registry can read host image versions through dockergate (OPE-12922)

- dockergate has a new optional `inspectOnlyImages` config list: exact image refs (tag or digest) whose image inspect is allowed read-only, with the same labels-only answer. They are never allowed for container create; only `images` is.
- The stack registry probe takes the exact refs of a docker-image component from `MYRMIDON_STACK_IMAGE_<NAME>` (for example `MYRMIDON_STACK_IMAGE_CLICKHOUSE`) instead of the tagless seed refs that resolved to `:latest` and answered 404. Unset keeps the old behaviour. Point `MYRMIDON_STACK_DOCKER_SOCKET` at the dockergate socket and list the same refs in `inspectOnlyImages`.

### IDLE-STOP works for fleetd bots: stopIdle route, idle-stopped mark, one warning per process (OPE-12663)

- fleetd gains `POST /v1/bots/<key>/stopIdle`: it stops the container and records an
  `hermes/.myrmidon/idle-stopped.json` mark in the bot's volume root, the same contract the
  local docker driver has. The status and list answers carry `idleStopped: true` while the
  mark stands; a wake (`start`) or an operator stop clears it. A docker container in any
  non-running state (e.g. `exited`) now reads as `stopped`, so the reconciler honors the
  mark and leaves the container down until the next run wakes it.
- The fleetd driver client (`fleetd-driver.ts`) gained `stopIdle`, so IDLE-STOP stops bots
  on a fleetd host instead of logging the unsupported-driver error.
- The sweeper logs "driver cannot idle-stop" as a single warning per process instead of an
  error on every sweep (the condition is permanent; a real stop failure still logs an error
  per occurrence).

### Stack registry: LiteLLM local version probe reads /public/model_hub/info (OPE-12718)

- LiteLLM has no `/version` route, so the http-version probe always answered
  "unreachable / 404" and the board showed no running version for the litellm
  component. The probe now targets LiteLLM's public model-hub endpoint
  `/public/model_hub/info` and reads the version from its `litellm_version`
  field; the generic `version` / `api_version` fields stay accepted as
  fallbacks. A bare base URL in `MYRMIDON_STACK_HTTP_LITELLM` is now enough —
  the documented endpoint is appended automatically, as for hindsight and
  Langfuse.

### The pnpm store sits on the same mount as the task clones (OPE-12720)

- On the bots disk the shared pnpm store of 1.6.5-1.6.7 (`/cache/pnpm-store`) was on the root
  disk, while the task clones live under the bot's own bind mount. A hard link cannot cross a
  mount point, so pnpm copied ~3 GB of `node_modules` into every clone. The store is now
  `/workspace/.pnpm-store`: the per-bot store of BOT-DISK-D on the clones' own mount, chowned to
  the bot and skipped by the draft sweep. It is not `/bot/.pnpm-store`: the `/bot` root is
  root-owned (0711) on a production host, the bot user cannot create an entry there and every
  `pnpm install` would fail with `EACCES`.
- `/workspace/.pnpm-store` is also the previous image's own default, so the board can roll out
  before the image: the profile `.env` it rewrites for a bot whose container still runs the
  previous image names a path that image can write (no ordering between board and image is
  required). A stored `general.botDisk.pnpmStoreDir` of `/cache/pnpm-store` reads as
  `/workspace/.pnpm-store` with a note in the log; the setting accepts any path inside the
  bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) and refuses a path elsewhere
  (`/cache/...` included).
- The operator step is gone: `install -d <sharedPackageCachePath>/pnpm-store` is not needed, and
  the `pnpm-store` subdirectory is dropped from dockergate's mount list and prepare scripts, so
  deploy dockergate together with or after the board (the new dockergate refuses the old board's
  `pnpm-store` bind; the old dockergate accepts the new board's shorter list). The host
  subdirectory, if it exists, is unused and can be removed once no container of the previous
  layout runs. `/cache/pnpm` stays the download cache.
- Rollout for existing clones: their `node_modules/.modules.yaml` still has the old `storeDir`
  (`/cache/pnpm-store/...`). The first `pnpm install` in such a clone finds a different store,
  removes `node_modules` and installs again from the new store; without a TTY pnpm 10 asks for
  the removal and aborts (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The bot image's pnpm
  wrapper injects `--config.confirm-modules-purge=false` for `pnpm install`/`pnpm add` — the
  pinned pnpm 10.18.1 reads `confirmModulesPurge` from the command line only, not from
  `npm_config_*` or `.npmrc` — so an agent's plain `pnpm install` purges non-interactively.
  `pnpm add` and `pnpm update` refuse with `ERR_PNPM_UNEXPECTED_STORE` until it has run. New
  clones need nothing. The first install of each bot fills the new store from the download cache.
- Acceptance check: compare `df` of the bot partition before and after a fresh `pnpm install` in
  a new clone; the delta is the size of the packages that were new to the store, not the ~3 GB of
  a full `node_modules`. `du -xs node_modules` is not a check: it counts a linked file in full.
- Tests: the bot-disk-cache, template, docker-driver and profile-compile suites assert the new
  default (under `/workspace`, never at the `/bot` root or at `/cache/pnpm-store`), the absent
  bind and the migration; the image tests assert the Dockerfile and entrypoint defaults; the
  dockergate policy tests drop the `pnpm-store` pair; the pnpm-wrapper purge test
  (`pnpm-wrapper-purge.test.mjs`) asserts `--config.confirm-modules-purge=false` on
  install/add and its absence on the light lanes.

### A bot's npx and cargo caches stay under a byte quota (OPE-12110)

One bot grew `hermes/.npm/_npx` by 2.2 GB in 45 minutes (npx fetched a whole vendor package with all
its binaries), and a Rust `target/` in a task working copy reached 2.4 GB. botd now bounds both:

- `hermes/.npm/_npx`: entries older than 24 h are removed, and when the rest weighs more than the
  quota (512 MiB per bot) the entries written longest ago go first, until it fits.
- `hermes/.cache/cargo-target`, the per-bot `CARGO_TARGET_DIR` the bot image already sets (outside
  every task working copy): quota 2 GiB per bot, whole profile dirs (`debug`, `release`, a target
  triple) removed least recently written first. A bot that never builds Rust has no such directory
  and nothing creates it.

Both passes work on whole entries, never remove a path a process holds open, and never touch an entry
written in the last 15 minutes (an install or a build may still be going), so a quota can stay
exceeded for one pass. Each eviction is a line in the botd log. The quotas are set with
`MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` and `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` on the botd process.

### CI-QUEUE: cancel-in-progress concurrency for workflows running on main (1.6.7)

- Workflows triggering on push to `main` (image, bot image, cloud files, dockergate, extension, fleetd, media tools, redact, wiki-sync, pr-autoupdate, agent-runtime-images, extension-package) and workflow_run `main` trigger (main green gate) now configure `concurrency` with `cancel-in-progress: true` when running on `main`.
- Release branches (`rel/*`) and release tags (`myr-v*`) remain protected from cancellation (`cancel-in-progress: false`).
- Added `scripts/myrmidon/ci/check-workflow-concurrency.py` and unit test `scripts/myrmidon/ci/workflow-concurrency.test.mjs` verifying that all workflows triggering on `main` specify concurrency cancellation for `main`.

### One informational docs reminder comment on PRs that change API/schema/capability

A new GitHub Actions workflow (`.github/workflows/myrmidon-docs-reminder.yml`)
posts exactly one non-blocking comment when a pull request changes the API,
schema, or generated capability surface (`packages/paperclip-runner/generated/capability/`,
`server/**` schema files, `.agents/schemas/`) but ships neither a change
fragment (`docs/myrmidon/changes/`) nor a skill reference update
(`skills/myrmidon/references/`). The reminder is guarded by the
`<!-- docs-reminder -->` marker, so it is posted once per PR no matter how
many pushes; it never fails CI (docs-only and fork paths exit 0 silently).
Fragments stay mandatory only at the release cut
(`scripts/myrmidon/release/collect-fragments.mjs`); the reminder is a hint,
not a gate.

### fleetd on a remote site: a safe marker read, the same container template, writable caches

- A bot can no longer stall or exhaust fleetd through its applied marker. fleetd runs as root and
  reads `hermes/.myrmidon/applied.json` from a directory the bot owns. It now opens the file without
  following a symlink and without blocking, accepts only a regular file, and reads at most 64 KiB.
  A symlink, a FIFO, a directory or a larger file counts as "no marker".
- A container on a remote site now gets the template of the board host: `/tmp` as a tmpfs, an init
  process, the `on-failure` restart policy, and `MemorySwap` equal to `Memory`. A container that
  exists already gets the template at its next recreate.
- fleetd refuses a spec with `cpus` below 0.01 (a tiny value used to round to "no CPU limit"), with
  a `gatewayPort` outside 1024-65535, or with a `boardExtraHost` that differs from the site's own.
  The answer is `spec_invalid`. The board address in a container always comes from the site
  configuration.
- New configuration key `writableMountRoots` (default: empty). An extra mount without `readOnly` is
  accepted only when its source, with symlinks resolved, is inside one of these directories (and
  inside `allowedMounts`). Work bots can use their shared package caches on a remote site. Roll out
  the new binary before the configuration that uses the key.

### GitHub credentials cache, single-flight resolution, and per-run request fuse (OPE-12446)

- The GitHub operation credentials broker caches minted installation tokens in-memory for 50 minutes per company, agent, run, and repository, preventing duplicate token minting against the GitHub App hourly installation limit.
- Concurrent requests for the same repository and context join a single-flight token resolution promise, minting exactly one token from GitHub.
- Bot runtime launcher configures run-scoped credentials disk cache via `PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR` with 45-minute TTL and 0600 file permissions, eliminating repeated HTTP credentials requests from git and gh CLI invocations.
- Per-run request fuse rejects runaway credentials requests exceeding `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` (default 60/min, rolling 60s window) with HTTP 429 Too Many Requests.

### GitHub pull request reads are cached on the board, and nothing is asked while the rate limit is exhausted (OPE-12397)

The board reads the same ~100 open pull requests from several places (review rework, merge
details, the CI resolver, the work-product refresh), and none of those reads carried an ETag, so
each was a full `GET` answered with 200: about 4-5 thousand requests an hour used up the GitHub
App's budget of 5000, after which the CI gate of the review could not see the checks. The
provider that reads pull requests and issues now keeps a read cache per process:

- an open object is served from memory for `MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC` (default 120
  s; `0` turns the cache off); a merged, closed or not-found one for
  `MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC` (default 1800 s). A "not found" that an anonymous
  read got, and a merged pull request whose merge commit the default branch does not reach yet,
  are not final: they are re-read after the short TTL;
- after the TTL the read is conditional (`If-None-Match`): a 304 costs no rate limit and renews
  the entry;
- reads of one object that run at the same time share one request;
- while the shared rate-limit state says the budget is gone, nothing is sent to GitHub: the cached
  read (even an expired one) is returned, or the same "rate limited" answer a 403 gives, with the
  time to come back; the extra `/compare` request of a merged pull request is skipped too;
- when the board merges a pull request itself, its cache entry is dropped.

The cache keeps at most 5000 objects, the oldest leave first. A read that a caller makes with an
ETag of its own is answered as before.

### An exhausted anonymous GitHub budget no longer blinds the board's authenticated reads (OPE-12397)

The board keeps one shared GitHub rate-limit state, and since 1.6.7-rc.12 the pull request and CI
readers send nothing to GitHub while that state says the budget is gone. A response of a small
bucket — the anonymous 60 requests an hour, the search 30 a minute — was recorded into the same
state, so one exhausted anonymous bucket marked every authenticated read rate limited: on 09.11 the
review's CI reads were blind for half an hour with 3740 of the installation's 5000 left. Responses
whose `x-ratelimit-limit` is below 1000 are now only counted and no longer change the shared state.

### OMP sandbox: omp_local supports local process confinement (1.6.7 OMP-HARDEN)

- The `omp_local` adapter now supports the same local process sandbox as
  `claude_local`/`codex_local`: `filesystemScope: "workspace"` (Bubblewrap
  workspace-only filesystem), `networkScope: "deny" | "allowlist"` with
  `networkAllowlist`, `filesystemExtraPaths`, and `filesystemSandboxCommand`
  (default `bwrap`). With neither scope set, execution stays unsandboxed.
- The omp session directory (`--session-dir`, `~/.omp/paperclips/<companyId>/<agentId>`)
  and the managed agent-config directory (`models.yml`, skills) are mounted
  read/write inside the sandbox; the configured control-plane API URL is
  trusted for the adapter's runtime connection.
- New `omp_local` agents default to `filesystemScope: "workspace"` in the
  create form; the Agent Settings form now shows the shared sandbox and
  network fields for `omp_local` (no timeout keys — the adapter reads none).
- Sandbox keys of `omp_local` are validated on save and gated as a security
  change: editing them requires an instance admin, same as `claude_local`/`codex_local`.
- Bubblewrap that cannot create a Linux user namespace now fails the launch
  with an explicit error before the agent process starts; the process is never
  started without the requested confinement.
- The default `--tools` list was corrected for omp 18.9.2 built-ins
  (`read,bash,edit,write,grep`; `ls` is a hard error and `find` needs the `fd`
  binary) and is configurable via adapter `tools`.

### The review-stage CI reads are cached on the board, and nothing is asked while the rate limit is exhausted (OPE-12397)

The stranded-issue sweep asks GitHub for the CI of the open pull request of every review stage on
each heartbeat tick (30 s by default). Each ask was two to four `GET`s (the pull request, the
workflow listing, the `CI result` check, and in a repository without that check the checks of the
whole head), and none of them was remembered: about 2400 requests an hour were counted for the
`review-recovery` source out of the GitHub App's budget of 5000, after which the other readers of
GitHub (the CI gate of the review, the work-product refresh) went blind. The CI reads of the
review-stage recovery now keep a read cache per process:

- the head of a pull request is served from memory for `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC`
  (default 60 s). The CI verdict of a head commit and the list of its failed checks are kept for
  the same time while the CI is pending (or the verdict is unknown without an error), and for
  `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` (default 600 s) once the CI of the head is complete.
  `0` for both turns the cache off;
- an error (network, GitHub status, unreadable payload) is never stored, so the next sweep asks
  again;
- reads of the same head that run at the same time share one request;
- a result read with one token is never served to a caller with another;
- while the shared rate-limit state says the budget is gone, nothing is sent to GitHub (the
  workflow-listing probe included): the remembered result is returned, even an expired one, or
  "unknown" with the reason `...:skipped_rate_limited` and the time of the reset, which the review
  CI wait already uses to postpone the next check.

The cache keeps at most 5000 reads, the oldest leave first.

### The review-return loop pace is a setting, and its pass spends one read per pull request (OPE-12397)

The review-return (rework) loop swept every minute and re-read the pull request of every
candidate review task on every pass — up to 200 tasks, no deduplication between tasks that
share one pull request, terminal pull requests included, and every process of the
installation swept on its own. Together with the other GitHub readers this drained the
App's budget of 5000 requests per hour. The loop now:

- paces by the stored instance setting `sweepIntervalSec` (default 300 s, range 60–3600,
  the Review Rework panel edits it, saving applies without a restart);
- `MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC` overrides the stored value as the
  deployment fallback (the panel shows the override read-only, the LiteLlm budget-sync
  rule);
- reads each pull request at most once per pass: two review tasks linked to the same
  pull request cost one read, a task naming the same pull request twice costs one;
- skips candidates that cannot produce a move before any GitHub read: no rework child,
  no verdict keyword, and no live (non-terminal) pull-request work product;
- runs only on the "scheduler" leader process — the same leadership gate TASK-PR-SYNC
  uses — so secondary processes stop re-reading every candidate's pull requests.

Run-start context no longer refreshes pull-request metadata from GitHub: `loadRunPullRequest`
reads the stored work-product metadata (`headRef`, `repo` are already there), and the
wake-payload CI resolver reads only live (non-terminal) pull-request products of the task,
at most 10 references per build. GitHub reads are attributed per reader in the
`[github-rate-limit]` log: `review-rework`, `review-routing`, `run-context`, `ui-refresh`
join the existing buckets, and `review-routing` counts and honours the limit as the other
readers do.

### Instance → General: the "Workspace hygiene" panel is on the page (1.6.7 SETTINGS-UI, OPE-6249)

- The two disk ceilings of the workspace quota sweep, `workspaceQuotaMb` (one execution workspace) and
  `totalQuotaMb` (the sum of one company's measured workspaces), had a read/write route
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene`) and a finished panel component, but the component was
  never placed on the page, so the production UI had no way to see or change them. The panel "Workspace
  hygiene" now sits on Settings → General next to the bot disk panels. It shows both ceilings, the source
  of each value (default, environment override, saved here), the biggest measured workspaces and the last
  sweep, and saves through the existing `PATCH` route. An empty field means the cap is off.
- A save applies at once: the sweep reads the stored ceilings at the top of every tick, no restart.
- The source labels of the panel went through i18n (they were fixed English strings). A save or a read
  refused with 403 now says "Instance admin rights are required." instead of the raw server text; the
  `PATCH` route stays instance-admin only.
- The merged-workspace cooldown and the stuck-workspace signal delay stay in the Runs & Queue panel; they
  are not part of this one.

### Stack watch live: self-refreshing local versions, GitHub 403 retry with stale marker, persistent update cards, owner escalation (1.6.7 STACK-WATCH-LIVE, OPE-12141)

- The scheduled stack release check now refreshes the local side itself: the http-version probe reads
  running versions from `MYRMIDON_STACK_HTTP_HINDSIGHT` (Hindsight `/version`), `MYRMIDON_STACK_HTTP_LITELLM`
  (LiteLLM `/version`) and `MYRMIDON_STACK_HTTP_LANGFUSE` (Langfuse `/api/public/health`), so a component
  no longer sits at «not refreshed yet» until a manual admin refresh.
- GitHub 403 (anonymous rate limit) is retried once after a configurable delay and otherwise recorded as
  stale: cards and the UI carry an explicit «сверка не удалась N ч, данные от ДАТЫ» marker instead of
  silently keeping the previous cache.
- A `stack_update` attention card now lives while the component is behind, not just one check, and lags or
  security notes escalate into backlog tasks (deduped per component) plus a line in the daily Telegram digest.
- The seeded registry reads only `myr-v*` release tags for the board component and no longer treats
  pre-release or nightly tags as the latest release; RAGFlow is marked as retired from the stack.

### TASK-CARD-READINESS-4: Task card edit target existence verification on main

- Extends task card readiness verification (`assertTaskCardReadyWithEditTargets`, `verifyEditTargets`, `extractEditTargetPaths`) to verify repository file paths specified in «МЕСТО ПРАВКИ».
- Probes paths against the default branch via GitHub raw content; absent files yield `EDIT_TARGET_NOT_FOUND` (422 in enforce mode).
- Paths marked as new files («новый файл», «new file») are excluded from probing.
- Network errors or missing GitHub connections fail open with `EDIT_TARGET_UNVERIFIED` warnings without blocking transitions.

### TASK-CARD-READINESS-2: Task card readiness server gate

- Server-side readiness check for task cards (`assertTaskCardReady`) based on the slice-1 evaluation engine.
- Rejects incomplete cards with 422 `task_card_not_ready` in `enforce` mode; logs a warning during the 3-day grace period or when `MYRMIDON_TASK_CARD_GATE_MODE=warning`.

### OMP git-checkout workspace sync (1.6.8 OMP-GIT-ONLY-SYNC)

- `omp_local` SSH execution supports `workspaceSync: "git_checkout"` to transfer only the Git bundle and checkout for each run.
- The shared local workspace is not snapshotted, copied back, merged, or locked; skills and agent configuration assets continue to be staged normally.
- The default `workspaceSync: "full"` behavior is unchanged. Non-Git workspaces fall back to full synchronization.

### SSH transfer streams no longer crash the board (1.6.8 SSH-STDIN-EPIPE)

- SSH and tar transfer stdin streams now handle early-close/write errors and reject the current transfer instead of emitting an unhandled `EPIPE`.
- Uploads stop the peer tar/ssh process when either side exits early.
- SSH/tar stderr retained for transfer errors is limited to a 64 KiB tail, with an explicit truncation marker.

### Auto-created backlog drafts for lagging or security-flagged stack components (1.7-STACK-UPDATES-B)

- The daily stack release check now creates a backlog draft task (`todo`, `originKind stack_update`) per component that lags upstream by the configured number of releases or carries a critical security note — previously the check only produced attention cards and the draft had to be written by hand from the UI.
- Deduplication: while an open task for the same component exists (`originKind stack_update`, `originId` = component name, status not done/cancelled), no duplicate draft is created.
- The draft title and summary reuse the attention card wording, so the backlog draft and the "needs me" feed stay consistent; a security-only component (no lag, hence no attention card) gets a title/summary in the same shape.
- The lag threshold is configured with `MYRMIDON_STACK_BACKLOG_LAG_RELEASES` (default 2); the draft-creation step is injectable (`createDraft`/`findOpenComponents` ports in `checkStackReleases`), failures are logged per company without failing the check.

### Stack component CVE advisory integration via OSV.dev (1.7-STACK-UPDATES-B)

- Stack registry release verification now queries known vulnerabilities from OSV.dev API (`/v1/querybatch`) for tracked components.
- Components with matching advisories report advisory markers (`vulnerabilities` list with CVE id, primary id, and normalized severity) alongside release divergence.
- When the advisory source is unreachable or times out, release checking degrades gracefully without failing.
- Advisory endpoint base URL is configurable via `MYRMIDON_STACK_OSV_API_BASE`.

### DEVFLOW: load-based review routing with lead pool and idle rebalancing (OPE-10084)

- Company review pool now dynamically includes `lead` along with `reviewer` castes.
- Participant selection at review stage start and reassignment prioritizes the least loaded agent (pending stages and active runs queue), excluding the author and escalated stages.
- Automated rebalancing during review routing sweep shifts pending stages waiting longer than `rebalanceAfterMinutes` to an idle pool member with an immediate wake.

### CI: main runs complete instead of cancelling each other

- Every push to main cancelled the running Myrmidon CI run; with merges more frequent than a full run, main had no completed run for hours and `main-green-gate` never turned green. Pushes to main no longer cancel the running main run: the concurrency group keeps one running and one pending run, so runs do not pile up.

### CI and pull-request events from our own GitHub App reach the board (GITHUB-APP-WEBHOOK)

- New public receiver `POST /api/myrmidon/github-app/webhook`. The call is authenticated by GitHub's `X-Hub-Signature-256` (HMAC-SHA256 over the exact body, constant-time compare) against the webhook secret of the App entry named by `X-GitHub-Hook-Installation-Target-ID`; unknown App id answers `204`, a bad or missing signature `401`, an accepted delivery `202` with `{ companies, processed, duplicate, ignored }`.
- The delivery goes through the same event service as the connector events (`processForCompany` with no bindings): check_run / check_suite / workflow_run update the CI state of the pull request and return the task to its executor on a failed head, pull_request keeps the merge and conflict returns. Companies are picked by App id and `allowedRepos`; a delivery id is processed once per company; deliveries without a repository are ignored.
- New App-entry field `webhookSecretId` (company secret, server-owned) and `POST /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/webhook-sync` with `{ webhookUrl }`: creates the secret once, sets the App's webhook with the App JWT and answers the `{ url, contentType }` GitHub reports. A board save that omits `webhookSecretId` keeps the stored one.

### OPE-10494: bots ship the GitHub CLI from its own release (2.103.3)

- Bot images installed Debian's `gh` 2.46.0, which fails `gh pr view` and `gh pr edit` with "GraphQL: Projects (classic) is being deprecated"; bots retried the same command and runs stopped on repeated tool failures. Every bot image variant now carries `gh` 2.103.3 from the pinned, checksummed upstream release at `/usr/bin/gh`.

### Codex / ChatGPT pool account OAuth management, account plans (Plus, Pro, K-12), and sliding window load distribution (OPE-10775)

- Codex / ChatGPT account OAuth connection lifecycle directly from the board UI (`POST /providers/:id/oauth/start` and `POST /providers/:id/oauth/complete`).
- Persistent pool registry supporting subscription account plans (`Plus`, `Pro`, `K-12`) and account deletion.
- Sliding quota window tracking (5 hours and 7 days) with automated exhaustion detection.
- Dynamic account rotation (`selectActivePoolAccount`) automatically removing banned and exhausted accounts from rotation and failing over to available accounts.
- Automatic operator attention role signals for banned (high severity) and quota-exhausted (medium severity) pool accounts.

### Release reconciliation service and tests (1.7 STACK-UPDATES-B, OPE-12044)

- Added standalone release reconciliation module under `server/src/myrmidon/release-reconciliation/`
  with config reader, mockable GitHub client, in-memory issue sink, and reconciliation service.
- Normalises release and vendor tag versions (stripping `v`/`V`, `myr-v`, and image prefixes),
  detects divergences, and generates structured draft tasks with change summaries.
- Configurable via environment variables: `MYRMIDON_VENDOR_GITHUB_REPO`, `MYRMIDON_GITHUB_API_BASE`,
  `MYRMIDON_VENDOR_TAG`, `MYRMIDON_RELEASE_RECONCILIATION_INTERVAL_SEC`, and `MYRMIDON_RELEASE_TASK_COMPANY_ID`.

### Corpus: a failed document is parsed again with one button in the board UI (1.6.7 CORPUS-UI, OPE-12058)

- The documents table of the knowledge corpus screen shows a «Reparse» button for every document whose
  parse has failed (the RU text is «Разобрать заново»). It calls the reparse route the server half
  shipped in OPE-12029 (`POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`,
  `202 {document, job}`) — before this change the screen called the non-existent `…/retry` route and the
  button answered 404. The row is replaced with the returned document at once (back to `queued`, error
  cleared) and then confirmed by a refetch, so the list never keeps showing a stale `failed` row.
- Refusals of the route surface with their response text: `409 document_not_failed` / `409
  document_has_no_stored_bytes`, `422` when the embedder is not configured, `502 enqueue_failed` — the
  screen shows the `message` field of the error body (the human text), not the machine token.

### Wake diagnostics name the private-task suppression reason (OPE-12197)

- A wake skipped because its issue is private to another agent is now shown with its own reason `heartbeat.private_issue_suppressed` instead of "other" in the issue wake diagnostics.

### Server and client: add limit and before cursor for heartbeat-runs list (OPE-12210)

- `GET /api/companies/:id/heartbeat-runs` now defaults `limit` to 200 (max 1000, validates non-numeric input as 400) and supports `before` (ISO createdAt cursor) for efficient pagination without heavy full-table aggregation or unconstrained SELECTs.
- `heartbeat.list` and `listVersionKey` are scoped to the requested pagination window and return `X-Next-Cursor` when rows equal `limit`. The response remains a raw array of heartbeat runs for full backward compatibility.
- Updated UI (`AgentDetail`, `AgentDetail.production`, API clients) and CLI (`client run`, `heartbeat-run`) to support limit and pagination.

### Datastore-care audit: pg_settings unit factors, pgvector relkind filter, external backup coverage (1.6.6 DBC-4, OPE-12248)

- The audit report multiplies each `pg_settings` memory parameter by the byte
  factor of its `unit` column (B/kB/MB/GB/TB and the page units `8kB`/`16kB`),
  so `work_mem` 32768 kB is reported as 32.0 MiB with a true «attention»
  verdict against the 16 MiB threshold, and `shared_buffers` /
  `effective_cache_size` given in 8kB pages are shown in GiB instead of KiB.
- The pgvector column query filters `relkind = 'r'`, so an HNSW index record is
  no longer listed as an unindexed vector column («1 из 2 ok» → «1 из 1 ok»).
- New env `MYRMIDON_DATASTORE_CARE_BACKUP_EXTERNAL` (a coverage label such as
  `vm-pbs`): when set, the `backup-freshness` criterion reports the external
  coverage as healthy with the env as its source and does not scan the local
  backup directory.

### Heartbeat: non-hermes agents skip bot container idle-stop check during transient retry (1.6.7 RETRY-NONHERMES, OPE-12269)

- In `heartbeatService.claimQueuedRun()`, the IDLE-STOP container health check (`idleStopService.ensureStartedAndHealthy()`) is now guarded to only run for `hermes_gateway` agents that have `adapterConfig.container.enabled === true`.
- Previously, scheduled retries with cause `transient_failure_retry` for agents with non-hermes adapters (such as `omp_local` or `codex_local`) invoked the container check without verifying adapter type, causing immediate `hermes_gateway_connect_failed: dockergate: denied (bot_not_enrolled)` failures, infinite retry loops, and stranded task execution locks. Non-hermes agents now follow the standard adapter dispatch path during retry.

### Provider garbage detection and bounded retry protection (OPE-12286)
Upstream model provider stub replies (e.g. maintenance notices or overloaded messages returned with HTTP 200 in sub-second time) are now detected and classified as `provider_garbage`. The heartbeat persists a `run.provider_garbage.detected` event, and the devflow health collector turns recent events into one critical (P1) signal per outcome/model-group burst, including the outcome text and model group. Suspect runs do not enter recovery-block; instead, they receive bounded retries with a pause (`MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS`, default 3; delay `MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS`, default 300s).

### CI: affected tests now always run static guards that read app.ts via fs (OPE-12295)

- The `tests (affected)` tier now always includes
  `server/src/myrmidon/app-plugin.myrmidon.test.ts` when one of the shared
  guard triggers changes (`server/src/app.ts`, `server/src/index.ts`,
  `server/src/myrmidon/app-plugin*.ts`, `docs/myrmidon/FLAGS.md`,
  `docs/myrmidon/SETTINGS.md`). The suite reads `app.ts` through
  `readFileSync` (not an import), so the dependency graph could not discover
  it; PR #876 merged with a green PR CI but red main because the mounts
  snapshot was stale.

### Fail-closed bot container cleanup on agent termination and deletion (OPE-12323, PR #2803)

- Terminating (`POST /api/agents/:id/terminate`) or deleting (`DELETE /api/agents/:id`) an agent with an active bot container now performs a fail-closed cleanup against the execution runtime or remote fleetd site (`POST /v1/bots/:botKey/cleanup` or `DELETE /v1/bots/:botKey`).
- The cleanup removes both the running Docker container and the host-side bot volume directory (`volumeRoot/:botKey`), preventing orphaned containers and residual disk usage.
- The operation is fail-closed: if the remote site is unreachable or container cleanup fails, the terminate/delete endpoint returns an error and leaves the agent record in the database so the operation can be retried safely.
- The fleetd route `/v1/bots/:botKey/cleanup` (also accepting `DELETE`) is idempotent and treats missing containers (Docker 404) or already-removed data directories as successful cleanups.

### OPE-12335: deploy.sh exclusive deploy lock protection against parallel runs

- Added exclusive deploy locking (`flock`) at the beginning of `scripts/myrmidon/deploy/deploy.sh` via `acquire_deploy_lock` in `lib.sh`.
- Prevents concurrent deployments from overlapping and racing during maintenance and container recreation.
- Supports `MYRMIDON_DEPLOY_LOCK_FILE` (defaults to `$STATE_DIR/deploy.lock` or `/var/lib/myrmidon/deploy/deploy.lock`) and `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` (defaults to 0).
- If the lock is held, exits immediately with code 42 and prints the holder's PID, start time, and version (or waits if `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` > 0).
- Dry-run mode warns if the lock is held without acquiring it.
- Automatically releases and cleans up the lock file via a trap on EXIT, INT, and TERM.

### Bot card: validate memoryMb, cpus and pidsLimit against dockergate platform ceilings (1.6.7 OPE-12337)

- Saving or updating an agent card with `adapterConfig.container` now validates requested resources against enrolled dockergate limits (route A21 `GET /myrmidon/bots/{botKey}/limits` / platform ceilings).
- An update exceeding enrolled ceilings is rejected at card save time with HTTP 422 ("exceeds dockergate ceiling ... for this bot; raise bots[].maxMemoryMb in dockergate config.json and reload dockergate (SIGHUP)") rather than silently saving and failing later during container reconciliation with 403 `dockergate: denied (limit_exceeds_enrollment)`.
- The bot container status API (`GET /api/myrmidon/agents/:id/bot-container/status`) and agent card UI now report the running container's actual resource limits alongside requested card limits and display divergence warnings with the reconciliation denial reason when they differ.

### Model Providers screen and fallback editor: full RU localization, correct pool counters and badges (OPE-12361)

- Model Providers screen and the gateway fallbacks editor are fully translated for the RU locale: account table headers (plan, actions), pool attention signals, live/total/exhausted/disabled counters with the "next reset" line, `Codex OAuth Login` (now shown only on ChatGPT-pool cards), `Show diff`, ok/error statuses, and the whole fallbacks editor (Save Changes, Fallback Chain, cycle detection, warnings, add-target placeholder).
- Pool channel summaries no longer count `error` accounts as live. The reset date now comes from the real channel data: the earliest still-future limit window across non-banned/non-disabled accounts, so a rotated stale cache (e.g. an outdated 21.10 reset) can no longer shadow the real upcoming reset; the connectors never carried a pool-level reset document, so that dead read path is gone.
- Change log rows render the real author name/email; every audit writer (gateway keys, models, fallbacks rollback, provider mutations) now persists the display name from the authenticated actor instead of `user:<id>`. The fallback role labels (agent/board/system/user) come from the locale catalog, so the English UI no longer renders Russian words.
- Pool models are no longer badged "Paid" (pools are subscriptions); the fallback editor stops flagging pool groups with false "single provider (openai)" / "Paid fallback channel" warnings by deriving the provider from the board channel registry (pool type) instead of the LiteLLM prefix, and `kie-gpt-6-luna` is no longer reported "Free" (strict paid-provider check).
- Fixed 404 on page open: the hindsight model-groups route is now mounted under the company-scope alias.
- RU/EN locale parity and the latin-scan guard updated accordingly.

### Corpus: embedding gateway retry and hybrid vector search resilience for cold query p95 < 2s (OPE-12372)

- Added 1 retry with exponential backoff on transient embedding gateway failures/timeouts in `corpus_search` / embedder adapters to eliminate embedding tail latency spikes on cold questions.

### Financial history integrity: deleting agents with cost_events rejected with 409 Conflict (OPE-12475)

- Deleting an agent (`DELETE /api/agents/:id`) that has recorded financial cost events (`cost_events`) is now rejected with `HTTP 409 Conflict` (`code: "agent_has_cost_events"`). Callers must terminate the agent (`POST /api/agents/:id/terminate`) instead of deleting it to preserve financial audit history.
- Deletion failures caused by remaining foreign-key references are handled cleanly and return `HTTP 409 Conflict` (`code: "agent_referenced"`) instead of uncaught 500 errors.
- Pre-deletion checks verify `cost_events` under row-level lock before native run dependency cleanups or record deletions.

### Re-scope shared bot runtime RO-layer to bin only (1.6.5-BOT-DISK-H11, OPE-12493)

- Exclude `lazy-packages` and `lsp` from `general.botDisk.sharedBotRuntimePath` read-only mounts. Only `bin` (~38 MB per bot, ~2.4 GB fleet-wide) is shared read-only across bots on the host. `lsp` is kept writable per bot and `lazy-packages` remains image-specific.
- Dockergate policy `BotRuntimeMounts` updated to accept only `bin`.

### Per-bot npm content cache quota (1.6.7 BOT-DISK)

- botd now enforces a 512 MiB per-bot `hermes/.npm/_cacache` limit after age-based cache cleanup. It removes oldest complete content and index shards first, skips open paths and active runs, and logs each idle quota pass.

### OPE-12557: advisory-lock transactions no longer exhaust the database pool

- Wake-queue release runs its host callbacks on the release transaction's connection instead of taking a second pool connection while it holds the lock.
- At most two locked conversation deliveries run at once per process; the others wait without holding a connection. On 10.11 all 12 pool connections were taken by transactions waiting for each other after `pg_advisory_xact_lock` and the board stopped.

### OPE-12577: the manager is woken after a final run guard stop

- A final run guard stop blocks the task and wakes the assignee's manager (`run_guard_stop_needs_input`). The stopped run still held its environment lease for a moment, an execution hold, so the manager's wake was parked as an execution wait and never ran: 5 such wakes ran for 235 stops in 72 h, and engineers sat idle on blocked tasks.
- The wake of the assignee's `reports_to` (or `adm`) passes the execution hold at enqueue and is not made stale by it at claim; the assignee and the blocked status stay as the escalation set them.

### OPE-12578: the board keeps its runs after its own event-loop stall

- A run's controller lease was treated as lost as soon as its expiry passed, although no other process had taken it. After a stall of the board process every run it controlled was cancelled ("Legacy controller lease lost": 27 runs on 10.11 03:29Z, ~140 on 09.11).
- Renewal is now decided by the boot id (revocation always replaces it); a passed local deadline first asks the database and aborts only when the renewal is refused, fails, or does not answer within 5 s; a failed background renewal is retried on the next tick.

### OPE-12579: secret masking of run logs no longer stalls the board on long unbroken lines

- The JSON secret-field patterns of `redactSensitiveText` (server/src/redaction.ts) used an unbounded field-name pattern and backtracked quadratically on a long run of name characters (a base64 blob in a run's stdout). On 10.11 a 183 878-character line held the board's event loop for minutes and runs across the fleet lost their controller leases.
- Free-text scans now use a field name that starts only where a word run starts and has bounded name parts: 2 000 000 characters take ~15 ms. Masking results are unchanged; key checks keep the old pattern.

### OPE-12609: fix false DEPLOYED-DEGRADED on idle-stopped, stale OOM and transient unhealthy bots

- Corrected bot classification in `bot-apply-smoke.sh` during post-deploy verification to prevent false `DEPLOYED-DEGRADED` results (rc.17 and rc.19 incidents):
  - Missing runtime container ("No such container", absent docker inspect output) for an agent without a board error is classified as `idle_stopped` rather than an active unhealthy gateway, excluding it from the active smoke denominator. Empty inspect fields now normalize to `missing` rather than printing `docker:`.
  - `OOMKilled=true` is counted as a deployment casualty only if the container's `FinishedAt` timestamp is inside the deployment window (`>= --deploy-started-at`). Stale OOM killed containers from before the deployment window are excluded as pre-deploy `idle_stopped`.
  - Docker or board `unhealthy` mark is evaluated on the current poll via an active `/health` probe response (`docker exec … curl /health`); bots whose gateways recovered by the end of the maintenance window pass as `healthy` instead of failing the deploy with a sticky `crashed:docker_unhealthy`.
  - Genuine exits, in-window OOMs, and dead gateways continue to produce `DEPLOYED-DEGRADED`.

### OPE-12609: the post-deploy bot smoke no longer reports idle-stopped bots as crashed

- Docker keeps the last Health.Status of a container after it stops, so a bot idle-stopped hours before the deploy still read "unhealthy" and the smoke reported it as `crashed:docker_unhealthy` (rc.20, 10.11: seven bots, deploy exit code 1 on a healthy fleet). The health mark now counts only for a container that is not exited, dead or created; a stopped one is judged by its exit (before the deploy, or an idle-stop 143, is idle).

### omp agents run in their own container: the omp SSH runner (OMP-SSH-RUNNER, OPE-12633)

- New image `agent-runtime-omp-ssh`, built and signed by the agent-runtime image workflow. It adds Bun and omp (pinned like the board image), pnpm, the GitHub CLI, a C toolchain and a key-only sshd (port 2222, user `paperclip`) to the agent runtime base image.
- An `omp_local` agent is attached to a board SSH environment that points at one runner container per agent (template: `docker/agent-runtime/omp-ssh/compose.yml`). The runner has its own limits; the defaults are those of an engineer bot container: 4 GB, 1 CPU, 1024 processes. omp, its tools and the builds it starts run there, not in the board container. The board syncs the workspace and streams the output.
- The procedure is in the "OMP SSH runner" section of `docker/agent-runtime/README.md`.

### SSH environments no longer fill the remote disk; omp model ids save on the card (OPE-12633)

- A synced run in an SSH environment copies the workspace to `<remote workspace>/.paperclip-runtime/runs/<runId>/workspace`; on the Myrmidon monorepo that is about 0.8 GB per run, and nothing removed it. After a successful restore, the run's workspace copy is now removed. The small runtime directory stays: the API bridge stops in parallel. Run directories older than two days are pruned when the next run starts. A failed restore keeps the copy, so the run's work is not lost.
- The agent card accepts an omp model id in the form omp runs it: one of the agent's custom provider keys (`MYRMIDON_OMP_PROVIDERS`) followed by a gateway model from the list, e.g. `litellm/antigravity/gemini-3.8-flash-medium`. Before, the board refused that id and the card could only be repaired in the database.

### Variables introduced by Myrmidon are named MYRMIDON_* (REBRAND-OWN-ENV, OPE-12652)

- The omp adapter reads `MYRMIDON_OMP_PROVIDERS` and `MYRMIDON_OMP_COMMAND`. The names it shipped with, `PAPERCLIP_OMP_PROVIDERS` and `PAPERCLIP_OMP_COMMAND`, still work for one release as deprecated aliases; a run that uses the old provider name says so in its first note.
- Other variables we had introduced under the vendor prefix are renamed the same way, with the old name kept as an alias:
  - `MYRMIDON_RUNNER_SANDBOX_COMMAND`;
  - `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` (the bot runtime sets both names);
  - `MYRMIDON_GIT_PROBE_ACTIVE`;
  - `MYRMIDON_PARENT_BOOT_ID`;
  - the dev launcher's `MYRMIDON_PROCESS_MODE` / `MYRMIDON_PROCESS_ROLE`;
  - the standby drill's `MYRMIDON_DB_PASSWORD`;
  - the scripts' `MYRMIDON_BASE_URL` and `MYRMIDON_UPSTREAM_REPO`.
- The omp discovery cache now ignores per-run `MYRMIDON_*` variables, as it already ignored `PAPERCLIP_*` ones.
- New CI guard `scripts/myrmidon/ci/paperclip-names-ratchet.mjs`, run by the checks job's script tests. It fails a change that adds a `PAPERCLIP_*` name absent from `scripts/myrmidon/ci/paperclip-names-baseline.txt`, which lists the vendor names and our deprecated aliases.

### Deploys remove unused release images after success (OPE-12664)

- A successful product deploy now removes unused `myrmidon*` and `agent-runtime*` images from the deploy host. Docker containers in any state keep their image. The sweep does not run when the deploy fails, and a cleanup failure is logged without changing the successful deploy result.
- The deploy host disk signal measures both the root filesystem and `/srv/myrmidon-xfs`. It warns above 85% and raises a critical signal above 90% with the largest consumers. The root and bot-partition checks use the existing host-disk attention and owner-notification path.

### omp SSH runner data on the bot data disk (OPE-12664)

- The runner compose template keeps workspace, home and host key under `OMP_RUNNER_DATA_DIR` (bind volumes) instead of named volumes in `/var/lib/docker`: agents clone and build repositories in the runner, gigabytes per agent, and on vm-core that landed on the root disk.

### The SSH run copy is removed at every end of the run, not only after a successful restore (OPE-12664)

- A synced run in an SSH environment copies the workspace to `<remote workspace>/.paperclip-runtime/runs/<runId>/workspace`, up to 3 GB on the Myrmidon monorepo. The board removed the copy only after a successful restore, so a failed, timed-out or cancelled run left it until the next run on that runner pruned copies older than four hours. On 11.11 and 12.11 that filled the bots disk to 100% and crashed the bots.
- Now the run's whole directory is removed after the restore attempt whatever the outcome of the run. It is also removed when the restore itself fails (the restore error is still reported) and when the workspace upload or the asset staging fails before the run starts. Only this run's directory is touched; an in-place workspace has no run directory, so nothing is removed. A failed removal is logged and does not fail the run. The removal first stops the API bridge server of the run, which stops in parallel with the restore.
- A run whose restore failed no longer keeps its remote copy for recovery: it is removed together with the rest. The four-hour prune at the start of the next run stays as a safety net for runs that never reach their end, for example when the board restarts.

### SSH run copies of failed and cancelled runs are pruned after four hours (OPE-12664)

- A failed or cancelled run in an SSH environment never reaches the restore that removes its workspace copy. Run directories older than four hours are now pruned when the next run starts (before: two days). The longest run timeout is three hours. On 11.11 one omp runner held 24 copies of 1.5 GB.

### A review goes only to a reviewer of the task's own group (OPE-12683)

- The board accepted any agent as a reviewer. The automatic review rebalance gave development reviews to shop and business bots (`bbq*`, `work*`, `dispatch`). They approved and closed tasks whose pull requests were not merged.
- A review or approval participant must now be an agent of the task's own group, with `swarmQueueEligible` not set to `false`. The board refuses any other agent with 422 `invalid_review_participant` and lists eligible teammates. The check runs when the task enters review and when the reviewer changes while the task is already in review.
- The automatic review routing takes reviewers only from the task's own group: first assignment, reassignment of an overdue review, queue offload, rebalance, and the pull request lane. There is no fallback to the whole company pool. When the group has no eligible reviewer, nothing is moved and the `no_reviewer` card is raised.
- While a review is pending, the task's group is the group of the engineer the review returns to, not the group of the reviewer who holds it.

### Company behavior-settings writes need an explicit agent permission grant (1.6.8 BEHAVIOR-SETTINGS-AUTHZ, OPE-12699)

- `PATCH /api/myrmidon/behavior-settings/company/:companyId` (and the legacy alias `PATCH /api/myrmidon/behavior-settings/:companyId`) no longer accepts every agent key with company access. Board users keep writing as before; an agent key is admitted only with an explicit `users:manage_permissions` grant for that company, and receives `403 Forbidden` without one (no stored change, no audit entry).
- Grants are managed on `PATCH /api/companies/:companyId/members/:memberId/permissions` (the same key the tool-access routes use). The instance-level `PATCH`/`PUT /api/myrmidon/behavior-settings` stays instance-admin only, and company settings reads are unchanged.

### The board now tells the operator when a whole role has no working model channel (OPE-12709)

- New attention signal `role_model_down`: when the agents of one role (per company) finish at least 5 runs in the last 30 minutes (`succeeded` / `failed` / `timed_out`; `cancelled` never counts — it is a deliberate stop) and none of them succeeded, AND at least 5 of the counted finishes are classified as model refusals, the attention feed raises one critical card per role. A finish is a model refusal when the adapter marked the provider failure in `resultJson` (`model_unavailable` / `provider_error_as_content`) or the run's error text carries a provider quota/limit marker (`model_unavailable`, `overload`, `insufficient_quota`, `credits insufficient`, and 402 / 429 as whole numbers, never inside an id, port or duration); ordinary adapter or process failures never raise this signal. The card carries the role, the busiest model group of the failed runs, the finished-run count and the last provider refusal error. The threshold counts all channels of the role together, so an outage spread over a primary and a fallback channel still trips it. The card clears itself on the role's first successful run (the zero-success condition drops out). The card keeps the per-role dedupKey `role_model_down:<role>`; the Telegram delivery adds an hour bucket to its publication key, so a role that stays down is re-sent at most once per hour and a later outage is delivered again.
- New attention signal `provider_no_credits`: when a run's error text carries a no-credits marker (HTTP 402 as a whole number, `insufficient_quota`, "Credits insufficient"), the feed raises a critical card naming the provider channel (`resultJson.providerModelGroup`). This is an independent operator signal — a top-up question for the owner, raised even when its role is also down, never folded into the role card. Dedup key: `provider_no_credits:<channel>`; the Telegram delivery is once per hour per channel, the same way.
- Both kinds are delivered to the operator through the board errors Telegram channel: they were added to the closed `ERROR_CHANNEL_SOURCE_KINDS` list, and the card text renders the role/model/channel/finished counts from the subject metadata.
- Collector data comes from one query over `heartbeat_runs` joined to `agents` for the 30-minute window (see `server/src/services/attention.ts`, next to the `provider_usage_warning` collector). The same state drives the agent mark "model unavailable since HH:MM": the agents API (`GET /companies/:id/agents` and `GET /agents/:id`) adds the optional `roleModelDownSince` (ISO time of the first model refusal in the window) to every agent of a role with an active signal, from the same shared query and one query per company, and the agents list and the agent card show it as a badge in the viewer's local time. The mark disappears on the role's first successful run and is absent for agents of other roles.
- The ADM host-side watchdog checks (ROLE_MODEL_DOWN, KIE_NO_CREDITS in `~/ops/auto/supertick.py`, added 2026-11-11) can be retired once this ships and is verified in production.

### 1.6.8 DEPLOY-SMOKE-REMOTE / DEPLOY-SMOKE-OOM-WARN: post-deploy bot smoke handles remote-host bots and single untouched OOM (OPE-12716)

- `scripts/myrmidon/deploy/bot-apply-smoke.sh`: bots pinned to another host (`adapterConfig.container.host != local`, e.g. the `work-*` bots on a remote VM) are verified by their own gateway — `apiBaseUrl` `/health` probe, board status as fallback — instead of local `docker`, which only answered "No such container" for them. Gateway diagnosis names the bot's host ("remote host <host>: логи на хосте") instead of "No such container".
- An in-window `OOMKilled` exit is a deploy casualty only when the rollout touched the container (it started inside the deploy window, i.e. re-created/restarted by the rollout) or two or more untouched containers OOMed (fleet-wide). A single OOM of a container untouched by the deploy is a `WARNING` (bot id + memory limit) and no longer fails the deploy (`rc.23` case).
- End-to-end coverage in `scripts/myrmidon/deploy/release-gate.test.mjs`: remote healthy bots classify healthy without local docker calls; single untouched OOM warns with exit 0; rollout-recreated OOM still fails the deploy; two untouched OOMs are a fleet casualty.

### Bot Runtime: `skill_view` resolves the qualified board-skill alias instead of failing every run skill load (OPE-12719)

- Board-managed skills materialize inside the bot profile as `paperclip-managed/<slug>--<hash>/SKILL.md` (hashed directory names from the run-scoped skills materialization), but the agent-facing skills index renders each entry as `paperclip-managed:<slug>` (category = first path segment, name = frontmatter `name:`). The hermes `skill_view` resolver matched exact directory names and bare frontmatter names only, so every agent call with the index name returned "Skill '...' not found", failed three times, and the run guard stopped the run — the failure signature `skill_view failed 3 times consecutively` seen on live runs (OPE-12719).
- `docker/bot-runtime/patches/35-skill-view-managed-name.patch` adds a zero-candidate fallback in `_collect_skill_candidates` (`tools/skills_tool.py`): when the exact-name passes found nothing, a qualified `namespace:bare` name resolves by matching a skill whose parent-of-parent directory equals the namespace and whose frontmatter `name:` equals the bare part. The fallback never runs when any candidate exists, so exact matches, project precedence, and the quarantine gate are untouched; two same-slug skills from different board keys still refuse as "Ambiguous skill name".
- Build-time regression `docker/bot-runtime/tests/skill_view_managed_name.py` pins: the qualified alias resolves to the hashed directory, the direct hashed path resolves, bare names keep resolving, an unknown namespace still fails with not found, same-slug collisions refuse as ambiguous, and `skills_list` output shape is unchanged. Wired as a Dockerfile RUN step; the full patch stack 02–35 applies cleanly in sequence on a fresh upstream checkout.
- Replaced dead references to the renamed operational skill across agent-facing instructions and docs (`paperclip` → `myrmidon`, `paperclip-create-agent` → `myrmidon-create-agent`, `paperclip-converting-plans-to-tasks` → `myrmidon-converting-plans-to-tasks`, `skills/paperclip/scripts/paperclip-upload-artifact.sh` → `skills/myrmidon/scripts/paperclip-upload-artifact.sh`) in `AGENTS.md`, onboarding bundles (`server/src/onboarding-assets/`), the accepted-plan heartbeat directive (`server/src/services/heartbeat.ts`), the agent-configuration LLMs endpoint (`server/src/routes/llms.ts`), `skills/myrmidon/references/`, developer skills under `.agents/skills/`, and `doc/AGENT-ARTIFACTS.md` / `doc/DEVELOPING.md`. The onboarding brand guard's allowed-token list shrinks to `X-Paperclip-Run-Id` plus the helper filename. Untouched: the `/api/skills/paperclip` invite route contract, `LEGACY_BUNDLED_SKILL_*` alias tables, the `PAPERCLIP_*`/`MYRMIDON_*` dual-write environment variables (`packages/shared/src/env-alias.ts`), and the artifact work-product wire value `provider: "paperclip"` — all are live contracts, not skill names.
- Requires a bot-runtime image rebuild; running containers keep the old resolver until the next deploy. Post-deploy proof: zero runs with `skill_view failed` caused by "Skill 'paperclip-managed:...' not found" (operator acceptance after the release).

### Host GC removes stale run copies of the omp SSH runners (OPE-12722)

- An omp runner keeps a copy of the workspace for every run; a failed or cancelled run never removed its copy, and old copies were pruned only when the next run on that runner started. On 11.11 an idle fleet accumulated 47 GB of such copies, the bots disk filled up and nine bots went down. The host GC now also removes run copies older than 4 hours (`--run-copy-ttl`, at least 3) under the runners' root. The pass runs only when the runner root is configured: `--runner-root`, or `HOST_GC_RUNNER_ROOTS` (on vm-core, the line `HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners` in `/etc/myrmidon-host-gc.env`). The repo systemd unit sets the variable; a host that runs the script through its own wrapper must configure the root itself, and a wrapper that calls the script once per bot root should pass `--runner-root` on one invocation only, otherwise the pass repeats per bot.

### Added: shared package cache for the omp SSH runners (OPE-12722)

- A second task copy on the same omp SSH runner no longer re-downloads a full
  repository pack and a full package set. The compose template
  (`docker/agent-runtime/omp-ssh/compose.yml`) gained the optional
  `OMP_RUNNER_CACHE_DIR` — the shared cache directory on the bot data disk (the
  board's `general.botDisk.sharedPackageCachePath`; default
  `${OMP_RUNNER_DATA_DIR}/cache`, a cache private to the runner). It binds
  `<dir>/git` → `/cache/git` (read-only, owned by the board's user, created
  before the first start) and `<dir>/pnpm-omp` → `/cache/pnpm` (read-write,
  owned by uid 1000). The runners get their own `pnpm-omp` directory: the
  `<dir>/pnpm` directory is shared with the hermes bots (uid 10001), whose
  prepare step re-owns it, so a runner must not chown it.
- The omp-ssh image installs a consume-only git wrapper at `/usr/local/bin/git`
  (port of the bot wrapper's reference logic, minus the bot-local store; the
  interpreter is the absolute `/usr/bin/node`): a plain
  `git clone https://github.com/<owner>/<repo>.git` becomes
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …` when the
  board's mirror exists, so the clone borrows the mirrored objects. Any other
  clone — another host, `--dissociate`/`--filter`/`--shared`, a repository
  without a mirror — runs unchanged, and a clone never fails because of the
  wrapper. The image build now runs the wrapper (`git --version` through it,
  and a probe that it, not `/usr/bin/git`, answers) and fails if it cannot.
- The entrypoint writes the tool environment into `/etc/profile.d/` instead of
  Dockerfile ENV: sshd does not pass container environment variables to SSH
  sessions (`PermitUserEnvironment no`), so ENV never reached board-spawned
  commands. `omp-runner-cache.sh` sets `npm_config_cache_dir=/cache/pnpm`
  (pnpm's metadata cache) and `npm_config_cache=/cache/pnpm` (npm's tarball and
  `_cacache` download cache; the two tools read different variables, and
  exporting both puts npm's downloads on the shared mount instead of a
  per-runner `~/.npm`; only when uid 1000 owns the mount, a root-owned mount
  is fixed, any other owner is left alone with a warning);
  `omp-runner-pnpm.sh` sets
  `npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store` and
  `npm_config_package_import_method=clone-or-copy`. The pnpm store stays in the
  workspace volume, one per runner, because a reflink/hardlink cannot cross a
  filesystem boundary, and inside `.paperclip-runtime`, the one directory the
  board's workspace cleanups spare and its sync never copies. pnpm 9 copies
  silently when a reflink is refused, so the store is checked by disk usage.
- Contract: `scripts/myrmidon/omp-ssh-image.test.mjs` (plain `node --test`,
  including a behavioural test of the wrapper's `rewriteArgs`); the image lane
  `agent-runtime-images.yml` builds the image, with the new smoke, on push to
  `main` (it does not run on pull requests). Operator setup,
  the rollout for runners that already run, and the acceptance measure (a `df`
  delta of the data disk, not `du`) are in the "OMP SSH runner" section of
  `docker/agent-runtime/README.md` (EN/RU); production re-measurement
  (< 700 MB per second copy) happens after deploy.

### OPE-12725: scheduler sweeps issue monitors stuck in `triggered` state forever

- After an issue monitor fires, `buildIssueMonitorTriggeredPatch` strips the policy monitor and nulls `monitorNextCheckAt`. If the woken run dies without settling the external wait, the issue kept `execution_state.monitor.status = "triggered"` forever: no timer existed, so nothing ever re-checked it, and comment-driven wakes kept deferring behind the dead monitor.
- `tickDueIssueMonitors` now runs `sweepStuckTriggeredIssueMonitors` next to the existing inactive-monitor drop. The sweep selects active-company agent-assigned issues (`in_progress`/`in_review`/`blocked`) whose `monitorNextCheckAt` is null and whose execution-state monitor still says `triggered`, after a 10-minute grace since `monitorLastTriggeredAt`.
- A monitor whose state `timeoutAt` (persisted at trigger time) is still ahead gets a bounded re-arm: `monitorNextCheckAt` = min(now + 30 s × 2^min(attempts, 4), timeoutAt), capped at 10 minutes, activity `issue.monitor_rearmed_after_trigger`.
- An expired monitor is cleared with `clearReason: "timeout_exceeded"` through the same `buildIssueMonitorClearedPatch` path as normal monitor expiry (activity `issue.monitor_timeout_swept`) and wakes the assignee once per trigger with a new `issue_monitor_timeout` wake reason (idempotency key `issue-monitor-timeout:<issueId>:<lastTriggeredAt>`), so the agent learns the wait was abandoned instead of sitting silently. Orphaned monitors (post-trigger shape with no policy) are covered by the same predicate; once cleared, comment wakes no longer defer.
- Rows missing either `timeoutAt` or `lastTriggeredAt` are skipped — the sweep never invents a timeout. Both new wake and sweep paths reuse existing guardrails (`withRecoveryContext` status-only payload, per-row try/catch, limit 50 per tick). No wake-queue change: the comment-wake deferral gate keys on `monitorNextCheckAt`, not the monitor status, so clearing the monitor is sufficient.

### The bridge queue poller blocks remotely instead of spawning an ssh process per poll (OPE-12727)

- In SSH environments the bridge worker polled the request queue every 100 ms, and each poll spawned a fresh `ssh` process; under load the board spent ~30% of a core in `spawn` alone. On the SSH transport one poll now blocks inside the remote shell until a request appears or five seconds elapse, so an idle bridge costs one exec per five seconds instead of ~10 per second. Other transports (sandbox) already run a persistent in-sandbox gateway and keep the legacy single-shot poll. `MYRMIDON_BRIDGE_QUEUE_POLL_IDLE_MS` (legacy `PAPERCLIP_BRIDGE_QUEUE_POLL_IDLE_MS`) tunes the SSH budget: an invalid or negative value falls back to 5000, a value above 5000 (half of the 10 s per-poll timeout) is capped to it, and `0` restores the old per-poll behavior. Stopping the bridge does not wait for an idle poll to finish.

### The board no longer leaks SSH sync-back copies into its /tmp (OPE-12727)

- Pulling a run's workspace back from an SSH runner stages it in `/tmp/paperclip-ssh-sync-back-*` on the board, and copies stayed there: on 12.11 they held 26 GB (0.7–4.1 GB each) and the root disk blocked a deploy. A restore now stops `ssh` when the local `tar` fails (before, the board process could crash on an unhandled `EPIPE` or wait on a full pipe, and the cleanup never ran), drops a dead connection after about three minutes of silence, makes read-only directories (a Go module cache) removable before deleting the copy, and logs a copy it cannot remove. Each restore also removes sync-back copies older than four hours, which covers a board restart in the middle of a restore.

### A full disk no longer leaves a bot answering 500 until restart (OPE-12759)

- When a write to the bot's run idempotency store failed on commit (for example, the bots disk was full), the store kept its database connection inside the failed transaction, and every later run request to that bot answered HTTP 500 until the bot container restarted. On 11.11 nine bots stayed down for 15 hours this way after the disk filled up. The store now rolls back a failed write, and rolls back a transaction left open before starting the next one, so the bot recovers by itself once space is back.

### Bot images ship patched aiohttp, httpx2 and certifi (OPE-12760)

- The pinned hermes (v2026.9.24, 0.21.5) locks aiohttp 3.14.3, httpx2 2.7.0 and certifi 2026.5.20, all with known advisories: aiohttp GHSA-2g87-pp6c-29x5 and GHSA-5wr8-gcqf-gqf3 (the gateway API server runs on it), httpx2 GHSA-8xx6-hgc6-gc2m, GHSA-f2fp-rgf2-35cp and others (used by HTTP MCP), certifi GHSA-6q48-6c7w-9gw2. The bot runtime image now installs aiohttp 3.14.5, httpx2 2.12.0 and certifi 2026.10.19 over them and fails the build when any of the three is lower. The override is dropped when the pinned hermes is 0.22.5 or newer.

### OPE-12780: immediate no_reviewer signal restricts reviewer availability to the issue's own agent group

- The immediate `no_reviewer` availability pre-check in `server/src/routes/issues.ts` now filters reviewers through `ownGroupReviewerPool` keyed on the issue anchor's group, so an empty own team signals instead of staying silent because another team's reviewer has capacity.
- Added a route regression test proving that an out-of-group reviewer does not suppress the `no_reviewer` signal.

### Workspace restore merge: no full target sha256 walk under the merge lock (OPE-12793)

- `mergeDirectoryWithBaseline` no longer captures a full `captureDirectorySnapshot` of the
  target directory while holding the directory-merge lock. Deletion safety is now checked
  per deleted path with the existing point comparison `directoryEntryMatchesBaseline`
  (one `lstat` + hash of the single file) — merge semantics are unchanged: a path absent
  from the source is removed from the target only when the target entry still matches the
  baseline snapshot. On the shared omp workspace (~27k files / 0.9 GB) this removes the
  3–10 minute full-directory sha256 walk that ran under the lock.
- The lock-wait timeout is split from the stale-lock threshold: `LOCK_STALE_MS` (30 s)
  remains only the "lock directory without a readable `owner.json` outlived this" marker,
  and a new `LOCK_WAIT_MS` (10 minutes) bounds how long an acquirer waits for a live
  holder. Restores no longer fail with `ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT` after 30 s
  while another restore's merge is legitimately running; the error code and message are
  unchanged.
- The source snapshot (`captureDirectorySnapshot(input.sourceDir)`) stays outside the
  lock, as before.

### Fixed: the repeated tool failure limit no longer aborts working runs (OPE-12796)

- The hermes_gateway guard "Repeated tool failure limit exceeded" stopped a run after any three failed calls of one tool in a row: the gateway reports `error` as a boolean, so every failure looked like "the same error". It now counts only the same call (same tool and arguments, and the same error text when the event carries one) failing again after the model has seen the previous failure. Parallel failures of one model turn and failures of different calls no longer add up; a successful call still resets the counter. The threshold (3) and the stop message are unchanged; the run log now also shows the arguments of the repeated call.
- Code: `packages/adapters/hermes/src/gateway/server/myrmidon-tool-failure-repeat.ts`, wired in `execute.ts`. Tests: `myrmidon-tool-failure-repeat.myrmidon.test.ts`, `execute.test.ts`.

### Stalled run keeps its credentials for a grace window (RUN-STALL, OPE-12808)

- A run interrupted by the stall sweep (status `cancelled`, error code `run_stalled`) can still obtain its credentials for `MYRMIDON_RUN_STALL_GRACE_SEC` seconds (default 600), so an agent that was only quiet can push and report. After the window the board refuses with the named `run_stalled` reason instead of a bare 403.

### Chat test flake: credential-lease isolation (OPE-6916)

- The pending receipt-reaction sweep treats a busy credential-mutation lease
  (409 `chat_endpoint_credentials_busy`) as a skip for this pass: the refusal
  is transient by design and the action stays retryable, so a leaked lease
  from a finished test case (or a slow concurrent holder) can no longer fail
  an unrelated caller.
- The chat-channels integration suite now deletes fixture-company
  `chat_endpoint_leases` rows in `afterEach`, so a service that died while
  holding a lease cannot make the next case wait out the 10s acquire window.

### Release deploy records compose-set anchor changes (OPE-7010)

- After the board health check, the release deploy compares the live `com.docker.compose.project.config_files` label with the `board-mount-set` block in the configured anchor file.
- When the compose-file set differs, the deploy rewrites the block with one fragment per line and commits the anchor in the configured Git repository with the deploy reference and image digest. A matching set is a no-op.
- `MYRMIDON_COMPOSE_SET_ANCHOR_FILE`, `MYRMIDON_COMPOSE_SET_ANCHOR_GIT`, and `MYRMIDON_COMPOSE_SET_LABEL_SOURCE` configure the optional sync. An empty anchor-file setting skips it; malformed or uncommittable anchors produce a warning and never fail an otherwise healthy deploy.

### Hindsight plugin: configurable request timeout with 60s default (OPE-8150)

- Hindsight client requests (`recall`, `retain`) now default to a 60-second timeout
  (`DEFAULT_TIMEOUT_MS = 60_000`), increased from the legacy 15 seconds to prevent
  aborted recall queries when the bank experiences high latency under CPU contention (OPE-3314).
- The timeout is now configurable via the plugin instance configuration field `requestTimeoutMs`
  (declared in manifest with default `60000` and validated on configuration submit).
- Health checks continue to use a dedicated 5-second timeout.

### Heartbeat & Adapters: delay retries on deployment cooldown and HTTP 429 instead of immediate wakeups (1.6.6 WAKE-5, OPE-9497)

- Added recognition for LiteLLM deployment pool cooldown signatures (`No deployments available`, `all deployments in cooldown`, `all deployments are in cooldown`, `All deployments for selected model are in cooldown`, `deployments in cooldown`) and HTTP 429 / `too many requests` / `rate_limit_error` in both the board retry classifier (`server/src/myrmidon/run-retry-policy/classification.ts`) and the Hermes gateway adapter (`packages/adapters/hermes/src/gateway/server/execute.ts`).
- `errorResult` maps deployment cooldown to `errorFamily: "provider_quota"` with `resultJson.cooldown: true` and extracts `retryNotBefore`, while generic HTTP 429 without a cooldown signature stays `transient_upstream` with `retryNotBefore`.
- Bounded retry scheduling honors `Retry-After` / `retryNotBefore` precedence over default backoff, otherwise applies exponential backoff with jitter and ceiling, suppresses immediate wakeup, and schedules at most one `scheduled_retry` per window.
- Added operator guides: `docs/myrmidon/guides/deployment-cooldown-retries.md` and `docs/myrmidon/guides/deployment-cooldown-retries.ru.md`.

### Fixed: typed review resubmit after changes_requested no longer fails recovery-path validation (OPE-9733)

- Resubmitting an issue to `in_review` after a `changes_requested` review stage no longer returns `422 missing review_path`. When a review/approval stage is configured, the executor resubmitting from the recovery-action route now lands back in `in_review` with the reviewer continuation preserved: the same review stage, `returnAssignee` stays with the original executor, and no recovery loop.
- Two fixes in `server/src/routes/issues.ts` (PR #1966, merge `ddc27433`): the review-path validator now falls back to `input.existing.executionPolicy` when the resubmit PATCH carries no `executionPolicy` field, and in `POST /api/issues/:id/recovery-actions/resolve` the execution-policy transition is applied before `assertInReviewReviewPath` so the validator sees the typed reviewer continuation in the update fields.
- Covered by regression tests: recovery route (`server/src/__tests__/issue-recovery-actions.test.ts`), issue PATCH route (`server/src/__tests__/issue-execution-policy-routes.test.ts`).

### fleetd no longer leaks memory through per-call Docker transports (OPE-12923)

- Stopped the memory leak that OOM-killed the fleetd site agent on a remote site. Every Docker API call (request, pull, logs) built a throwaway `http.Transport` whose pooled keep-alive connection pinned its goroutines forever, so fleetd grew without limit (about 45 MB/h at rest, about 220 MB/h during a bot roll) until the OOM killer fired at `MemoryMax`.
- All Docker calls now share one transport with a bounded idle pool (`IdleConnTimeout` 1m); the per-call budgets stay the same (30 s request/logs, 15 min pull). A regression test runs 1000 recreate/profile/status cycles against a fake Docker socket and fails when goroutines or the GC'd heap grow (limit: 20 MB above the 10-cycle baseline).

### Stack refresh and check run on the main board process (OPE-12957)

- `POST /api/myrmidon/stack/refresh` and `POST /api/myrmidon/stack/check` failed with 503 on a split board: an api process served them and its image probes reached dockergate, which admits only the main board process (`write EPIPE`, `caller_not_board_main`).
- Both routes now join the `bot_container` group of single routes, so an api process forwards them to the main process. `GET /api/myrmidon/stack` still reads the database and stays on the api process.

### The host disk threshold signal is written per company (OPE-12958)

- The host disk sweep wrote the `host.disk_threshold_exceeded` activity line without a company, which violates the NOT NULL `company_id` column; the write failed on every sweep and the signal interval never started.
- The line is now written once per company, like the other instance-level host-disk lines. With no company the sweep skips the write and logs once, and a failed write is logged instead of aborting the measurement result.

### Warm authority rotation: the outbox acknowledgement wait is renewable (OPE-12098)

- The old-authority outbox acknowledgement wait uses the same renewable window as the terminal result wait (OPE-12021): each cumulative ACK that advances the cursor re-arms the 2 s window (capped at 10 s total), so a controller that commits the retained event backlog slowly no longer trips the fixed 2 s fence.
- A repeated ACK without progress does not extend the window; a silent controller still times out one window after its last advancing ACK, never later than the hard cap. The arithmetic lives in the shared pure `terminal_result_ack_deadline` helper, with unit tests on synthetic `Instant`s.

### A queued run keeps its scheduled retry when the environment lease is released (OPE-12204)

- `terminalizeRunOnLeaseRelease` no longer forces a queued run that still carries `scheduled_retry_at` to `interrupted` / `lease_released_before_terminal`. A retry scheduled before the lease cleanup survives it and is dispatched instead of burning the wake-up.

### Botd git-base repack works on partial clones (OPE-12263)

- The botd git-base repack now supports partial clones: bitmap writing is disabled, stale temporary pack/index files older than 30 minutes are removed when no Git lock exists (after a failed repack and at botd startup), and failed repack attempts back off for six hours with the failure reason logged. A high pack count does not bypass the backoff.

### Secrets: a value that contains the redaction mask is refused on write (OPE-12270)

- The board refuses to store any plain env binding or adapter config secret field whose value CONTAINS the `***REDACTED***` sentinel, not only a value equal to it. Agent GET redacts plain values, including keys nested inside JSON-string env values such as `adapterConfig.env.PAPERCLIP_OMP_PROVIDERS`; a read-modify-write PATCH then sent the literal mask to the provider (LiteLLM 401).
- The write-time guard now rejects the whole roundtrip with 422 «value came from a redacted response, send the original value» instead of storing the mask.

### Bot resource-ceiling updates work when the dockergate config is read-only (OPE-12383)

- Bot resource-ceiling updates no longer fail as an opaque dockergate upstream error when dockergate's config file is mounted read-only. The gate writes the mutable per-bot limits (and the ceilings the first update pinned) to a separate limits-override file on the writable state bind (`limitsOverrideFile` in `config.json`; fresh installs point it at `/run/myrmidon-dockergate-state/limits.json`) and never rewrites the read-only main config.
- An update the gate cannot persist is refused with `config_read_only` (HTTP 403) instead of `upstream_error` (502), which the board driver surfaces as a clear operator-facing fault instead of a retried upstream failure.

### The lead role joins the default shared-cache roles (OPE-12384)

- The default `general.botDisk.sharedCacheRoles` now includes `lead`, so a lead bot gets the same shared package-cache, git-mirror and uv-cache mounts as the coding roles. A lead runs the same devbuild/build toolchain on the same repositories as the engineers it reviews; before this change its container had no `/cache/*` mounts, so the uv-cache, shared-objects and devbuild startup self-checks failed on every restart.
- The change applies on the next reconcile pass without a restart: exactly the bots whose role membership changed (the leads) are recreated with the mounts.

### Gateway slot reconcile no longer re-probes finished runs (OPE-12890)

- The run-start slot reconcile probed up to 64 finished runs of the agent on every pass and resolved the agent's secrets for each probe, which wrote a `secret_access_events` row per secret per probed run — up to 3.6 million audit rows a day on the fleet, faster than the retention sweep could delete them.
- A pass now resolves the agent's gateway credentials once and reuses them for every probe and stop, and a run the gateway has confirmed closed is not probed again.

### The reviewer is not woken again while CI is still running (OPE-12859)

- The board now records the review verdict as structured data next to the decision: the decision, the pull request head SHA and the pull request number (OPE-12181). A verdict counts only for the head it was given on.
- When the recorded verdict already covers the current pull request head, the board no longer wakes the reviewer while CI is pending: the review is done, and the merge gate checks `CI result` on its own. On the fleet this loop produced up to 60 % empty reviewer runs.
- The reviewer's wake text now tells it to review the diff and submit the decision without waiting for CI.

### tokens-trace routes require company-scoped board access (OPE-12675)

- `GET /api/myrmidon/companies/:companyId/tokens-trace/agents` and `/reconcile` ran their queries before any authorization check, so any caller that reached the route could read another company's token aggregates. Both handlers now check company access first (401 without credentials, 403 for a foreign board user) and then board access (403 for agent keys).

### Ready tasks of an unstaffed caste reach idle engineers (OPE-12846)

- Free engineers sat idle while ready tasks waited in the queue: the tasks belonged to castes with no staffed agent, and the swarm never offered them to anyone. The routing predicate shared by the queue read, the matcher and claim revalidation now routes such tasks to the default role.

### Fewer secret resolutions when minting GitHub App tokens (OPE-12537)

- The GitHub App private key is resolved only on a token cache miss, and a cold mint resolves it once instead of twice. Warm paths resolve nothing, which removes the matching rows from `secret_access_events`.

### A task is not treated as live because of its own watchdog (OPE-9590)

- Blocker attention counted a running watchdog recovery task as live work of the task it watches. The source task looked alive because its own watchdog was running, and the watchdog's recovery was refused with stale 409 errors. Watchdog-origin tasks are now excluded from that liveness check.

### Queued-run resweep timer no longer outlives its owner

- `scheduleQueuedResweep()` armed a module-level timer that nothing cancelled; it could fire later with stale state and adopt runs it did not own. The timer is now cancelled when the service drains its runs or resets its admission state.

### dockergate: an expected quota-entry refusal is not logged as an error (OPE-12959)

- When a bot container is recreated its data directory stays, so dockergate rightly refuses to drop the bot's disk quota entry. This expected refusal was logged as `disk_project_remove_failed` at error level on every recreate, with no cause. It is now an informational `disk_project_still_has_directory` event; a real removal failure is still an error and carries its cause.

### Host GC removes task folders of closed runner issues (OPE-12903)

- The host GC of the release line gained the pass from OPE-12855: task folders of done or cancelled issues under the omp runner roots are removed after the clone TTL. A folder whose git state cannot be proven clean and pushed is archived first; folders of open issues and an unreachable board keep everything in place. The pass runs only when a runner root is configured.

## 1.6.7

### Corpus: the full-text ranking starts after the embedding again (1.6.7 CORPUS-LATENCY, OPE-12272)

- The change "the full-text ranking starts together with the embedding" is taken back. The full-text
  ranking has a time bound of 800 ms. When it started first, the bound ran out while the question was
  still being embedded, and whether the ranking finished in time or was cancelled depended on a race with
  the embedding and with the load of the database. The top 5 of the same question then changed between
  identical runs (21 of 70 questions of the golden set, against 5 before), and hit@5 of the cold run fell
  to 57 of 70 (the limit is 58).
- A search embeds the question first and then starts the vector and the full-text ranking side by side, as
  it did in the full-text bound change. `CorpusSearchQuery.embedding` is a plain vector again.
- Kept from the same change: the cache of the resolved embedder key
  (`MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`) and the sampled step timings on the info log
  (`MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`).

### Saving the bot disk settings no longer erases keys the screen does not show (SETTINGS-BOTDISK-MERGE)

- Found by QA on 1.6.7-rc.9: after a Save of Settings -> General -> "Bot disk lifecycle" the stored `general.botDisk.gitMigrationEnabled: true` was gone, so `MYRMIDON_GIT_MIGRATION_ENABLED` was no longer set when a bot container was recreated.
- Cause: `PATCH /api/myrmidon/bot-disk` merges the patch over `resolveBotDiskSettings(...).settings` and stores the result as the whole `botDisk` object (instance settings replace nested objects). That effective view left out the five BOT-DISK-H5c / OPE-9673 mechanics keys (`botdIntervalSec`, `legacyPressureIdleDays`, `hermesPruneEnabled`, `hermesPruneDays`, `gitMigrationEnabled`), so any PATCH of another key (also every Save of this panel) dropped them from the row.
- Fix: the effective settings now carry every stored mechanics key, so the merge keeps them; an explicit `null` still returns a key to its default. `GET /api/myrmidon/bot-disk` shows these keys when they are stored. No contract change, no UI change.

## 1.6.7

### Settings → General no longer crashes on the Runs & Queue panel (SETTINGS-GENERAL-CRASH)

- Fixed: a few seconds after opening Settings → General the page fell to the error screen "values is not iterable". The Runs & Queue panel read a `values[]` array from `GET /api/myrmidon/behavior-settings`, while the server answers `{ settings, sources }` (the contract every other behavior-settings panel uses). The panel now reads that contract; a response of any other shape, or a failed request, is shown as an error inside the panel and never takes the page down. A value typed into a field that cannot be parsed is flagged and not sent.
- Fixed: a non-administrator who opens the Channels or Bot disk settings now sees "Нужны права администратора экземпляра" / "Instance admin access required" (translated) instead of raw English or no message at all.
- Fixed: the swarm "scent" block of Settings → General showed raw `swarmClaim.scent.*` keys; the ru/en strings are added.
- Test: the server contract test now pins that `GET /api/myrmidon/behavior-settings` answers `{ settings, sources }` and carries every runs-queue key; the panel's key list is checked against the registry.

### Instance → General: the "Workspace hygiene" panel is on the page (1.6.7 SETTINGS-UI, OPE-6249)

- The two disk ceilings of the workspace quota sweep, `workspaceQuotaMb` (one execution workspace) and
  `totalQuotaMb` (the sum of one company's measured workspaces), had a read/write route
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene`) and a finished panel component, but the component was
  never placed on the page, so the production UI had no way to see or change them. The panel "Workspace
  hygiene" now sits on Settings → General next to the bot disk panels. It shows both ceilings, the source
  of each value (default, environment override, saved here), the biggest measured workspaces and the last
  sweep, and saves through the existing `PATCH` route. An empty field means the cap is off.
- A save applies at once: the sweep reads the stored ceilings at the top of every tick, no restart.
- The source labels of the panel went through i18n (they were fixed English strings). A save or a read
  refused with 403 now says "Instance admin rights are required." instead of the raw server text; the
  `PATCH` route stays instance-admin only.
- The merged-workspace cooldown and the stuck-workspace signal delay stay in the Runs & Queue panel; they
  are not part of this one.

## 1.6.7

### Corpus: the embedder key is kept for 60 s, the full-text ranking starts with the embedding, and the step timings reach the info log (1.6.7 CORPUS-LATENCY, OPE-12272)

- A cold question needs the API key of the company's embedder secret. The secrets service resolved it
  on every such question: several reads and one write of a secret access event, and the reads queue
  behind a busy database. The resolved key is now kept in the board process for 60 s (setting
  `MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`, `0` turns it off). The lookup of the secret row still runs
  on every question and the cache key holds the secret id and its latest version, so a rotated,
  replaced or deactivated secret is never served from an older entry. An embedder without the secret
  still answers `corpus_embedder_not_configured` at once.
- **Audit change, on purpose.** The access event of the embedder secret is written when the key is
  actually resolved, that is at most once per TTL and company (and once per secret version), not on every
  search. A reader of the access log sees about one `myrmidon-corpus` read a minute under load instead
  of one per cold question. Set the TTL to `0` to get one event per question again.
- The full-text ranking of a search does not need the vector. A search now starts the embedding and the
  full-text ranking together: the index receives the embedding as a promise (the type of
  `CorpusSearchQuery.embedding` is `number[] | PromiseLike<number[]>`), runs the full-text ranking at
  once and runs the vector ranking when the embedding is ready. The 800 ms time bound of the full-text
  ranking runs from its own start, so it now elapses while the question is still being embedded. The
  fusion and the hits are the same as before; a failed embedding still fails the search; a cancelled
  full-text ranking is still replaced by the vector ranking alone.
- The step timings of a search (`corpus search: handler step timings` of the REST route, the new
  `corpus mcp search: handler step timings` of the agent route, and `corpus search: embed and index
  timings`) went to the debug log. One search in N now writes them on the info log, so the split of a
  slow search can be read in production without debug (setting
  `MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`, default 20; `1` is every search, `0` keeps them on debug). The
  other searches still write them on debug.

## 1.6.7

### MODEL-PROVIDERS-POOLS-WEB: model channels, the ChatGPT and Antigravity pools, the fallback order and the agent key lists work from the board web UI

- The "Model providers" screen called `/model-providers/providers/...`, a path the server never had, so every call answered 404 (the list, the model list, the channels, the key rotation and the removal). The client now calls the paths the server mounts: `/model-providers` and `/model-providers/:id/...`. The change log of the screen no longer adds a second `/api` prefix, and the LiteLLM channel rows of both server spellings fill the same table columns.
- The `antigravity-pool` and `google-ai-pool` provider types are registered when the plugins `myrmidon.antigravity` and `myrmidon.google-ai` are ready, as `chatgpt-pool` is. Both support channels. `antigravity-pool` brings the four model groups `antigravity/gemini-3.8-flash-high`, `antigravity/gemini-3.8-flash-medium`, `antigravity/gemini-3.8-flash-low` and `antigravity/gemini-3.5-flash-lite`; the model id is the LiteLLM group name. `google-ai-pool` has no default models. A connector that declares no models no longer gets the ChatGPT models. The pool service address has no default for these two types: enter it in the base URL field.
- A pool lives on its own LiteLLM deployments. For `chatgpt-pool`, `antigravity-pool` and `google-ai-pool` the board sends no `/model/new`, `/model/update` or `/model/delete` when a model is enabled or disabled, when the key is rotated, when the provider is removed, or at the startup reconciliation. The board still shows or hides the pool models, and the fallback order (`GET` and `PUT .../litellm/fallbacks`) and the agent key lists stay board settings. The LiteLLM provider prefix of the pool types is now `openai`.
- Removing a provider that is not a pool deletes only its own gateway deployments, found by deployment id and by the provider's own `api_base`. Before this change a removal deleted every database deployment of each removed model group, which also removed the deployments of other providers and of the pool routers.
- The agent key allowlist pass read no enabled model (the joined rows were keyed by the SQL table names), so it never changed a key. It reads the registry now. To keep it from rewriting the model lists of every restricted key on its own, the startup check and the provider-change hooks run it as a dry run: they count the keys that would change, log the model names that would be added or removed, and send nothing. Applying is an explicit owner or admin action: `POST /api/myrmidon/companies/:companyId/litellm/keys/allowlist-sync` answers the dry-run report, and `?apply=true` applies it.

## 1.6.7

### Native runner: the gateway address now reaches Codex through its config file

Codex 0.157 ignores the `OPENAI_BASE_URL` environment variable and reads the gateway address only
from the `openai_base_url` key of its config. Passing the variable (previous fix) was therefore not
enough: a native Codex agent that used an LLM gateway (for example LiteLLM) still sent its gateway
key to api.openai.com and got 401 on the first turn. When the agent environment has
`OPENAI_BASE_URL`, the native runner now also writes `openai_base_url = "<url>"` to the
`config.toml` of the isolated Codex home, ahead of all tables and next to the existing keys. Only an
`http://` or `https://` address without whitespace, quotes or control characters is accepted; any
other value stops the launch with a clear error that does not repeat the value. Without
`OPENAI_BASE_URL` the config is unchanged.

### Corpus: a search no longer counts every dataset, and a repeated question reuses its vector (1.6.7 CORPUS-LATENCY, OPE-12272)

- The `corpus_search` tool (the route the agents use) called the same store read as `corpus_list_datasets`
  on every search. That read counts the documents and the chunks of every dataset of the company, to get
  the id and the name of each dataset. On a corpus of hundreds of thousands of chunks it took 3 to 5 s, so
  the agent route was about 3 s slower than the REST search of one dataset. The search now reads only the
  ids and names (new store port method `listDatasetNames`, one query with no counters). The answer of the
  search does not change: the same datasets, the same hits, the same `datasetName` in each hit. The tools
  `corpus_get_document` and `corpus_list_documents` also take the dataset name from this read and no
  longer count the dataset.
- The dataset list with its counters (`corpus_list_datasets`, the board screen, the shadow search) is kept
  per company for 60 s. A write through the corpus ports (dataset, document or chunk change) drops the
  list of that company at once, so an upload, a parse result or a delete shows in the list without
  waiting. A change made outside the board process (an import script on its own connection) shows after
  at most the TTL. The counters of one dataset (`getDataset`) no longer load every document row to count
  the documents: the count is the sum of the per-status counts that the same read already had.
- The vector of a search question is kept for 600 s (was 60 s) and for at most 512 questions (was 128),
  so a repeated question, for example a run of a golden set, does not call the embedder again. The key is
  the company, the embedder (base URL, model, dimensions) and the exact text of the question. Identical
  questions in flight at the same time share one embedder call. A failed embedder call is never kept.
- Two new settings, both in seconds: `MYRMIDON_CORPUS_QUERY_EMBED_CACHE_TTL_SEC` and
  `MYRMIDON_CORPUS_DATASET_LIST_CACHE_TTL_SEC`. `0` turns the matching cache off.

## 1.6.7

### A bot's npx and cargo caches stay under a byte quota (OPE-12110)

One bot grew `hermes/.npm/_npx` by 2.2 GB in 45 minutes (npx fetched a whole vendor package with all
its binaries), and a Rust `target/` in a task working copy reached 2.4 GB. botd now bounds both:

- `hermes/.npm/_npx`: entries older than 24 h are removed, and when the rest weighs more than the
  quota (512 MiB per bot) the entries written longest ago go first, until it fits.
- `hermes/.cache/cargo-target`, the per-bot `CARGO_TARGET_DIR` the bot image already sets (outside
  every task working copy): quota 2 GiB per bot, whole profile dirs (`debug`, `release`, a target
  triple) removed least recently written first. A bot that never builds Rust has no such directory
  and nothing creates it.

Both passes work on whole entries, never remove a path a process holds open, and never touch an entry
written in the last 15 minutes (an install or a build may still be going), so a quota can stay
exceeded for one pass. Each eviction is a line in the botd log. The quotas are set with
`MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES` and `MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES` on the botd process.

## 1.6.7

### Corpus: the full-text part of a search has a time bound, and the two parts run side by side (1.6.7 CORPUS-SEARCH)

- A search of the knowledge corpus ranks chunks twice: by vector distance and by full text. The full-text
  part of a natural-language question matched a large part of a big corpus and scored every match, and it
  also computed a trigram `similarity` over the whole text of every match. On a corpus of 285 000 chunks
  it took 9.8 s on average and up to 104 s, while the vector part took 0.4 s.
- The full-text part now runs in its own transaction with `statement_timeout` of 800 ms (new option
  `fullTextTimeoutMs`; `0` sets no bound of its own). When the server cancels it, the search answers from
  the vector part alone, and the server log gets a warning with the company, the datasets, the length of
  the query text and the time used. Every other error is still an error. A search that has no vector
  part (a text-only search) has nothing to fall back on, so it returns the cancel error and not an empty
  list.
- The vector part and the full-text part run at the same time, each in its own transaction on its own
  pooled connection, so a search takes the longer of the two and not their sum. A search holds two
  connections while it runs.
- For a question without the substring match, `similarity` now runs only over the best 1 000 chunks by
  `ts_rank` (new option `fullTextRerankPool`; `0` brings the old statement back). Short query texts and
  identifiers keep their statement and their order.

### Remote sites: plain http is checked against the site record, fleet calls are audited, snapshots drop secret files

- The hermes adapter allowed plain http to a bot gateway on a remote site when only the host name matched the site.
  It now needs all of these: the site is active and marked `privateNetwork` or `tunnel`; the site address and the
  target are IP literals in a private range (RFC 1918, RFC 6598 shared address space or loopback); the target host is the site host;
  and the target port is inside the gateway port range of the site record (`gatewayPortStart`..`gatewayPortEnd`).
  A site record without a port range allows no plain-http port. The `dangerouslyAllowInsecureRemoteHttp` flag of a
  card is not changed.
- The site registry is the only source of the site. The `fleetSite` and `fleetSites` fields of a card were read
  before the registry and could describe a site that does not exist; they are not read any more.
- `PATCH /api/myrmidon/fleet/sites/:name` takes `privateNetwork: true` and `tunnel: true` for a private IP address of
  the site only (400 otherwise), and a site that carries a flag cannot be moved to another kind of address unless
  the flags are cleared in the same request. The request also takes `gatewayPortStart` and `gatewayPortEnd`, so a
  site that has no range (the env bootstrap writes none) can get one.
- `MYRMIDON_FLEET_HOSTS` is deprecated. An `http://` address in it (`url`, `hindsightUrl`, `llmBaseUrl`) must now be
  a private IP literal; a DNS name or a public address is refused. The board logs a warning at start while the
  variable is set. Register sites with `POST /api/companies/:companyId/fleet/sites` instead.
- Control calls on remote sites leave a row in the company activity log: `fleet.site.enroll`, `fleet.site.patch`,
  `fleet.site.drain`, `fleet.site.resume`, `fleet.site.delete`, `fleet.bot.restart`, `fleet.bot.stop`,
  `fleet.bot.move`, `fleet.bot.logs` (entity `fleet_site` or `agent`). A row says who, what, the outcome
  (`ok`, `denied`, `rejected`, `failed`) and a few non-secret facts. It never holds a token, a secret name, a
  certificate or a log. Only an actor of the company writes into its trail. Reading a log is recorded once a minute
  per actor and bot.
- The replica store no longer keeps the secret profile files. A stored snapshot leaves out `hermes/.env` and
  `hermes/config.yaml` (the files the profile compiler writes as secrets), and its manifest is rewritten to match.
  The apply that follows every restore writes the files again. A snapshot that cannot be read and checked in full is
  refused, and the previous replica stays. Replicas that were stored before this change are replaced on the next two
  snapshot passes.

### Remote sites: the board generates the site token, enroll is owner-only and limited to private addresses, bots of remote sites no longer break the local bot lists

- `POST /api/companies/:companyId/fleet/sites` no longer takes `tokenSecret`. The field named any secret of the company, and the board then sent the value of that secret as a bearer token, together with its client certificate, to the address from the same request. The board now generates a random token for each new site, keeps it in the company secret `myrmidon-fleet-site-token-<site>`, and returns it once in the enroll answer as `fleetd.token`. Put it in the `token` key of `fleetd.json`. A request that carries `tokenSecret` gets `400`. A site that is already enrolled keeps its own token secret and needs no action.
- The host of a site address (enroll, and a changed `url` in `PATCH`) must be a private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10) or a host listed in the new setting `MYRMIDON_FLEET_SITE_URL_ALLOWLIST`. Any other host gets `400` and the board issues no certificate and no key. A `PATCH` that leaves the stored address as it is is not checked again.
- Enroll, `PATCH` and delete of a site are for the company owner (and the instance admin). Before, a company admin could do it. Drain, resume, restart and stop stay open to the company admin.
- Moving a bot to another site, reading the status of a move and reading the log of a bot of a remote site (`/fleet/bots/:key/move`, `/fleet/bots/:key/logs`, `/api/myrmidon/fleet/bots/:key/logs`) need a company admin. Before, any member of the company could do it.
- The enroll answer carries `Cache-Control: no-store`: it holds the server key and the token.
- Deleting a site also deletes the token secret that the board generated for it. The token secret of an older site is never deleted with the site.
- The fleet router lists bots per host. `list` and `listRunning` sent every bot key to the local driver and to every site. The local dockergate refused each bot of a remote site (`bot_not_enrolled`), and one refused call failed the whole list, so the clone-report pass and the idle sweep saw no bot. Now each host gets only the bots of its own cards. A host that fails no longer fails the list: the failure is logged (`fleet routing: a host could not be listed`), and the list fails only when no host answered. The clone-report key list and the disk-quota sweep skip bots that run on a remote site.

### fleetd: audit log, request limits, client certificate allowlist and clean-up

- fleetd writes one JSON audit line per API request to stdout (the journal): time, route, method,
  bot key, status, the SHA-256 of the client certificate and the duration. Bodies, query strings
  and tokens are not logged.
- A JSON request body is limited to 1 MiB. A restore is limited to 20 GiB of file content and
  2,000,000 archive entries; above that it answers `413 restore_too_large` and changes nothing.
  The HTTP server now has header, read and idle timeouts. It has no write timeout, so a long
  snapshot is not cut.
- New optional key `clientCertSha256` in `fleetd.json`: a list of SHA-256 fingerprints of the
  client certificates that may call the API. When the list is set, fleetd refuses any other
  certificate in the TLS handshake. When it is empty or absent, nothing changes. The board renews
  its client certificate, so do not pin a fingerprint without a plan for the renewal.
- fleetd removes the `.replaced-*` and `.quarantined-*` directories that are older than 7 days
  from the volume root, at start and then every 24 hours.
- The out-of-memory listener now also reports the containers that fleetd creates itself
  (`fleet-<botKey>`), not only `myrmidon-bot-*`.
- A systemd drop-in with sandboxing options for the fleetd unit is added in
  `docs/myrmidon/fleetd/myrmidon-fleetd.service.d/`.

### fleetd on a remote site: a safe marker read, the same container template, writable caches

- A bot can no longer stall or exhaust fleetd through its applied marker. fleetd runs as root and
  reads `hermes/.myrmidon/applied.json` from a directory the bot owns. It now opens the file without
  following a symlink and without blocking, accepts only a regular file, and reads at most 64 KiB.
  A symlink, a FIFO, a directory or a larger file counts as "no marker".
- A container on a remote site now gets the template of the board host: `/tmp` as a tmpfs, an init
  process, the `on-failure` restart policy, and `MemorySwap` equal to `Memory`. A container that
  exists already gets the template at its next recreate.
- fleetd refuses a spec with `cpus` below 0.01 (a tiny value used to round to "no CPU limit"), with
  a `gatewayPort` outside 1024-65535, or with a `boardExtraHost` that differs from the site's own.
  The answer is `spec_invalid`. The board address in a container always comes from the site
  configuration.
- New configuration key `writableMountRoots` (default: empty). An extra mount without `readOnly` is
  accepted only when its source, with symlinks resolved, is inside one of these directories (and
  inside `allowedMounts`). Work bots can use their shared package caches on a remote site. Roll out
  the new binary before the configuration that uses the key.

### Gateway channels and fallbacks managed from the board (LITELLM-BOARD)

- `GET /api/myrmidon/companies/:companyId/litellm/channels` lists the gateway deployments again. The
  model-provider routes are mounted first and used to answer that path with
  `{channels: [], enabled: false}`. They now serve only
  `/model-providers/litellm/channels`, the model-group list of the provider screen.
- The fallback topology lives in the gateway only. `GET .../litellm/fallbacks` reads the live router
  settings; `PUT .../litellm/fallbacks` sends the whole list with `POST /config/update`. The board no
  longer keeps a copy of the topology in its own database, and a save the gateway refuses is no longer
  reported as stored. A `PUT` without a `chains` list answers 400 instead of clearing the list.
- The model catalog reads the provider of a model from `model_info.litellm_provider`
  (`custom_llm_provider` stays as the second choice). Before, every catalog row had no provider and
  every fallback save was refused for it.
- A fallback inside one provider (for example `zai-glm-5.3` to `zai-glm-5.3-flash`) is allowed. The
  answer lists it in `warnings`, as it lists a model whose provider the catalog does not know. A target
  that is not in the catalog, a loop, a free channel after a paid one and a cheaper channel after a
  dearer one are still refused with 422.
- `PUT .../litellm/fallbacks` stays behind the admin-key setting. Without it the answer is 503 with
  `code: litellm_gateway_not_configured` and `missing` — the names of the variables to set.

### Board-to-gateway sync: provider and channel keys, order, pause, names, agent keys

The board registered models and channels in LiteLLM in ways the gateway ignores or rejects. All of it is
now checked against LiteLLM v1.104.1.

- **Keys travel as values.** LiteLLM has no secret manager here, so a `secrets/<name>` reference was stored
  as the key, and a plugin model went out with an empty one. The board now resolves the company secret and
  sends its value, for provider models, plugin models, channels and the startup reconciliation (which built
  its sync service without a resolver and failed on the first enabled model of a company). A secret with no
  value is an error, never an empty key.
- **Order is `litellm_params.order`.** `/model/update` writes only `litellm_params`, so the order, priority and
  disabled flags the board put in `model_info` were dropped. `priority`, `disabled` and `provider` are not
  LiteLLM parameters and are no longer sent. A deployment without an order is only used when no ordered one
  of its group is healthy.
- **Disabling a channel pauses it.** LiteLLM has no `disabled` parameter; it has a pause flag. Disabling calls
  `/model/block`, enabling calls `/model/unblock`; the router skips a paused deployment, and the definition
  and the stored key stay in the gateway. Only deployments stored in the gateway database can be paused. A
  channel can be created paused.
- **Removing a model works.** `/model/delete` takes only a deployment id; the board sent model names and every
  removal failed. It now looks the deployments up and deletes them by id. Switching a model off removes only
  the deployment on the provider's own endpoint; deployments from the static gateway config are never touched.
- **Key rotation keeps the group's other channels.** Rotating a provider key updated the first deployment under
  the model name and deleted the other ones. It now rotates only the deployment on the provider's endpoint and
  never deletes a channel on another endpoint.
- **The registry name can be set.** The model's LiteLLM name was always `<type>/<model name>`, so it could not
  match a group that already exists (`kimi/kimi-for-coding`). It can now be given when the provider is created
  (`litellmModelNames`) and changed with the model update (`litellmModelName`, while the model is disabled).
  The upstream model is always the provider's own model name. Registering the same name on the same endpoint
  again no longer adds a second deployment.
- **Agent keys are found where agents keep them.** The allowlist update looked for a `llm-gateway-key-<name>-<id>`
  secret that live agents do not have. It now follows the card's key binding (`MYRMIDON_LLM_API_KEY`, else
  `apiKey`) to the secret value and updates the key through `/key/update` by its sha256. Keys that allow all
  models are still left alone, and an empty allowlist is still never sent when models are switched off.

## 1.6.7

### Native runner: Codex can use an OpenAI-compatible gateway

The native runner passes only an allowlist of environment variables to the Codex app-server. The
list had the API key but not `OPENAI_BASE_URL`, so a Codex agent that was configured for an LLM
gateway (for example LiteLLM) still sent its requests, and its key, to api.openai.com and got
401. `OPENAI_BASE_URL` is now on both allowlists (the TypeScript transport and the Rust runnerd).
It is an address, not a credential.

### A bot on a remote site can read its managed skills

fleetd writes the profile files of a bot on a remote site. It created the missing directories of a
file as its own user and gave the bot user only the file's own directory. So `hermes/skills` and
`hermes/skills/paperclip-managed` stayed owned by root with mode 0700, and the bot gateway failed:
"Permission denied: /data/hermes/skills/paperclip-managed". fleetd now gives the bot user every
directory between the bot volume root and the file. The volume root itself stays as it is.

## 1.6.7

### An approved pull request whose head moved goes back to the implementer instead of waiting forever

The board merge loop only merges the head a review verdict names. When the branch moved after
the approval (a new push, or the base merged in), the loop skipped the pull request silently and
nobody was asked to look again: approved PRs sat open for a day with green CI. Now, when the verdict
names another head, the task goes back to the implementer with a "head moved after approval" note,
the same path as a conflict or a branch behind its base; the implementer resubmits and the reviewer
approves the current head. A verdict that names no head is still skipped.

### Corpus search no longer loads every hit's chunks and jobs

One corpus search resolved each hit's document with a full read that also loaded the
document's chunks (embeddings included) and parse jobs, and the dataset check loaded every
document of the dataset (OPE-12272). Both are now one bounded company-scoped query (document
titles for the hits, dataset existence), and the search handler and the search index log
their step durations on the debug log (`corpus search: handler step timings`,
`corpus search: embed and index timings`), so a slow search can be attributed to the
embedding call or to the SQL.

### Remote sites: fleet restart/stop/logs reach the site, the network profile is editable, a new bot's first apply no longer races

- Fleet bot actions (`POST /api/myrmidon/fleet/bots/:key/restart|stop`, `GET …/logs`) looked up the site transport
  as `companyId:siteName`, while the client manager keys it as `companyId/siteName` (`fleetSiteKey`): every call
  answered 502 "no valid mTLS client certificate". The lookups now use `fleetSiteKey`.
- The same `companyId:siteName` lookup broke the bot move between sites (`fleet-move-wiring`); fixed the same way.
- The fleet client manager kept the old site row when a refresh found the connection unchanged, so a changed
  profile, status or capacity never reached `getSite()` (the hermes adapter's plain-http check) until a restart.
  The fresh row now replaces the cached one; the client is kept.
- `PATCH /api/myrmidon/fleet/sites/:name` accepts `privateNetwork` and `tunnel` and merges them into the stored
  site profile (admin only). A site enrolled without `privateNetwork` could not get it later, and the hermes
  adapter refused its plain-http gateway on an IPsec-internal address.
- The bot profile compiler ensures the card's board API key before the parallel block: the MCP source listing
  ensures it too, and on a new bot's first apply the two concurrent get-or-create calls both created the
  secret ("Secret already exists: …-paperclip-api-key").

### OMP agents resume their session again with omp 18.9.2

omp 18.9.2 writes a `{"type":"title",…}` line before the `{"type":"session",…,"cwd":…}`
header of a session file. The omp-local adapter read only the first line, never found the
saved working directory and started every next heartbeat as a fresh session (OPE-12287).
The header is now looked up among the first 10 lines (the remote path reads `head -n 10`
too), so both the old and the new session file formats resume with `--session <file>`.

### The block owner's unblock wake is no longer cancelled as "assignee changed"

When the board blocks an issue and wakes its block owner with `issue_unblock_requested`
(stranded-issue disposition, routable blocked issues), that owner — typically a senior
agent asked to assign a final status — is usually not the assignee. The queued-run gate
cancelled every such run as `issue_assignee_changed`, so the block could never be resolved
and the same owner was woken again and again (on 2026-11-08 the operator agent spent 36 runs
in an hour on two issues this way). The gate now lets the run start when it is an automation
`issue_unblock_requested` wake, the issue is still `blocked`, and the run's agent is the
recorded block owner (`blockerMetadata.owner` or `unblockDescriptor.owner`); any other
non-assignee is cancelled as before, and a terminal issue still stops the run.

## 1.6.6

### IDLE-STOP: stop idle bot containers, wake on demand with health check (IDLE-STOP)

- Periodic sweeper stops bot containers that have had no active heartbeat runs
  for longer than `MYRMIDON_IDLE_STOP_AFTER_SEC` (default 30 min), via
  `BotContainerDriver.stop(botKey)` — the driver itself is unchanged.
- Before a claimed run starts, the board wakes a stopped container with
  `driver.start(botKey)` and waits for it to become healthy, up to
  `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` (default 420 s). On timeout the run is
  cancelled with a clear journal error — it never starts blind.
- Cold-start duration (start → healthy) is logged for every wake.
- The feature is on by default since OPE-7898 (IDLE-STOP board controls): `MYRMIDON_IDLE_STOP_ENABLED` set to `false`, `0`, `no` or `off`
  turns it off when nothing is stored in the instance settings; the stored instance settings (idle threshold, health timeout, switch) win
  over the environment, and each agent can be set to the mode "On demand" or "Always on".

### Live browser screen is connected (BROWSER-CONSOLE part B)

- Settings -> Browsers: pressing "Open screen" now shows the live Chromium
  picture. The panel signs a short-lived (5-minute) Guacamole auth-JSON for a
  VNC connection and loads the shared Guacamole client in the screen frame —
  the same client, URL and `guacamole-json-secret-key` as the server console;
  no second Guacamole deployment. The picture rides guacd -> x11vnc on the
  exec host (Xvfb :99); the board talks to the exec host through the new
  screen node, and activity on the panel keeps the session timers alive.
- New settings: `MYRMIDON_BROWSER_VNC_TARGET` (the `host[:port]` guacd must
  reach; unset — the console token answers 503, the session itself keeps
  working) and `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` (endpoint -> browser map
  for the gateway pause guard).
- The bot pause got its server-side insurance wired into the tool gateway:
  while an owner screen session is open, MCP calls aimed at the live browser
  answer 423 before reaching the browser.
- New operational service on the exec host: `browser-console-node.service`
  (ops/browser-console-node, python3 stdlib) — opens/stops the x11vnc session
  units, stops/starts the bot MCP path on pause/resume, clears site data over
  CDP, and releases the screen itself if the board stopped reporting
  heartbeats (2 minutes). Install/rollback scripts ship with the node.

### Custom castes in the interface (CUSTOM-CASTES C)

- The company caste directory now has a screen: **Company Settings → Agent
  castes** (`/company/settings/caste-directory`). The first visit seeds the
  twelve built-in castes; the owner adds their own, edits names (EN/RU),
  description, color (token palette), icon, default model, swarm
  participation (`swarmEligible`) and a per-caste active-task limit (empty =
  the global swarm limit). Create/edit/delete go through part A's API
  (`POST`/`PATCH`/`DELETE` `/api/myrmidon/companies/:id/castes[/:key]`); the
  caste key and the built-in flag never change after creation. A caste with
  live agents on it cannot be deleted outright: the screen asks for a
  reassignment target and the delete runs only with `reassignTo` — the agents
  (and their queued tasks, which follow `agents.role`) move to the target
  caste in one transaction. The same directory drives every role picker: the
  role select on the agent card, the role rows of the autonomy matrix and
  the onboarding select all list the company's castes, falling back to the
  built-in twelve while the directory is unavailable. A custom role that has
  no directory entry displays its key instead of breaking the label.

### 1.6.2 — AUTONOMY-MATRIX: an `approval_required` cell now holds the action instead of refusing it (pause / resume / wakeup)

Pausing, resuming and waking an agent (action class `pause_wake_agents`) is now enforced at
the API seam: `POST /agents/:id/pause`, `POST /agents/:id/resume` and `POST /agents/:id/wakeup`
consult the autonomy matrix before they touch the agent. `forbidden` keeps answering
`403 autonomy_forbidden`. `approval_required` no longer answers `403
autonomy_approval_required`: the attempt is recorded as an ordinary approval card
(`tool_action_requests` + `tool_invocations`, `tool_name = autonomy_action_<class>`) and the
route answers `202 { held: true, approvalId }` without pausing, resuming or waking anyone.

The card is decided through the regular action-request approval entry
(`POST /api/tool-gateway/action-requests/:id/approve`, board-only). On approval the stored
descriptor is replayed on behalf of the original actor — pause/resume through the agent
service, wakeup through the heartbeat service — **exactly once**: the request is claimed with
a conditional `UPDATE ... WHERE status = 'approved'` (`approved` → `executing`), so a second
approval, or a retry that no longer finds the row approved, executes nothing; a rejection
executes nothing. Both rows are settled (`executed` / `failed` and `succeeded` / `failed`) and
the execution is logged as `myrmidon.autonomy.action_executed`.

The matrix is read from `instance_settings.general.myrmidonAutonomy` on every request, so
editing a cell in the Regulations UI takes effect without a restart — no env override and no
new settings key. Board and admin callers are not subject to the matrix. Guide:
`docs/myrmidon/guides/autonomy-matrix-holding-actions.md` (RU: `…ru.md`).

### Cloud storage docs: connector guide links and the Russian settings section (CLOUD-CONNECTOR)

- The cloud-storage bullet in the root README now points at
  [docs/myrmidon/guides/cloud-connector.md](docs/myrmidon/guides/cloud-connector.md) — the guide of
  the connector module — instead of the 1.3 `cloud-files` guide, which documents the temporary
  Microsoft 365 file-and-mail service for bots and carries none of the `MYRMIDON_CLOUD_*` variables.
- The Russian settings registry gains the connector section the English one already had, so an owner
  reading `SETTINGS.ru.md` finds the provider client credentials and the callback base address.

### 1.6.5 SWARM-PANEL-COOLING (OPE-6894): the swarm panel loses its dead cooling knobs, gains the real one, speaks Russian

- Removed: `pheromone.cooldownBaseMin` and `pheromone.cooldownCapMin` from the
  swarm-claim settings contract (`packages/shared/src/myrmidon-swarm-claim.ts`)
  and from the "Self-organization (swarm)" panel — no server code ever read
  them; the real cooling rule is `general.swarm` (the F-26 wake-task guard).
  A stored pre-1.6.5 `general.swarmClaim.pheromone` block that still carries
  the dead keys keeps parsing: they are stripped on read (mirrors the retired
  pilot keys), so no existing install loses its swarm settings.
- Added: a "Task cooling" block in the same panel section editing the one rule
  the board applies — `general.swarm.cooldownBaseMin` (default 30 min),
  `general.swarm.cooldownCeilingHours` (default 24 h) and the
  run-without-task gate. Empty fields mean the server default; saving PATCHes
  `general.swarm` through the instance-general settings API, so a change
  applies on the next wake without a restart. `updateGeneral` writes the
  stored document underneath, so `general.swarmClaim` survives the save (and
  a claim save keeps the cooling block) — pinned by
  `server/src/services/instance-settings-swarm-cooling.myrmidon.test.ts`.
- Localized: every string of the swarm-claim panel — the master switch, the
  pheromone mapping, the advanced extras, the change journal, the new cooling
  block, the live status line and the field-source badges — runs through the
  fork i18n catalog (`swarmClaim` namespace, en + ru). No hardcoded English
  remains in `SwarmClaimSettingsPanel.tsx`.
- How to check: Instance → General → "Self-organization (swarm)" in Russian:
  the pheromone grid has 8 fields (no cooldown pair); set the cooldown base to
  10, leave the ceiling empty, save, then look at the wake-task guard read
  back — `readSwarmSettings` returns 10 and a task whose stale run finished
  20 minutes ago wakes again (covered by
  `server/src/myrmidon/wake-task-guard.myrmidon.test.ts`).

### The publish gate survives transient gh api failures (1.6.5 TAG-CI-RETRY)

- The 1.6.5 rc.13 incident: the tag's CI run finished `success` 50 minutes in,
  but one `gh api` read of the runs list failed transiently (5xx / a
  secondary rate limit while polling every 20 s). The old gate swallowed the
  failure (`|| true`), the jq pipeline then read EMPTY input and answered an
  EMPTY verdict — and `"" != "missing"` read as a COMPLETED run with an empty
  conclusion, killing the publish after 36 minutes with "(conclusion: )"
  while the CI was still green on its way to success.
- `runs_of` now retries the `gh api` read with backoff
  (`MYRMIDON_RELEASE_GH_RETRIES`, default 3; `MYRMIDON_RELEASE_GH_RETRY_SLEEP`,
  default 5 s); a persistent failure answers an empty runs list which every
  caller normalizes to `missing` — the gate keeps WAITING (a retryable
  answer), never a bogus refusal.
- `run_verdict`/`run_status` normalize an empty/blank read to `missing` —
  an empty conclusion can no longer kill the publish.
- The poll budget grew from 120 to 180 polls (40 → 60 minutes): the tag CI
  measured ~50 minutes (18:15 → 19:05), so the old budget would have timed
  out a clean publish even without the API glitch. The publish job's
  `timeout-minutes: 90` still bounds the run.

### ARCH-GUARD: architecture invariants in the repository and checked in CI (OPE-6856)

- `docs/architecture/` holds the invariants catalog (INV-0..INV-13) and the ADR
  records of the product decisions from the decision registry.
- `scripts/myrmidon/ci/arch-invariants-gate.mjs` turns INV-10..INV-13 into CI
  checks (no automatic wake-up without a task, one swarm queue ordering, no
  pilot fields, unique and gapless migration numbers); dependency rules are in
  `.dependency-cruiser.cjs`. The pull request template asks which ADR a change
  implements or amends.
- Dependency-blocked idle pickup now binds its wake-up to the task whose
  dependency release made the agent eligible, so the automatic wake is auditable.

### A change of a bot's memory or pids limit reaches the running container without a restart (1.6.6 BOT-RESOURCES-APPLY, OPE-10565)

- When `adapterConfig.container.memoryMb`, `cpus`, or `pidsLimit` are changed in the
  card, the reconciler updates container resources as a single coordinated operation:
  it updates dockergate's `bots[]` configuration and runtime ceilings via dockergate
  route A20 (`PUT /containers/<name>/config/update`), validating against instance platform
  ceilings with atomic reload, then applies the limits to the running container via
  live `docker update` (route A18, memory, memory-swap, pids) without container restart.
- If requested limits exceed platform ceilings, dockergate rejects the update with a
  clear error (`requested resource limits exceed platform ceiling`), keeping the container
  running with its existing limits.
- A driver without live updates keeps the previous behaviour: the container is
  recreated. Any other kind of drift still recreates the container.

### CI: merge queue candidates run the full tier (OPE-8531)

- Ordinary pull requests run the fast tier; the full tier runs when the `review-approved` or `full-ci` label is set (the label starts a run on the same head), on the merge queue candidate (`merge_group`, if a queue is enabled), and on `main`.

### Board bots search and read the knowledge corpus with the corpus_* MCP tools (1.6.6 CORPUS-2.0, part D — MCP)

- The board now serves a company's corpus over its own MCP endpoint,
  `POST /api/myrmidon/companies/:companyId/corpus/mcp` (`initialize`, `tools/list`,
  `tools/call`), next to the existing OCR endpoint. It answers with the four tools
  the RAGFlow facade answered before — `corpus_search` (query, dataset(s), top_k →
  chunks with a score, the document they came from and a link),
  `corpus_get_document`, `corpus_list_datasets`, `corpus_list_documents` — so a
  shadow comparison can put the same request to both paths.
- The tools follow the module's switch and are read on every call, so switching
  the corpus on or off takes effect on the bot's next call, with no restart. With
  the module off, `tools/list` comes back empty and a call that names a corpus
  tool is answered as a tool result with `corpus_disabled`: a bot on an instance
  that never turned the corpus on sees exactly the tool set it saw before.
- The operator's purpose limit holds: a `top_k`/`limit` above the module's ceiling
  is refused with `invalid_tool_input` instead of being silently clamped.
- Every failure is a tool result carrying a stable code — `corpus_disabled`,
  `corpus_unavailable`, `invalid_tool_input`, `dataset_not_found`,
  `document_not_found`, `query_failed` — never a broken transport a bot can only
  retry blindly.

### Import pre-parsed RAGFlow chunks into the company corpus (1.6.6 CORPUS-2.0)

- The resumable corpus importer copies RAGFlow dataset, document and chunk metadata without parsing source files again, checks source counts before writes or embeddings, and reports new (`embedded`) and reused vectors separately. The operator guide documents the required bge-m3/1024 model alignment, secure environment, preflight, resume and acceptance steps.

### The CLI is now called `myrmidon`; `paperclipai` keeps working (DEBRAND-d)

- The CLI package and binary are renamed to `myrmidon`. The old `paperclipai`
  binary stays as a synonym and prints `paperclipai is deprecated, use myrmidon`
  to stderr once per run, then works as before.
- Help texts of the top-level commands say Myrmidon. `PAPERCLIP_*` variables and
  `@paperclipai/*` imports are unchanged.
- Managed installs find the CLI in either package directory, so existing
  installs and updates keep working.

### Knowledge UI: ADR-0008 seed title no longer says the vendor name (DEBRAND, OPE-9333)

- The seeded knowledge item `decisions/2026-09-27-no-upstream` (ADR-0008, shown
  in the Knowledge UI decisions folder) is now titled "В апстрим не отправляем",
  matching the debranded ADR-0008 record in `docs/architecture/adr/`. The
  vendor name stays only in the license/attribution and fork-history entries,
  and in the owner's verbatim quote, which are out of DEBRAND scope.
- Follow-up to the architecture-records debrand reviewed in OPE-9331 (PR #1805);
  same wording as the ADR file so the registry, the docs record and the
  Knowledge UI item agree.
- Regression coverage: `knowledge-seed.db.myrmidon.test.ts` now asserts the
  seeded item's title exactly and rejects a vendor-brand title.

### The installation pulls the issuer's signed deny-list itself (OPE-9084, 1.6.6)

- The board now periodically fetches the signed `license.deny.json` from the URL in
  `MYR_LICENSE_DENY_URL` (default interval 60s, override via `MYR_LICENSE_DENY_PULL_INTERVAL_MS`,
  minimum 1s). The manual admin `POST /api/licensing/deny-list` remains for offline installs.
- Each pull verifies the Ed25519 signature against the trusted issuer keys, enforces the
  monotonic serial rule (a lower serial is rejected and logged, the file stays untouched),
  and replaces the file next to `license.key` atomically (temp file + rename, 0644).
- The puller holds no private key and never serves the list; it only downloads, verifies and
  installs it. No URL configured -> the puller stays idle and starts no timer.
- Timer lifecycle: started with the app's background work, stopped on the shutdown hook
  (`app.locals.paperclipShutdown`), `unref`'d so it never keeps the process alive.

### Project-scoped development process (OPE-9681)

- Documents the `developmentProcess` project setting: `enabled`, `executionPolicy`, and optional `pipelineId`.
- When enabled, only newly created issues in that project inherit the normalized execution policy when they have no explicit policy; other projects retain their existing defaults and explicit issue policies take precedence.
- Adds the English and Russian operator guidance to this change fragment; the shared settings registries remain unchanged.

### DEVFLOW: collect queue health durations and thresholds (#1960)

- Environment overrides for devflow health thresholds:
  - `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`: idle engineer alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`: review queue age alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_RED_CI_MS`: red CI alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`: legacy alias for stale marker alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`: legacy alias for stalled merge alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`: legacy alias for stalled router alert threshold in milliseconds.
  - `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS`: alert threshold in milliseconds for an approved pull request that is not merged (default 7200000, 2 h; the `approvedNotMergedMs` instance setting wins).
  - `MYRMIDON_DEVFLOW_NO_MERGES_MS`: alert threshold in milliseconds for a period without any merge (default 21600000, 6 h; the `noMergesMs` instance setting wins).

### DEBRAND runtime environment aliases (OPE-8124)

- Managed settings: `MYRMIDON_MANAGED_CONFIG`, `MYRMIDON_SETTING_DEFAULTS`, `MYRMIDON_HIDDEN_SETTINGS` (legacy aliases accepted for one release).
- Datastore care: `MYRMIDON_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS` (legacy alias accepted for one release).
- Migrated product settings include: `API_URL`, `CLOUD_API_ORIGIN`, `IN_WORKTREE`, `PROCESS_ROLE`, `PROCESS_MODE`, `ADAPTER_MODELS`, `RUNNER_API_TOOLS_ENABLED`, `RUNNER_API_TOOLS_COMPANY_IDS`, `MANAGED_CONFIG`, `SETTING_DEFAULTS`, `HIDDEN_SETTINGS`, and `HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS`.
- Remaining `PAPERCLIP_*` uses inside server/shared are compatibility inputs, generated/public API fields, process/adapter transport contracts, or independent vendor integrations; they were not blindly renamed.

### F-09 B-UI: admission denial counter on the "Runs & queue" screen (1.6.6)

- The "Runs & queue" screen shows, next to the queue and memory snapshots,
  how many times the admission sweep refused to start a queued run since the
  server started: the total, the breakdown by gate (global cap, start ramp,
  memory of the server container, free memory of the host, host CPU load) and
  the most recent refusal with its reason and time.
- The counter comes from the `admissionDenials` field of the runtime-limits
  response (the field and its type are shipped by the legacy-screen change;
  this change wires the ui2 screen to it). Gates with zero refusals are not
  listed, and a reason this build does not know is shown exactly as the
  server sends it.
- The field is optional: a server that does not send it (or sends `null`)
  leaves the whole block hidden and the screen keeps working. Both UI
  languages are covered.

### GUARD-RETURN: return code tasks on noncoding roles (#2036)

- Environment overrides for guard-return and devflow:
  - `MYRMIDON_GUARD_RETURN_INTERVAL_SEC`: interval in seconds for the periodic guard-return sweep (default 300).
  - `MYRMIDON_DEVFLOW_CODE_TASKS_NONCODING_MS`: threshold in milliseconds for devflow alert on code tasks held by non-coding roles (default 1800000).

### Guarded agent-to-agent task handoff on the general PATCH path (1.6.6 UPSTREAM-HANDOFF, part A)

- `PATCH /api/issues/{id}` accepts optional `expectedAssigneeAgentId` (nullable)
  and `expectedStatusVersion`. When both are present and the update changes the
  assignee, the handoff runs as compare-and-set, following vendor
  paperclipai/paperclip#13686: the expectations are checked first without a lock
  and again under `SELECT ... FOR UPDATE` inside the commit transaction; any
  owner, version or user-assignment mismatch answers
  `409 issue_reassignment_conflict` and the row is left untouched. Requests
  without the fields keep the previous behavior.
- A guarded handoff stops the previous owner's live run through the existing
  ownership-change stop (`stopRunnerGoalForOwnershipChange` +
  `heartbeat.cancelRun`, confirmed stop), then commits in one transaction: a
  re-read under `FOR UPDATE`, the CAS and stopped-run fences (executionRunId
  unchanged, no running/queued/scheduled_retry run — otherwise
  `409 reassignment_stop_unconfirmed`), the new owner, `statusVersion + 1`, the
  `in_progress → todo` demote, and an `issue.reassigned` activity receipt
  (`commandId`, `disposition applied/duplicate/conflict/rollback`,
  `stateRevision`, `scheduledWakeKeys`). The response carries the applied
  receipt.
- Handoff idempotency: an optional `handoffIdempotencyKey` is checked against
  the activity journal (action + commandId + sha256 fingerprint of the inputs,
  no new index or migration). A replay with the same fingerprint returns the
  stored `duplicate` receipt without mutating; the same key with a different
  fingerprint answers `409 idempotency_conflict`.
- Guarded rollback: when the commit phase fails after the previous owner's run
  was already stopped under confirmation, the previous owner receives a
  restore wake (issue-state guard: statuses todo/in_progress, previous owner,
  previous version; executionRunId in the snapshot), the failure is recorded as
  a `rollback` receipt, and restore errors are aggregated into the receipt and
  logged — never swallowed. The new owner's wake carries a deterministic
  idempotency key and the part-B statusVersion guard, so a lost delivery cannot
  enqueue the wake twice and a stale delivery cannot start a turn.
- Forbidden handoff states match the vendor: `in_review`, `done`, `cancelled`,
  conversation issues and issues with a pending execution stage refuse a
  guarded reassignment with 409.
- `reason` (optional) records the handoff cause both in the receipt and as a
  thread comment. Every disposition — applied, duplicate, conflict, rollback —
  lands in the activity journal, which feeds the weekly handoff counter.

### hermes_local switch-off flag (hermes-local-off)

- New operator environment variable `MYRMIDON_DISABLE_HERMES_LOCAL`. When it is
  exactly `1`, the `hermes_local` adapter is treated as disabled: it is left out
  of the enabled adapter list offered for new agents, `GET /api/adapters/:type`
  reports it as disabled, and creating or switching an agent to `hermes_local`
  is rejected with "Adapter is not available on this instance".
- Off by default: when the variable is unset or has any other value, nothing
  changes. Existing agents and the registered adapter are not modified.

### Hindsight plugin: API key field is a secret reference (SETTINGS-UI, OPE-6249)

- `hindsightApiKeyRef` in the Hindsight plugin settings is now declared as a
  `secret-ref` field, so the settings screen offers the secret picker instead
  of a plain text box.

### Comment wakes of one task are collected into one run (1.6.6 INBOX-BATCH)

- Comments written on one task inside a short window no longer start one run
  each: the first comment still wakes the assignee at once, but the run it
  queues waits out `MYRMIDON_WAKE_BATCH_WINDOW_MS` before it is claimed — off by
  default, so a deployment that wants the burst sets the variable (10 s is the
  recommended window) — and every comment that arrives inside the window is merged into
  that waiting run's wake — the agent starts **once**, with the whole list of
  comment ids in the order they were written.
- A comment wake is never held when someone is waiting on the run: a run
  checked out by the operator, a run bound to an external chat, an interaction
  wake or its continuation, and any wake that carries no comment id keep the
  immediate per-event delivery.
- The window is a debounce, not a queue: a held run stays an ordinary `queued`
  run, nothing new is written for it, and it is retried when the window closes
  (the same resweep the run-admission gates use), by the periodic queued-run
  sweep and by any later wake of the same agent — a missed timer costs the
  window, never the run.
- `MYRMIDON_WAKE_BATCH_WINDOW_MS=0` (or `off`) is the default: with no window
  the board keeps the per-event delivery of one run per comment.

### Instance core settings are editable from the board (1.6.6 SETTINGS-UI)

- Instance admins can configure the shared bot mount, including host path, write access and bot allowlist, with an explicit confirmation. Paths are checked before storage. Existing containers take mount changes on reconciliation/recreation, not as an in-place bind update.
- Run queue priority now uses the live `/api/myrmidon/run-priority` contract, including issue weights and starvation limits. Changes apply to the queue without a server restart.
- Prompt-budget deep analysis can target an agent selected from the current company.

### Instance → Features: every fork feature with its settings and live health (1.6.2 FEATURES)

- New page **Instance → Features** (`/company/settings/instance/features`, a "Features" entry in the
  settings sidebar and tab bar) and API `GET /api/myrmidon/features`. A registry of 14 fork features —
  swarm self-claim and idle wake, run admission, bot disk lifecycle, shared package cache, bot language
  servers, agent memory card, cost attribution sweep, Telegram DM status and progress, chat hold rules,
  budget enforcement, plugin entitlements, host disk signal, workspace quotas, model fallback signal —
  each with a name, a description, a guide link, the **effective configuration** (every value with its
  source: settings, server environment, default or derived, and the variable that forces it) and a link to
  its settings panel. The swarm self-claim and the bot disk lifecycle (which had no panel) carry an
  inline on/off switch (`PATCH /api/myrmidon/features/:key`, instance admin only; locked while an
  environment variable forces the value).
- **Live health per feature** from a small contract each module implements: status `working` / `off` /
  `misconfigured` / `failing`, last successful run, last error with the count over 24 hours, and one effect
  metric ("issues claimed in 24 h", "directories reaped in 24 h", "runs held in the queue now"). Built on
  data that already exists (activity log, run, publication, spend and budget tables, module state) plus a
  bounded in-process record of each timed sweep's passes. A module with no health signal — the bot
  language servers, and the chat hold rules while nothing was lifted — reports
  **`unknown — no health signal`**, never a fake `working`.
- **Attention signal**: a feature that is enabled and `misconfigured` or `failing` for more than 30 minutes
  raises one card in the attention queue (and clears when it recovers). The health pass runs every five
  minutes (`MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC`).
- The bot disk sweep now reports what it did (a volume root that cannot be listed, directories reaped,
  errors) instead of only logging, so a volume root that does not exist shows as `misconfigured` rather than
  failing on every pass unseen. See [guides/features-page.md](guides/features-page.md), [SETTINGS.md](SETTINGS.md).

### Knowledge REST and MCP: one service, one set of rights (KNOWLEDGE-2.0 K-2 part B)

- New REST surface `/api/myrmidon/companies/:companyId/knowledge/*` (search,
  items, revisions, backlinks, suggestions, export/import, create, draft,
  submit, publish, approve, rollback, archive, supersede, propose) and one MCP
  endpoint `POST .../knowledge/mcp` over the same module and the same gates.
- Gate order: company access, tool grant (`permissions.toolAccess`), injection
  scan on writes, autonomy matrix, K-1 domain gates.
- Autonomy matrix: new action classes `knowledge_publish`, `rule_approve`,
  `skill_promote`, `knowledge_external_publish` with safe defaults
  (`rule_approve` forbidden for agents; `knowledge_publish` needs approval
  outside the auto sections). Publish, rollback, archive and supersede by an
  agent follow the same matrix; an agent never archives or supersedes a rule;
  a bulk import by an agent needs the matrix to say `allowed`.
- `POST .../knowledge/import` accepts the gzipped tree produced by `export`
  (own raw body parser on the route).
- OpenAPI entries and the guide `docs/myrmidon/guides/knowledge.md` (EN + RU).

### Rules in the knowledge module: derivation, resolver, delivery (KNOWLEDGE-2.0 K-3)

- The caste directory gains `sensitive` (additive migration
  `0413_knowledge_rules.sql`): a sensitive caste's rules are the owner's to
  approve, every other caste's are the board operator's — the owner's matrix of
  29.09 ("разработка — оператор доски (ADM), площадки и SMM — Alex").
  `cmo` seeds as sensitive; the flag is edited through the castes API.
- `approver_kind` is derived from the rule's castes in code
  (`server/src/myrmidon/knowledge/rules.ts`): a rule that governs any sensitive
  caste asks for `owner`, every other rule asks for `operator`. Nobody types the
  field by hand, and approving as a lower grade still answers 403 — the SMM rule
  is refused to the board operator and approved by the owner.
- A rule's castes live on the knowledge item (`knowledge_items.roles`, a GIN
  index) — the port of the wiki model's `roles`, `["*"]` meaning every caste —
  and ride through the tree export/import (`roles:` line).
- The delivery path reads the knowledge module:
  `knowledge.rules.resolved(nest, caste)` feeds the profile compiler, so the
  wiki tables are no longer a second carrier of rules. `REGULATIONS.md` gains a
  `Source: <slug> · revision <n>` line in every section (the page id is the
  slug) plus a `Provenance:` line when the revision carries sources, and stays a
  pure function of the approved set — same approved revisions, same bytes.
- N-4: `0413_knowledge_rules.sql` moves the legacy wiki regulations into
  `knowledge_items` as `kind=rule` — text, history, statuses, the delivered
  revision and one provenance record per revision. The slug stays the page key,
  so every reference resolves to the same page.
- Legacy CRUD for autonomy regulations (`/myrmidon/autonomy/regulations*`) and
  wiki-cortex (`/wiki-regulations/*`) reads and writes through `knowledge_items`
  (`kind=rule`) without creating state in `myrmidon_wiki_regulations`.

### Knowledge and Regulations screens in UI 2.0 (OPE-5957, K-4)

- Added the read-only "Knowledge" screen (space tree, search, `[[...]]` links, sources panel, revision diff and rollback by approver kind) and the "Regulations" screen of Autonomy to the UI 2.0 shell.
- The "Work" navigation group is shown only after the server confirms the knowledge REST (K-2) responds, so nothing appears while the API is not deployed.

### Knowledge base seed: decisions/ and product/ (KNOWLEDGE-2.0 K-8)

- New seed corpus `server/src/myrmidon/knowledge/seed-data.ts`: 46 owner
  decisions imported from the OPE-401 registry ("Реестр решений ADM"), one
  knowledge item per decision with `decided_by`, ISO date, the owner's
  verbatim quote, and a `sources` pointer back to the registry entry. Each
  decision lives in the `decisions/` folder as a dated record, so agents read
  decisions as individual entries instead of a 204 KB document (arch §6 K-8).
- New seed corpus `server/src/myrmidon/knowledge/seed-product.ts`: the four
  `product/` pages — `product/vision` (Alex's "Концепция Myrmidon 2.0" text
  verbatim, per the dont_revise_owners_existing_texts memory),
  `product/principles` (principles P1–P14), `product/colony-model` (the
  ant-colony model → product capabilities map), and `product/open-core`
  (open core MIT + closed modules licensing model).
- New seeder `seedKnowledgeBase(db, companyId, nestId)` in
  `server/src/myrmidon/knowledge/seed.ts`, exported from the module barrel.
  Idempotent: existing slugs are skipped. Supersede chains are applied via
  `store.supersede` in a second pass, so cancelled decisions (e.g. FORAGING
  "вариант 2" 03.10 → "включить сейчас" 03.10) link to their replacement and
  keep their history.
- Tests: `knowledge-seed.db.myrmidon.test.ts` (3 tests over embedded Postgres)
  asserting ≥40 decisions with decided_by/date/quote, 4 product pages, the
  FORAGING supersede chain, and idempotency on re-run.

### Knowledge distiller v2: closed tasks to suggestions (KNOWLEDGE-2.0 K-5)

- New server module `server/src/myrmidon/distill/`: `domain.ts` (pure
  filtering rules: silent `noise` drop, ≥1 internal source per proposal, the
  `life`-source exclusion for common sections (I-7), the ≤10 human package,
  the 1M-input-token / 30-min budget as a signal, auto-accept restricted to
  `glossary`/`releases`/`how-made`), `settings.ts` (the stored
  `general.knowledgeDistill` row + per-key env overrides, same resolution
  shape as foraging), `raw.ts` (raw material by `completedAt`: tasks closed
  in the pass window with their final comments, documents and work-product
  refs, capped at `maxTasksPerPass`, the private-contour split at the
  selection edge), `model.ts` (the free-model call through the same
  OpenAI-compatible gateway transport the debates use; one call per pass;
  the answer parsed leniently), `service.ts` (the pass: pick → call → filter
  → land suggestions through the K-1 knowledge module; zero pages created
  directly; the numeric report written as a `knowledge.distill.pass` event
  into the knowledge journal), `startup.ts` (the sweep: foraging-shaped
  timer, live settings read per tick, disabled by default), `index.ts`
  (barrel).
- The startup is wired into `server/src/index.ts` next to the foraging
  sweep: `startDistillSweep(db)` / `stopDistillSweep()`.
- New bundled skill
  `packages/skills-catalog/catalog/bundled/paperclip-operations/knowledge-distill/SKILL.md`
  (registered in the shipped-catalog list): the `knowledge-curator` playbook
  that replaces the plugin `paperclip-distill` skill — proposal texts for
  the suggestion queue, never pages, never unsourced claims.
- New pure-domain test `server/src/myrmidon/distill/distill-domain.test.ts`
  covering each K-5 criterion decidable without a board: silent noise, the
  source rule, the package cap, the budget signal, the life boundary, the
  settings resolution, the lenient parser, the window math.

### Knowledge module: transfer from the plugin (KNOWLEDGE-2.0 K-6)

- New `server/src/myrmidon/knowledge/migrate/`: `frontmatter.ts` (a
  frontmatter parser with no dependency — values never leave the process,
  only key names reach the report), `classify.ts` (the §5.3 class rules as a
  deterministic, path-based classifier; the only rule that reads the file is
  the stub rule, and it reads its length), `map.ts` (the operator-authored
  slug map: parsed hard, never guessed), `links.ts` (`[[…]]` rewritten into
  knowledge slugs, unresolved targets kept verbatim and counted),
  `source.ts` (reads the plugin wiki export), `report.ts` (numbers-only
  reports), `run.ts` (`classify` plans, `import` writes through the K-1
  service), `index.ts` (barrel).
- New `scripts/knowledge-migrate.ts` + `pnpm knowledge:migrate`:
  `classify --root <export> [--emit-map <file>]` seeds the operator's map and
  prints the class counts, their sum and the link rate; `import --root <export>
  --map <map.json> --company-id <uuid> [--nest-id <uuid>] [--actor-agent <id>]`
  writes items, revisions, sources and supersedes. Both accept `--dry-run`
  (compute everything, write nothing) and both exit non-zero when the class sum
  does not match `expectedTotal` or a page failed.
- Every imported page gets a revision, a source list (`wiki/<path>` plus the
  page's own frontmatter refs and the map's `defaultSources`) and its parsed
  frontmatter fields (title, tags, summary); regulations are imported as
  `kind=rule` drafts with their `approverKind`. Class C pages are created and
  then superseded by their `mergeInto` target. A second source page for the
  same target is appended as an extra revision — its knowledge is not dropped.
- The report holds numbers, class names, slugs and frontmatter *key names*;
  page bodies and field values are never printed (§5.3: pages can carry
  personal data).
- The map's `kind` is validated against the domain's own knowledge kinds, so a
  typo (`rulle`) fails while the map is parsed, not halfway through writing.
  Links also resolve when they are written as the *title* of an imported page —
  the form the plugin wiki used most — so a title-only link no longer counts as
  unresolved. A regulation whose name §5.3 does not know has no approver and
  fails on write with `rule_requires_approver_kind`; the operator runbook says
  so and tells the operator to set `approverKind` in the map.
- Tests: `server/src/myrmidon/knowledge/migrate/migrate.myrmidon.test.ts`
  (frontmatter parsing, every class rule, map validation, link rewriting,
  classify report invariants, and `runImport` over a stub writer: create,
  shared-target append, supersede, dry-run, failure reporting).

### Board load lanes now cover the auth middleware and the periodic sweeps

- About 71% of the board's DB statements were counted in the `untagged` lane: the request lane was attached only inside the `/api` router, after the auth / actor / run-identity middleware and outside the provider webhook ingress, and the board's own timers inherit the empty context of the startup code that armed them. A request is now tagged `http_route` before any other middleware, and a new `background_sweep` lane covers the periodic sweeps and housekeeping timers (features, alerts, deploy jobs, maintenance, canary, distill, litellm sync, leases, plugin jobs, email polling and others). The `myrmidon_board_db_queries_total{lane}` and `myrmidon_board_lane_busy_seconds_total{lane}` series gain the `background_sweep` label value. Nothing is scheduled, delayed or reordered; only the attribution changes.

- Production acceptance measurement is not included in this code change: no post-deploy 24-hour sample was available. The authenticated `GET /metrics` endpoint exposes cumulative `myrmidon_board_db_queries_total{role,lane}` counters, including `lane="untagged"`, and uses the bearer configured through `MYRMIDON_METRICS_TOKEN_SECRET` or `MYRMIDON_METRICS_TOKEN`. To measure, scrape the same process/role at T0 and T0+24h and compute `100 * (delta untagged / sum of per-lane deltas)`; preserve the `role` and instance/target identity and do not compare cumulative values across process restarts. If scrape access is unavailable, use the instance-admin `/api/myrmidon/board-load/lanes` route instead.

### Live console scratch cleanup

The live console browser server now removes the temporary working directory it creates when it closes or fails to start. Caller-provided directories are left untouched.

### Model menu: the group tree of `/model`, the rules that build it and the owner's editor (1.6.6-MODEL-MENU A+B)

- The bot's model list stops being a flat wall of buttons: `/model` becomes a
  menu of groups, and the owner decides in the board which models are visible,
  how they are grouped and how deep the nesting goes (the owner's decision of
  10.10, following the flat list of 1.6.5).
- Part A — the menu model itself. `@paperclipai/shared` (`myrmidon-model-menu.ts`)
  carries the canonical shape of `instance_settings.general.modelMenu`: a tree
  of groups of any depth (title, models, nested groups) plus the list of hidden
  models, validated as a whole (a hand-edited row that does not match is
  ignored entirely — the automatic menu is shown rather than half a tree), at
  most 8 levels deep.
- With no tree stored the menu is built automatically: one group per
  provider/family of the gateway catalog, DashScope first, then z.ai, then the
  rest alphabetically (`Прочие` for what matches no family), so the 1.6.5 order
  survives without any settings.
- A catalog model the tree does not mention is never lost: it lands in the
  `Новые` group. A model the tree names but the catalog does not offer is
  dropped and reported (`missingModelIds`), a model named twice is kept once at
  its first position, and the invariant `visible = catalog − hidden` holds.
- The screens of the menu
  (`server/src/myrmidon/agent-chat-bridge/model-menu.ts`) are built from the
  resolved tree: the first screen is the first level, a group opens into its
  subgroups and models, the last row is `Назад` while the position is not the
  root, and a level longer than `MODEL_MENU_PAGE_SIZE` (20) is paged with
  `Ещё →`, never past Telegram's limit of 100 buttons per message. The
  transport is not in this part: the entries are `{ kind, label }` plus the
  position they lead to.
- Part B — the setting and its editor. `GET /api/myrmidon/model-menu` (any
  board member) reports the menu in force: the stored tree, the catalog it was
  resolved against and the groups the bot would show;
  `PATCH /api/myrmidon/model-menu` (instance admin) saves the tree and the
  hidden list, keeps the keys a patch leaves out, refuses a tree past the
  depth/width/model-count limits (`400 model_menu_tree_too_large`) and writes
  one activity-log line (`instance.model_menu.updated`, with the changed keys).
  The row lives in `instance_settings.general.modelMenu`, and a hand-edited
  value that does not validate reads as absent, so it can never wipe the other
  general settings.
- Instance → General («Model menu») is the editor: the catalog selector, a list
  editor for the group tree — rename, reorder, nest, add a group of models from
  the catalog, delete — and the hidden models, with the menu the bot would show
  drawn under the editor. Saving writes the same row the bot reads, so a change
  applies without a restart.
- The inline buttons of the bot land in the following part (the button
  transport is the 1.6.5 F-07 work).

### Per-agent notification preferences mute event-shaped wakes (NOTIF-PREFS)

- An agent's `runtimeConfig.notifications` block now mutes whole wake event
  classes at generation time: `assignment` (issue assigned / assignment
  recovery), `mention` (a comment @-mentioned the agent) and `review`
  (execution review / approval requested, changes requested), plus an
  `enabled` master switch. Absence of the block — or any malformed field —
  means "notify": agents without a block behave exactly as before.
- The filter runs in `enqueueWakeup`, the single funnel every wake path goes
  through, so every call point (issue create, delegation, interactions,
  monitors, review handoff) is covered at once. Manual board wakes are an
  operator override and bypass the filter; reasons outside the three classes
  (timers, monitors, idle pickup, retries, …) always pass.
- A suppressed wake is logged (`wake suppressed by agent notification
  preferences`) and never becomes a run. Contract lives in
  `packages/shared/src/notification-prefs.ts`; decisions are covered by
  `packages/shared/src/notification-prefs.test.ts` and
  `server/src/__tests__/notification-prefs-wake.test.ts`.

### OOM process-loss recovery is classified as `resource.oom` (1.6.6 OOM RECOVERY)

- When a finalized agent run has run-correlated OOM evidence from the container monitor, recovery factory creates a typed `resource.oom` action instead of an unexplained generic failure.
- OOM evidence must match the finalized run (and its issue); unrelated or missing evidence does not create an OOM recovery action.
- The action is routed to the infrastructure/DevOps recovery owner, uses the standard 60-minute recovery SLA, and keeps the evidence and run ID for operator diagnosis. The configured OOM runbook reference is shown in the recovery action.
- The issue recovery card displays a dedicated OOM label and headline. Operators should inspect the linked run evidence and follow the runbook before retrying or changing container resources.

### Run queue priority and shared bot mount panels speak Russian and English (1.6.6 SETTINGS-UI, OPE-11232, OPE-11233)

- The "Run queue priority" and "Shared bot mount" panels of Instance settings now take every visible string (titles, field captions, hints, buttons, validation messages) from the RU/EN catalogs. Before, they were hard-coded in English. The field captions name each weight in words instead of showing the internal field key.
- Behaviour is unchanged: the instance administrator can still set the shared directory path, and the server does not restrict `hostPath`.

### Settings UI: execution policy badge and attention feed panel (SETTINGS-UI S, OPE-11234)

- Mounted `AttentionFeedSettingsPanel` in Settings > Instance > General, allowing administrators to view and update attention feed windows (`attentionFailedRunHorizonDays` and `attentionFeedCacheTtlSeconds`).
- Displayed `general.executionMode` as a read-only badge (`execution-mode-badge`) in Settings > Instance > General, clarifying that execution targets are cloud/platform-configured and cannot be modified via human toggle.
- Added localized UI descriptions (EN/RU) and test coverage in `InstanceGeneralSettings.test.tsx`.
- Published administrator guides in `docs/myrmidon/guides/instance-execution-policy-and-attention(.ru).md`.

### Experimental workspace-repair and duplex switches in Instance Settings (1.6.6 SETTINGS-UI)

- Added settings cards in Settings > Instance > Experimental for existing runtime keys:
  - `enableWorkspaceBranchReconcileForward`: allows runtime to fast-forward execution workspace branch on branch-containment check before run starts. Kill-switch semantics: turning off prevents automatic fast-forward if manual diagnostic is required.
  - `enableWorkspaceDirtyQuarantineRepair`: automatically quarantines dirty workspaces and repairs clean worktree before run. Kill-switch semantics: turning off preserves untouched dirty worktree state for post-mortem forensics.
  - `enableSandboxDuplexBridge`: duplex stream transport for sandbox runner communications. Kill-switch semantics: turning off falls back to file bridge transport when socket/pipe duplex experiences transport degradation.
- Clear kill-switch and availability descriptions in RU and EN; values are managed via existing instance settings GET/PATCH endpoints and properly respect cloud-managed read-only locks.
- `enablePipelines` remains without runtime-consumer and is not enabled in production configurations.

### Typed adapter settings in Agent Settings (SETTINGS-UI, OPE-11239)

- **Hermes gateway**: typed controls for the status poll interval, the run-create timeout, liveness by gateway events, raw debug events, runtime MCP URL rewrite and internal base URL, and central session history (switch, Hindsight URL, bank ID, turns to restore). There is no field for the central history API key: a credential is never typed into the form. The create timeout, the history URL and the MCP base URL are validated on save, because the gateway ignores bad values silently.
- **Claude / Codex local**: filesystem sandbox (workspace scope, extra paths; a path followed by `(rw)` is writable), network sandbox (deny or allowlist), the Claude hello-probe timeout and cleanup grace after the final result, and the Codex output inactivity timeout. Host paths are hidden under the managed-sandbox-only policy. These keys are validated on save with the parsers the run path uses, and changing a sandbox or permission key needs an instance admin (also on create and on agent hire). The create form's permission defaults are not a change.
- **Hermes local**: switch for including the configured MCP servers; values set on the create form (toolsets, sandbox, timeouts) are now stored. Comma-separated sandbox lists are honoured at run time instead of being ignored.
- **OpenClaw gateway**: client ID, mode and version, with the adapter defaults shown as placeholders.

### Settings UI: remaining product modules without editing (SETTINGS-UI, OPE-11246)

- Added settings UI and verified stored controls for product modules identified in audit:
  - Foraging: enable/disable per foraging source through the existing registry PUT (`/api/myrmidon/foraging/sources/:name`).
  - LiteLLM budget synchronization: distinct settings panel on Instance → General for `enabled`, `signalOnly`, and `sweepIntervalSec` via `/api/myrmidon/litellm-budget-sync/settings`.
  - Skill lifecycle pilot: settings panel on Instance → General with stored GET/PUT controls via `/api/myrmidon/skills/pilot`.
- Plugin entitlement expiration: retained read-only display with clarification that expiration is part of the cryptographically signed entitlement payload and cannot be edited locally without invalidating the signature.

### Corpus search: the full-text leg keeps the question as a whole next to the OR of its words; a small company is ranked exactly (1.6.6 OPE-12034)

- The full-text ranking matches `plainto_tsquery(question) || to_tsquery(OR of significant words)`.
  The OR alone, which replaced the all-words match so that a natural-language question finds
  something, drops numbers and words shorter than 4 characters: a question that names a chunk by its
  number or code matched every chunk that shares the other words, and the chunk was lost in the
  tie (the hybrid recall of the integration suite fell from 1.00 to 0.85). The question taken as a
  whole singles such a chunk out, and `ts_rank` puts it first. The tie-break by `similarity` uses the
  question as written, not the OR string. The statement no longer raises a "query doesn't contain
  lexemes" notice for a question with no significant word.
- A search that names no dataset probes the company the same way a dataset search probes its
  dataset: a company of up to 10 000 embedded chunks (`exactSetMaxChunks`) is ranked exactly, a
  larger one goes through the HNSW iterative scan.

### Corpus search: vector ranking through the HNSW iterative scan, shorter substring match (1.6.6 OPE-12034)

- The vector ranking of the corpus search no longer loses candidates to the dataset filter. The index
  knows the company, not the dataset, so the old statement returned only the chunks of the dataset
  among the 64 rows the index scan reached (on production 51 of the 100 requested candidates per call
  on average). With pgvector 0.8 the search now runs with the HNSW iterative scan
  (`hnsw.iterative_scan = relaxed_order`), which keeps scanning until the limit is filled, and sorts
  the rows by score; the scan may visit up to 100 000 index tuples (`hnsw.max_scan_tuples`; pgvector's
  own 20 000 left a question far from work-craft with 47 to 67 of the 100 candidates). A dataset of up
  to 10 000 embedded chunks is ranked exactly over its own chunks
  instead (milliseconds, where the index scan has to walk far to find a few of them). With pgvector
  before 0.8 the search keeps the previous statement; the version is read from `pg_extension` (one lookup
  per search) instead of being tried with `SET`, so no failed `SET` can abort the transaction.
- The full-text ranking adds the `ILIKE '%…%'` trigram match only for query texts of up to 16
  characters (`ilikeMaxLength`) and for an identifier, a single token without whitespace of up to 64
  characters (a file name, a version, a task code), which the `tsvector` does not find. On a long
  question the trigram index reads one posting list per
  trigram of the pattern: a cold run took 0.3 to 1.2 s on production for a match that did not add
  a single row to the 16 long questions measured, while the `tsvector` match alone takes
  milliseconds. Other longer texts are matched by the `tsvector` only.
- No migration and no setting: the limits are options of `createPostgresSearchIndex`
  (`exactSetMaxChunks`, `ilikeMaxLength`, `maxScanTuples`).

### Recover stranded deferred issue-execution wakes (OPE-9445)

- Scheduler reconciliation now expires deferred issue-execution wakes older than 30 minutes, records `deferred_issue_execution_expired`, and wakes the agent again with the affected issue context. Execution-wait wakes remain parked until their blocker is released; queue-drain behavior is preserved. A gauge, `myrmidon_deferred_issue_execution_over_30m`, exposes stale wakes for monitoring.

### DEVFLOW: return in_review task to PR author on merge conflict (#OPE-9976)

- When an open PR of an `in_review` task has `mergeable=CONFLICTING`, task is returned to the PR author in `in_progress` status with a conflict comment.

### PERF: issue list board key defaults, GitHub credentials cache, API load latency alert (OPE-9997) (#2034)

- **Issue List Defaults for Board Keys**: Extended `issuesListAgentDefaults` (`instance_settings.general`) to apply compact view and default limit of 200 (max 500) to integration board keys (`req.actor.source === "board_key"`).
- **GitHub Operation Credentials Cache**: In-memory broker cache for GitHub installation credentials with a 50-minute TTL, keyed by identity context, run, and repository. Actively validates grant and connection state before returning cached tokens.
- **API Load Monitoring and Alerting**: In-memory latency tracking middleware on `/runtime-tools/github/credentials` and `/api/companies/:companyId/issues` via `boardLoadRequestMiddleware()`. Flags route samples with `alert: true` when p95 duration exceeds 2000 ms (2 seconds), exposed through `GET /api/myrmidon/board-load/api-load`.

### Safe project backfill planner

Added a read-only snapshot planner for open issue project assignments. Ambiguous and unverified mappings remain excluded; production mutation stays operator-owned.

### The leader lease of the board: backend (PROCS-1.7 part A)

The board can now run as several processes against one database (design
OPE-5394 §5). This part delivers the protocol and the tables; the settings
panel that switches the mode is part B of the same task (OPE-5413).

- New tables: `board_processes` (one row per running process, refreshed by a
  10 s pulse; rows older than 2 min are reaped by the leader) and
  `board_leases` (`name` PK, `holder_boot_id`, `epoch`, `acquired_at`,
  `expires_at`) — migration 0388.
- The leader lease service (`server/src/services/leader-lease.ts`) implements
  the design §5.3 protocol: acquire as `INSERT … ON CONFLICT DO NOTHING`
  followed by `UPDATE … WHERE name=? AND (expires_at < clock_timestamp() OR
  holder_boot_id=me) RETURNING epoch`; the holder renews with the same UPDATE
  every TTL/3 (default TTL 30 s → every 10 s); a renewal that returns no row
  means the lease is lost and fires `onLost()` with an abort signal (design
  §5.4: the former leader stops its in-flight background passes and returns
  to the contender loop).
- The leader-only work is gated on the lease: the execution-control sweeps
  and the scheduled database backup check the lease before every pass. With
  the default (single-process) configuration nothing changes — the running
  process is the leader of everything and no lease rows are written.
- Graceful shutdown releases the leases right after the timers stop, so a
  standby takes over within one renewal tick (≤ 1 s); after kill -9 the lease
  expires and is taken over within the TTL (≤ 30 s by default).
- Every handover raises the «лидер сменился» attention signal (an
  activity-log entry) and publishes the `board.leader_changed` live event,
  so the panel sees the handover without restarting the board.
- The setting is `general.processes` (design §5.7: `{ mode: "single" |
  "split", apiCount, leaderLeaseTtlSec? }`), read live from the board UI —
  no restart needed. With the block absent the board behaves exactly as
  before.
- Read routes for the panel (part B): `GET /api/myrmidon/board-processes`
  and `GET /api/myrmidon/processes/leases`, answering the contract formats
  in `docs/myrmidon/board-leases-contract/*.json`.

Tests: unit coverage of acquire/renew/expire/release and the integration T2
(two contenders on one embedded Postgres: exactly one leader per lease,
handover on release ≤ 1 s, takeover after kill -9 within the TTL).

### Integration stand "two processes, one database" and race tests T1–T8 (PROCS-1.9, OPE-5415)

- Added `server/src/__tests__/procs/procs-races-t1-t8.test.ts` implementing the end-to-end integration test stand against a single shared test database (embedded Postgres) verifying all 8 race conditions T1–T8 from design OPE-5394 §8 / §10:
  - T1: Two executors dispatching one agent's queue through the real claim path (`dispatchRunStart`) do not duplicate starts; each run gets exactly one `running` transition.
  - T2: Dual leader / lease expiry: a standby does not steal a live lease and takes over after release; two concurrent reattach sweeps adopt an expired run exactly once.
  - T3: Bot container apply on an api process answers 409 `bot_containers_disabled`, journals no apply job and leaves the card untouched (the `caller_not_board_main` verdict is the docker gate's and is covered by its Go tests).
  - T4: Gateway run reattach protects active controller leases and ensures expired leases are adopted by exactly one surviving process.
  - T5: A real `PATCH /api/myrmidon/processes` through one api process is read through the other, and concurrent PATCHes of different keys through both processes lose no edit.
  - T6: Two real `ProcessBus` instances with their own LISTEN connections on the shared database: a `live_event` published on one process reaches the other, the origin filter keeps it from coming back, and another channel is not delivered. (The bus itself is covered here; this build does not yet publish live events onto it.)
  - T7: The real process supervisor moves single -> split (two real api children) -> single under a steady request load against the shared port, with zero 5xx; the budget is at most one connection error per transition (same as the drain/failover suite). It runs as a second suite in the same file with its own database.
  - T8: A real `SIGKILL` of an api process holding a run lease: the survivor keeps serving, the dead process's registry row stays until the reaper window, the live lease is not stolen, and after it expires the reattach sweep re-claims the run exactly once. The reaper's 2 minute window is not waited for.

- Fixed a lost update found by T5: `PATCH /api/myrmidon/processes` read, merged and wrote the processes settings outside any cross-process lock, so two processes saving different keys at once could drop one of them. The whole read-merge-write now runs under a database advisory lock.

### Process split follow-ups: one worker shutdown, fail-closed single-route proxy (OPE-9107)

- The worker entry no longer installs a second SIGTERM handler: the board
  runtime shutdown is idempotent, so a repeated signal closes resources once.
- The single-route proxy of an api process fails closed: when the
  `singletonProxy` setting cannot be read and has no cached value it forwards
  to the worker (503 with `Retry-After` while the worker is down) instead of
  serving the route locally.
- Headers named in `Connection:` are removed in both directions (RFC 9110
  section 7.6.1). The worker gets `X-Forwarded-For` equal to the client address
  resolved by the api process under `TRUST_PROXY`.
- Docs: a standalone worker is launched with `HOST=127.0.0.1`
  ([multi-instance.md](multi-instance.md)).

### Run admission can be serialized in Postgres (1.6.6 PROCS-2/T2.1)

- With `processes.admissionStore = "db"`, claiming a queued run takes a
  transaction-scoped advisory lock (`myrmidon:run-admission`), counts the
  running rows (global and per agent) and moves the run to `running` in the
  same transaction. Two worker processes can no longer both take the last free
  slot. The global cap is the configured `maxConcurrentRuns` of run admission;
  the per-agent cap is the agent's heartbeat `maxConcurrentRuns`.
- The default `memory` mode is unchanged: no lock, no extra counts. Shadow
  comparison and the remaining PROCS-2 items (attention signals, pairing codes,
  import owner, `secrets_changed`) ship in follow-up changes.

### The board tracks provider key and account usage and warns before a package or window runs out (1.6.6 OPE-7189 part E)

- Agent adapters report usage of an LLM key or a Codex account with a versioned
  event, `POST /api/companies/:companyId/provider-usage-reports`. The board keeps
  the latest value per key, window kind and window start; repeated and older
  reports do not overwrite newer ones, and a reset starts a new period.
- A warning fires before the package or window resets, when usage or the elapsed share of the window crosses the
  configurable per-company threshold (`PATCH .../provider-usage-warning-threshold`); the text says which one fired. It shows
  up in the attention feed and as a comment in the issue that owns the secret.
  Raw keys and OAuth values are never stored.
- The secrets registry shows the remaining usage per key (`GET .../provider-usage`), matched by the secret key or id.
- Migrations `0411` and `0412` add the usage snapshot, event receipt and warning
  delivery tables.

### The GitHub broker capability header is redacted from the board HTTP log

- `server/src/middleware/http-log-redaction.ts`: `req.headers["x-paperclip-github-capability"]`
  is added to `HTTP_LOG_REDACT_PATHS`. The gh wrapper and the git credential
  helper send the run-scoped `github_credentials` capability (valid for 30
  days) in this header on every `POST /runtime-tools/github/credentials`, and
  pino-http logged it in clear text.
- Operator action: capabilities already written to the existing logs stay
  valid until they expire; rotate `AGENT_JWT_SECRET` or purge the logs
  accordingly.

### REMOTE-SITES-T4: remote site health, automatic drain and failover (OPE-7651)

- New `site-monitor` lane (30 s), off by default (`MYRMIDON_SITE_HEALTH=1`). It probes `GET /v1/health` of each remote site (5 s timeout) and keeps the result in the new `myrmidon_fleet_sites.health` and `lastSeenAt`. Three misses in a row (90 s) turn the site `draining` automatically (no new placements, an alert in the log and `myrmidon_fleet_site_reachable 0`); a rejected certificate or an answer that is not the health contract puts it in `quarantined` and drops its client. A drain set by an operator is never lifted or acted on by the monitor.
- After 10 minutes unavailable the failover moves each unpinned bot of the site to the board host from its last replica, after finalizing its running runs as `failed` with the new error code `site_lost` and queuing the bounded retry (an atomic claim on each run: a live controller lease, a reattach in flight or an earlier claim leave it alone, so a retry is never doubled). The retry runs once the bot's move has closed its maintenance window, against the new host. Pinned bots are never moved and are reported; a bot without a replica is reported and its runs are left for the returning site. `site_lost` joins `MYRMIDON_INFRA_INTERRUPT_CODES`.
- The board keeps replicas of the remote datadirs itself: the replica lane pulls a snapshot of each bot of an answering site every 15 minutes into `MYRMIDON_FLEET_REPLICA_DIR`. A snapshot of a running bot is file-level; the move's phase log says when the replica was taken, and what changed after that is lost.
- A bot has at most one unfinished move: the claim is a partial unique index on `myrmidon_fleet_moves`, so two board processes cannot both move one bot. The migration adds `myrmidon_fleet_sites.health`, `myrmidon_fleet_moves.source` (`live` or `replica`) and that index.
- When the site answers three times in a row after being lost, the return pass reconciles the registry against the site: every bot container the site-agent reports (`GET /v1/bots`, the bots enrolled on the site; hand-run containers it does not know are never touched) whose bot is not in the board's registry for that site is stopped, and the datadir of a bot that was failed over is also set aside. A bot with an unfinished move is left to that move. The drain is lifted afterwards only by an operator, or automatically when the site carries the label `autoResume=true`; the buttons are T8. A draining site keeps its client and stays reachable for a move only while `MYRMIDON_SITE_HEALTH=1`: without the switch the client map and the move wiring behave as before T4.
- Pinned bots: the health reducer holds the whole site's failover back while any bot on it is pinned. That would keep the unpinned bots on a dead site too, so the monitor feeds the reducer `pinnedBotCount: 0` on purpose and the failover skips each pinned bot on its own (reported, never moved).
- A manual move of a bot that already has an unfinished move is refused with 409 naming that move (id, sites, phase) and what to do: repeating the request with the same destination resumes it, as before; the new part is that the database now enforces the rule across processes.
- The Fleet screen shows a state badge and the last answer time for each site (`GET /api/myrmidon/fleet/sites`). `/metrics` gains `myrmidon_fleet_site_reachable`, `myrmidon_fleet_site_last_seen_seconds`, `myrmidon_fleet_exec_retries_total` and `myrmidon_fleet_moves_total`.

Runtime setting: `MYRMIDON_QUEUED_RESWEEP` controls the queued-run resweep
interval; set it to `0` to disable the background resweep. The default remains
enabled outside test runners.

### Run start dispatch over the process bus: the `notify` mode (1.6.6 RUN-DISPATCH-NOTIFY)

- Part B of T1.4. With `general.processes.runStartDispatch = "notify"`, a
  process that must not execute runs (`role.executesRuns = false`, the api
  role of T1.1) no longer starts a run locally: it publishes
  `run_queued {agentId, companyId, schemaVersion: 1}` to the process bus
  (T1.3) and the executor process's listener lifts the queued run via
  `startNextQueuedRunForAgent`. The executor itself starts inline in every
  mode and additionally publishes, so a second executor reacts without
  waiting for its resweep.
- The worker listener subscribes to `run_queued` on the bus; every bus
  (re-)listen fires the part-A resweep as the reconnect catch-up — a NOTIFY
  lost while the connection was down is recovered within one resweep
  interval, per the design rule «NOTIFY is the accelerator, the timer is
  correctness» (OPE-5394 section 0 item 2). A burst of messages for one
  agent folds into a single start attempt; a second attempt is a no-op on
  the vendor agent start lock anyway (one `controllerBootId` per run).
- The resweep timer and the bus subscription now follow the role: an api
  process arms neither; the single-process default (`inline`, no
  `PAPERCLIP_PROCESS_ROLE`) is byte-for-byte the behaviour of part A and of
  main.
- The bus starts only in a multi-process deployment
  (`PAPERCLIP_PROCESS_ROLE` set to a role value). Its postgres.js client is
  dedicated (`max: 1`, `createPostgresJsClient` in `@paperclipai/db`): a
  `sql.listen` connection is pinned for the lifetime of the listener and
  never shares the drizzle pool. A bus that fails to start degrades the
  `notify` mode to the resweep — logged, never fatal.

### Settings screens for workspace hygiene, channels and the model-fallback signal (SETTINGS-UI A)

- Three new sections on Instance → General cover the settings routes that
  already existed without a screen: "Workspace hygiene"
  (`GET`/`PATCH /api/myrmidon/workspace-hygiene` — per-workspace and total
  disk ceilings, the last sweep report and the largest workspaces),
  "Channels (Telegram & chat bridges)"
  (`GET`/`PATCH /api/myrmidon/channel-settings` — ten channel fields;
  `telegramApiBaseUrl` stays deployment-only and is shown read-only) and
  "Model fallback signal"
  (`GET`/`PATCH /api/myrmidon/model-fallback/settings` — the switch, the
  threshold, the minimum calls, the window and the check interval).
- The stored row is the source of truth: a saved value applies without a
  restart — the scheduler re-resolves the row before each pass and read paths
  re-check on use. `MYRMIDON_*` environment variables stay forced per-key
  overrides exactly as the server modules already worked; each field in the
  panels shows its origin (`ui`/`settings`, `env` or `default`).
- Numeric fields are range-validated in the panel (the server validator stays
  the authority); an out-of-range or unparseable value blocks the save rather
  than being sent. Every PATCH writes the audit entry the route already
  produces.
- The retention screen (datastore-care) is intentionally not part of this
  slice: the server core is still in progress, the panel lands after it in
  its own follow-up.

### Parallel helpers: clear host-capacity hints

- Clearing Shared build slots or Dev host memory now sends an explicit `null` in the settings PATCH, removing the stored capacity hint. Server validation and persistence already accept nullable values.

### Company settings: feedback sharing, responsible user, pause/resume (SETTINGS-UI, OPE-8796)

- Organization settings now expose three fields that already existed in the
  API and the stored company row but had no screen: the feedback data sharing
  switch (`feedbackDataSharingEnabled`; enabling records the consent on the
  server), the default responsible user (`defaultResponsibleUserId`, chosen
  from active company members) and pause/resume of the organization
  (`status` `paused`/`active`), both read from and written through
  `GET`/`PATCH /api/companies/:id`.
- Pause and resume ask for confirmation before the request is sent. Saving
  state, the saved mark and server errors (including a permission refusal)
  are shown inline. Values apply without a restart: the company list is
  refetched after every successful change.

### Skills Store: discover skills and check delivery (SKILLS-UI)

- Documented discovery from an agentskills.io site, SHA-256-verified archive
  imports, required environment names and role-scoped use of existing secrets.
- Added guidance for interpreting discovery/import errors, checking delivery for
  a selected agent, and using the separate Apps MCP connector path. Documentation
  does not claim provider account, balance, or general runtime acceptance.

### Stale-block sweep no longer freezes the board with an idle transaction

- The sweep that lifts dead blocks locked the task row, then wrote its activity rows through the
  root database handle instead of its own transaction. The `activity_log` insert touches the same
  task row, so it queued behind the sweep's own lock: the transaction stayed `idle in transaction`
  for about two minutes, blocking other writers, and the next sweep tick repeated it.
- Activity rows are now written inside the unblock transaction. The transaction also sets
  `idle_in_transaction_session_timeout = 15s` and logs a warning with the path name
  (`stale_block_sweep.unblock`) when it stays open longer than 2 s.

### Orphaned run scratch directories are swept and measured

The board now removes orphaned heartbeat run scratch directories (`paperclip-run-*` in the temp directory) on a timer. Only directories that carry the run marker file and are older than the TTL are removed; unmarked directories are never touched. The volume is exported on `/metrics`: `myrmidon_run_scratch_removed_dirs_total`, `myrmidon_run_scratch_removed_bytes_total`, `myrmidon_run_scratch_remaining_dirs`, `myrmidon_run_scratch_remaining_bytes`.

### UI2 plugin navigation and direct plugin-page loading (1.6.6)

- The UI2 desktop rail now has a Plugins group populated from installed plugin
  sidebar contributions and launchers. The mobile navigation exposes the same
  entries; it observes the plugin section's rendered height so page content
  reserves the space it needs.
- A plugin page loads its matching UI contribution when opened directly, rather
  than relying on the sidebar having loaded the plugin first.
- The release acceptance set is Personal bot, License issuer, Google AI Pro,
  ChatGPT and Antigravity. The rail and phone-nav tests cover the contribution
  and launcher rendering paths; they do not substitute for the pending live
  acceptance of each plugin's form.
- English and Russian labels are provided. The shell implementation is covered
  by rail, phone-navigation and direct-page tests.
- Verification recorded before this documentation follow-up: exact-head CI run
  [40354943018](https://github.com/itkadr-git/myrmidon/actions/runs/40354943018)
  passed on code head `e454535918d1e116be9a0bfb280e73f243f0194a`. This follow-up
  adds documentation; its own exact-head checks must be evaluated on the new
  commit. The live check of all five release plugins, direct URLs and forms at
  1440/390 in Russian remains ADM acceptance after the rc.17 rollout.
- Tests and implementation references: `ui/src/ui2/shell/Ui2Rail.tsx`,
  `Ui2Rail.plugins.test.tsx`, `Ui2PhoneNav.tsx`,
  `Ui2PhoneNav.plugins.test.tsx`, `ui/src/pages/PluginPage.tsx` and
  `PluginPage.test.tsx`.

### The worker's loopback listener follows MYRMIDON_WORKER_HOST/PORT; the T1-T8 stand boots a worker for T3

- The worker opened its internal loopback listener on a fixed 127.0.0.1:3101
  while the api side (single-route proxy) and the launch map of the
  orchestrator already used `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT`.
  Both sides now resolve the address through one function, so a launch map
  with a non-default worker port no longer leaves the api dialing a closed port.
- Test stand: the bot-container route is a single route that an api process
  forwards to the worker, so T3 now runs against a real worker (own free
  loopback port) and checks the worker's `409 bot_containers_disabled` arriving
  through the api processes.

### BOARD-JANITOR: daily board hygiene routine and report (1.6.7)

- Automated daily board maintenance sweep running at 08:00 Irkutsk (00:00 UTC) and on-demand via `POST /api/myrmidon/board-janitor/run`.
- Automatically closes tasks with merged PRs.
- Safely lifts false blocks when no blocker or child task is open and no active question is pending.
- Automatically routes unassigned release tasks to role-based queue (DEVFLOW-9678) via notifySwarmIssueEvent.
- Flags untouched tasks (>21 days) with label "залежалась".
- Daily report written as document `janitor-YYYY-MM-DD` on service ticket.

### Continue RAGFlow corpus import after partial document failures (1.6.7)

- Preserve available chunks from failed RAGFlow documents, report partial document IDs, and list documents without chunks instead of creating empty corpus rows.
- Optionally upload unparsed source files through the normal corpus parser when `CORPUS_IMPORT_UPLOAD_UNPARSED=1` is enabled.

### Hindsight model groups (OPE-9858)

- Added shared Hindsight model groups for the `write`, `summarize`, and `search` roles.
- Added the server adapter and routes, with persistence in instance settings and no server restart required for reads and writes.
- Integrated the groups into the model providers screen with mapping, suggested models, save feedback, and API limitation details.
- Hot application inside a running Hindsight container remains dependent on OPE-9469.
- The UI does not edit secrets or environment variables; selected models must be available through LiteLLM or configured providers.
- Changing the search embedding model may require reindexing existing memory stores.

### Wake storm circuit breaker (1.6.7 WAKE-STORM-GUARD)

- Repeated automatic wakes from the same source for one agent are bounded by a sliding window circuit breaker (`MYRMIDON_WAKE_STORM_LIMIT`, `MYRMIDON_WAKE_STORM_WINDOW_MS`). Exceeding the limit trips the source, pauses it for the window duration, and records `heartbeat.wake_storm_guard_tripped`.

### Owner active channel: reports follow the owner between portal and Telegram (1.7-ACTIVE-CHANNEL)

- The board now marks the owner's last activity per channel — a portal
  session request touches `web`, an inbound Telegram DM message touches
  `telegram` — and answers `GET /api/myrmidon/owner/active-channel` with the
  channel the owner is active in, the last touches and the inactivity
  threshold with the source of its value.
- Report cards (questions and confirmations from ordinary tasks) go to the
  channel the owner is using: Telegram while they are active there, board-only
  while they are active on the board, and the standing U2 Telegram binding
  when neither channel is recent. The threshold is an instance setting,
  changed from Instance → General without a restart.
- The shell's "Web · now" / "Owner · Web" literals are gone: the rail footer
  and the phone header show the real active channel, refreshed without a
  reload.
- New table `myrmidon_owner_activity` (one row per user and channel), the
  shared contract `myrmidon-owner-active-channel.ts`, and guides
  `docs/myrmidon/guides/owner-active-channel.md` / `.ru.md`.

### Board update policy: maintenance window, mode, canary (1.7-AUTO-UPDATE-B)

The board update now has a policy the deploy scheduler executes: the maintenance
window (days/hours), the update mode (manual, or automatic by the release tag
after a human approval) and the fleet canary (a share of the bots first, the rest
only when that share is healthy). The policy lives in `instance_settings.general`
under `myrmidonAutoUpdate`, is read on every tick (runtime change, no restart) and
shows where each value comes from — the interface or a forced env override.

A verified deploy whose window is shut waits in the new `waiting_window` status:
nothing touches the host, the job names the moment the window opens, and it is
still cancellable. When the window opens the scheduler resumes the same job. A
deploy of the fleet is not one wave: the board switch runs first, then the canary
batch, and only a healthy batch lets the rest follow (new `fleet_canary` phase);
a failed batch ends the update as `canary_failed` with the fleet left on the
previous image.

The policy is edited in the current interface (Instance → General, "Product
updates"): `GET`/`PATCH /api/myrmidon/auto-update` (read — board, write — instance
admin) and `POST`/`DELETE /api/myrmidon/auto-update/approvals[/:tag]` for
approving and withdrawing a release. In automatic mode the tick starts an approved
release inside the window without a click and claims the approval, so it never
starts twice; the journal says `auto_started` for it.

### The spend limits screen (1.7 BUDGET-CONFIG D)

- Company settings → Budgets is where the owner reads and edits the spend
  limits of the hierarchy: nest (the whole company and each project) → caste →
  foraging → task, one row per level with its amount, period, mode and the
  spend of the period against the limit (`$600.00 / $500.00 (120% used)`,
  marked when the limit is crossed). Editing is in place — change the amount,
  the period or the mode and press Save on that row; a row without a limit is
  created right there, and a stored one can be removed (its history stays).
- The switch at the top is the global "signal only" mode; the screen shows the
  effective value **and where it comes from** (default / saved / forced by the
  server environment, in which case the switch is locked). Everything writes
  straight to the running API: no restart, no page reload — the row, its spend
  and the journal entry refresh from the server.
- The bottom table is the change journal: who, when, what (created / updated /
  deleted), which level and value, and the amount move. Guide:
  [guides/budget-limits-ui.md](guides/budget-limits-ui.md).

### Queue admission enforces budget limits (1.7-BUDGET-CONFIG-ADMISSION)

- Hierarchy spend limits (`budget_limits`) now take effect on run admission in the queue.
- `getInvocationBlock` checks effective limits (issue -> foraging -> caste -> project nest -> company nest) against spend from `litellm_cost_events` and sweep state.
- Only hard, active, over-budget limits block runs; soft limits and default signal-only mode do not refuse admission.
- Raising a limit via API or UI takes effect immediately without restart.

### COLLECT-FRAGMENTS: support line-number-prefixed table rows in SETTINGS replacements (OPE-10778)

- `scripts/myrmidon/release/collect-fragments.mjs` recognizes rows with line number prefixes (e.g. `240i|`) as table rows, allowing replacement of upstream line-prefix artifacts via `settings-ru-replace`.

### Endpoint costs/by-issue for expensive tasks (1.7-COSTS-BY-ISSUE)

- New endpoint `GET /api/companies/:companyId/costs/by-issue?from&to&limit` returning top expensive tasks ordered by `costCents` descending.
- Grouping `cost_events` by `issue_id`, distinct `heartbeat_run_id` as `runs`, joining `issues` for `identifier` and `title`.
- Default `limit=20`, maximum `100` (`>100` returns HTTP 400).

### Guardrail enforcement modes, settings, and journal (1.7-GRD-MODES)

- Configurable enforcement modes (`flag`, `mask`, `block`) for all guardrail rule categories (`secret`, `pii`, `injection`).
- Precedence hierarchy: environment force override (`MYRMIDON_GUARDRAILS_MODE_FORCE`) > per-agent override > caste override > company setting > default `flag`.
- Effective resolution returns mode and resolution source (`env`, `agent`, `caste`, `company`, `default`).
- Hot configuration readback and persistence in `instance_settings.general.guardrailModes` without server restart.
- Run-output enforcement applies mode before visible publication; `block` safely withholds output and provides a safe refusal message with zero leakage.
- Queued-input injection protection enforces configured modes on queue updates, safely refusing injection when configured to block.
- Safety bounds preserved: 262,144-character scan bound, 20-event write cap, shape-redacted and clamped snippets.
- Settings screen in Company Settings → Guardrails (`/company/settings/guardrails`) with company, caste, and agent controls.
- Event firing journal with filtering by rule kind, severity, surface, and run ID.
- Complete English and Russian localization.

### Knowledge module part L-4: POST-TASK-REFLECT lesson distillation (KNOWLEDGE-2.0 L-4)

- New `server/src/myrmidon/lesson-distill/`: the lessons agents retained in
  hindsight over the last 24 hours become knowledge suggestions. Units typed
  `lesson` (fact type, or the `lesson` tag on an untyped unit) are collected
  from every agent bank of the company — the bank resolution is the memory
  card's own rule (agent-card `adapterConfig`, else the plugin config) —
  grouped by normalized text, and a lesson seen **≥ 2 times** inside the
  window becomes one pending suggestion marked
  `[lesson-distill:regulation_candidate]` with `sourceKind: "run"` and the
  evidence (repeats + memory ids) in the rationale. A single mention stays in
  the bank: one mention is not yet a rule. The distiller never writes a page —
  the curator cast decides (§4.5).
- The pass is idempotent: a still-pending twin from a previous pass is
  refreshed (newer evidence) instead of duplicated; every company tick leaves
  one `knowledge.lesson_distill.pass` journal line with the counters and the
  window. Caps by construction: at most 10 suggestions and 500 raw lessons
  per pass, 200 per bank.
- The sweep (`startup.ts`, wired from `server/src/index.ts`) is a no-op until
  `MYRMIDON_LESSON_DISTILL_ENABLED=1`; defaults: hourly tick, 24 h window,
  threshold 2. Optional env: `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES`,
  `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS`,
  `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD`, and the memory service address
  `MYRMIDON_MEMORY_BASE_URL` / `MYRMIDON_MEMORY_API_KEY` (the stored memory
  card settings are used when the env is absent).
- Tests: `lesson-distill.myrmidon.test.ts` (the pure domain: window math,
  lesson typing, grouping, the ≥2 rule) and
  `lesson-distill-pass.db.myrmidon.test.ts` over embedded Postgres — two
  agents' identical lessons become one marked pending suggestion plus the
  journal line; a single mention yields nothing; a repeat outside the window
  does not count; a second pass refreshes instead of duplicating.

### REDACT: Sensitive data masking, entity detection, and guardrails (1.7-REDACT)

- Added standalone `myrmidon-redact` module in `tools/redact`.
- Implemented offline regex and checksum recognizers for INN, KPP, OGRN/OGRNIP, OKPO, bank accounts, BIC, bank cards (Luhn), SNILS, Russian passport, and secrets (API keys, tokens, passwords).
- Implemented `RedactEngine` supporting flag-only, irreversible masking, and reversible masking with TTL substitution store restoring text byte-for-byte.
- Added HTTP service endpoints `/healthz`, `/redact`, `/restore`, and `/scan`.
- Added MCP server exposing `redact_text`, `restore_text`, and `scan_text`.
- Added LiteLLM guardrail adapter with score-based gating avoiding binary presence blocking.
- Added CI workflow `.github/workflows/myrmidon-redact.yml` and container build artifacts.
- Added synthetic benchmark suite verifying recall >= 0.95, false positive rate <= 0.02, and latency < 150ms on 4 KiB payload.
- Added documentation in `docs/myrmidon/redact.md` and `docs/myrmidon/redact.ru.md`.

### Gate the vendor name in the built interface and the server answers (REBRAND-F)

- The rebrand keeps the vendor name only in the LICENSE, the third-party notices and the "based on ... (MIT)" line of About. The new gate `scripts/myrmidon/vendor-name/check-vendor-name.mjs` scans the built UI bundle (`ui/dist`) and the recorded response bodies of the main endpoints and counts the visible vendor name; identifier spellings (`@paperclipai/*`, `PAPERCLIP_*`, API paths, storage keys, headers) are reported but not gated for one release. Modes: `ratchet` (the visible count may not grow above the baseline) and `strict` (no occurrence outside the exceptions); CI fails a build that adds a new visible mention. Mode and baseline are editable on Instance -> General without a restart; `MYRMIDON_VENDOR_NAME_CHECK_MODE` / `MYRMIDON_VENDOR_NAME_CHECK_BASELINE` remain forced overrides (both are documented in docs/myrmidon/SETTINGS.md rows below).

### UI 2.0 agents fleet screen (OPE-8576)

- Added the company-scoped `agents` route with a scrollable `reportsTo` tree, canonical agent statuses, bounded live-run data, empty state, and direct agent-card links.

### 1.7 UI2 — swarm-claim settings in Runs & queue (OPE-10133)

The UI 2.0 Settings → Runs & queue screen now includes the swarm-claim
controls: the master switch, task lease TTL, and per-agent task limit. Each
control shows whether its effective value comes from saved settings, an
environment override, or the built-in default; environment-pinned values are
disabled. Queue counters remain live, and saves apply immediately without a
restart. The legacy pheromone display, cooldown window, and change log remain
in the existing panel.

How to check: with `enableMyrmidonUi2` enabled, open
`/company/settings/runs-queue`; configure and save the three controls, verify
source badges and live queue counters, and confirm environment-pinned controls
are disabled. See `Ui2SwarmClaimBlock.myrmidon.test.tsx` for mocked API tests.

### The settings panel shows the signal the admission decides on (1.6.5 RUN-ADMISSION, rc.3, part B)

- The «Runs & queue» settings (both panels: Settings → Runtime limits and
  ui2 → Settings → Runs & queue) now lead the live host line with the signal
  the gate decides on: the CPU busy percent (the non-idle share of all cores
  from `/proc/stat`) with its threshold and verdict, and — when the operator
  set the PSI ceiling — the PSI cpu `some avg10` pressure next to it. The
  load average follows as an explicitly auxiliary reading («Auxiliary: load
  average …»). A gate that still decides on load average (a settings row
  saved before rc.3) keeps the old load-average line.
- Two new editable limits: `maxHostCpuBusyPercent` (default 90, absolute
  percent of all cores) and `maxHostCpuPsiSomeAvg10` (off unless set); the
  legacy `maxHostLoadPercentPerCore` stays editable and is marked deprecated
  in the label and hint. The host state line moved from the legacy field to
  the busy-ceiling field, next to the ceiling it describes. An unmeasured
  first sample window and an unreadable counter render honestly («busy % not
  measured yet», «the host load cannot be read, so the ceiling is inactive:
  …») instead of invented numbers.
- Both CPU keys are typed members of `RunLimits`/`RunLimitsPatch` since part
  A, but are not `RunLimitKey`s yet (their source map arrives with the shared
  key promotion): the panels carry them as string literals and fall back to
  the «Default» source label for them.

### Agent action audit log exports as JSONL with pagination (1.6.6 AUDIT-TRAIL)

- `GET /api/companies/{companyId}/audit/agent-actions.jsonl` exports the agent
  action audit feed (comments, status transitions, assignments) as
  newline-delimited JSON: one JSON object per line, with the same record shape
  the read endpoint returns.
- Filters match the read endpoint: agent, actor, run, entity, action and the
  `from`/`to` period. The 200-row ceiling is unchanged.
- Unlike the CSV export, the JSONL export honours the caller's `cursor` and
  `limit`, so a long audit tail is fetched page by page. The cursor for the next
  page arrives in the `X-Next-Cursor` header; `X-Audit-Row-Count` carries the
  number of lines in the response.
- The endpoint requires the same `audit:view_agent_actions` permission and
  records its own `audit.exported` activity row, now with `format: "jsonl"`.

### CONNECTORS D1: the bridge touch points of the Telegram channel go through the connector adapter (1.6.6)

- The bridge of the Telegram channel reads its themes from one seam,
  `server/src/myrmidon/channel-connectors/bridge/`: the addressing of `@alias`
  turns, the cross-channel context, the links to board tasks, the conversation
  identity, the bridged-DM settings, the topic inbound, the voice intake and the
  bridge locale. This first batch converts 26 touch points of the call map
  (OPE-6629) — the most isolated ones; the core no longer reaches those bridge
  modules directly.
- The seam is a deployment switch. With `MYRMIDON_CHANNEL_CONNECTOR_BRIDGE`
  unset (the default) every theme is the bridge module itself, so the board
  behaves byte for byte as before. With the switch on a registered channel
  connector serves the themes it declares, and every symbol it does not serve
  stays with the bridge module — a half-finished connector cannot break a theme
  (fail-open, the rule of the connector design).
- Nothing changes on the running board: no connector is registered yet and the
  switch is off.

### CONNECTORS D3: the last third of the Telegram bridge touch points goes through the connector adapter (1.6.6)

- The bridge seam `server/src/myrmidon/channel-connectors/bridge/` now also
  serves the last third of the call map (OPE-6629, points 53-77): the Telegram
  helper modules the core reaches (upload projection, ephemeral callbacks, media
  intake, rich intake), the DM command menus and menu locale, and the notify
  track (jobs entry, proactivity sweep, the two instance-settings preservation
  keys). The core no longer imports any of these bridge modules directly.
- Every legacy module that lost its last core importer now carries a
  deprecation note: with the bridge flag off the module is still the code that
  runs (fail-open), but new importers must go through the seam, and deleting
  the direct path is the follow-up step after the channel connector ships. The
  code itself is not removed in this change.
- Two contract values stay bound to the legacy module even when a connector
  serves the theme, because stored data carries them: the private-action notice
  text `TELEGRAM_PRIVATE_ACTION_UNAVAILABLE` (already-written rows compare
  against it) and the canonical command list `TELEGRAM_DM_COMMANDS` (its copy
  hashes into the menu-registration version).
- Point 70 of the map — the `packages/shared` re-export of the telegramNotify
  settings contract — intentionally stays out of the seam: it is a data
  contract (types and validators the board UI reads too), not a bridge call a
  connector can serve.
- Nothing changes on the running board: no connector is registered yet, the
  switch is off, and the flag-off behavior is byte for byte the previous code.

### CONNECTORS G: the bridge returns to the direct path when the adapter does not answer (1.6.6)

- The seam of the bridge now wraps every symbol a channel connector serves with
  the fallback chain
  (`server/src/myrmidon/channel-connectors/bridge/fallback.ts`). The adapter
  answers — the core gets its value and the bridge module does not run (no double
  delivery). The adapter throws, rejects or runs out of time — one warn line, one
  `myrmidon_adapter_fallback_total{reason="error"|"timeout"}` sample, and the
  bridge module answers exactly once, so the Telegram bridge keeps working while
  the connector is down.
- With the switch off (the default) the seam hands the bridge module itself over:
  the adapter is not touched and the board behaves byte for byte as before.
- New setting `MYRMIDON_CHANNEL_CONNECTOR_BRIDGE_TIMEOUT_MS` (default 15000 ms)
  bounds one adapter call; a value that is not a positive number keeps the
  default. The counter is part of the board's `/metrics` scrape.

### Pipelines in instance experimental settings (1.6.6 SETTINGS-UI)

- Instance admins can switch Pipelines in Settings > Instance > Experimental. The existing GET/PATCH endpoint stores the flag; the sidebar and pipeline route gate read it. A cloud-managed key stays visible but locked.
- No control is added for workspace recovery or sandbox transport kill switches; these remain operator decisions described below.

### CONNECTORS I: the inbound event of a chat endpoint read through the connector (1.6.6)

- The vendor webhook path reads an inbound transport event through the channel
  connector when one is registered for the endpoint's provider, and through the
  vendor path when none is. The switch of the step is the registry: no connector
  registered — nothing changes for the running board.
- One update never reaches the queue twice: the connector answers `duplicate`
  for a repeated `externalId`, and the read stops at the seam.
- New counter `myrmidon_chat_ingress_total{path="adapter"|"direct"}` tells the
  two readings apart on the metrics scrape.
- Our own failures — an unreadable body, a connector that throws — leave the
  event to the vendor path (fail-open, journaled). A channel never goes silent
  because of us.

### MEDIA-ACL: scoped media-tool token delivery (MEDIA-ACL)

- Adds an operator-controlled, comma-separated allowlist for binding `MEDIA_TOOLS_TOKEN` into selected Hermes bot environments during the media-tools rollout.
- The allowlist is empty by default; each enabled agent still requires an authorized secret reference, and token values are not passed to adapter environment variables.
- The shared ACL registry is exported through the board compose volume and read-only by the media facade; existing entries are preserved when the generated fleet is empty.

### Manage remaining inbox and agent access policies in settings (OPE-11248)

- Company member access now exposes the existing administrator-only inbox agent policy endpoint; agent trust settings expose visibility, assignment, and protected-agent assignment blocks. Blocking or unblocking assignments requires explicit confirmation. Existing trust preset and unrelated permissions remain intact.

### Prevent completing an issue before its linked PR is merged (OPE-8289)

- An issue linked to pull-request work products cannot transition to `done` until every linked PR is verified merged. Open, draft, closed-unmerged, invalid-reference, and provider-unavailable states return the stable `issue_done_pull_request_gate` conflict with a retryable message and PR URL. A closed PR is accepted only when `metadata.replacementPullRequestUrl` names a valid GitHub PR and the existing company-scoped provider resolver verifies that replacement is merged. Freeform comments and asserted metadata do not prove delivery.
- Provider lookups happen before the status transaction; the service then compares the linked work-product snapshot before applying the change. If the work product changed while the lookup was in flight, retry completion. Callers that supply an external transaction cannot safely make network requests and fail closed unless the stored work-product state already proves merged. Refresh/sync linked PR work-product state, then retry. Cancellation remains unchanged.
- Post-deploy audit query: run the same query before and after rollout. It deduplicates PR identities and reports open PRs linked to any done/cancelled issue; historical counts are not a current baseline.

```sql
WITH open_prs AS (
  SELECT DISTINCT
    COALESCE(wp.metadata->>'repo', wp.url) AS pr_key,
    wp.metadata->>'number' AS pr_number
  FROM issue_work_products wp
  WHERE wp.type = 'pull_request'
    AND wp.status IN ('open', 'draft', 'ready_for_review', 'approved', 'changes_requested')
),
affected AS (
  SELECT p.pr_key, p.pr_number
  FROM open_prs p
  WHERE EXISTS (
    SELECT 1
    FROM issue_work_products wp
    JOIN issues i ON i.id = wp.issue_id AND i.company_id = wp.company_id
    WHERE wp.type = 'pull_request'
      AND COALESCE(wp.metadata->>'repo', wp.url) = p.pr_key
      AND wp.metadata->>'number' IS NOT DISTINCT FROM p.pr_number
      AND i.status IN ('done', 'cancelled')
  )
)
SELECT pr_key, pr_number FROM affected ORDER BY pr_key, pr_number;
```

### Access hub: ssh failure notes no longer echo command details (SEC1)

A failed ssh operation of the Access hub (deploy/revoke/dry-run of a key on
a fleet host) now reports only `ssh command timed out` or
`ssh command failed (exit <code>)` in the API response and the journal —
never the host address, the login, the admin key file path or the remote
command. Deploy and dry-run of a secret whose stored public key half is
missing or unparseable now refuse up front with `not_deployed` and the note
`the secret has no parseable public key half` instead of writing a useless
`authorized_keys` line that reported `deployed`. The ssh operations contract
is documented in the Access hub guide.

### ADM archive migration and REST context hook

- Add deterministic migration reports, source provenance, secret removal, and guarded draft import.
- Add bounded REST context delivery with session deduplication and byte metrics.
- See [the operator guide](guides/adm-knowledge-migration.md) for dry-run, apply, environment variables, and rollback. Production installation is a separate operator action.

### Add the built-in instance administrator (ADMIN-ASSISTANT)

- Register the instance administrator as a first-class built-in agent and route routine or complex work through configured LiteLLM models with reserve fallback.

### An agent in "контейнер не поднят" gets its bot container started automatically (1.6.6 AUTO-RESUME)

- When the gateway connect retries of a run ran out, the board marks the agent
  `error` with the reason "контейнер не поднят". Auto-resume used to skip that
  reason (`container_not_started`) until an operator started the container; on
  07.11 an idle-stopped container left adm-devops in error for 4.5 hours.
- The sweep now starts the bot container first, through the board's own start
  path (`IdleStopService.ensureStartedAndHealthy`, the call `claimQueuedRun`
  uses for an idle-stopped container: the driver's start, then a check that the
  container is running and healthy). A healthy container is followed by the
  ordinary resume of the agent.
- A start that fails is retried no sooner than 15 minutes after the previous
  attempt, 4 attempts in all (activity row
  `agent.auto_resume_container_start_failed` for each). After the fourth the
  board gives up once: `agent.auto_resume_exhausted` and the critical
  `agent_error_alert` card, as for any other give-up, and the agent is skipped
  until an operator acts. Each attempt is written to the state
  (`containerStartFailures`) before the start, so a crash or an overlapping
  pass cannot repeat it.
- A resume that follows a healthy start counts in the ordinary streak and its
  cap (3 within the failure window), so a container that starts and still
  refuses the gateway cannot loop for ever. Every other error reason keeps the
  old behaviour. A starter that is absent (no IDLE-STOP service) keeps the old
  skip.

### Quota errors take the model-unavailable path; auto-resume re-arms only on operator action (OPE-11947)

- The Hermes adapters (gateway and local) now mark a run `model_unavailable`
  whenever the provider's overload, quota or maintenance text came back as the
  turn's content (`provider_error_as_content`), not only for Hermes' own "No
  reply" notice. Such a run is retried by the model-unavailable policy
  (30 min, 1 h ... 6 h, five attempts) instead of the 30 second transient pair.
  The replay evidence (`executionRecovery`) is unchanged.
- An agent whose last finished run is model-unavailable is no longer resumed
  on the 1/5/15 minute backoff: a resume wakes every task the agent is
  stranded on, and each new run failed on the same quota again. It returns on
  the long model-unavailable schedule counted from the end of that run: 30 min,
  1 h, 2 h, 4 h, then every 6 h (skip reason `model_unavailable_wait` while it
  waits). These resumes do not count towards the attempt cap and never give up,
  so an agent whose quota ran out comes back by itself no later than 6 hours
  after the quota resets. The series counter (`modelUnavailableResumes`) lives
  in the same state and is dropped when the last run is no longer
  model-unavailable; then the ordinary backoff and cap apply again.
- After auto-resume gives up on an agent (`agent.auto_resume_exhausted`), only
  an operator action re-arms it: an `agent.resumed`, `agent.updated` or
  `agent.error_cleared` activity row written by a user for that agent after the
  give-up. A change of `agents.updated_at` alone (a run, a status change) used
  to re-arm it a few minutes later, so the give-up never held.

### A task can no longer enter `blocked` without a reason (422 `blocked_requires_reason`)

- The issue service update, the single point every status change passes through, refuses a
  transition into `blocked` unless, after the change, the task has an open blocker, a
  `blockerMetadata.blockReason`, or an `unblockDescriptor` with an owner and an action. The
  answer is 422 with `details.code = blocked_requires_reason`. Agents, the board and the system
  paths obey the same rule. Already blocked tasks are not re-validated.
- System paths that block a task with no open blocker now name the reason (a recovery liveness
  descriptor): the stranded-assigned recovery disposition and the raw native failure projection.
- When the last open blocker closes (`done`) and nothing else holds the dependent (no
  `blockReason`, no descriptor, an executor exists), it returns to `todo` in the same
  transaction; the existing dependency wake-up runs after commit.
- A `cancelled` blocker now counts as resolved everywhere, the same as `done` (ADM decision 24.10): one
  source of truth `isBlockerResolved` / `blockerOpenSql` / `blockerOpenCondition` in
  `server/src/myrmidon/blocker-resolved.ts` serves dependency readiness, swarm-claim queue and matcher, idle pickup,
  plugin wake checks, blocker attention and the liveness check for non-blocked sources. Idle pickup therefore
  wakes tasks whose only blockers are cancelled; the workspace sync-back barrier still applies to `done` blockers only.
- `scripts/myrmidon/unblock-reasonless.mjs` returns the existing reasonless blocked tasks to
  `todo` for their executor (dry-run by default, `--apply`, snapshot first, batches of 10, no wake-ups).

### Traceable run cancellations and cached GitHub App tokens (OPE-8543)

- Every run cancellation logs `heartbeat run cancellation requested` with `runId`, `agentId`, `correlationId`, the source (`code`, endpoint, actor) and the reason. The same provenance is stored in `resultJson.executionCancellation` and forwarded to the Hermes gateway as `X-Paperclip-Correlation-Id` / `X-Paperclip-Cancellation-*` headers; the Hermes adapter logs the correlation id and sender when it stops a gateway run.
- `company_secrets.last_resolved_at` is updated at most once per five minutes per secret instead of on every resolution. GitHub App installation tokens are cached until five minutes before expiry (`myrmidon.github_app.issued` is expected to drop to about one per installation per hour).

### Licenses screen: request, install and state of closed-module licenses (LICENSING)

- New screen Settings → Instance → Licenses (instance admins only). It shows the
  installation id, a one-click "Copy request" (`MYRQ1.…`, byte-identical to the
  modules' own `build_request`, naming the closed modules installed into this
  board), the state of every closed module's license (valid until a date /
  expiring / expired / not for this installation / not included / no license /
  invalid signature) and an install form: paste the `MYR1.…` line or load
  `license.key`.
- The board verifies the license with the embedded vendor public key exactly as
  the modules do, refuses one that no module would accept, and writes it in
  place to the file the modules read (`MYR_LICENSE_PATH`, default
  `/etc/myrmidon-license/license.key`). Several trusted public keys and a `kid`
  field are supported for key rotation; licenses without `kid` keep verifying.
- A banner in the common layout tells instance admins when an installed closed
  module has no working license and links to the screen.
- The installer mounts the host license directory into the board read-write and
  sets `MYR_LICENSE_PATH`, so the adapter inside the board and the modules on the
  host read the same file. See `docs/myrmidon/guides/licensing.md`.
- The board no longer issues licenses: the issue form, `POST /api/licensing/issue`,
  `POST /api/licensing/parse-request`, `GET /api/licensing/issued` and the
  variables `MYRMIDON_LICENSE_ISSUER_KEY_FILE` / `MYRMIDON_LICENSE_JOURNAL_FILE`
  are removed; the core never loads a private key. Issuing is the vendor's
  closed module.

### Plugins see whether the user is an instance admin (PLUGIN-INSTANCE-ADMIN)

- The host-verified actor of a plugin action (`context.actor`) now carries
  `isInstanceAdmin` (true only for a board user with the instance admin role),
  and the UI host context of plugin pages and slots carries `isInstanceAdmin`
  for rendering. A plugin can restrict an action to the instance admin without
  keeping its own user list. The SDK test harness accepts
  `actor.isInstanceAdmin`. Data calls carry no actor, as before.

### Pending interactions expire when the issue closes (CLOSED-ISSUE-INTERACTIONS, #2235)

- When an issue transitions to a terminal status (`done` or `cancelled`) — through the HTTP routes or any direct service-level status update — every still-pending issue-thread interaction (`request_confirmation`, `ask_user_questions`, `suggest_tasks`, `request_item_verdicts`, …) moves `pending` → `expired` with result outcome `issue_closed` and `expirationReason: "issue_closed"`. `connection_intent` cards keep outcome `expired` and record the same `expirationReason`. Linked tool actions and secret proposals are revoked or expired in the same transaction; `resolvedAt` is stamped.
- The transition is idempotent: repeated terminal transitions and concurrent resolutions do not double-write, and a later resolve attempt on the expired card returns `409 interaction_issue_closed` instead of acting on a closed issue.
- Migration `0459_expire_pending_interactions_on_closed_issues` performed the one-time catch-up: pre-existing pending rows on issues already in a terminal status were expired in the same shape.
- Docs: the lifecycle is specified in `doc/execution-semantics.md` (§10 Issue-thread interaction resolution) and its Russian version, the API surface in `docs/api/issues.md`, and the agent guidance in `docs/guides/agent-developer/comments-and-communication.md`.

### Input-token economy for bots: stale wake messages, stale tool results, unused tool schemas (CONTEXT-ECONOMY A/B, TOOL-DIET D)

- **A. Superseded wake messages** (off by default since `token-burn-cache-friendly`: a rewrite of an earlier message
  breaks the provider's prompt cache; `context_economy.stale_wakes: true` switches it on). The bot runtime (patch `16-context-economy`) then sends every
  wake message of a session except the newest as a short note (run, issue, wake reason) instead of
  the whole task package. Only the per-call request copy changes; the transcript, `state.db` and
  compaction input are untouched. `HERMES_KEEP_STALE_WAKES=1` in the bot's env restores the old request
  byte for byte.
- **B. Stale tool results** (off by default since `token-burn-cache-friendly`, for the same reason; `context_economy.stale_tool_results: true`
  switches it on; `skill_view` and reads of skill files are never replaced). A tool result of at least 8000 characters that lies below a
  boundary (moving in steps of 8 messages, the last 8 messages are never touched) is sent as a note with the
  tool, its argument summary, the size, a short head and tail and a `ref`. The new `read_stale_tool_result`
  tool returns the original for the ref (in windows for long results). Untrusted external text is never quoted into
  a note. `HERMES_KEEP_STALE_TOOL_RESULTS=1` restores the old request and removes the tool from the
  schema; `HERMES_STALE_TOOL_MIN_CHARS`, `HERMES_STALE_TOOL_KEEP_MESSAGES`, `HERMES_STALE_TOOL_STEP`
  and `HERMES_STALE_TOOL_EXEMPT` (comma-separated tool names never replaced) tune it. The runtime logs
  `context-economy: session=… stale_wakes=… stale_tool_results=… saved_chars=…` whenever the counts change.
- **D. Unused tool schemas.** Patch `17-disabled-tools-by-name` adds `agent.disabled_tools` (single tools,
  subtracted after the toolsets), and the profile compiler writes it: the instance list
  `MYRMIDON_BOT_DISABLED_TOOLS` (default: the five `browser_vault_*` tools and `vision_analyze`,
  about 1.2k tokens per call), replaced by the card's own `adapterConfig.disabledTools` when present.
  A card with its own vision model keeps `vision_analyze`. `MYRMIDON_BOT_DISABLED_TOOLS=none` restores the
  previous `config.yaml`. A changed `config.yaml` restarts the bot container.

### Continuation dedupe counters are exposed on the metrics scrape

- The `/metrics` endpoint exposes `myrmidon_continuation_created_total` for continuation keys claimed
  for the first time and `myrmidon_continuation_deduped_total` for claims suppressed because their
  key was already claimed.
- These counters are process-local and reset when a process restarts. Each sample
  carries the existing `role` label.
- Continuation keys are not metric labels. The scrape exposes no key values or
  per-key series. This avoids unbounded cardinality and identifier disclosure.
- The `metrics-scrape-failing` runbook documents how to interpret the counters.

### A continuation wake carries a summary, not the task history three times (WAKE-HISTORY)

- The structured wake payload JSON that gateway adapters put into the prompt no longer repeats the
  execution continuation: `executionContinuation.messages`, `resumeDelta.messages`, the completed
  work and the other evidence stay in the rendered "Current request and continuation context"
  section only. The JSON keeps the envelope shape and cursors and names what it left out in
  `omittedFromJson`. The JSON is capped at 12000 characters; over the cap the largest cappable keys
  are emptied and listed in `jsonTruncation`.
- New card setting `wakeHistory` for the `hermes_gateway` adapter (`auto` | `summary` | `recent` |
  `full`). `auto` (default) sends the summary only when `sessionKeyStrategy` is `run` or `none`:
  the previous run, its final status, the completed work (2000 characters at most), the open
  interactions and no earlier messages. Every other card gets the newest 8 messages once, each cut
  to 1000 characters (8000 in total); the comments the run was woken for and the latest human
  request stay.
- The continuation envelope gets `previousRun` (`runId`, `status`).

### Continuation wakes only for actionable assigned issues, with a real attempt cap (OPE-11948)

- An automatic `issue_continuation_needed` wake is now admitted only for an issue in `todo` or `in_progress` that is assigned to the woken agent. Issues in `backlog`, `blocked`, `in_review`, `done` and `cancelled`, and issues assigned to someone else, get no continuation wake. A continuation that is already queued is cancelled at dispatch when the issue is no longer `todo` or `in_progress`.
- The continuation loop is now bounded by a real counter. It counts the succeeded continuation runs of one agent on one issue since the latest external input. External input is a comment or a movement by a user or by a different agent, a resolved blocker, a PR or CI sync event. The agent's own comments and updates and system bookkeeping no longer reset it. After 3 such runs no further continuation is enqueued, and the issue is moved to `blocked` with a system comment until an external event arrives.
- Before the change, the agent's own activity counted as progress and kept `continuation_attempt` at 0, so neither the attempt limit nor the rewake throttle stopped the loop: in one day about 22% of engineer wakes were continuation wakes for parked issues.

### Corpus indexing sends embeddings in batches with a timeout (1.6.6 CORPUS-2.0)

- The embedder of the corpus module no longer sends all chunks of a document in one
  request. It sends them in sequential batches of 64 texts and keeps the order of the
  vectors. Cloud embedding endpoints cap the inputs per request and answer a very large
  request slowly, so a long document (thousands of chunks) failed to index before.
- Every embedding request now has a timeout of 120 seconds. The secret that holds the
  embedder key is still resolved once per call, not once per batch. A failed batch fails
  the document as before, and the parse worker retries it. Search sends one text and is
  otherwise unchanged.

### Knowledge corpus in code: hybrid search index and document parser client (CORPUS-2.0 step 4)

- `packages/corpus` gains the search half of the module. `createPostgresSearchIndex`
  implements the `SearchIndex` port as the pilot measured it: a vector ranking over the HNSW
  index with `ef_search = 64` on L2-normalized 1024-dimension embeddings, a full-text ranking
  over the generated `fts` column with its `pg_trgm` indexed fallback, both scoped by company
  and dataset and merged by reciprocal rank fusion (`k0 = 60`, `k_candidates = 100`). Every
  hit carries `score`, `chunk`, `document` and both source ranks; the fused order is
  deterministic. Dataset and `ready` filtering join `corpus_documents`, where part A put them.
- Clusters without pgvector stay usable rather than broken: the package migrations create the
  full-text objects everywhere but the vector objects (the `embedding` column, its HNSW index)
  only where the extension exists, so a search that carries an embedding there fails with the
  module's own `CorpusVectorSearchUnavailableError` — naming the missing migration and keeping
  the driver error as `pgError` — while a search without an embedding still answers from the
  full-text ranking. A raw "undefined column" from the driver no longer reaches the worker. Fresh
  installations and the production cluster already carry the extension, so this path covers installs
  that are upgraded in place.
- Document ingestion behind the ports of part A: the sliding-window chunker (300–1500
  characters, 150 characters of overlap, boundaries on line breaks, configurable), batch
  embedding through the module `Embedder` port, and one atomic `replaceDocumentChunks` call at
  the end, so a gateway failure leaves a document the chunks it already had instead of half of
  a new set. The failure carries a retryable/permanent flag.
- `createHttpDocumentParser` implements the `DocumentParser` port on top of the HTTP client
  (submit, poll, timeouts, retries): the service's pages become parsed blocks in reading
  order, a plain-text answer becomes a single block, and failures are thrown as a typed
  `DocumentParserError` with `retryable` set — the flag the worker needs to record a failed job
  and let the queue retry it, instead of losing the worker. The richer client surface
  (submit/poll/outcome) stays exported, and the wire contract is written down in
  `src/parser/README.md`.
- Tests: fusion, vector helpers, chunker boundaries and `chunk_id` idempotency, the ingestion
  pipeline against the `Embedder` port, both parser surfaces against a mock HTTP server (bytes
  and source-URI submissions, retries, a refused and a failed job, an unreachable service), and
  an integration test for the search path that takes its database from the first source that works —
  the stand named by `CORPUS_TEST_PGVECTOR_DSN`, else the embedded PostgreSQL 18 cluster with
  pgvector staged into it by the package shim — and skips with a printed reason when neither is
  usable. The search SQL itself is unit-tested through a recording SQL executor, so the ordinary
  run needs no database, and the probe tables the integration suite creates are described by
  `src/search/probe-schema.ts`: a database-free guard (`probe-schema.myrmidon.test.ts`) asserts
  that every column the search SQL reads exists in that schema, because a probe table that has
  drifted from the query surface would otherwise only surface as a red lane on the first host that
  can run the suite.
- The vector integration suite can now actually run on CI, where it silently skipped before: the
  embedded-cluster shim unpacked the pgvector package with `tar -J`, while the embedded-postgres
  helper had prepended its own native lib directory to `LD_LIBRARY_PATH` — that directory carries an
  older `liblzma.so.5`, so the system `xz` refused to start (`version `XZ_5.4' not found`) and `tar`
  exited non-zero. The shim now hands `ar` and `tar` an environment with the loader paths removed
  (the treatment the repo's rootless runner already gives `dpkg-deb`), reads the payload member from
  `ar t` instead of assuming `data.tar.xz`, and reports a failed command together with its `stderr`,
  which is where `xz` and `tar` say what went wrong. Database-free tests pin those decisions
  (`test-pgvector.myrmidon.test.ts`), so the extension installs wherever a system `xz` exists.
- The integration stand now mirrors the migration's indexes, not only its columns. The search SQL joins
  chunks to documents by `document_id` and narrows documents by `(dataset_id, status)`, and a probe
  build without those btree indexes made the planner answer with a nested loop that scanned every
  chunk per document: CI measured a 789 ms plan on a 2000-chunk stand with `Rows Removed by Join
  Filter: 4000000`, a shape production never picks and a latency that described the stand rather than
  the product. The probe schema now creates the four btree indexes of the migration's tables, a
  database-free guard fails if any of them goes missing or stops covering the joined and filtered
  columns, and the plan test fails if that join explosion comes back.
- This is the code half of the corpus step; wiring the module to routes, settings and the UI
  follows in the later parts of CORPUS-2.0.

### Corpus shadow mode behind the `corpus.shadow` flag (1.6.6 CORPUS, part A)

- A new instance behavior flag `corpus.shadow` (off by default) compares the
  knowledge-corpus module against RAGFlow without touching bot answers: every
  remote-MCP search call that completes normally gets a fire-and-forget shadow
  leg, and the bot still receives the RAGFlow result exactly as before.
- Each shadow call writes one row into the new `corpus_shadow_log` table
  (migration 0409): bot, dataset, query, the chunk ids and latency of both
  legs, and — for the module leg only — the error text. Module failures never
  surface to the bot.
- The `GET /metrics` endpoint now exposes p50/p95 of both legs
  (`myrmidon_corpus_shadow_ragflow_latency_seconds`,
  `myrmidon_corpus_shadow_module_latency_seconds`) read from the shadow log
  inside the scrape window; with the flag off the families render without
  samples.

### Corpus shadow search follows RAGFlow dataset ids (1.6.6 CORPUS, part A)

- The shadow hook now reads the `dataset_ids` argument of the live RAGFlow
  retrieval tool (an array of RAGFlow dataset ids; the first one is used), so
  `corpus_shadow_log.dataset` is no longer empty for those calls.
- The module leg finds the dataset by its id, by its exact name, or by a
  RAGFlow dataset id: the RAGFlow importer names datasets
  `RAGFlow: <name> [<id>]`, and a name that ends with `[<id>]` matches. A
  missing or ambiguous dataset is still recorded in `module_error`, and the
  search stays inside the company of the bot.

### Corpus keeps non-ASCII file names intact on upload (1.6.6 CORPUS-2.0)

- The corpus upload route now reads the file name of a multipart upload as UTF-8.
  Browsers and HTTP clients send the name as raw UTF-8 bytes, but the multipart
  parser read it as latin1 by default. A Cyrillic name such as `Руководство.pdf`
  was saved as unreadable text in the document title, in the API answers and in the
  audit log. New uploads keep their name.
- Documents uploaded before this fix keep the garbled title. Delete such a document
  and upload it again to get the correct name.

### Deploy precheck counts incoming release images and DB dump reserve (OPE-7723)

- `deploy_disk_precheck` now adds the registry size of every release image that
  is not present locally (resolved through the linux/amd64 platform manifest of
  an OCI image index) to the required free space before pulling anything or
  entering the maintenance window; a deploy that cannot fit is refused before
  the first pull with cleanup candidates printed.
- New setting `MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB` (default 5) reserves space
  for the predeploy database copy. The reserve applies only to full deploys
  that declare `MYRMIDON_DEPLOY_IMAGE_REFS`; `bot-image-rollout.sh` and
  `rollout-component.sh` keep the plain `MYRMIDON_DEPLOY_MIN_FREE_GB` threshold.
- The precheck fails closed when an image size cannot be determined from the
  registry; in `--dry-run` it warns and continues instead (a dry run refuses
  nothing).
- Unknown free space on `/var/lib/docker` continues a dry run with a warning;
  a real deploy is still refused.

### Deploy image retention keeps the current release plus N previous (DEPLOY-HYGIENE, OPE-5107)

- `deploy_image_retention` (deploy.sh step 11, bot-image-rollout.sh step 6b) counted its `MYRMIDON_DEPLOY_IMAGE_KEEP` window over the images no container uses and kept the first `keep + 1` of them. The release a container runs never entered that window, so for the bot images (`myrmidon-hermes`, `-hermes-dev`, `-hermes-node`: pulled by digest, no tags) the window kept two superseded generations on top of the running one. On the production host four generations of each bot image piled up (2.9 + 1.6 + 1.2 GB per generation); the rc.41 and rc.42 deploys logged «0 image(s) removed» and the disk fell to 8% free.
- The window now matches the setting: the current release plus `MYRMIDON_DEPLOY_IMAGE_KEEP` previous ones, per repository. The newest image a container uses is the current release and stays; images newer than it (just pulled, not started yet) always stay and are not counted; after the current release at most `keep` unused images stay, every older unused image is removed. A repository with no used image keeps the `keep + 1` newest as before. An image any container uses is still never removed.
- The summary line now also names how many newer-than-running images were kept.

### Devflow queue health derivations and thresholds

Deployment environment overrides for devflow queue health metrics:
- `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`
- `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`
- `MYRMIDON_DEVFLOW_RED_CI_MS`
- `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS`
- `MYRMIDON_DEVFLOW_NO_MERGES_MS`

### BOT-TUNING-C — per-model effort validation and safe default

- Document per-model validation of the agent-card Thinking effort field and the model-safe default used when the field is empty.
- GLM models via DashScope accept `low`, `high`, and `max`; empty effort resolves to `high` instead of Hermes' incompatible global `medium`.

### Engineer idle and unblocked task metrics in /metrics

- The `/metrics` endpoint exposes `myrmidon_engineers_live` (count of live, unpaused engineer agents).
- The `/metrics` endpoint exposes `myrmidon_engineers_idle` (count of live engineer agents without a heartbeat run in the idle window, default 60 minutes, configurable via `?idle_window=`).
- The `/metrics` endpoint exposes `myrmidon_todo_unblocked_tasks` (count of todo issues without user assignment and without open blocking relations).

### Browser extension package built in CI (CLIENT-1-PKG)

- A new workflow builds `extension/` into `dist-extension/`, checks that every file the manifest names is in the build, and zips it. Pull requests and pushes to `main` get the zip as a workflow artifact; a tag `extension-v<manifest version>` also publishes it as a GitHub Release with a SHA-256 file.

### Release drain no longer leaves sibling issues locked or blocked (1.6.6)

- A sibling issue released by a finished run now keeps the execution lease only while it has a deferred wake to drain; otherwise the lease is handed back and the primary issue is drained as before.
- A release gated on a blocked primary issue reports the block again instead of reporting the sibling as released.

### Fleet control of bots on remote sites works on a split board (OPE-12032)

- On a board running `processes.mode = split`, `POST /api/myrmidon/fleet/bots/:key/restart`, `…/stop`
  and `GET …/logs` for a bot on a registered, healthy site answered `502 … has no active mTLS client
  transport; register valid certificate, key, and CA`. The site mTLS client manager is built by
  `startBotContainers`, which only the worker runs, so an api process had no manager (and no
  bot-container runtime) even with `MYRMIDON_SITE_HEALTH=1`.
- The api process now forwards the fleet control routes of bots and sites to the worker through the
  single-route proxy (the `bot_container` group): `/api/myrmidon/fleet/bots/:key/(restart|stop|logs)`,
  `/api/myrmidon/fleet/sites/overview`, `/api/myrmidon/fleet/sites/:name[/bots|/drain|/resume]` and
  `/api/fleet/bots/:key/(move|logs)`. The worker holds the one client manager and reaches the site's
  fleetd through its mutual-TLS transport. The registry list `GET /api/myrmidon/fleet/sites`, the
  enroll/list/delete routes of `/api/companies/:id/fleet/sites` and the console routes stay with the
  api process (database only).
- Unchanged: with the `singletonProxy` setting off, or on a single-process board, the process that
  serves the route answers from its own manager, and without one the answer is still the clear 502
  naming the site.

### fleetd: optional centralized-memory client boundary (1.6.6)

- `tools/fleetd` gains an isolated HTTP client for the centralized memory
  service, configured by an optional `memory` block in the fleetd JSON
  configuration (`enabled`, `url`, `token`, `bank`, `timeoutMs`). Disabled by
  default: without the block, the new `/v1/memory/recall` and `/v1/memory/retain`
  routes answer `503 centralized_memory_disabled` and no outbound traffic
  happens.
- The boundary speaks only HTTP(S) to the configured URL — no `/host` mount,
  no docker.sock, no host filesystem paths. A non-http(s) URL, an embedded
  credential, or a missing bank fails `--check-config` validation instead of
  starting.
- Upstream failures surface as explicit errors (`memory upstream returned HTTP
  <code>`, `memory upstream unavailable`), never as panics or silent
  degradation; responses are size-capped and every request carries a timeout.

### fleetd: mutual-TLS listener for the site API (1.6.6)

- `tools/fleetd` serves the `/v1` API over TLS and requires a client
  certificate signed by the site CA (`tls.RequireAndVerifyClientCert`, TLS 1.2+).
  New optional JSON config keys: `siteCA`, `serverCert`, `serverKey` (absolute
  paths). A partial set or a relative path fails `--check-config`; starting the
  server without all three is refused. `--check-config` without the TLS block
  stays valid, so existing smoke-test configs keep working.
- The bearer token check stays on top of mTLS. TLS setup errors never include
  key material. This is the listener part of site-agent v1; the Docker backend
  operations are delivered separately.

### Code issues are assigned to engineers only (GATE-CODE-ASSIGN)

Creating an issue, or changing its assignee, now refuses (422 `issue_requires_engineer`) an assignment of a code issue to an agent whose role is not `engineer`. An issue counts as code when it carries the `needs-engineer` label, routes to the engineer caste, or needs a live checkout (`skill_test` harness, `operator_branch`/`reuse_existing` workspace preference); nothing is inferred from the title or description, and an unreadable signal never blocks (fail-open). Whoever already holds the issue can still change its status. Humans can still be assigned, and issues in review or finished can be held by a reviewer. When the workspace of an engineer issue cannot be prepared, the issue returns to the queue through the regular issue update and a free engineer picks it up without a lead.

### GitHub broker explains "no repository" instead of looking like "no access"

- Run engineers saw `gh auth status` or `gh api user` fail as unauthenticated when run outside
  a clone and concluded they had no GitHub access, although the broker issues tokens normally.
  The broker only mints a token once the target `owner/repo` is known, and otherwise answered a
  bare `absent`.
- The broker now infers the repository from the task: its own workspace, then the project's
  primary workspace (a single distinct github.com repository). If none is known it still
  answers `absent`, now with `reasonCode: "repository_required"` and `availableRepositories`,
  the repository patterns of the PAT and App entries that serve the calling agent (at most 50;
  configuration only, never secrets). Nothing is minted or read from the secret store without a
  repository.
- The `gh` wrapper in the bot image also takes the repository from the `repos/OWNER/REPO`
  endpoint of `gh api`, says in plain words "GitHub access is available, pass -R owner/repo,
  set GH_REPO or work inside a clone" (with the allowed repositories), explains a plain `absent`,
  and `gh auth status` reports the broker's state (identity, repository, never the token)
  instead of "not logged in".

### Idle pickup no longer wakes an agent over its daily cap on every tick (IDLE-PICKUP-DAILY-CAP, OPE-11947)

- The per-day heartbeat cap gate (`heartbeat.daily_run_limit`, `heartbeat.daily_cost_limit`) does not hold a wake: it writes a `skipped` row to `agent_wakeup_requests` and returns nothing. Idle pickup offered every ready `todo`/`in_progress` task of an agent on every pass and relied on that gate, so an agent that had used up its `maxDailyRuns` collected one rejected wake per task per pass until midnight UTC: 4 179 rows in 6 hours on the production board (adm-infra 3 277, adm 815, adm-observability 86), 13 591 in 3 days. No run and no tokens were spent, but the table, the feed and the attention-card query filled up.
- Idle pickup now asks the cap gate's own verdict once per agent per pass (the same `getHeartbeatDailyCapBlock` over the agent's own policy, so the run count and the failed-before-model exclusion are not counted a second time). The first attempt of the day still reaches the gate and leaves its one receipt row, which is what the «agent exhausted its daily run limit» attention card is built from. From then on the agent is skipped before any per-task lookup and without a write: at most one row per agent per cap per day. A changed limit counts as a new cap and leaves its own receipt. When the cap lookup fails, the pass behaves as before and the gate decides.
- The pass result gains `dailyCapSkipped` (agents left alone because of a cap, once per agent per pass).

### One-command installer opens the board by IP (OPE-5584)

- The installer now names the addresses of the machine (host names and global
  IPv4 addresses) in the board allow-list (`MYRMIDON_ALLOWED_HOSTNAMES` in
  `deploy.env`, passed to the board as `PAPERCLIP_ALLOWED_HOSTNAMES`). Before,
  the private hostname guard answered 403 to a request by the machine's own IP.
- The address printed at the end and used as the default public URL is the
  first IPv4 of the host instead of `hostname -f`, which resolves only where
  DNS knows the name. `MYRMIDON_ALLOWED_HOSTS` (comma-separated) overrides the
  detected list.

### ONE-COMMAND-INSTALL: installer fixes since 1.6.5 (CPU baseline, dockergate wiring, built-in help)

The 1.6.5 entry describes the first installer. The installer in this release also does the following:

- It reads the CPU feature flags and refuses a processor below the x86-64-v2 baseline (SSE4.2, POPCNT, CMPXCHG16B) before touching the machine: the board image carries native code built for that baseline and dies minutes after start on anything older (`MYRMIDON_INSTALL_CPUINFO` overrides the source of the flags).
- The dockergate service is wired the way a working deployment needs it: it joins the group that owns the docker socket (the GID is read from the socket, kept in `deploy.env` as `MYRMIDON_DOCKER_GID` and passed through `group_add`), shares the host PID namespace (`pid: host`) so its `/proc` lookup of the board's main process resolves, and its configuration file is written `0640` for the image's unprivileged user instead of a root-only `0600`.
- The documented form pipes the script into `bash`, so the script carries its own manual: `--help` prints the command, every option and the update promise, and an option missing its value is named in plain language instead of dying with a bare shell error.
- A release manifest that names no board image digest is refused.
- Tests (`scripts/myrmidon/install/install.test.mjs`) additionally cover the manifest without a board digest, a CPU below the baseline refused before the machine is touched, and `--help` plus a missing option value when the script is piped to bash.

### The issue list honours the `page` parameter (`GET /api/companies/:companyId/issues`)

- The endpoint parsed only `offset`; `page=N` was ignored without an error, so a client (or an agent) that iterated
  `page=1, 2, …` received the first page again and again and could loop until it ran out of memory.
- `page` is now read as `offset = (page - 1) * limit`. It must be a positive integer (`/^[1-9]\d*$/`); `page=0`, a
  negative or a non-numeric value answers HTTP 400. An explicit `offset` still takes priority over `page`.
- The agent skill (`skills/myrmidon/SKILL.md`, `references/api-reference.md`) now describes direct lookup
  (`GET /api/issues/OPE-N`) and `limit` + `offset` pagination.

### K8S-EXPANSION: orchestrator-managed k3s agent body

- Adds the 1.7 design contract for stateful agents on k3s hosted by Proxmox VMs.
  The Myrmidon orchestrator is the sole lifecycle and survivability authority:
  it owns wake, drain, hibernation, recovery, generations, fencing, and queue
  admission. Zabbix is diagnostic-only and cannot mutate lifecycle state; a
  future NATS path is an event transport, not a second source of truth. The
  design defines durable state, second-site recovery boundaries, failure drills,
  security boundaries, and staged acceptance criteria without claiming an
  unmeasured HA guarantee.

### Knowledge module part L-8: nightly deterministic Git export (KNOWLEDGE-2.0 L-8)

- New `server/src/myrmidon/knowledge/git-export*.ts`: the knowledge tree is
  exported once per interval (24 h by default) into a branch of a Git
  repository as Markdown, one file per page. The same set of pages always
  yields the same bytes, so an unchanged tree makes no commit; a deleted page
  disappears from the branch. The `life` section never leaves the database.
  Each company lives in its own `<companyId>/` directory of the shared
  repository; one company never deletes another's pages. Errors from git are
  logged with credentials in URLs removed.
- The job is a no-op until `MYRMIDON_KNOWLEDGE_EXPORT_REPO` is set; branch and
  interval are tuned by `MYRMIDON_KNOWLEDGE_EXPORT_BRANCH` and
  `MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS`.
- Restores #1297 (reverted by #1420/#1423) together with the registry rows for
  the three variables and the updated file list in the module hygiene test.

### Knowledge-note gate for system changes

- System-significant issue changes now require a valid `Вики: slug@rev` reference when moving to `done` or approving review.
- The gate is warning-only for the first three days after 2026-10-31, then returns `knowledge_note_required` when the reference is absent or invalid.

### Knowledge-on-change telemetry on the metrics scrape

- `GET /metrics` answers two more families: `myrmidon_knowledge_on_change_share` (gauge) and `myrmidon_knowledge_revision_delay_seconds` (summary, quantile 0.5/0.95).
- `myrmidon_knowledge_on_change_share` is the share of tasks closed in the last 7 days that have a merged pull-request work product (a system change) and a knowledge revision citing the task (`knowledge_sources` kind=`task`, ref=`issues.identifier`). Tasks closed without a merged PR stay out of the denominator; tasks closed with a merged PR but without a wiki revision count in the denominator only.
- `myrmidon_knowledge_revision_delay_seconds` is the delay from a merged pull-request work product (`issue_work_products` type=`pull_request`, status=`merged`) to a knowledge revision citing that PR (`knowledge_sources` kind=`pr`, matched by `externalId` or `url`). Both quantiles are linear-interpolated percentiles over the non-negative samples.
- Both families are collected by the existing guarded collector; a failed DB read never kills the scrape and renders HELP/TYPE without samples. `METRIC_FAMILIES` names both families so the selfcheck on a broken DB lists them. Each sample carries the existing `role` label.
- The metrics-scrape-failing runbook documents how to interpret the new families.

### Knowledge screen in the current interface

- After the wiki plugin was retired, the side menu of the current interface lost its wiki
  entry and the module's reader existed only in UI2. The current interface now has a
  "Knowledge" menu item and the screens `/:companyPrefix/wiki` and
  `/:companyPrefix/wiki/:spaceKey/:slug`: page tree, search (full-text and semantic), the page
  with its sources, backlinks and revisions.
- The screen reuses the UI2 reader and reads the knowledge module through the existing REST
  facade (`/api/myrmidon/companies/:id/knowledge/*`: items, search, backlinks). Backlinks are
  now actually loaded and shown as links to the linking pages.

### The licensing screen honours the vendor's signed deny-list of revoked licenses

- A license may now carry an optional signed `id`; licenses without it verify as before.
- If a file `license.deny.json` signed by a trusted issuer key lists a license's `id`,
  `instance_id` or `kid`, the module status shows it as invalid with reason `revoked`.
  The file lives next to `license.key` (override `MYR_LICENSE_DENY_PATH`), is re-read on every
  request, and an absent, broken or foreign-signed file revokes nobody (a warning is logged).
  A list with a `serial` lower than the highest one seen is rejected; the highest serial is kept
  next to the license (`MYR_LICENSE_DENY_STATE_PATH`).
- `license.deny.state` records the highest observed serial; `license.deny.accepted` stores the complete signed envelope of the latest accepted list. On rollback, the board ignores the older incoming list and keeps applying the accepted cache. If that cache is absent, the check fails closed with reason `denylist_rollback_no_cache` and logs a warning. Damaged or unverifiable incoming lists are ignored and do not replace accepted state. Back up and restore both state files with the license directory; monitor logs for `denylist_rollback_no_cache`.
- Added `POST /api/licensing/deny-list` endpoint for atomic delivery and saving of the signed deny-list.

### Image licenses note: primary-text assessment of the SDK/libvips dependencies (LICENSES-NOTE)

- New `docs/myrmidon/licenses.md` and `docs/myrmidon/licenses.ru.md`: what the
  primary license texts (npm tarballs, Anthropic Commercial Terms, Cursor ToS,
  LGPL-3.0) permit or forbid for redistributing `@anthropic-ai/claude-agent-sdk`,
  `@cursor/sdk`, `@img/sharp-libvips-*` and the globally installed
  `@anthropic-ai/claude-code` inside the published MIT image; options
  keep/opt-in/exclude and one recommendation (B: opt-in target for the
  proprietary SDKs, keep libvips with a notice). Research note for the
  maintainer, not legal advice; no code or license policy changed.

### Installation id for closed-module licensing (LICENSING)

- `GET /api/licensing/install-id` (instance admins only) returns the
  installation id (`myr-` + 20 hex of `sha256(machine-id)`, the same algorithm
  the closed connector modules use). The board does not issue licenses: issuing
  is the vendor's closed module. See `docs/myrmidon/guides/licensing.md`.

### One installation id, owned by the board (OPE-8836)

- The installation id is now stored in the board database (table
  `myrmidon_install_identity`, migration `0404_install_identity`) and never
  changes. On the first start it is `MYR_LICENSE_INSTANCE_ID` if set, else
  `myr-` + 20 hex of `sha256(machine-id)` (the same formula as before, so
  licenses already issued stay valid), else `myr-` + 20 hex of a random UUID.
  A later change of the machine id or of the variable does not touch it.
- `GET /api/licensing/install-id`, the Licenses screen and the license check
  read the id only from the database; none of them reads the machine id.
- At start the board writes the id to the file `instance-id` in the license
  directory (`dirname(MYR_LICENSE_PATH)`, default `/etc/myrmidon-license`) for
  the closed modules: atomically, mode 0644. If the directory is not writable
  the board logs a warning and starts anyway.
- A license issued for another installation now says so with both ids: the one
  the license was issued for and the id of this board, on the screen and in the
  API (`licenseInstanceId`, `boardInstanceId`, `message`).
- `MYR_LICENSE_STATE_DIR` is no longer used by the board.
- `deploy.sh` and `install.sh` check the license directory before changing
  anything (also in `--dry-run`): an `issuer` subdirectory, `*.pem` or
  `*ed25519*` files in it, or a compose issuer mount inside it stop the run with
  a message to move the issuing key to `/etc/myrmidon-license-issuer`. The
  directory is mounted into the module containers.

### LiteLLM workers card: planned restart instead of gunicorn signals, real `current` and working metrics (OPE-8899)

- The gateway runs as `litellm --num_workers N`, not under gunicorn, so the TTIN/TTOU
  signals never applied. `apply.path` is now `restart`: `PUT .../litellm/workers` stores the
  target, runs the instance's restart command (`MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND`,
  `{workers}` is the target) and then reads the pool size back; `applied` is true only when
  it equals the target. Nothing is restarted unless the command is configured, and a pool
  already at its measured target is not restarted. The card warns that requests are briefly
  dropped before the operator confirms. `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` and
  `MYRMIDON_LITELLM_WORKERS_CONTAINER` are removed.
- `current` is no longer null on such a gateway: it is taken from the gateway's own pool
  gauge or, when the exposition names none (Prometheus in multiprocess mode), from the
  `--num_workers` of the gateway unit file (`MYRMIDON_LITELLM_WORKERS_UNIT_FILE`, read-only,
  `currentSource: launch_line`).
- Metrics read `reachable=false` with HTTP 401 because the board sent the secret NAME as the
  bearer token and asked for `/metrics`, which the gateway redirects. The key is now resolved
  from the company secret store (the cost-reader secret, else the admin one) and the request
  goes to `/metrics/`.

### `myrmidon:migrate` accepts Paperclip releases v2026.1001.0, v2026.1005.0 and v2026.1012.0 (MIGRATE-D)

- The source can now be any of the Paperclip releases `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0` or
  `v2026.1012.0`. The release is recognised by the exact hashes of the applied migrations and is
  named in the dry-run report (`source.vendorRelease`). Truncated, extended and foreign
  histories are still refused before any write, now with the list of supported releases.
- Data of Paperclip features that Myrmidon does not have (tables and columns added after
  `v2026.916.1`, such as browser-use runs or MCP OAuth clients) is no longer an error. The dry run
  lists it as `vendorOnlyData`: table or column, rows that hold data, release. When any of it
  holds data a real run stops before the first write unless `--accept-vendor-only-data` is given;
  that data is not transferred. Empty ones are left out and reported. Other schema differences
  stay errors. A value that does not fit a narrower target column (`assets.byte_size`, `bigint` to
  `integer`) is refused before rows are copied.
- Adding the next Paperclip release is one command (`scripts/myrmidon/vendor-release-add.mjs <tag>`),
  and a daily workflow fails when a new Paperclip release is published that is not in the list.

### CLI: `myrmidon:migrate` moves a Paperclip v2026.916.1 instance into a clean Myrmidon target (MIGRATE-A)

- New command `paperclipai myrmidon:migrate`: `--dry-run` prints a full JSON inventory (tables, row counts, content digests, secret carriers, file manifest, exclusions) and writes nothing; without `--dry-run` it transfers the database, the storage files and the secrets.
- Source is a PostgreSQL URL (read-only snapshot) or a plain `pg_dump` file restored into an empty scratch database. The source is supported only when its applied migration hashes equal the pinned vendor chain of release v2026.916.1 exactly; any other history is rejected before the target is touched.
- Secrets stored as `local_encrypted_v1` envelopes anywhere in a JSON column are decrypted with the source key and encrypted with the target key through the existing provider; the run fails closed on a wrong key, on a carrier in a text column, and verifies the target decryption (the old key must not open the target).
- The target must be an empty dedicated database and an empty directory. A lock and a durable journal in `--state-dir` make a rerun idempotent and a failed run resumable without duplicates; `--rollback` removes only what the run created.
- The server package now exports `secrets/local-encrypted-provider` so the CLI reuses the provider instead of copying the cipher.

### Guide: migrating from Paperclip to Myrmidon (MIGRATE-C)

- New user guide `docs/myrmidon/migration-from-paperclip.md`: supported source release, prerequisites, backup, dry run, transfer from a database URL or a pg_dump file, verification, cutover limits, and rollback — written against the actual behavior of `paperclipai myrmidon:migrate`. Russian version: `migration-from-paperclip.ru.md`.

### Migration guide: plain-language introduction and where source-only data goes (MIGRATE-D4)

- The guide for `myrmidon:migrate` now opens with what the command does, that the source is never changed and the command writes only to the empty target it creates, and when it stops. It also explains that data of Paperclip features that Myrmidon lacks is not copied into the database but listed in the report under `vendorOnlyData`. Russian version: `migration-from-paperclip.ru.md`.

### Restore monitor after recovery unblock (MON-RESTORE)
- Restore monitors cleared by recovery blocking and publish clear notices.

### Fleet dashboard: Zabbix 7.4 client, additive settings PATCH, host mapping (1.6.6 MONITORING C)

- The Zabbix client now sends the token as `Authorization: Bearer` (never in the JSON-RPC `auth` body), and `apiinfo.version` selfcheck calls go out without auth headers — compatible with Zabbix 7.4, the `zbx-auth-shim` proxy is no longer needed.
- Dashboard item keys fall back per source in order: memory `vm.memory.utilization` → `vm.memory.util`, disk `vfs.fs.size[/,pused]` → `vfs.fs.dependent.size[/,pused]` — Zabbix 7.4 «Linux active» hosts show CPU, memory and disk instead of CPU-only.
- `PATCH /api/myrmidon/monitoring` is additive: omitted fields keep their stored values (patching `zabbixUrl` no longer nulls `vmUrl`); an explicit `null` still clears.
- New setting `zabbixHostMapping` (`{}` default) maps a VictoriaMetrics `instance` label (bare host or `host:port`) to a Zabbix host technical/visible name, merging both sources into one host card (no more the same host twice); merged cards keep the VM metrics and fill CPU/memory/swap/disk gaps from Zabbix, and the build-VPS fleet rollup still resolves through the mapping.

### Multi-agent addressing in the bridged Telegram chat (TG-MULTI-AGENT)

- A matching `@<token>` mention identifies the addressed agent. The `/to`
  command stores the selected addressee, shown by `/who` and `/agents`, but
  ordinary messages without a matching mention continue to the endpoint's
  assigned agent. No new setting: the addressing rides the X8b bridge (see
  [telegram-alias-addressing](../guides/telegram-alias-addressing.md)).

### Debates per caste and the «Discuss» button on a caste's task (DEBATE-ASYM B)

- Every caste now has its own debate configuration, on top of the instance
  level part A introduced: whether debates run for the caste at all, the model
  of each role, extra guidance per role, the rounds (at most three) and the
  token ceiling. The entry is stored inside the same
  `instance_settings.general.debate` value, under `castes.<key>`, pinned to its
  company — so there is no migration, no restart (it is read at run time), and
  an entry written for another company is inert instead of silently driving a
  same-named caste elsewhere. A caste with no entry of its own inherits the
  instance configuration and is **on**; the switch exists to take a caste out
  of the spend.
- The screen is Instance → General → Asymmetric debates → **Debates per caste**
  (the instance roles stay above it); the API is
  `GET`/`PATCH /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings`
  (board reads, instance admin writes, every save audited as
  `debate.caste_settings.saved`). Both the switch and the configuration show
  where their value comes from (*set for this caste* / *inherited from the
  instance level*), and a save applies to the next debate with no restart.
- The cross-family rule is re-checked on the **merged** configuration: a caste
  that overrides only the critic cannot slip a same-family judge past it, and
  nothing is stored when the result cannot run. A caste's guidance per role is
  appended to the built-in pole prompt — the critic keeps its adversarial pole
  and its missed-error penalty; a caste narrows where a role looks, it does not
  change the nature of the dispute.
- A debate can be started **from the task of a caste**: every row of a role
  queue on the swarm supervisor page (`/swarm-claim`) carries a **Discuss**
  button, which runs one debate for that task with the row's caste
  (`POST …/debates/issues/:issueId/run` with `{ casteKey }`) and shows the
  judge's verdict, how the debate stopped, the rounds, tokens and cost, the
  caste and which roles used custom guidance, and the name of the result
  document. The transcript, the roles and the cost still land on the task as
  the `debate-result` document and as task-level cost events, so BUDGET-CONFIG
  counts a debate like any other work. A switched-off caste refuses the run with
  `422 debate_caste_disabled` and the screen says where the switch lives; a task
  that is not routed to a caste keeps part A's instance-level behaviour.
- Pilot: the marketing caste. Check the engine is configured (three families),
  pick *marketing* in *Debates per caste*, set its models/rounds/ceiling and —
  if the caste needs it — its own guidance per role, then press **Discuss** on a
  marketing task in the role queue. Guide:
  `docs/myrmidon/guides/debate-asym-castes.md` (RU:
  `debate-asym-castes.ru.md`).

### Foraging → knowledge proposals (KNOWLEDGE-2.0 L-5)

- A foraging finding no longer becomes a skill candidate directly. The
  foraging candidate port now routes to KNOWLEDGE first: every finding with a
  diff becomes exactly one `pending` knowledge suggestion (a proposal). The
  suggestion id is what lands in `foraging_findings.candidate_ref` — the
  candidate_ref of a foraged finding is the proposal itself. If the knowledge
  module cannot be constructed the previous skill-lifecycle port stays as the
  fallback; the null port (findings stay `unverified`) is still the last
  resort. No auto-accept, ever: the suggestion waits for a human decision on
  the suggestions review surface.
- Provenance is explicit: the suggestion row carries `trust=external` (the
  only source of a foraged claim is a foreign url) and the url as
  `source_ref` with `source_kind=url`. The column is new
  (`knowledge_suggestions.trust`, migration 0315, nullable — existing rows
  stay null = internal provenance).
- The foreign text never enters knowledge. The captured page text is
  quarantined as a document of the `foraging-inbox` corpus dataset (created
  per company on first finding; one document per finding, the raw lines in
  `metadata.markdown`, capped at 64 KiB, metadata carries
  `{role, skillKey, sourceId}`). Knowledge receives only our own retelling:
  a single-line body (summary + up to six added/removed lines joined by `|`)
  that cites the url. Quarantine first, proposal second — when the
  quarantine fails, no proposal is created (fail closed); when only the
  proposal fails, the quarantine document is kept and the finding stays
  `unverified`.
- The pass itself stays idle-only: this release also ports FORAGING-IDLE-GATE
  (1.6.3, OPE-4142) onto the 1.7 line — the per-role idle check (queue empty
  + a free agent of the role) gates every pass, `GET`/`PATCH
  /api/myrmidon/foraging/idle-gate` and Instance → General → "Foraging idle
  gate" are unchanged, `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` is the forced
  environment override.

### GUARDRAILS false-positive eval on the reference corpus as a CI check (1.7-GRD-CI)

- The 1.6.1 reference corpus now drives a CI gate: a pure harness
  (`server/src/myrmidon/guardrails/eval/evaluate.ts`) runs every registered
  rule over every labelled case and reports, per rule, support, TP/FP/FN,
  false blocks (a rule firing on a clean fixture), precision and recall.
  The blocking number is false blocks — target 0; any false block turns the
  check red, so a blocking mode can never be shipped blind.
- Rules: `injection` (wake-queue heuristic at the shipped default threshold)
  is active; `secret`/`pii` (the part-A output detectors) load optionally —
  while the part-A module is not on main the rules report
  `pending-base-layer` (coverage listed, not gating) and activate
  automatically once it merges, with no change to this code.
- The per-rule report is a committed, generated artifact
  (`report.json` / `report.md` next to the harness). CI recomputes it and
  fails on any drift: a detector or corpus change that moves false positives
  or misses cannot merge without the artifact diff showing it. Regenerate
  deliberately with `pnpm --filter @paperclipai/server exec tsx
  ../scripts/myrmidon/guardrails-eval/refresh.ts` — it refuses to write when
  the eval is red.
- Recall is measured and published, not gated: the committed report names
  every injection case the heuristic currently misses (6/20 flagged at the
  default threshold) — the evidence base for the guardrail-modes track that
  decides per-rule blocking.
- No runtime settings: the eval is CI-only, measuring the shipped defaults.

### Users under the administrator's control (USERS-ADMIN-UI part A, server)
- An instance administrator can create board users directly (1.7 USERS-ADMIN-UI A):
  `POST /api/myrmidon/users-admin-a/users` with a login and either a
  password or a one-time password-set link, and a role
  (`instance_admin` or `member`). A user created without an email gets the
  synthetic address `<login>@myr.local` and signs in with the login through
  the new `POST /api/auth/sign-in/username`.
- Blocking (`PATCH /users/:id {blocked}`) closes every live session of the
  user immediately and refuses new sign-ins on every Better Auth path
  (`403 USER_BLOCKED`); unblocking restores access.
- A password reset (`PATCH /users/:id {resetPassword}`) revokes outstanding
  tokens and returns a fresh one-time link; the user picks the new password
  through it (the token is sha256-hashed at rest and dies on first use).
- Self-registration is off by default: `POST /api/auth/sign-up/email`
  answers `403 SELF_SIGN_UP_DISABLED` until the instance enables it
  (`GET/PATCH /api/myrmidon/users-admin-a/self-sign-up`,
  `MYRMIDON_AUTH_SELF_SIGN_UP` as the forced env override). The gate reads
  the setting live, so flipping it needs no restart.
- Every mutation is audit-logged (`instance.user.created/blocked/unblocked/
  password_reset/password_set`) with who, whom, the role granted and the
  block reason. New table `user_password_set_tokens` (migration 0298); the
  block list lives in `instance_settings.general.myrmidonAuthBlockedUsers`.

### SWARM: agent list query filters q, status, role, reportsTo (OPE-10129)

- `GET /companies/:companyId/agents` now supports query filters `q`, `status`, `role`, and `reportsTo`.
- `q` matches against agent name, role, or title (case-insensitive substring match).
- `status` accepts a single status or a comma-separated list of agent statuses.
- `role` performs exact role matching.
- `reportsTo` accepts an agent ID or `none` for root agents (`reportsTo == null`).
- Filters combine via AND logic and are applied after actor permission filtering (`filterAgentsForActor`).
- Unsupported query parameters continue to return HTTP 400 with the list of unsupported parameters.
- ETag generation (`svc.listSummariesVersionKey`) includes normalized filters so filtered queries and unfiltered queries produce distinct version keys.
- UI client `agentsApi.list` accepts optional `AgentListFilters` parameter without changing parameterless calls.

### Complete busy-agent profile updates (L6-PROFILE-UPDATE-STARVATION)

- Maintenance drain completion waits for owned interrupted runs to finish teardown before promoting retries.
- The stuck-window backstop applies only to agent-scoped `entering` windows and closes them through the normal exit path (queue wake, exit hook).
- Agent status exposes pending profile-update time while an agent-scoped maintenance window is open.

### `myr-ws open` safely recovers standalone legacy clones (PR #1427)

- `myr-ws open <KEY> <REPO>` can adopt a legacy standalone Git clone at the task path after verifying that it is a real standalone copy, has a recognizable GitHub origin, and matches the requested repository. An unrelated directory, linked worktree, or repository mismatch is refused without being adopted.
- The original clone is always moved to `<path>.legacy-<KEY>` and retained there, whether or not it is clean; `myr-ws open` refuses if that path already exists. If the copy has a `HEAD` and uncommitted changes, the command saves its current commit at `refs/myr-ws/recovery/<KEY>` inside the legacy copy and saves tracked and untracked working-tree changes in a Git stash named `myr-ws recovery <KEY>`; a clean copy gets neither. If the copy has no `HEAD`, the stash cannot be created and `myr-ws open` fails with "could not preserve legacy working tree". If preserving the worktree fails or cannot be verified, the command stops before moving the original clone, though a recovery ref may already have been created. When the copy had a `HEAD`, the JSON result reports `recoveryRef` as `refs/heads/myr-ws/recovery/<KEY>` in the base repository; that branch is created only if the copy's commit differs from the new worktree's `HEAD`, so the field may name a branch that does not exist.
- If preserving the worktree fails or cannot be verified, `myr-ws open` stops and leaves the original copy in place. If creating the replacement worktree fails, it restores the original clone path. Running `myr-ws open` again reuses the registered managed worktree.
- An unregistered linked worktree already at the task path is adopted into the registry and reused; this supports recovery after registry loss without converting the worktree.

### `myr-ws`: one task can hold copies of two repositories (OPE-8946)

- `myr-ws open KEY owner/repo` no longer fails with "already open for ..." when the task already
  holds a copy of another repository: the second copy is opened next to the first as
  `/workspace/KEY.<repo-name>` (branch `bot/KEY` in its own base). Opening the same repository
  again returns its copy (`reused`).
- `myr-ws close KEY` closes every copy of the task (the first dirty or unpushed copy stops it
  with exit 7 as before); `myr-ws close KEY owner/repo` closes one. `myr-ws restore KEY owner/repo`
  picks the archive of that repository; `list` already shows every copy.

### A failed `myr-ws open` no longer turns the agent to error (OPE-8946)

- Any failure to open the task copy for a run (exit code outside 3/4/5, timeout, no path in the output) now
  starts the run in `/scratch` with a `run.workspace_fallback` warning, like the quota refusals. Before, it
  failed the run, and repeated failed runs put the agent in `error` status.

### `myr-ws open` repairs a copy a run left half-way; `--branch` / `--repository`; the task's PR picks the workspace (MYR-WS-RECOVER)

- A reused task copy is no longer returned as it is. `myr-ws open` first looks for a merge, rebase,
  cherry-pick, revert or `git am` in progress, unresolved index stages, a detached head and a branch
  other than the registry (or `--branch`) names. Found: the whole state (HEAD, the index with the
  conflicts as files, the working tree, untracked files) is saved as a commit in
  `refs/myr-ws/recovery/<KEY>` (`-2`, `-3`, ... when taken), then the operation is aborted
  (`merge --abort`, `rebase --abort`, ...). If that does not clean the copy, the worktree is recreated
  on the same branch. Local changes that block a branch switch go to the stash. The answer says what was
  done: `recovered: [{problem, action, detail}]` and `recoveryRef` in `--json`, one line on stderr
  otherwise. A branch the bot moved the copy to on its own is adopted into the registry (nothing on disk
  changes); a worktree whose git directory is gone is moved aside and replaced.
- `myr-ws open KEY owner/repo --branch <name>` opens (or moves the copy to) that branch, taken from its
  remote state, instead of `bot/<KEY>`; `--repository owner/repo` is the named form of the positional.
- The hermes gateway adapter takes the repository and the head branch of the task's own pull request
  work product (`context.paperclipPullRequest`, filled by the server per run), and uses the project's
  repository only as a fallback, then the instance default. A PR of another repository than the
  project's (OPE-7967, PR #82 of `myrmidon-deploy`) no longer fails every run with "already open for ...".
- A run interrupted mid-merge (maintenance drain, kill) is repaired by botd: when no run is going or
  possibly going, each pass calls the new `myr-ws repair [KEY]`, which applies the same recovery to
  copies with no process working inside them.

### Add a pinned omp agent runtime image (OPE-7290)

- Add a CI-published, non-root omp runtime image with Bun 1.4.3 and `@oh-my-pi/pi-coding-agent` 18.9.2 matching the adapter version in Part A. The image smoke-checks `omp --version`, `bun --version`, `command -v omp`, `omp --help`, and `omp models ls` without contacting a model provider, and validates adapter execution alignment.

### Transactional outbox for governed secret-proposal resolution (OPE-10061 / OPE-3061 / OPE-3078)

- Governed approval and rejection via `markProposalInteractionResolution` writes an interaction continuation outbox intent inside the resolution transaction for `continuation_policy wake_assignee` and `wake_assignee_on_accept`.
- Guaranteed delivery via periodic outbox sweep on direct enqueue failure.
- Deterministic idempotency key (`interaction:<interactionId>:<status>`) for `secret_proposal_resolved` to prevent duplicate wakeups and double launches.
- Continuation policies outside resolution scope (`none`, or `wake_assignee_on_accept` on reject) skip outbox recording and wakeup dispatch.

### Pipeline liveness metrics and alerts in DEVFLOW health (OPE-10075)

- Added persisted, observable liveness and age metrics and actionable alerts to DEVFLOW health monitoring for three pipeline stages:
  - **Approval-to-PR-marker step** (`staleMarkerMs`): emits an alert when an APPROVE review verdict exists on an open PR but the `review-approved` marker is missing or stale.
  - **Auto-merge step** (`stalledMergeMs`): emits an alert when an approved PR remains unmerged beyond the configured threshold.
  - **Review router queue** (`stalledRouterMs`): emits an alert when an issue in `in_review` needing a reviewer remains unrouted beyond the configured threshold.
- Automatic recovery: all alerts clear automatically when progress is made (marker applied, PR merged/closed, reviewer assigned, or review verdict changed).
- Configurable thresholds via `instance_settings.general.devflowHealth` and environment variable overrides (`MYRMIDON_DEVFLOW_STALE_MARKER_MS` / `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`, `MYRMIDON_DEVFLOW_STALLED_MERGE_MS` / `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`, `MYRMIDON_DEVFLOW_STALLED_ROUTER_MS` / `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`).

### DEVFLOW: behavior-level integration tests for PR approval and pipeline liveness (OPE-10076)

- Added comprehensive behavior-level integration tests covering the complete DEVFLOW lifecycle in `server/src/__tests__/devflow-lifecycle.integration.test.ts`.
- Validated native APPROVE propagation, non-approval guards, idempotency, pipeline liveness alerts (`staleMarkerMs`, `stalledMergeMs`, `stalledRouterMs`), and automatic recovery.

### Hot delivery of company skills without container restart (OPE-10086)

- Skill files (`hermes/skills/paperclip-managed/**`) are now classified as files-class changes (`filesHash`) rather than restart-class (`restartHash`).
- Modifying, adding, or removing company skills applies to the running bot container via live profile write without restarting the container or entering maintenance mode.
- In-progress runs are not interrupted by skill updates, and subsequent runs receive the updated skills per run.

### Alibaba image connector is covered by the closed-module license gate (LICENSING)

- The board now lists `alibaba-image` as a known closed module.
- Installed `myrmidon.alibaba-image` plugins appear in the license status and request.
- The existing Ed25519 verifier applies installation, expiry, module, and feature checks.
- Missing, invalid, expired, tampered, foreign, or ungranted licenses remain fail-closed.
- No private signing key is shipped to the board.

### PREDEPLOY-IO throttles the throwaway database copy at the Docker data device

- `predeploy-board-check.sh` applies `--device-read-bps` and
  `--device-write-bps` to the throwaway Postgres container. The default is
  30,000,000 bytes/s (30 MB/s), configurable with
  `MYRMIDON_PREDEPLOY_IO_RATE`; restore, `ANALYZE`, readiness probes and other
  `docker exec` work run inside that throttled container.
- The backing device comes from `MYRMIDON_PREDEPLOY_IO_DEVICE` when set;
  otherwise the script resolves the device carrying DockerRootDir with
  `findmnt` and fails closed if it cannot identify one.
- Dry-run output shows the effective device and limits; fake-Docker tests assert
  both Docker flags.

### The merge controller ignores a skipped `CI result` run when it picks the latest run (OPE-10461)

- On `main` the `CI result` job is skipped on a label event (except `full-ci`), so its `skipped` run is newer than the
  real one. `scripts/myrmidon/review-approve-label.mjs` took the newest `CI result` check run by `started_at`, saw
  `skipped` instead of `success`, and neither set the label nor enabled auto-merge (`ci-skipped`): approved pull
  requests did not merge on their own.
- New pure function `selectCiResultConclusion`: runs are taken from the newest to the oldest (`started_at`, then
  id); a completed `skipped` run is passed over and the first other one decides; a running one (`queued` /
  `in_progress`) answers with its status, that is pending; only `skipped` runs give pending; no runs give `missing`;
  `cancelled`, `timed_out`, `neutral` and the like are never read as `success`.
- The GitHub port's `ciConclusion` reads all check runs (`check_name=CI result`, `filter=all`, pages of 100), as
  the board-side merge reader already does. The board-side reader already skipped `skipped`; its code is unchanged,
  a regression test was added.

### LiteLLM v1.104.1 overlay restores streaming cost accounting

- Added the operator runbook [`guides/litellm-streaming-cost-overlay.md`](guides/litellm-streaming-cost-overlay.md) and its Russian version. It documents the pinned `ghcr.io/berriai/litellm:v1.104.1` overlay, planned restart, live smoke checks, rollback, and the decision not to backfill historical rows.
- The verification procedure requires all seven overlay tests and checks that `LiteLLM_SpendLogs.spend` matches the configured token-price calculation.

### Corpus reports clear error when embedder is not configured (1.6.7 CORPUS)

- Uploading documents and executing semantic searches in a company without an embedder
  (missing secret `MYRMIDON_CORPUS_EMBEDDER_API_KEY` and no `embedderBaseUrl`) now rejects
  with HTTP 422 `corpus_embedder_not_configured` accompanied by a actionable hint.
- Uploaded documents without an available embedder are marked with status `failed` and
  record `corpus_embedder_not_configured` as their failure reason.

### Review routing: timer-based reassignment of stalled green-CI reviews (OPE-10731)

- Stalled reviews on tasks with green CI (`head.ci === "green"`) and no verdict (`head.reviewDecision === null`) are now reassigned to another eligible reviewer of the same caste after `reassignAfterMinutes` minutes.
- Reassignment prioritizes idle agents (`status === "idle"`, zero active runs, or zero load) before least-loaded agents; the author, the executor, and reviewers who previously lapsed or had the task are excluded.
- The `reassignAfterMinutes` setting is configurable in `instance_settings.general.reviewRouting` (Company Settings → Review routing) with range 0–129600 minutes (0 disables minute-based reassignment), taking precedence over `reassignAfterHours`.

### Codex OAuth lifecycle for pool accounts, limit windows (5h/7d), and K-12 tariff handling (OPE-10810)

- Implemented Codex OAuth lifecycle (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`) for subscription pool providers.
- Strict secret-store isolation for OAuth tokens (`modelProviderAccountSecretName`) — credentials are never returned over plain API responses or exposed to UI clients.
- Added subscription plan support (Plus, Pro, K-12): K-12 tariff accounts (disabled per ADM 05.11 directive) are marked disabled (`isDisabled: true`), excluded from live pool rotation and active counts.
- Enforced 5-hour rolling primary and weekly secondary quota window tracking with automated limit exhaustion detection (`p_used`/`p_reset_at`).
- UI enhancements in ModelProvidersScreen: Codex OAuth login trigger and authorization modal, channel plan badges, disabled state indication, and token refresh action.
- Added and updated tests:
  - `server/src/myrmidon/model-providers/codex-oauth-pool.myrmidon.test.ts`: verified `isK12Plan`, secret name derivation under `modelProviderAccountSecretName`, pool channel mapping with 5h/7d windows (`p_used`/`p_reset_at`), disabled account status for K-12, ignoring disabled accounts in signal evaluation, and full Codex OAuth lifecycle (`oauthBegin`, `oauthStatus`, `oauthComplete`, `oauthRefresh`).
  - `ui/src/components/myrmidon/model-providers/ModelProvidersScreen.myrmidon.test.tsx`: verified Plus, Pro, K-12 badges, disabled counter and status rendering, and OAuth modal flow.
  - `server/src/myrmidon/model-providers/signals.ts`: verified signal evaluation ignores disabled accounts.

### Agent Settings: sandbox controls for local adapters, Hindsight fields for Hermes, a secret picker for the OpenClaw device token (OPE-11247)

- Claude, Codex and Hermes local adapters get Bubblewrap filesystem and network controls in the agent card. Network
  allowlist entries are validated, and Bubblewrap is limited to the supported CLI engines.
- Hermes agent cards get the Hindsight bank, tags, mission, recall budget, memory mode, auto-retain and observation
  scopes in Advanced settings; the bot profile consumes them (`server/src/myrmidon/bot-containers/profile-input.ts`).
  The plugin's own recall policy stays plugin-wide (`doc/architecture/memory-layers.md` explains the boundary).
- The OpenClaw device token is bound through a company secret reference (a picker in the card). A raw token is
  rejected at the persistence boundary and secret references are resolved at runtime.
- Internal probe timeout fields are excluded from editing: they are diagnostics, not operator adapter settings.

### A run over the agent's daily run limit is deferred to the window reset instead of being cancelled (OPE-11718)

- A queued run refused by the admission gate under `heartbeat.daily_run_limit` used to become `cancelled`, which is
  final: the task waited for the next external event. The same run now goes `queued` → `scheduled_retry`
  (`deferQueuedRunForHeartbeatDailyRunLimit` in `heartbeat.ts`):
  - `scheduled_retry_at` is the end of the day window the gate counted (the `windowEnd` of its verdict, midnight UTC)
    plus a random jitter of 0–5 minutes (`server/src/myrmidon/daily-run-limit-deferral.ts`; a `NaN` from the
    randomness source gives jitter 0), so the burst after midnight is spread out.
  - The existing due-retry sweep (`promoteDueScheduledRetries`, 50 per pass, earliest first) puts the run back in
    the queue; the gate checks the limit again when the run starts. A repeated refusal defers the same row (counter
    `contextSnapshot.dailyRunLimitDeferral`); no second run is created.
  - `scheduled_retry_reason` and `scheduled_retry_attempt` of the run are not changed: the execution failure count,
    the `workspace_busy` ladder and the promote/claim gates depend on them. The deferral is marked only in the run
    context. The wake stays `queued` and is served at the start after the reset.
- Still cancelled with a visible reason: a zero limit (the reset would not free a slot), the daily cost limit, and a
  user's manual wake (`payload.manualUserWake`).

### Review routing: the board merges an approved pull request once its head is green; conflicts go back for a rebase (OPE-11767)

- A task whose board review stage is approved and whose open pull request is green and mergeable on the approved head is now merged by the board itself through the shared GitHub App identity (squash, the repository's convention). It fires when a review is approved, when a CI run completes, and on the periodic review-routing pass as the safety net; the pass merges at most `boardMerge.maxMergesPerPass` pull requests. Before this, a PR approved while CI was still running was merged by nobody once CI turned green: the steward lane only creates a human "Merge PR" task (and its GitHub resolver finds no token on the release board), and the host script that covered the gap was removed.
- The merge is bound to the exact approved head: the approving verdict must name the current head (a full or abbreviated sha anywhere in the verdict — the reviewers' `APPROVE PR #N <sha>` is now read; before only the spelling `head <sha>` was, which left the GitHub approval marker unset on PR #2449 and #2467), the required check `CI result` must be `success` on that head (latest run per name; cancelled, skipped and stale runs are not a verdict), the base must be `main` (or a configured release base) and GitHub must report the PR mergeable. The merge call carries the approved sha, so a head that moved is refused by GitHub itself (409). A branch that is merely behind main is merged as it is: the board never calls `update-branch` after an approval, because it would move the head and void the approval.
- A conflict with the base after the approval — or a head behind a base that the repository requires to be up to date — returns the task to its implementer once (status `in_progress`, changes requested) with a system comment "конфликт с main после одобрения — нужен rebase", and wakes the implementer. Before, such a task stayed in `in_review` forever.
- A PR blocked only by the missing `review-approved` marker (the hot-files gate) gets the marker from the board and is merged on the next look.
- The behavior is the new `boardMerge` block of `instance_settings.general.reviewRouting`, ON by default; `boardMerge.enabled = false` restores the previous behavior exactly. A settings screen that does not know the block keeps the stored value on save.

### LiteLLM fallback chains are validated on save, and a live dead end raises a board signal (OPE-11777)

- Before the LiteLLM configuration is written, empty fallback groups and unknown providers are rejected
  (`server/src/myrmidon/litellm-sync/config-client.ts`); the existing checks for cycles, models and provider
  diversity stay in force.
- Failed spend-log rows that carry attempted fallbacks are parsed (`litellm-costs.ts`), and the fallback signal sweep
  (`litellm-fallback-signal/sweep.ts`, `attention.ts`) raises a high-severity board attention signal for an
  attributed dead end. Tests cover validation, the parser, the sweep and the attention feed.

### HERMES-GATEWAY-CLOSE: the board frees the gateway slot of every run it finishes (OPE-11889)

- A `hermes_gateway` run keeps a slot in the bot gateway's `max_concurrent_runs`
  until the remote run ends. Before, the board stopped the remote run only when an
  operator cancelled an unsupervised run, so runs the board ended any other way
  (the execution-control deadline, a stale or `process_lost` reap, an adapter
  failure that left the remote run alive) held their slot until the gateway's own
  timeout, and bots answered `Too many concurrent runs (max 8)`.
- Now every terminal status (`succeeded`, `failed`, `timed_out`, `cancelled`,
  `interrupted`) closes the remote run: the central status writers and the
  execution-control reconciliation do it at once, and a periodic sweep
  (every 60 s, runs changed within the last 2 h) covers every other writer and a
  crash between the terminal write and the close. The board probes
  `GET /v1/runs/{id}` first and sends `POST /v1/runs/{id}/stop` only to a run
  that is still live, so a run the gateway already finished costs one GET.
- Once per run: the close is claimed under the run row lock and recorded as run
  events `gateway_remote_close_requested` / `_done` / `_failed`. Each carries who
  closed the run and why (an operator's cancellation provenance, or
  `board_timeout` / `board_stale` / `board_cancelled` / `terminal_completion`
  with the run's correlation id); the same provenance goes to the gateway as
  `x-paperclip-*` headers. A failed or unreachable close is retried at most 3
  times, at least 5 minutes apart.
- A retry of the run is not affected: only the remote run is stopped, never the
  Hermes session, so the retry continues the same conversation, and a closed run
  is never re-closed or re-dispatched.
- Fix: a cancellation reason with non-Latin-1 text (for example Russian) made
  `fetch` throw while building the `x-paperclip-cancellation-reason` header, so
  the best-effort stop never reached the gateway. Header values are now
  percent-encoded when needed, single-line and bounded.
- To verify, let a gateway run outlive its board run (for example fail it on the
  execution-control deadline) and check that the run's events hold
  `gateway_remote_close_done` and that the gateway no longer lists the run as live.

### Invite credentials and secret path segments are redacted in the board API log (OPE-11891)

- Invite tokens in URL paths (`/invites/:token`, `/invite/:token`), in route params, request bodies and error context
  are redacted in the board's HTTP log (`server/src/middleware/redact-sensitive.ts`, `logger.ts`).
- Every invite route (`/api/invites/:token` and the rest) is marked secret-sensitive whatever the HTTP method
  (`http-log-policy.ts`), so no raw token reaches the log in the `ok`, 400, 404 and 500 cases. Behavior tests cover
  all four.

### Bots get the board key and URL inside `execute_code` (OPE-11947)

- hermes' `execute_code` strips every environment variable containing KEY or TOKEN from the core except those listed
  in `terminal.env_passthrough` of `config.yaml`. The profile the board compiled set only `terminal: { cwd }`, so
  `PAPERCLIP_API_KEY` / `PAPERCLIP_API_URL` were missing in the code tool, the skill told Python code to read them
  from the environment, and the requests went out without a key (401). Some agents worked around it by reading the
  bot's `.env` file, which put the secret into the session history.
- `profile-compiler.ts` now writes `terminal.env_passthrough: [PAPERCLIP_API_KEY, PAPERCLIP_API_URL]` (the bot's
  own permanent key, already in the terminal environment; not a provider key, hermes does not block it).
- The skill `auth-and-run-context.md` says: no key in `execute_code` means use the terminal; do not read `.env`;
  do not retry a 401.
- The change alters `config.yaml`, hence the profile hash: bot containers are recreated by the regular maintenance
  window (template update).

### Bot LLM requests carry a stable conversation key (TOKEN-BURN F, OPE-11966)

The pool of ChatGPT accounts behind the LLM gateway caches a prompt only when the requests of one conversation
carry one stable key. Hermes sent none, so the pool saw a new session id (the call id) on every request and its
cache hit only 25-47% of the input.

- **Header.** The bot profile (`hermes/config.yaml`) now has a `providers.myrmidon-gateway` entry for the instance
  LLM gateway endpoint (the URL of `model.base_url`) with Hermes' vendor option
  `session_affinity_header: x-litellm-session-id`. Hermes puts the conversation key in that header on every request
  to the endpoint: the conversation root (stable across compaction rotation), else the Hermes session id, which is
  the board's session key of the run (`paperclip:company:<id>:agent:<id>:issue:<id>`, with the generation suffix
  when the board raises it). The gateway forwards the header to the pool for `chatgpt-pool/*` models only, where it
  becomes the ChatGPT `session_id`. For every other model the header is read by the gateway only (it groups traces).
- **Body.** The chat-completions body of such a request also carries `prompt_cache_key` (bot-runtime patch `28`): the
  header's own value, bounded to 64 characters the way every key is (a longer id becomes `pck_` plus a hash of
  it). A key pinned by the caller stays; an endpoint without the option, and api.openai.com, are unchanged.
- **Rollout.** The profile change is part of every gateway bot's `config.yaml`, so each bot restarts its gateway once
  when the board applies the new profile; the body key arrives with the new bot runtime image.
- **To verify.** In the pool's statistics (`stats/usage.db`, table `req`) requests after the rollout have
  `session_hash` and `cache_key_hash` set and `cached_tokens` rising; compare the share `sum(cached_tokens) /
  sum(in_tok)` against the period before. A bot's `config.yaml` holds the `providers:` block; a request to the
  gateway shows the `x-litellm-session-id` header.

### Corpus search across datasets: one global ranking, dataset names accepted, a longer parse sweep interval (OPE-11988)

- An unscoped `corpus_search` MCP call took the best `topK` per dataset group and cut the merged list without
  re-ranking, so high-scoring chunks of datasets processed later in the loop were lost. The search index
  (`packages/corpus`, `ports.ts`, `search/hybrid-search-index.ts`) now takes `datasetIds?: string[]` and runs one SQL
  query (`$3::uuid[] is null or d.dataset_id = any($3::uuid[])`) with a single global reciprocal-rank-fusion ranking.
- `corpus_search` also accepts dataset **names**, not only ids: `server/src/myrmidon/corpus/adapters.ts` maps names to
  ids through a dataset map (before, a name matched nothing and the call silently returned 0 hits).
- The parse sweep interval of the corpus worker (`server/src/myrmidon/corpus/worker.ts`) is raised to 150 s, so the
  sweep no longer collides with the parser on large documents.
- `corpus_list_datasets` returns its structured content as an object `{ datasets: [...] }` (fixed in #2491), as MCP
  clients require.

### Corpus: documents by address, refreshed on a schedule (1.6.6 CORPUS, OPE-12000)

- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents/url` with
  `{url, refreshIntervalHours?, name?}` adds a document by address. The board downloads the page
  (http/https on port 80 or 443 only, 30 s deadline, the same `maxDocumentBytes` ceiling as an upload, enforced
  on the decoded stream), stores it as an ordinary document on the road an upload takes (BlobStore, parse job,
  audit action `myrmidon.corpus.document_uploaded` with `sourceUrl`), and answers `202 {document, job}`. The
  document remembers `sourceUrl`, `refreshIntervalHours` (168 hours unless given; 1 to 8760), `contentHash`
  (SHA-256) and `lastFetchedAt`; they appear on every document the corpus API returns, together with
  `sourceError`. The same address in one dataset is refused with `409 source_url_exists`, also when two
  requests for it arrive at the same time (one document is made).
- The download goes through the board's guarded transport (the one outbound MCP and OAuth calls use): the host
  name is resolved once, every address must be public, the socket is dialled at an approved address, and the
  peer address is checked again before a request byte is written, so a rebinding name server gets nothing.
  Loopback, private, link-local and cloud-metadata addresses, `localhost`, other ports, `file:`/`ftp:` addresses
  and addresses with a user name or password are refused with `422 source_url_blocked` / `source_url_invalid`
  before any document is created. Redirects are followed by the board itself, up to 5, each hop through the
  whole guard again. A failed download is answered with a fixed text (`502 source_fetch_failed`): what the
  socket or the resolver said goes to the log only. All downloads of the board (the hourly sweep, a manual
  refresh, an add by address) share one limit of 4 at a time.
- Documents added by address are kept current by the product: once an hour (on the scheduler tick, behind the
  corpus switch, a no-op while the module is off) the board fetches the ones whose interval has passed. The same
  hash only moves `lastFetchedAt`, except for a `failed` document, which is parsed again from the bytes it
  holds. A new hash stores the new bytes and queues a new parse job (the document goes back to `queued`; the
  parse of the new version replaces the old chunks, and the old bytes are removed once the new version is
  `ready`). A failed download leaves the stored version untouched and records a short code in `sourceError`;
  a document still being parsed is skipped. A replaced document is audited as `myrmidon.corpus.document_refreshed`.
- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/refresh-urls`: starts fetching every
  URL-sourced document of the dataset now, whatever its interval, and answers `202 {datasetId, started, documents}`
  at once. The run goes on in the background, one at a time per dataset (`409 refresh_in_progress`), with a pause of
  60 s after the end of a run (`429 refresh_too_soon`, with `Retry-After`). The start is audited as
  `myrmidon.corpus.refresh_started`, the end, with the counters `{checked, unchanged, updated, skipped, failed,
  failures[]}`, as `myrmidon.corpus.refresh_completed`.
- No migration: `source_uri` and `content_hash` of `corpus_documents` already exist, and the interval and fetch
  bookkeeping live in its `metadata` (a document counts as "by address" only when it carries the interval, so the
  RAGFlow importer's provenance in `source_uri` is never fetched). Both new routes need the same company access as an upload.

### Run guard: wider read-only limits for code roles, and one automatic retry after a read-only stop (OPE-12004)

- The default limits of the stops `no_progress_exploration` (consecutive read-only tool calls without a write) and
  `repeated_tool_call` (the same read-only call repeated since the last write) now depend on the agent's role:
  **100 and 5** for the code roles (`engineer`, `reviewer`, `lead`, `architect`), **40 and 3** for every other role
  (as before). `heartbeat.ts` passes `agent.role` to `resolveRunGuardOptions`. Values set on the agent card, in the
  team settings or in `MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT` / `MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT` still
  win over the role default. Engineers can now read about 100 files while exploring a codebase without a false stop.
- A run stopped with `no_progress_exploration` is continued once in a follow-up run (before, every guard stop was
  final). The follow-up carries the instruction (`livenessContinuationInstruction`) to move on to a write (a code
  change, a test, a commit) or to describe the blocker in a comment.

### Pull-request work products with an empty `url` / `externalId` are readable again (OPE-12024)

- Records of `issue_work_products` of type `pull_request` could have an empty `url` and `external_id` while the
  repository and the number lived only in `metadata` (`{repository, number, …}` or `{repo, number, …}`). The board
  reads CI by `url` / `external_id`, so it answered "CI state=unknown (`pull_request_reference_unreadable`)", and the
  review decision engine rejected the reviewer's verdict with HTTP 422 although CI was green.
- `loadIssuePullRequestTarget` (`review-stage-recovery/github-ci.ts`) falls back to `metadata.repository` (or
  `metadata.repo`) with `metadata.number`, and to `metadata.url` for the pull request URL, when the top-level `url`
  is empty.
- `createForIssue` (`services/work-products.ts`): for a `pull_request` work product of provider `github`, `url` and
  `externalId` are derived from the metadata when absent; it answers 422 when neither the fields nor the metadata
  carry enough information.
- Migration `0462_pull_request_work_product_url_backfill` fills `url` and `external_id` from the metadata of the
  existing rows where they are empty.

### `corpus_search` returns the document title as `document.name`, not its UUID (OPE-12028)

- Bots cited sources as "document.name: 37c94457-…" (a UUID) instead of the book title. The wrapper had to fetch the
  name with a separate `corpus_get_document`, and that call failed with "corpus blob: empty key" when asked for
  `include_text: true`.
- `createCorpusMcpProvider` (`server/src/myrmidon/corpus/adapters.ts`): after the index hits, `search` asks the store
  for the unique `documentId`s in one batch and fills `document.name` with the real name of the document
  (`corpus_documents.title`); a document that is not found falls back to its `documentId`.
- `getDocument`: `includeText` is guarded against an empty `blobRef`; a document without a blob returns `text: null`
  instead of the "corpus blob: empty key" error.

### Corpus: big books parse to the end, abandoned parses are cancelled, failed documents can be parsed again (1.6.6 CORPUS, OPE-12029)

- The time limit of a parse (`parserTimeoutMs`) is now the time a job RUNS WITHOUT PROGRESS in the parse
  service, not the time since the submission. The clock starts when the service starts the job and starts
  over every time the number of pages done grows, so a scanned book of 300 pages (about 25 minutes of OCR)
  is no longer failed and re-parsed from page 1 three times at a limit of 10 minutes, while a job that stops
  is still given up on. Waiting in the service's queue behind other documents no longer uses the limit up
  (it is bounded separately, 4 hours, and a hard ceiling of 6 hours stops a run that never ends). The
  ceiling of the setting (settings screen, `PATCH /api/myrmidon/corpus/settings`,
  `MYRMIDON_CORPUS_PARSER_TIMEOUT_MS`) is raised from 10 minutes to 2 hours.
- When an attempt gives up on a job (timeout, broken poll, abort) the module cancels the job in the parse
  service with `DELETE /v1/parse/{jobId}` instead of leaving it to run, so a retry no longer queues behind a
  dead copy of the same document. If another client has submitted the same document and still waits for
  the job, the parse service keeps it running. A parse service that does not know the endpoint is tolerated.
- The parse pass no longer claims more jobs than `parseConcurrency` allows across passes. A pass lasts as long as
  its slowest parse while the scheduler starts a new one every 150 s, so each new pass used to claim another
  `parseConcurrency` documents on top of the running ones and flood the parser.
- New `POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/reparse`: parses a `failed`
  document again from the bytes already stored (no delete and re-upload). The document goes back to `queued`
  with its error cleared and its job starts over with no attempts used; the answer is `202 {document, job}`,
  the audit action is `myrmidon.corpus.document_reparsed`. A document that is not `failed` (`409
  document_not_failed`) or has no stored bytes (`409 document_has_no_stored_bytes`) is refused.

### Bot runtime: a lost connection to the model gateway no longer moves a run to the fallback model (TOKEN-BURN-G)

A bot reaches every model through one gateway. When the gateway restarted (about 75 s), the bot's primary model
failed with `APIConnectionError`, hermes switched the run to the fallback chain of the agent card after the second
failure and kept the run there until it ended - the primary comes back only at the start of the next turn - so a
restart of about a minute moved the rest of a run onto a paid model, although the fallback sat behind the same gateway.
Patch `29` of the bot runtime (`docker/bot-runtime/patches/`) changes this in one place, the error path of the model call:

- **A gateway that is not answering is ridden out on the primary.** An error with no HTTP answer at all (connection
  refused or reset, connect timeout, `APIConnectionError`), or a 502/503/504 whose text names no model and no provider,
  is retried against the primary with the usual growing pause for up to `HERMES_GATEWAY_OUTAGE_BUDGET_S` seconds
  (default 180) before the fallback chain is tried. For that time the retry limit of the call is lifted and the last
  pause is cut to the budget that is left. After the budget the behaviour is the old one: the fallback chain, then the
  recovery ladder. Nothing is held when the agent has no fallback.
- **An error of a model or a provider still goes to the fallback as before.** 429 and quota, `model not found`,
  `no healthy deployments`, an overloaded provider, a read timeout of a slow model, authentication errors.
- **A run on a fallback goes back to the primary.** Every `HERMES_FALLBACK_PROBE_EVERY` model calls (default 10) the
  run tries the primary again and stays on it when the call succeeds; a probe that fails walks the fallback chain
  again through the ordinary error path, and the primary's rate-limit cooldown still gates the probe.
- `0` in either variable gives the upstream behaviour back.
- To verify, stop the model gateway for about a minute while a bot run is working: the run's log shows
  `Model gateway unreachable ... retrying the primary model` and no `switching to fallback provider`, and the run finishes on
  its own model.

### Corpus: a board restart no longer strands a document in `parsing`, and a shutdown no longer waits for a whole book (1.6.6 CORPUS, OPE-12057)

- When the board restarted in the middle of a parse, the job stayed `running` and the document `parsing`
  for good: the parse queue only claims `pending` jobs and nothing took a `running` one back. Now the
  first pass of the parse worker after a start settles every job left `running` by the previous process,
  before it claims anything: the job goes back to `pending` (due at once, no backoff) and its document to
  `queued`, with the reason ("the board stopped or restarted while the document was being parsed") kept
  on both. The attempt the claim counted stays counted, so a document that takes the board down every
  time (out of memory on a huge scan) runs out of attempts and ends `failed` with that reason, instead of
  restarting the board in a loop; a failed document can be parsed again with the reparse request. A
  document that had already reached `ready` before the process died is settled as done, not parsed twice.
  Jobs of the running process are never touched: the settling happens once per worker, before its first
  claim, and a process has exactly one worker. A job whose settling fails (database down) is retried on the
  next pass, and nothing is claimed until it works.
- A board shutdown used to wait, without a limit, for the whole parse pass to end - a scanned book takes the
  better part of an hour. The parse worker is no longer part of that wait. On a shutdown signal it stops
  claiming, lets the parses in flight finish for a grace period (30 s by default, `MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS`,
  0 to 600000 ms), then aborts them: the parser client ends the call without retries and cancels the job
  in the parse service (`DELETE /v1/parse/{jobId}`), the corpus job goes back to the queue with its attempt
  refunded (a deploy does not use up `maxParseAttempts`) and the document to `queued`. After the abort the
  shutdown waits at most 10 s more; a parse that still does not answer is left `running` and the next
  start settles it as above. The shutdown is therefore bounded by the grace period plus 10 s.
- The parser client reports an aborted call as its own error kind, `aborted`, and does not retry it.

### Bot runtime: state.db is compacted by its share of free pages, and its temporary copy goes to the bot's volume (1.6.6 BOT-DISK)

The `state.db` of a bot never shrank. On the fleet 15.6 GB of 39.9 GB of the 65 databases were free pages (56% of the
largest, 3.4 GB), and none of them had ever been vacuumed. Hermes vacuums only in a pass whose own prune deleted a
session, and the bot runtime deletes old sessions through the API when a container starts, before hermes' first
maintenance tick, so the tick's prune never found anything. Patch `30` of the bot runtime
(`docker/bot-runtime/patches/`) and the entrypoint change this:

- **The VACUUM runs on the share of free pages.** When more than 25% of the pages are free
  (`AUTO_VACUUM_MIN_FREELIST_RATIO`) and `sessions.min_vacuum_interval_days` (default 30) have passed since the last
  one, the maintenance pass vacuums whether or not it pruned anything. `sessions.vacuum_after_prune: false` still
  turns it off.
- **It waits for room and for a quiet moment.** No VACUUM starts while another process holds the store, while a
  session turn lease is held in the store, while the gateway is running a turn (messaging platforms and API-server
  runs), when the volume has less than twice the live data free, or when SQLite's temp directory is RAM. It then
  tries again on the next housekeeping tick (hourly), not after another 24 hours. The reason is logged and returned
  as `vacuum_skipped`; a finished VACUUM logs the size before and after.
- **The temporary copy is not charged to the container's memory.** SQLite writes the copy of the live data (about
  1.5 GB for the largest database) to `/tmp`, which in the bot container is tmpfs. The entrypoint now exports
  `SQLITE_TMPDIR=$HERMES_HOME/.sqlite-tmp`, a directory on the bot's volume.
- The first passes after the rollout vacuum the databases that have waited so far: the 19 databases above 25% free
  are the ones that shrink. Each gateway decides for itself at its own hourly tick, roughly an hour after it started,
  so the starts follow the sequential restarts of the rollout; there is no fleet-wide limit on simultaneous VACUUMs.
  A bot that is never idle waits for a quiet moment.
- To verify, find `state.db VACUUM: ... MB -> ... MB` in a bot's gateway log, and `state_meta.last_vacuum` in its
  `state.db`.

### Heartbeat: an old exhausted connect retry no longer flips a healthy agent to error (1.6.6 OPE-12150)

The stranded-issue sweep re-schedules the last run of an `in_progress` issue on every pass. When that run had used up its `container_not_started` retry budget, every pass wrote `status=error`, «контейнер не поднят» on the agent, even though its container was healthy and later runs of the agent had succeeded (prod 07.11: adm-devops returned to error 15–60 s after every clear). The exhausted budget now marks the agent only when no run of this agent succeeded after the exhausted one. A status patch that moves an agent out of `error` also clears `errorReason`.

### Bot containers: the image switch waits for an interrupted run to finalise (1.6.6 OPE-12150)

The bot container reconciler polled only 30 s past the maintenance drain deadline. R3 interrupts a busy run at the deadline, and a hermes gateway run took about 50 s to finalise, so every busy bot's switch to the release image failed seconds before the interrupt landed, the window closed and the retried run started on the old image again (prod 07.11, rc.46: 9 bots). The grace past the deadline is now 120 s.

### fleetd: a fleet site pulls a release image it does not have yet (1.6.6 OPE-12194)

The bot image rollout pre-pulls release images only on the hosts it reaches by ssh (`MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS`). A fleet site registered on the board got its first container of a new release image refused with Docker 404 «No such image», and its bot never switched (prod 07.11: work-qa on myr-vm1). On that 404, fleetd now pulls the allowlisted image (no registry auth: the release bot images are public) and retries the create. The pull is detached from the board request, so a board call that gives up waiting does not abort it, and a failed pull is reported in the create error.

### Review stage: a reviewer run interrupted by maintenance no longer blocks the stage (1.6.6 OPE-12201)

The maintenance drain of a deploy interrupts running reviewer runs (`myrmidon_maintenance_interrupted`). The review-stage recovery counted them as failed reviewer attempts, and after two of them moved the stage to `blocked` («retried the pending execution-review participant twice…»), although the review was fine (prod 07.11, rc.46: OPE-12058, OPE-12091). Such a run now re-wakes the reviewer without spending the decision budget; the activity row has kind `maintenance_retry`, which the budget counter ignores.

### Recovery: a lead's engineer subtasks are no longer handed back to the lead (1.6.6 OPE-12220)

The orphan-blocker reconcile assigns a blocking issue without an assignee back to the agent that created it. A lead slicing an epic creates its engineer subtasks unassigned so that the caste matcher hands them to engineers, but the reconcile gave them to the lead, and the leads wrote the code (prod 07.11: 11 subtasks on adm-dev-lead and adm-dev-lead-3). An issue with a caste is now assigned back only to a creator of that caste; otherwise it stays unassigned for the caste matcher.

### Byte ceiling on the serialized continuation envelope (OPE-2321)

- Kernel `MAX_ARG_STRLEN` (131072 bytes) limits the byte size of each argv/env string, but continuation character budgets count UTF-16 code units. Non-ASCII task history (e.g. Cyrillic comments) could exceed the kernel limit and crash local agent runs with `spawn E2BIG`.
- Adds `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` (default 98304 = 96 KiB, 0 disables): a final byte pass in `limitExecutionContinuationHistory` bounds `Buffer.byteLength(JSON.stringify(envelope))` while preserving origin comments, latest user requests, and resume deltas.

### Wake diagnostics report real engine reasons instead of `other` (OPE-2769)

- `GET /api/issues/{id}/diagnostics/wakes` no longer masks wake reasons the
  engine itself writes as `reason=other`: the whitelist now covers every
  reason written by the wake engine and its enqueue sites, including
  `execution_reconciliation_required` and
  `resurrection_execution_reconciliation_required`, which previously showed as
  `reason=other failureClass=failed` on issues with an execution hold.
- A static guard test re-derives the written reasons from the enqueue sites
  and fails when a new reason reaches `agent_wakeup_requests` without being
  added to the whitelist.

### Browser bridge: `browser.sign` through a local signing helper (OPE-3383)

- The Chrome/Edge extension implements `browser.sign` and declares the `sign` capability and the `nativeMessaging` permission. It fetches the document in the page session, passes the bytes to the local signing helper over native messaging and reports only the status and the document digest; the key, the PIN and the signature never reach the gateway.
- Auto and manual signing are kept: the gateway now tells the extension the panel's decision in the `confirmation` param of every `browser.sign` step (`human` waits for a person on the PC), whatever the bot sent.
- The native messaging host name is `com.myrmidon.sign_helper` (Chrome rejects hyphens in host names).
- New CI workflow for `extension/`: typecheck, tests, build.

### Live API process scaling and split deploy (PROCS-3)

- The process supervisor applies `apiCount` changes without a container restart.
  It scales the API children up and down through the readiness gate and drains
  children before removing them from service.
- A split deployment keeps the worker alive while API children start, and
  returns to the worker listener when the child set cannot stay available.
- The supervisor keeps the child IPC lifecycle and hot-restart handoff in one
  place, so a child restart does not create a second scheduler or lose the
  worker's control of the deployment.

### HERMES-RUN-REATTACH: gateway runs survive a board restart

- Before orphaned runs are reaped, the reattach sweep uses the gateway run ID
  saved with the heartbeat run to resume an in-flight `hermes_gateway` run.
  Its result remains visible on the board rather than being lost or restarted.
- Gateway HTTP 429 means busy, not a terminal failure: `transient_upstream`
  keeps the agent idle for a bounded retry, honoring `Retry-After` for up to
  eight attempts within one hour. Cancelling the board run sends
  `POST /v1/runs/{id}/stop` to the gateway.
- To verify, restart the board while a gateway run is active; confirm the run
  completes and its result is visible on the board.

### Run queue position, wait reason and priority settings in the UI (OPE-5525, RUN-PRIORITY B)

- `ui/src/components/myrmidon/runQueueApi.ts` — client for the part A
  (OPE-5526) endpoints: `GET /api/myrmidon/run-queue/position?runId=…` (rank
  in the waiting queue + wait reason), `GET/PATCH
  /api/myrmidon/run-queue/priority` (role weights, current-release line and
  bonus, aging step and cap). Every read answers `null` on 404/405 — before
  part A deploys the UI shows no position instead of inventing one.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — the line under a queued
  run's chat card: "Queue position 3 of 12, waiting: the host CPU ceiling is
  closed". Metadata the comment already carries (part A publishes it) wins
  per field; the position endpoint fills the gaps and is re-asked every 30 s
  while the rank is unknown. Renders nothing when neither source answers.
- `ui/src/components/IssueChatThread.tsx` — mounts the wait line under the
  queued run card (the same card that already shows the "Queued" badge).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` and
  `ui/src/pages/InstanceGeneralSettings.tsx` — the queue-priority section of
  Instance → General, on the runtime-limits pattern: five role weights
  (review, release, lead, engineer, docs), the current-release line, its
  bonus, the aging step and cap; per-field source tags (saved here / server
  environment / default); whole-number validation; saving applies on the next
  admission pass without a server restart. When the endpoint is not served
  yet the panel says so instead of pretending to save.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `runQueue` catalog (en+ru,
  parity-checked).
- Tests: `runQueueApi.myrmidon.test.ts`,
  `RunQueuePrioritySettingsPanel.myrmidon.test.tsx`,
  `RunQueueWaitLine.myrmidon.test.tsx`.

### Enforce brand release audit gate in CI (OPE-5794)

- Integrated `Brand release audit (DEBRAND gate)` step in `.github/workflows/myrmidon-ci.yml` checks job to enforce `brand-release-audit.mjs --gate` and `docs-branding-guard.mjs`.
- Added `check:brand` script in `package.json`.

### Browser preferences move to the Myrmidon namespace (DEBRAND-c)

- Browser storage now writes `myrmidon.*` and `myrmidon:*` keys. Startup migrates existing `paperclip.*` and `paperclip:*` local and session storage lazily without discarding a current Myrmidon value. The synchronous theme bootstrap migrates the selected theme before the first paint.

### Documentation for devbuild in bot containers (OPE-6760)

- Documented `DEVBUILD_SSH_KEY_DATA`, `MYRMIDON_DEVBUILD_CHECK`, and `MYRMIDON_LOCAL_NODE_HEAP_MB` in bot-runtime README.
- Added Russian translations for devbuild settings in `SETTINGS.ru.md`.

### OPE-6799 replay-block triage

A settled execution-reconciliation replay block is now visible in the attention feed as a high-severity `replay_blocked` card. The card identifies the responsible lead when the assignee reports to one, otherwise the company's default board operator, and carries a 24-hour triage deadline. It is computed from the live blocked hold and disappears when the hold is cleared.

Changing an issue's executor clears the previous executor's settled replay hold in the same transaction, records the reassignment reason in activity, and replans the new executor's parked wake.

### A task the dispatcher returns to the queue keeps its status (REQUEUE-HOLD)

- A task whose stopped run gets reconciled no longer loses the status the
  dispatcher set: `settleUnrecoverableExecutions` projected the failed run onto
  `blocked` even when the board had already moved the task back to `todo`, so
  the queue refill was silently reverted within minutes while `blockedBy`
  stayed empty and no run existed for the task.
- The reconciliation now keeps the ready-queue status (`todo`/`backlog`),
  records the same settled hold (`evidence.automaticRecovery.replay =
  "blocked"`, so nothing is replayed and wake admission is unchanged) and
  clears the dead run's pointers.
- Tasks being worked on (`in_progress`, `in_review`, …) keep the previous
  behaviour and still project to `blocked`; the Agent Chat branch is untouched.
- The settled hold is released exactly where it was released before — an
  explicitly authorized wake (L2) or a board person — and a board person now
  releases it by moving the held task into a working status from any other
  status (`blocked -> todo` is no longer the only move that counts).

### CONNECTORS C: the chat-provider-telegram connector (installation flag only, no traffic switch) (1.6.6)

- New `server/src/myrmidon/channel-connectors/telegram.ts`: the Telegram
  connector over the S1 contract — lifecycle (`start`/`stop`/`status` read the
  vendor row without rewriting it), links (the conversation key is exactly the
  vendor's `telegram:<chat>` / `telegram:<chat>:<topic>`, so already-linked
  conversations stay the same conversations), inbound
  (`normalize`/`admit`/`intakeMedia`), outbound (`plan`/`send`), the provider's
  own media limits (1024 caption, 50 MB file) and two settings keys resolved
  env → default.
- The outbound plan reuses the vendor splitter
  (`splitTelegramPublicationText`), so the parts a connector send would deliver
  are the parts the direct integration delivers today — no second copy of the
  4,096-unit rule.
- Installation is one flag: `MYRMIDON_TELEGRAM_CHAT_PROVIDER` (off by default).
  Off — `installTelegramChannelConnector` registers nothing and the hub answers
  pass-through for `telegram`; on — the registry holds the factory. No vendor
  file is edited, the hub is not wired into the message lanes and the lifecycle
  is not called from anywhere in this step: the live board sends and receives
  Telegram exactly as before. Traffic switches in the later bridge step (the
  77-point map of OPE-6629), not here.
- The group gate stays shut without a configured bot: with the flag on but
  `MYRMIDON_TELEGRAM_BOT_USERNAME` unset, private chats are admitted and group
  turns are refused `not-addressed`.
- `telegram.myrmidon.test.ts` pins the flag semantics (unset/off/typo never
  installs), the contract shape against `CHANNEL_CONNECTOR_AREAS`, the key
  equality with the vendor, the admission gate, the media limits, the plan and
  part-by-part send through a fixture transport.

### A run that finished without work no longer wakes its own task in a loop (IDLE-PICKUP-QUIET)

- The idle-pickup suppression after a successful run on the same task now holds
  for two hours instead of fifteen minutes
  (`MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS`). A run that ends without
  touching its task (no disposition, no comment) used to leave the task wakeable
  again a quarter of an hour later: the sweep woke it, that run ended the same
  way, and the pair repeated every 15–20 minutes with no new input on the board —
  four idle wakes on one task inside an hour, each one a fresh checkout plus a
  run.
- The window stays silent only while the task does: a comment written after that
  run ended, by anyone other than the run itself, reopens the task for idle
  pickup at once. A comment the run wrote itself (its closing report, matched by
  `created_by_run_id`) and a deleted comment do not.
- The newest success per task decides, and the trigger points are unchanged (the
  periodic sweep and the pass right after `releaseIssueExecutionAndPromote`), so
  both of them keep quiet.

### Run queue position and wait reason in the run card (RUN-PRIORITY)

A queued run card shows its queue position and why it is waiting, such as a higher-priority run or a per-agent concurrency limit. The queue position and wait reason are provided by the run queue API and displayed alongside the run state.

### ChatGPT/Codex model provider pool accounts registry, limit windows, and operator attention signals (OPE-7198)

- Registered model provider connector extension point with dynamic provider type availability (`registerModelProviderConnector`, `isModelProviderTypeAvailable`).
- Multi-provider account isolation and limit window tracking (5-hour and 7-day windows) with automated reset timestamp computation.
- Background sweeper (`MYRMIDON_POOL_SWEEP_INTERVAL_SEC`) and attention feed snapshot integration for automatic pool account synchronization and operator attention alerts.
- Plugin lifecycle bridge synchronizing dynamic connector availability with plugin status changes.

### Plugin provider model lifecycle synchronization (OPE-7251)

- Plugins can declare provider models in validated manifests. Lifecycle synchronization registers models with LiteLLM, updates agent key allow-lists, and exposes the company-scoped model catalog to the selector without a board restart.
- Disable/uninstall removes only models owned by that plugin; missing company credentials fail closed and cleanup is covered by regression tests.
- The private subscription-backed ChatGPT pool, periodic subscription discovery, and live isolated LiteLLM/first-call verification remain outside this change and are not claimed as complete.

### Automatic task taking is project-scoped (PROJECT-SCOPED-CLAIM)

- The swarm matcher (a ready task, a free agent, the periodic pass), the claim
  API's role queue now hand a task that belongs to a project
  only to a member of that project: its lead, an agent with a joined
  `project_memberships` row, or an agent nested in it (`agent_nests`). A task without a project stays open to the
  company, and a task already assigned to an agent (by hand) is never gated, and idle pickup, which only works assigned tasks, is not project-scoped.
- `GET /companies/:id/agents` carries an optional `projectIds` per agent (lead
  projects plus joined memberships), so the board UI can filter the roster by
  project on the client.
- Child tasks already inherit the parent's project when none is given
  (`createChild`, and the issue create route); this change leaves that as is.

### Remote sites T1 registry, mTLS routing driver, and startup wiring (OPE-7648)

- Added `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, and `myrmidon_fleet_moves` database schemas and migrations `0403` and `0405`.
- Implemented `site-registry.ts` with environment bootstrap (`MYRMIDON_FLEET_HOSTS`), site CRUD, affinity CRUD, and `FleetClientManager` with mTLS agent caching, client certificate and private key resolution.
- Wrapped local driver into `fleetRoutingDriver` at startup, routing by bot card container host, with hot-reload of the clients (registry version or 30 s TTL), no silent local fallback when the agent read fails, and secret-value fingerprints.

### Fleetd remote site driver hardening

- Align remote-site contract fixtures with HTTPS-only fleet gateway URLs and
  require a token-secret reference in named fleet host fixtures.
- Keep fleet gateway placement HTTPS-only and document the fleetd environment
  settings through the release fragment.

### REMOTE-SITES-T5: site scheduler and bot move between sites (OPE-7652)

- New `site-scheduler` lane (30 s), off by default (`MYRMIDON_SITE_SCHEDULER=1` with `MYRMIDON_BOT_CONTAINERS` on). It reads the site registry and the affinity rules and moves a bot whose affinity site differs from the one it runs on, one move at a time, with the move state machine below (never by rewriting `container.host` alone). A bot whose affinity site is full stays where it is, is marked `placementStatus: pending_placement` on its card and logged as a warning, never silently placed locally. Capacity-only verdicts and pinned bots cause no action. Preemption (low priority by a critical bot) needs `MYRMIDON_SITE_SCHEDULER_PREEMPTION=1`.
- New `POST /fleet/bots/:key/move` (and `GET` for the latest move) runs a persisted state machine (stop, snapshot, restore, host, reconcile, apiBaseUrl, quarantine) with a phase log. The bot key is the agent id; the caller needs access to the bot's company. The agent's maintenance window is held for the whole move, the per-bot lock keeps the reconcile sweep out, and a failure rolls the bot back to the source site. The source datadir is only set aside at the end (`.quarantined-*`), never deleted.
- fleetd gains `snapshot`, `restore` and `quarantine` handlers. The archive is a tar inside a zstd frame (raw blocks: not compressed yet) ending with a manifest (entries, bytes, SHA-256) that restore verifies; a snapshot that breaks off aborts the response and restore refuses an archive without a matching manifest. Restore unpacks beside the datadir and swaps it in, keeping the replaced one as `.replaced-<bot>-<time>`; hard links are archived as separate files.
- A move needs the site's token as a company secret (`MYRMIDON_FLEET_HOSTS` entry `tokenSecret`, or `token_secret` in `myrmidon_fleet_sites`). Moving to or from the board host needs its site-agent: `MYRMIDON_LOCAL_SITE_AGENT_URL` and `MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET`. Sites and affinity rules are rows in `myrmidon_fleet_sites` and `myrmidon_fleet_affinity` (no admin routes yet). The migration adds `myrmidon_fleet_sites`, `myrmidon_fleet_affinity` and `myrmidon_fleet_moves`.

### Work-memory of an execution site is replicated to the board (1.6.6)

- The memory of a remote site stays on the site (its own hindsight): its bots recall and retain
  there and do not depend on the link to the board. The board keeps a replica of it in the
  `fleet-work-replica` bank.
- New lane `myrmidon-memory-sync`: once a night (after `MYRMIDON_FLEET_MEMORY_SYNC_HOUR_UTC`, 20 by
  default) the board asks the site-agent for the bank export (`POST /v1/memory/export`) and merges
  it into the replica bank (`transfer/import`, `mode=merge`, `document_conflict=skip`, so a
  repeated or resumed sync never duplicates a document). A failed attempt is retried on every
  tick (every 15 minutes) until one succeeds.
- Every attempt is a row of the new table `myrmidon_fleet_memory_syncs` (migration 0416): site,
  kind (`nightly`, `forced`, `manual`), status, archive size, imported/skipped documents, error.
- A live bot move runs a forced sync right after the source container is stopped. It is bounded
  (5 minutes) and best effort: a failure is journaled and the move goes on.
- Opt-in: `MYRMIDON_FLEET_MEMORY_SYNC=1` and `MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL`
  (`MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN`, `MYRMIDON_FLEET_MEMORY_REPLICA_BANK` are optional).
  The lane runs inside the site-health lane (`MYRMIDON_SITE_HEALTH=1`).

### Site memory has a canonical compose (1.6.6)

- `docker/site-memory/docker-compose.yml` defines `hs-pg` (pgvector) and `hindsight-work` as one
  managed service of an execution site: loopback port only, digest-pinned images through
  variables with no default, limits on memory and pids, secrets only in profile files
  next to the compose. Operator guide section 4.5 (EN and RU) describes the bring-up, the fleetd
  `memory` settings and the nightly sync with its journal.
- The degradation scenario is covered by a test: with the link down for five minutes the site's
  bots recall and retain locally, the board's hindsight is not asked, and after the link returns
  the replica catches up without a duplicate document, also after an import that broke off.
- The production import of `fleet-work` / `work` (P5) is a separate manual step in the owner's
  window and never runs automatically at startup. Order: bring up the compose, run the import,
  then set `MYRMIDON_FLEET_MEMORY_SYNC=1`.

### Fleet screen manages execution sites (1.6.6, REMOTE-SITES-T8)

- New board API for the fleet screen: `GET /api/myrmidon/fleet/sites/overview?companyId=` (status, last answer, capacity used/total for CPU, memory and bots, bot count, drift count, the end of the board's client key for the site), `GET /api/myrmidon/fleet/sites/:name/bots` (each bot: container state, image, template drift fields, gateway address), `PATCH /api/myrmidon/fleet/sites/:name` (labels, capacity, address), `POST /api/myrmidon/fleet/sites/:name/drain` and `/resume`, `POST /api/myrmidon/fleet/bots/:key/restart` and `/stop`, and `GET /api/myrmidon/fleet/bots/:key/logs?tail=` (the container log through the site-agent, 1 to 500 lines). Reading is open to company members; changes are for the company owner/admin or the instance admin. The earlier `GET /api/myrmidon/fleet/sites` badge feed and the move and enroll routes are unchanged.
- The key lifetime is visible and enforced. Enrolling a site now stores the end of the client certificate's validity (`clientCertNotAfter`) and refuses an already expired certificate. While the key of a site is expired the board refuses to restart or stop its bots, read their logs or resume the site (409, and a warning in the server log), and the screen shows the expired key as an alert; a key that expires within 14 days is marked on the screen. The lifetime is re-read from the client certificate secret on every call, so rotating the secret lifts the block at once without editing the site; the alert is logged once when the state changes, not on every poll.
- An operator's drain is the operator's: pressing Drain on a site the monitor drained automatically makes the drain manual, so the `autoResume` label never lifts it. Resume is for a draining site only; a quarantined site stays fenced.
- The fleet screen (current UI: company settings, next to the server console; UI2: the Servers screen) lists the sites with capacity, drift and key lifetime, opens the bots of a site, restarts, stops (with a confirmation), moves a bot to another site or the board host, shows its log, drains and resumes a site, and adds a site by a form. The form takes the names of the company secrets for the token and the client certificate, never their values. Issuing the client certificate itself is still an operator step of the site PKI (operator guide, section 4); the board reads its lifetime from the secret.
- Restart and stop act on the container at once; they do not wait for the bot's runs to finish.

### DEVFLOW health: document the alias environment overrides (OPE-10075)

- The pipeline liveness thresholds also accept alias environment names, classified here so the env-coverage guard stays green:
  - `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`: alias of `MYRMIDON_DEVFLOW_STALE_MARKER_MS` (`staleMarkerMs` / `approvalMarkerMs`).
  - `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`: alias of `MYRMIDON_DEVFLOW_STALLED_MERGE_MS` (`stalledMergeMs` / `autoMergeMs`).
  - `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`: alias of `MYRMIDON_DEVFLOW_STALLED_ROUTER_MS` (`stalledRouterMs` / `reviewRouterMs`).

### Browser and runtime temp path trace (OPE-7738)

- Document confirmed product-owned run temp writers, Google AI and ChatGPT login-profile lifecycles, and completed runtime trace (OPE-7744/OPE-8747): no active production writers for `chr-p*` or `native-*` (historical residue on tmpfs); no product code changes required.

### /tmp hygiene policy and host janitor for temporary profiles (OPE-7773)

- Routed agent Chromium browser profiles into a run-scoped scratch directory (`$PAPERCLIP_SCRATCH_DIR/run-dir`), cleaned up automatically upon heartbeat run termination.
- Added automated trap cleanup for `install.sh` temporary release manifests and registered test sandbox cleanup in `install.test.mjs`.
- Introduced host-level `tmp-janitor.sh` with systemd service and timer units to prune orphaned `chr-*`, `native-*`, `mdep-*`, and `myrmidon-install-test-*` directories older than TTL with positive integer validation, recursive open-file activity detection (`lsof` and `/proc`), fail-closed safety, and protection for live profiles (e.g., `claude-1002`).
- Documented `/tmp` `size=8G` tmpfs fstab configuration to prevent unbounded host memory usage.

### Quarantine ownership on issue creation (QUARANTINE-OWNERSHIP)

- Resolve and persist the responsible promotion owner for low-trust issue and child creation. Require an owner only when agent output is actually quarantined; ordinary agent-created issues remain unaffected. Bulk child creation validates ownership before persistence.

### IDLE-STOP board controls (OPE-7898)

- Enable idle container stopping by default, with live instance settings for the idle threshold and health timeout.
- Add per-agent On demand and Always on modes (agent card, plus a bot list with mass change under Instance settings), container state, and last stop/start times that survive a server restart.

### Agent list and live-run validators follow the authorized response

- The company agent list checks company authorization and filters rows by agent-read access before response construction. Its ETag includes the authorized scope, configuration-redaction decision, and visible response rows.
- The live-runs endpoint checks telemetry access and redacts run data before deriving its ETag; authorization context and redacted rows are part of the response variant.
- The Agents pages refresh live-run data every 60 seconds (previously 15 seconds).
- Validation: route regressions exercise the same `If-None-Match` across changed agent visibility and run redaction. Validators intentionally over-invalidate when authorization or redaction context changes.

### Blocked issue monitors wake on schedule (OPE-7932)

Scheduled issue monitors now wake their assignee for `blocked` tasks as well as active/review tasks. Terminal tasks clear schedules; overdue schedules surface as `issue_monitor_overdue` in the operator Attention feed. Every skipped monitor is journaled with its reason, and existing terminal-task schedules are cleared by migration.

### DEBRAND 1.6.6: release brand audit and root-docs cleanup (OPE-8127)

- New release audit `scripts/myrmidon/brand-release-audit.mjs` scans everything
  the release ships that `docs-branding-guard.mjs` did not cover: the root
  `README.md`/`README.ru.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `DESIGN.md`,
  `AGENTS.md`, `CLAUDE.md` plus all of `docs/`. Report mode always exits 0 and
  prints the exact count and paths of non-allowlisted old-brand mentions;
  `--gate` fails on any finding (for a release-workflow maintainer commit).
- The allowlist is exact substrings with categories (vendor identifiers, legal
  attribution, compatibility identifiers, external vendor services, historical
  records, provenance prose) — never a file glob. The fixture tests pin this:
  a glob-like entry fails the suite, and a compatibility identifier on the same
  line does not mask a product mention next to it.
- Root docs cleaned: product prose in `CONTRIBUTING.md`, `ROADMAP.md`,
  `DESIGN.md`, `AGENTS.md` now says Myrmidon (46 findings at audit time → 0
  non-allowlisted). License attribution lines in the READMEs and vendor
  identifiers (`@paperclipai/*`, `PAPERCLIP_*`, CLI `paperclipai`, the
  `paperclip` skill path and API name) are untouched.
- Read-only release check instruction:
  `docs/myrmidon/guides/brand-release-check.md` (EN, with an RU summary) —
  how to audit UI copy, bot/log texts, and API answers by hand before a tag,
  without touching runtime or configuration.
- Fixture tests: `scripts/myrmidon/brand-release-audit.test.mjs`
  (7 cases: forbidden mention fails the gate; legal attribution green; hidden
  compatibility boundary green; same-line identifier does not mask prose;
  report mode exits 0 with findings; no glob-like allowlist entry; UI/log
  lines never allowlisted wholesale). Runs under the existing
  "Script tests (node:test under scripts/myrmidon)" CI step.

### Remote execution sites: site-agent contract and operator guide

Added the remote-site contract (health, lease claim, bot status, error discipline) with parsers and tests, an operator rollout guide, and `GET /v1/health` in fleetd (version, configurable `siteId` and `epoch`, live egress timestamp). Existing fleetd configs keep working: `siteId` defaults to `fleetd-local`, `epoch` to 1.

### Remote execution sites: a wiki page for the site-agent contract and the operator guide (OPE-8142)

- New wiki page pair `docs/wiki/Remote-execution-sites.md` +
  `Remote-execution-sites.ru.md` (linked from `docs/wiki/Home.md` and
  `Home.ru.md`): the one-way management plane (board → site over
  IPsec/WireGuard), the 13-route site-agent API of `fleetd`, the five site
  health states with epoch lease fencing, the secret-safe error reason
  codes, and the rollout runbook — canary migration, rollback without
  deleting data volumes; the deployment step now covers the configured
  `siteId`/`epoch` identity in `fleetd.json` (commit 5867fb21a of the
  upstream PR).
- The page condenses the authoritative operator guide
  `docs/myrmidon/guides/remote-execution-sites.md` (EN/RU) and
  `docs/myrmidon/fleetd-vmexec.md` (EN/RU) delivered with the remote
  execution sites feature.

### Stranded deferred wakes are advanced or closed (1.6.6)

- A periodic reconcile pass now cancels deferred wakes of done or cancelled tasks whose lock is free.
- The same pass hands the queue of an open task with a free lock to the ordinary release drain, including wakes without comment ids and wakes queued after an acknowledged operator Stop.
- Tasks under an effective "do not replay" hold keep waiting and advance in the first pass after the hold is lifted.
- The first pass after deploy also cleans up the records left behind earlier; the pass is idempotent.

### WAKE-STALL C release drain (1.6.6)

- Release now hands one additional issue released by the same run to the existing bounded deferred-wake drain.
- Deferred wakes for terminal issues are cancelled during release cleanup.

### DONE-GATE: protect pull-request work products from premature completion (1.6.6)

- Server-side completion now verifies every pull-request work product before allowing an issue to become `done`.
- Open or unknown provider state fails closed; a closed, unmerged pull request requires an explicit valid replacement reference.
- Verified merges are accepted, and task-PR synchronization persists verified merge state before completing an issue in its transaction.

### Swarm matcher reads real executor load, capacity, pause and quota

- The matcher now counts the open tasks an executor carries: assigned `todo` (reserved) and
  `in_progress` tasks plus live leases, a task once. Before, only live leases and the idle flag
  counted, so an executor with seven open tasks looked free.
- The ceiling (`maxActiveTasks`, caste override first) applies to that load. A full executor takes
  nothing and the task stays in the queue. Among eligible executors the least loaded one is
  preferred; a full tie still goes to the smallest id.
- The capacity check is atomic: it runs inside the claim transaction under a per-executor advisory
  lock, so two concurrent passes cannot push an executor over the ceiling.
- Paused executors (`status = paused` or `paused_at` set) are skipped until resumed. Executors held by
  a recorded provider quota failure (`error_code = provider_quota`, the "Individual quota" text on a
  run or a wake request, or `providerQuotaRetryNotBefore`) are skipped until the recorded reset, or
  for one hour when none was recorded; a succeeded run after the failure lifts the hold. Other
  transient failures never hold an executor. A fresh heartbeat does not re-admit either case.

### GUARDRAILS injection configuration in Company Settings (OPE-8319)

- Company Settings → Guardrails now stores `guardrailModes.injectionConfig` (`enabled`, `scoreThreshold`) and shows the effective values and provenance. Runtime precedence is environment override > UI setting > default, including explicit environment `false`; legacy mode overrides are preserved. The score threshold is constrained to 0..1 (UI step 0.05); the default is 0.6.

### DEFERRED-WAKE-LEAK: close deferred wakes with terminal issues (OPE-8490)

- Deferred issue-execution wakeups are cancelled when an issue transitions to `done` or `cancelled`, including status-decision-driven transitions.
- A queued comment interrupt that is skipped because its issue is already terminal closes its source deferred wake, preventing repeated wake creation.

### Adapter environment failures release execution tasks (OPE-8598)

- Execution recovery classifies structured adapter license/pool failures as executor health, clears the execution assignment and pointers, and returns the task to the unassigned `todo` queue for swarm claim instead of creating a task-level block without blocker metadata.
- Classification covers Antigravity error codes (including `antigravity_not_licensed` and `antigravity_pool_unavailable`), known adapter error families, and bounded diagnostics including the Russian production messages. Unrelated mentions of `LICENSE` in log excerpts do not trigger release.
- Tests cover the production failure signatures, false-positive protection, release semantics, and task re-availability.

### Assessment: heartbeat preflight budget caps are already covered (OPE-8647)

- Evaluated upstream PR [#8347](https://github.com/paperclipai/paperclip/pull/8347),
  merged 2026-06-20 as commit `631b7806ed92c43bd6b5666ad8b1406635d1ab18`.
- Upstream adds per-agent daily run and spend caps checked before enqueue and
  again at claim, clean cancellation of capped queued runs with issue-lock release
  and deferred-wake promotion, plus opt-in skipping of timer wakes without work.
- Myrmidon already has those core behaviors: admission cap checks, a claim-time
  cap recheck, safe cancellation, skipped wake metadata, per-agent/global idle
  timer skipping, and additional idle-work checks for pending interactions and
  assigned review participation. No behavior or settings change is recommended.
- Do not cherry-pick or establish automatic synchronization. Use upstream #8347
  as a regression checklist; open a separate implementation issue only if review
  finds a concrete missing execution path.

### User administration audit log and role management (OPE-8648)
- Added `GET /api/myrmidon/users-admin-a/audit` for user-management audit records with actor/target enrichment and filters by target user, actor, action, and limit.
- Added instance-admin/member role changes with `instance.user.role_changed` audit details and safeguards against self-demotion and demoting the last instance administrator.
- Added Users and Audit Log tabs to the Users administration screen, with role controls and audit filters.
- Added integration coverage for audit events, role management, filtering, and deduplication.

### Closed self-registration by default (OPE-8649)
- Self-registration without an invitation is rejected unless explicitly enabled.
- Configure `MYRMIDON_AUTH_DISABLE_SIGN_UP=false` to allow public credential sign-up; the default is closed.

### Telegram notifications for auto-update lifecycle events (OPE-8656)

- Owner notifications via Telegram on update lifecycle events: canary start, rollout success, auto-rollback with reason, and waiting for maintenance window.
- Delivery routed through active owner-delivery channel if present, otherwise direct Telegram chat/topic fallback.
- Added `telegramNotify.updates` configuration (`enabled`, `chatId`, `topicId`), disabled by default.

### The pull-request resolver reads private repositories through the shared GitHub identity (OPE-8756)

- `server/src/services/github-external-object-provider.ts`: the token provider
  now depends on the repository, `(companyId, repository)`. Order: a company
  secret by name; otherwise the single GitHub App of the shared identity whose
  `allowedRepos` matches the repository — a read-only installation token
  (`contents: read`, `pull_requests: read`, metadata), cached by
  `mintGitHubAppInstallationToken`; otherwise anonymous, as before. Two Apps
  matching one repository fail closed (no token). Secrets are read as the
  system consumer `github-external-object-resolver`; neither the token nor the
  key reaches a log or a response.
- Before, a private repository such as `myrmidon-deploy` was read anonymously,
  GitHub answered 404, and `issue_done_pull_request_gate` kept tasks with
  merged PRs blocked with the misleading "until the PR is merged".
- `PullRequestMergeDetails.access = "denied"` marks a PR the board cannot read
  for lack of rights (404 / 401 / 403 / unusable credentials). The gate then
  answers "Не удаётся прочитать PR <url>: у доски нет доступа к репозиторию
  <owner/repo> (настройте GitHub App/PAT)" with
  `reason: "repository_access_unavailable"`; other unknown states keep the old
  message.

### Users screen works: create, block, reset password with a one-time link (OPE-8985)
- The server half of the "Users" screen is in: `GET/POST /api/myrmidon/users-admin-a/users`
  and `PATCH /api/myrmidon/users-admin-a/users/:userId` (`{blocked}`, `{resetPassword: true}`
  returning `{passwordSetLink}`). Instance administrator only; anyone else gets 403.
- A user is created with a login, a name, a role and an optional temporary password. Without a
  password the answer carries a one-time link. The account address is `<login>@myr.local`; the
  user signs in on the normal form with it.
- The link opens the public page `/password-set/<token>`, where the user sets a password
  (`POST /api/myrmidon/users-admin-a/password-set`). It works once and for 24 hours; the
  database keeps only the sha256 of the token; a newer reset revokes the older link; setting
  a password closes the user's other sessions.
- Blocking closes the user's sessions and refuses any new sign-in (`403 USER_BLOCKED`).
- Every action is written to the activity log (`instance.user.*`). Self-registration is not
  changed. Migration 0412 (`user_password_set_tokens`, `user_blocks`).

### Execution sites are registered through the board API (1.6.6)

- New board-operator routes `GET/POST /api/companies/:companyId/fleet/sites` and
  `DELETE /api/companies/:companyId/fleet/sites/:name` enroll a site into
  `myrmidon_fleet_sites` without database edits. The request carries an `https://`
  fleetd address, the site CA (PEM, its fingerprint is stored), the names of company
  secrets for the bearer token and the client certificate and key, capacity and the
  gateway port range. POST and DELETE are for company owner/admin or instance admin only; DELETE answers `204`, or `409` while bots still sit on the site. The stored CA is pinned by fingerprint and the client certificate must be signed by it. Secret values never pass through the route; named secrets must
  exist, a name collision answers `409`.
- Operator guide section 4 (EN and RU) now matches the code: site PKI issuing steps,
  the real `fleetd.json` keys (`images`, `siteCA`, `serverCert`, `serverKey`,
  `gatewayPortStart`, `gatewayPortEnd`, `volumeRoot`) and mTLS health checks.

### Review escalation goes to a senior agent, never to a human (OPE-9031)

- When review rounds run out and the task has no `reviewEscalationPolicy`, the
  stage now passes to an agent: the current reviewer's manager (`reports_to`)
  and upward, then the project lead, then `adm`. The reviewer, the executor and
  paused or terminated agents are skipped. With nobody eligible a recovery card
  is raised instead. Tasks with a configured policy behave as before.
- One-time migration `scripts/myrmidon/escalate-human-reviews-to-agents.mjs`
  (`--dry-run` / `--apply`) moves stages already escalated to a user.

### Shared scoped secret-ref resolver for instance settings

- Instance-level settings can now take their value from a secret reference instead of a process
  environment variable. The reference is a binding on an existing secret; the value is resolved
  server-side through the secrets service, only for the consumers a setting names, and is masked
  in logs. An emergency environment variable still wins when it is set.
- New instance-admin API under `/api/instance/secret-settings`: list status, set or clear the
  reference, and a dry-run migration plan that reports presence flags and never values.
- The E2 secret coverage matrix records the disposition of the secret-provider names: credentials
  that open the store (AWS keys, master key) stay environment-only; region, endpoint, prefix and
  similar names are not secrets.
- Settings, General (and Settings, System in the new UI) lists these settings with a secret picker
  and a remove button, plus a dry-run migration check. The migration endpoint applies nothing
  unless the request says `apply: true`; it never returns a value.

### Tool OAuth client secrets can come from a secret reference

- The instance-wide and per-provider OAuth client secret of tool connections can now be bound
  to a stored secret instead of a process environment variable. The value is resolved on the
  server only, masked in logs, and an emergency environment variable still takes priority.
- The MCP gateway token rate-limit settings and the token broker allowed hosts are recorded as
  plain operator configuration, not secrets.

### Cloud connector OAuth client secrets can come from a secret reference

- The OAuth client secret of the OneDrive, Google Drive and Yandex Disk connectors can now be
  bound to a stored secret instead of a process environment variable. The value is resolved on
  the server at connect and refresh time only, masked in logs, and an emergency environment
  variable still takes priority.
- The connector's identity keys stay environment-only, and the Cloud runtime identity key set
  (public keys) is recorded as plain configuration.

### Application module credentials can use secret references

- The stack release check GitHub token, the tracing ClickHouse password and the browser screen-console token can now be taken from a bound secret reference instead of a process environment variable. The value is resolved on the server only, per use, so a changed or revoked reference applies without a restart. An emergency environment variable still wins when set.

### Telemetry export token can use a secret reference

- The feedback/telemetry export token can now be taken from a bound secret reference instead of a process environment variable. The value is resolved on the server only, per use, and an emergency environment variable still wins when set.
- Credentials the board needs before it can reach the secret store (session and agent token signing, workspace handoff, tenant and health tokens) stay environment-only by design; the E2 coverage matrix records the reason for each.

### A successful run without a final status no longer sends the issue to board users

- Before: when a run succeeded but left the issue without a status, and the issue had a monitor,
  execution state or execution policy (or the assignee had no manager), the issue went to
  `blocked` with no blocker and no metadata, and a "needs a disposition" card was addressed to
  board users. Agents did not pick such issues up and parent tasks stayed stuck.
- Now the escalation target is chosen by the same chain as review escalation: the assignee's
  `reports_to` upward, then the project lead, then the agent `adm`. A board user is the
  target only if the whole chain is empty.
- Issue without a workflow: handed to that agent as the `in_review` reviewer (previously only
  the direct manager).
- Issue with a monitor, execution state or policy: not taken over, the assignee and the
  workflow stay as they are. The issue becomes `blocked` with full `blockerMetadata`
  (reason, owner agent, next check) and an agent-owned `unblockDescriptor`; the owner gets one
  wake with an idempotency key tied to the source run.
- A paused assignee is handled as before. The retry wake and the direct-manager handoff are
  unchanged.
- Open PR with pending CI: transitions to a standard `external_service` monitor on CI (`serviceName: "CI"`, `scheduledBy: "assignee"`) with `nextCheckAt`, preserving `in_progress` and keeping the assignee. The check verifies the exact PR head matching the comment/run and validates that GitHub checks are not already completed.
- Data fix for issues already stuck: `scripts/myrmidon/escalate-stranded-disposition.mjs`
  (dry-run by default, `--apply` to write; it does not wake owners).

### Stale-block watchdog: live events publish after commit, locked recheck stays on the transaction

- The activity events written when the watchdog lifts a dead block are now published only after
  the transaction commits, so a rollback can no longer leave the UI with an event that never
  happened.
- The recovery-liveness check made under the issue lock now reads through the same transaction
  connection instead of taking a second one.

### Per-row secret migration apply

- Applying the secret-ref migration is now independent per setting: a failure on one row no longer
  loses the rows already bound or their audit entries. Each row is audited right after it is bound;
  if the audit or the binding fails, that row is rolled back (binding cleared, newly created secret
  deleted) and reported as an error with a code, never with a value.
- Re-running the migration after a reference was cleared reuses the secret created earlier for the
  same setting. A secret that holds the migration name but belongs to something else is reported as
  a conflict and left untouched.

### Per-provider tool OAuth client secrets are listed in settings

- The instance secret settings list now also includes one `tool-oauth.<provider>.client-secret`
  entry for each provider found in connected tool connections that sign in with OAuth. They appear
  in the same panel as the other secret references (current and new interface), so a reference can
  be chosen for each provider without the API. The list never returns a secret value.

### Transactional recovery issue factory (OPE-9139)

- Add ensureRecoveryIssue to the recovery action service: concurrent active dedupe keys share one recovery issue, action and blocker edge, with owner/SLA and wake policy persisted atomically.
- Emit committed created/deduped outcomes through the injected metrics port; reject incomplete requests before writes.
- Handle both active dedupe-key and fingerprint uniqueness conflicts atomically, including legacy actions with no dedupe key; repeated concurrent requests reuse the committed recovery without PostgreSQL 23505.
- Add PostgreSQL coverage for concurrency, rollback and owner variants; CI fails rather than skipping when PostgreSQL is unavailable. Registration and owner resolution remain separate integrations.

### Task/PR status synchronization (OPE-9406)

- Run task/PR synchronization on a dedicated scheduler-leader timer rather than the heartbeat tick.
- Reconcile PR work products for non-terminal tasks and perform a periodic closed-task reconciliation; stop timers during graceful shutdown.

### Review routing: author model separation and immediate transition assignment (OPE-9460)

When an issue enters `in_review` without an active review participant, Myrmidon now immediately evaluates review routing within the transition transaction to assign the least-loaded eligible reviewer agent. The candidate filter excludes agents whose model matches the author's model (`createdByAgentId`), ensuring diverse model evaluation across implementation and review. When no candidate with a distinct model is available, an immediate `no_reviewer` attention signal is raised.

### Production capacity dashboard metrics producer (OPE-9565)

- Implements the authoritative production producer for the five capacity metrics specified in OPE-9564:
  - `myrmidon_readiness_ratio` (gauge: ready issues / open issues; 0 when open is 0; unavailable if eligibility cannot be resolved)
  - `myrmidon_queue_age_seconds` (gauge: max elapsed seconds since continuous eligibility `readySince`; 0 when ready queue is empty; unavailable if `readySince` is missing)
  - `myrmidon_project_share{project="..."}` (gauge: share of active claim/run slots per project; 0 when total active slots is 0; sum is 1.0 when active slots > 0; unassigned issues labeled `"unassigned"`)
  - `myrmidon_starvation_total` (counter: ready episodes continuously unclaimed for >= `policy.starvation.afterMin`; exactly one increment per episode crossing threshold; re-scrapes do not increment)
  - `myrmidon_claim_rejection_total{reason="..."}` (counter: authoritative final claim rejection events with bounded closed vocabulary; attemptId deduplication prevents double-counting on HTTP replay)
- Injects the production producer by default into `GET /metrics` (`myrmidonMetricsApp` / `myrmidonMetricsRoutes`) while retaining test injection seams.
- Missing sources and unreachable eligibility are represented as unavailable (`null`), suppressing exposition without emitting fake zeroes.
- OPE-9204 (canary / production dashboard readiness) requires this production producer as an explicit prerequisite.

#### Rollout and Production Readiness
- Rolled out as part of Myrmidon 1.6.6 with no schema migrations required.
- The producer reads from existing tables (`companies`, `issues`, `agents`, `issueClaims`, `heartbeatRuns`, `instanceSettings`).
- Single company-scoped snapshot per scrape; multi-tenant instances evaluate company-scoped context cleanly.
- OPE-9204 can now proceed with production dashboard integration and canary verification against live `/metrics` scrapes.

#### Reset and Unavailable Semantics
- `starvation_total` and `claim_rejection_total` are monotonically increasing process-local counters accumulated since producer start.
- Counters reset only upon process restart or explicit reset. Use Prometheus `rate()` or `increase()` for rate calculations over time windows.
- When `policy.enabled = false`, no new starvation events are registered.
- When an underlying data source or eligibility check is unavailable, the corresponding metrics evaluate to `null` and samples are omitted from exposition; fake zeroes are strictly prohibited.

### Knowledge proposals in unified inbox and review routing (OPE-9639, KNOWLEDGE-2.0 L-1.1)

- Pending knowledge suggestions appear in the unified inbox (Streamlined UI and legacy Inbox) with `kind: "knowledge"`.
- Added the "Knowledge" category filter in the inbox filter popover with persistent selection and search.
- Selecting a knowledge inbox item routes to `/knowledge/review` for proposal inspection and disposition.

### Reviewer context isolation prototype (OPE-9655)

Add an opt-in Linux launcher with a fresh HOME and workspace, explicit task/diff
handoff and Landlock confinement. A real subprocess canary test verifies that
executor files, symlink aliases and session history cannot be read, including
from children. Production gateway behavior is unchanged.

### DEVFLOW: continuation after development review (OPE-9677)

- When an engineer hands an issue to review, automatically assign their next ready issue from the same development project; if none is eligible, signal the project lead.
- The run release path recognizes an author's issue in `in_review` via `executionState.returnAssignee` in an explicitly enabled development project and invokes the existing swarm matcher with an exact `projectId` scope.
- Configured via `MYRMIDON_DEV_PROCESS_PROJECT_IDS` (comma-separated project UUIDs; unset/empty leaves behavior disabled).
- When no eligible task is available in the project, the lead receives a `dev_project_queue_empty` wake signal.

### Reason refs on internal blocked paths (1.6.1 STALE-BLOCK follow-up)

- The service paths that enter `blocked` without going through the public
  PATCH route — native-failure reconciliation, the native finalizer's
  ambiguous-state block, recovery escalation of stranded and disposition-repair
  issues, the native blocked-wait repair, the unrunnable-workspace dispatch
  block, and the LLM Wiki maintainer blocks — now write the part A reason
  contract (`unblockDescriptor.reasonRef`) too. Recovery-driven paths cite the
  event key `recovery.liveness:<issueId>`; the stale-block sweep resolves that
  key against the live `issue_recovery_actions` rows, so a recovery block whose
  incident is explicitly resolved or cancelled is swept instead of staying an
  unknown, never-swept reason.
- The sweep's event reader is wired in the server entry
  (`createRecoveryLivenessEventReader`); any other event key keeps the
  documented still-set default, so an unwired gate never silently unblocks a
  task. The plugin SDK `issues.update` patch gained the additive
  `unblockDescriptor` field so plugins can carry the same contract.

### Owner-DM delivery journal (1.6.5 OWNER-DM-FILTER, part C)

- New instance-admin endpoint `GET /api/myrmidon/owner-delivery/publications?since=<iso>`
  lists chat publications that reached owner Telegram DM conversations in the
  window, each labeled `owner_decision` or `operational` with a machine-readable
  reason. The classification derives from the card's interaction row
  (`effectiveResolverPolicy` / `addresseeUserId` against the task owner), joined
  through `payload->>'interactionId'` — nothing new is stored and no migration
  ships.
- This is the observable surface behind the acceptance criterion "no operational
  cards in the owner's DM within a day of rollout": after the part-A filter
  ships, an `operational` entry can only come from a publication row created
  before the rollout; a fresh one is the alarm.

### Reference database fixtures and CI matrix for all supported vendor releases (MIGRATE-D3)

- Synthetic database fixtures and verification suites are generated for all supported Paperclip releases (`v2026.916.0`, `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0`, `v2026.1012.0`) in `tests/fixtures/paperclip-migration/`.
- Each release includes schema DDL derived from vendor migration tags, non-empty core entity seeds (company, projects, issues, comments, documents, agents, skills, secrets, attachments), and vendor-specific tables populated for releases 1001.0+ (`chat_github_reviews`, `browser_use_runs`, `mcp_oauth_tokens`).
- `myrmidon:migrate` CLI adds `--accept-unknown-source-objects` as a documented alias for `--accept-vendor-only-data`, reporting skipped vendor-only source data in dry-run and execution summaries.
- Verification script `scripts/myrmidon/paperclip-migration-verify.mjs` validates schema compatibility, full dry-run gap reports, entity counts, attachment transfers, secret re-encryption, source DB immutability, and transactional rollback.
- GitHub Actions CI workflow `myrmidon-paperclip-migration.yml` runs a matrix across all five releases with `fail-fast: false`, ensuring independent per-release test reporting.

### UI of plugins built against `@paperclipai/plugin-sdk` loads again

- After the debranding, the host only substituted `@myrmidon/plugin-sdk/ui` and
  `/ui/hooks` in plugin UI bundles. Plugins built with `@paperclipai/plugin-sdk/ui` kept
  as an external import (Google AI, ChatGPT, Antigravity, license issuing, LLM Wiki and
  third-party ecosystem plugins) failed to load their sidebar UI. The legacy
  names are substituted with the same shim again, in both quote styles.

### Pool-chat server boundary (OPE-8207)

- Adds authenticated module-scoped capabilities, submit, and request-status routes with bounded request validation, scoped idempotency, durable request/attempt/reservation records, account-selection policy, and fail-closed provider dispatch.
- A replay returns its existing durable request without repeating provider I/O. A request that may have reached a provider remains `uncertain`; provider exceptions are reduced to a stable redacted code. Missing provider transport configuration fails closed and releases the reservation.
- Quota is enforced per account in tokens. Each new request reserves an upper bound (estimated input at 4 characters per token plus the requested output ceiling) under a per-module advisory lock, so concurrent submits cannot overshoot `quotaUnits`; the check reads live usage from the ledger (reserved or settled units of dispatching, sent and uncertain attempts) added to the configured `usedUnits` baseline. Settlement replaces the reservation with actual usage; failed no-send attempts release it. The cap is a lifetime budget: the operator resets it by raising `quotaUnits` or lowering `usedUnits`. Automatic recovery of requests stuck in `uncertain` is not included: they keep their reservation until an operator resolves them.
- Disabled by default (`MYRMIDON_POOL_CHAT_ENABLED`). Live pool validation is operator-only and was not run.

### A monitor that waits for a pull request no longer starts a model run just to look at it (PR-WAIT-MONITOR)

- A due issue monitor whose service name or notes say it waits for CI or a pull request
  (`CI`, `github_actions_ci`, "waiting for CI to finish", ...) is now evaluated by the board
  from rows it already has: the pull request work products (status, review state, the
  `activeCi` / `lastCompletedCi` marks written by GitHub connection events) and the end of the
  agent's last run on the task. No GitHub call is made.
- Nothing new since the agent last looked: the agent stays asleep and the monitor is re-armed
  with a doubling interval (10, 20, 40 minutes, capped at 60); the check is logged as
  `issue.monitor_deferred` with reason `pr_wait_unchanged`. The agent's own `timeoutAt` is
  never postponed.
- News (CI completed, review submitted, merge conflict, pull request merged or closed) wakes
  the agent as before, with the observed change in the wake payload and context
  (`observedChange`, `observedChangeSummary`). When the board holds no CI data for the pull
  request and has seen nothing for 30 minutes, the agent is woken once with a `no_signal`
  note, so a finished CI is never left unnoticed.
- A run woken by a monitor no longer re-arms the "GitHub CI pending monitor" from its own
  context: that context carries the monitor's note ("CI pending"), which the successful-run
  handoff read as proof that CI was still pending, so the monitor re-armed itself after every
  run (one task reached 57 attempts). The agent's last comment and the recorded CI marks
  still count.
- A due monitor on a task that is no longer an active agent task (backlog, todo, done,
  cancelled, or not assigned to an agent) is cleared instead of left armed.
- A person triggering a monitor by hand, review-recovery monitors and monitors that do not
  wait for a pull request behave as before.

### 1.6.6 — BOARD-PROCESSES part A: the process role and the background-work gates (PROCS-1.1)

- The board can now be started as one process (`all`, the default and today's
  behaviour) or split between a scheduler process (`worker`) and HTTP-only
  processes (`api`): `PAPERCLIP_PROCESS_ROLE=api` starts without a single
  background timer — no heartbeat scheduler, no reconciliation sweeps, no
  plugin workers, no backups — serves the board on `0.0.0.0:3100` with
  `reusePort` so several api processes share the port, and waits for the
  migration-owning process instead of migrating the database itself. The
  `worker` process runs every timer and additionally serves the board app on
  the internal loopback `127.0.0.1:3101`.
- Every gate on background work reads one place — `processRole()` in
  `server/src/services/process-role.ts` (env `PAPERCLIP_PROCESS_ROLE` in
  `all|worker|api`) — instead of a scattering of `if` checks; `all` is
  byte-for-byte today's behaviour, and an unknown value falls back to `all`
  with a warning at startup.

### Process supervisor — fork, reusePort, IPC ready/drain, backoff, emergency return to single (PROCS-1.2, OPE-6425)

- `server/src/myrmidon/processes/supervisor.ts` — the worker's child-process
  supervisor: forks `server/dist/index.js` with the same execArgv (including
  `--import tsx/loader`), `PAPERCLIP_PROCESS_ROLE=api`,
  `PAPERCLIP_PARENT_BOOT_ID`, and a per-child `--max-old-space-size` (api
  1 GiB); restarts a crashed child on a 1 s → 30 s backoff; when no live api
  child remains for 15 s the worker re-opens :3100 itself (emergency return
  to single) and logs the attention signal.
- `server/src/myrmidon/processes/child.ts` — the api child's side of the IPC
  contract: `ready` after `listening` + `SELECT 1`; `drain` runs
  `server.close()` + `closeIdleConnections()`, closes live-events websocket
  clients with 1012, and exits after the 30 s grace via
  `closeAllConnections()`.
- `server/src/index.ts` — the worker's public listener is supervisor-managed:
  single→split forks the children and closes the worker's :3100 once all
  report ready; split→single re-opens :3100 (reusePort while children still
  hold it) and drains them one by one; the worker's shutdown stops the
  supervisor first. The api role skips the heartbeat/sweep scheduler block and
  gets a smaller database pool (6 connections).
- `server/src/myrmidon/processes/service.ts` — `PATCH
  /api/myrmidon/processes` now applies live through the supervisor (design
  OPE-5394 §7.2), no container restart; `PAPERCLIP_PROCESS_MODE=single` still
  wins over the database at boot.
- `packages/shared/src/myrmidon-processes.ts` —
  `PROCESSES_SUPERVISOR_IMPLEMENTED` flipped to true; a stored `split` is in
  effect instead of reported unsupported.
- `server/src/myrmidon/processes/supervisor.myrmidon.test.ts` — unit tests:
  single inertness, single→split with readiness gate, apiCount up/down with
  IPC drain, split→single, the backoff ladder, the emergency fallback, and
  shutdown.

### PROCS-T1.5: process-role orchestrator — the board launch map and config (api N + worker M)

- New `server/src/myrmidon/process-orchestrator/` — the single place the
  split board's launch map is computed. `config.ts` turns the env into a
  `ProcessMap` (design §2, §7.1): `single` mode returns exactly today's one
  `all` process with no overlays — byte-for-byte vendor behavior; `split`
  mode returns M worker entries + N api entries, workers first. Ports: api
  child i binds `PORT + i*MYRMIDON_API_PORT_STRIDE` (client entry stays
  `PORT`); worker i binds loopback `MYRMIDON_WORKER_PORT + i` (defaults to
  `PORT+4`, clear of the PROCS-1.1 single-worker slot 3101 the future
  proxy dials). Queues: the four execution-control sweeps split
  round-robin across workers (4/3/3/3 for M=1..4), each worker gets its
  slice written into its own `MYRMIDON_WORKER_QUEUES`; api entries own no
  queue. Every junk value is a hard `ProcessConfigError` before anything
  spawns — counts outside 1..4/1..2, ports outside 1024..65535, unknown
  queue names, an api/worker port-block collision, and the stride=0
  shared-port shape (which waits for PROCS-1.2's `reusePort`).
- New `launcher.ts` — the pure half of the spawner: `buildLaunchPlan`
  maps a `ProcessMap` to ordered spawn specs (`command`/`args`/`cwd`/`env`
  overlay/`healthUrl`), stamps every child with
  `PAPERCLIP_PARENT_BOOT_ID`, and spawns nothing itself. The env overlay
  carries the PROCS-1.1 role contract (`PAPERCLIP_PROCESS_ROLE`,
  `MYRMIDON_PROCESS_INDEX`) so a split child gates its background timers
  exactly as the role-gates PR specifies.
- New `scripts/procs-dev.ts` + `pnpm dev:procs` — the ticket's one-command
  dev stand: `MYRMIDON_API_PROCESSES=2 MYRMIDON_WORKER_PROCESSES=2 pnpm
  dev:procs` prints the launch card, prepares the same dists `pnpm dev`
  does (plugin sdk, ui), then spawns workers first and probes each child's
  `/api/health` before the next entry; Ctrl-C (or any child dying) stops
  the whole stand. No restart policy — that is PROCS-1.2. `--dry-run`
  prints the card only; a split without `DATABASE_URL` is refused with an
  explanation (embedded Postgres bootstraps one data dir per instance).
- `server/src/myrmidon/process-orchestrator/process-orchestrator.test.ts`
  pins all of it (17 tests): `single` stays a no-op card, the N=2+M=2
  acceptance map (ports 3100/3101 + 3104/3105, queue split 4/3, per-child
  role env), every error shape, and the plan mirroring the card.

### Single routes are proxied from the api processes to the worker (split mode)

- In the multi-process board (`api` processes + `worker`), an api process forwards the routes
  whose state lives only in the worker to its loopback listener (`127.0.0.1:3101`, or
  `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT` from the launch map): the attention feed
  (`GET /api/companies/:id/attention`), the plugin host (`/api/plugins/**`), the bot-container
  control (`/api/myrmidon/agents/:id/bot-container/**`) and the workspace-runtime control
  (`POST …/runtime-services|runtime-commands/:action` of projects and execution workspaces).
- Authorization is transparent: the request goes through unchanged (credentials, cookies, origin,
  body) and the worker resolves the actor itself; its answer is streamed back as is. A worker that
  does not answer yields `503` with `Retry-After`, never a local answer.
- The existing `Processes` setting `singletonProxy` (default on) switches it, no restart; off means
  the api process serves these routes itself. The single-process board and the worker never proxy.
- New metric `myrmidon_board_singleton_proxy_total{role,route,outcome}` (`proxied` / `unavailable`).

### Standalone worker entry (`pnpm --filter @myrmidon/server worker`)

- A dedicated launch point for the `worker` process role: `node dist/worker.js` boots the
  same board runtime as `index.ts` with `MYRMIDON_PROCESS_ROLE=worker` (set by the entry when
  unset, kept when already `worker`, refused for any other role). The role profile, the
  supervisor, the process registry and the `/internal/ready` + `/healthz` routes are the
  ones already shipped; the entry adds none of them a second time.
- The default launch (`node dist/index.js`, one process) is unchanged.

### Provider tool-call compatibility probe uses a model the provider really lists

- The probe no longer assumes `gpt-4o-mini`: it takes the first model from the provider's
  `/models` answer (or an explicit probe model). A provider with an empty model list gets a
  clear "provider_no_models" error instead of a false pass or a 404 for a missing model.
- The stored and returned `toolCallCheckError` is now a short `code: description`
  (`provider_http_<status>`, `no_tool_call`, `provider_unreachable`, `probe_failed`); the raw
  exception text, provider response body and headers are never kept or logged.

### Server and CLI texts renamed to Myrmidon (REBRAND B, OPE-4155)

- User-visible text in the server and the CLI names the product Myrmidon:
  CLI `--help` and banner, onboarding/doctor/service/update messages, CLI
  HTTP client errors, OpenAPI summaries and descriptions, API error
  messages, onboarding documents for external agents, outgoing request
  user agents, the Node version warning, and the org-chart SVG wordmark.
  Details: [guides/rebrand-b-server-texts.md](guides/rebrand-b-server-texts.md).
- New guard tests keep the surfaces free of the vendor name:
  `cli/src/__tests__/cli-product.myrmidon.test.ts` and
  `server/src/__tests__/server-user-text.myrmidon.test.ts`.
- Identifiers are untouched for compatibility: the `paperclipai` package and
  bin, `PAPERCLIP_*` env vars, `X-Paperclip-*` headers, `@paperclipai/*`
  packages, `~/.paperclip` paths, MCP server names, the `/paperclip` Discord
  command, and frozen pre-rename snapshots.

### Bots read the board key and address as MYRMIDON_API_KEY / MYRMIDON_API_URL (REBRAND-ENV)

- The `execute_code` pass-through list in the bot profile (`terminal.env_passthrough`) now carries `MYRMIDON_API_KEY` and `MYRMIDON_API_URL` ahead of the legacy `PAPERCLIP_API_KEY` / `PAPERCLIP_API_URL`; the `hermes/.env` of the bot already holds both pairs with the same values. The bot skill (`auth-and-run-context.md`) names `MYRMIDON_*` as the variables to read and `PAPERCLIP_*` as the deprecated alias.
- The bot disk agent `botd` (desired-state poll and disk report) reads `MYRMIDON_API_URL` / `MYRMIDON_API_KEY` first and falls back to `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` when the canonical one is missing or empty, so a bot image older than the board keeps working. The key is redacted from reasons and logs under either name; the "not set" reasons now name the `MYRMIDON_*` variable.

### Bot-container reconciler journal records identify the applied profile and trigger

- Apply records now include `appliedFilesHash` and, when set by the compiled profile, `appliedMaxConcurrentRuns`, alongside the existing `restartHash`.
- The `trigger` field records `<state>:<drift|nodrift>:<changeClass>` (for example, `running:nodrift:restart`); newly created containers use `missing:new`.
- Records for updates deferred by a maintenance window include `maintenanceReason` with the window's reason. These fields improve journal diagnostics only; reconciliation behavior is unchanged.

### Add redaction modes (OPE-8659)
- Added reversible, irreversible, and flag-only redaction modes with expiring database-backed substitutions and a restore endpoint.

### Release: a notes section over GitHub's limit is published condensed

A release whose notes exceed GitHub's 125000-character release-body limit (1.6.6 carries 172 entries) is no longer refused at publish: the body lists the entry headings and points at the full section in `docs/myrmidon/CHANGELOG.md` / `CHANGELOG.ru.md` at the tag. A body still over the limit after condensing is refused as before.

### Release publish: the tag-CI gate wait budget doubled to 80 min (RELEASE-GATE-POLL-BUDGET)

The publish step of a release tag waits for the tag's own CI run
(`myrmidon-ci-tag.yml`) up to `POLL_SECONDS × POLL_MAX`. A tag push starts
nine workflows at once, and under the hosted-runner queue the rc.13 tag CI
took ~50 minutes while the budget was 20 s × 120 = 40 minutes — the publish
died at the timeout with an empty verdict eleven minutes before the green
run landed, leaving the tag without its GitHub Release (the rc.13 publish
blocker). The publish job now sets `MYRMIDON_RELEASE_POLL_MAX: "240"`
(20 s × 240 = 80 min, inside the job's 90-minute timeout; the wait still
exits early once the run completes), and a regression test pins the
«the run completes only after more than the old 120 polls» scenario.

### Atomic review admission (REVIEW-ADMISSION)

Entering `in_review` and changing the assigned reviewer now use the issue-update transaction to persist a durable reviewer wake request. Execution-stage review wake requests are persisted through the same transaction path.

### Review escalation after the round limit goes to technical reviewers, never to the issue owner (OPE-8327)

- When a review stage exhausts its rounds, `reviewEscalationPolicy` (roles `lead` → `architect` → `secondary_reviewer`, `policyRevision`, `fallbackQueue`) picks the next technical agent; candidates outside the issue project or caste, or equal to the issue owner/creator, are skipped. The escalated reviewer holds the stage across unrelated updates until they decide.
- The transition is persisted (`reviewCycleId`, `escalationPolicyRevision`, `escalationReason=review_round_limit`, from/to participants). If no technical reviewer exists, the issue stays in review and one recovery interaction is raised, deduplicated by `(issue, reviewCycleId, policyRevision)`.
- Progression is by round: an escalated reviewer gets a fresh round budget and, on exhausting it, the stage moves to the next role; the exhausted actor is never reselected.
- Metric `review_escalation_to_user_owner` is emitted whenever an escalation reaches the human owner: the legacy policy-less hand-off and the recovery card (addressed to the owner). With technical reviewers available the value is 0.

### A review task with a live review participant is no longer escalated to board-only blocked (REVIEW-PARTICIPANT-LIVE-SKIP)

- The stranded-assigned-work reconciliation no longer moves an `in_review` task into board-only `blocked` while the typed review participant of the execution-review stage has a live run — a run in an execution status on **any** issue of the company, not only the task being reconciled.
- Before the escalation branch (policy `board_escalation_no_takeover_v1`) runs, the new helper `getLatestLiveRunForAgent` looks up the participant's latest live run across the company; a found live run skips both the board escalation and the participant's adapter-failure classification. The task keeps waiting for its live participant instead of receiving a board card.
- Shipped earlier (merge of the fix predates the 1.6.5 cut); this entry closes the missing changelog record. See DIVERGENCE.md, `REVIEW-PARTICIPANT-LIVE-SKIP`.

### A review return on the same pull request head, or only on infrastructure checks, no longer wakes the executor (REVIEW-RETURN-GUARD, OPE-11970)

- One engineer bot was woken 199 times in four days with `execution_changes_requested` (520M input tokens, almost all on
  four tasks). The reviewer returned the task because CI of the pull request head was red only on flaky or infrastructure
  checks, or returned it again on the same head; the executor had no commit to make, resubmitted, and the loop went on.
- The execution state now remembers the head of the pull request at the last return (`lastChangesRequestedHeadSha`).
  When an agent reviewer returns the task on that same head again, with no new commit in between, the decision is recorded
  as before and the executor stays assigned, but it is not woken. A system note says so in the task thread, and the
  activity row `issue.review_return_wake_suppressed` is written.
- When the decision comment reports only CI (it mentions CI and cites no file, line or code block) and every check that
  failed on the head is on the infrastructure list (`CI result` failing alone is its own queue-latency gate, `main-green`
  fails while main is red), the executor is not woken either, and the activity row `issue.ci_infra_retry_needed` tells
  the release tooling to re-run the failed jobs. The list is `MYRMIDON_REVIEW_INFRA_CHECK_NAMES`.
- The executor is still woken by a new CI result on the head (`ci_completed`), by a comment and by a new head. A human
  reviewer is never held back. Anything the guard cannot read (GitHub error, unknown head, a lane of the code failed)
  keeps the old behaviour.
- Reviewer rules (skill `engineering-discipline`): a verdict is about the code; wait while CI runs; re-run the failed jobs
  once when CI is red only on known flaky or infrastructure checks; never repeat REQUEST CHANGES on the same head without
  new findings in the code.

### An exhausted review wake series is escalated once and re-armed after 6 hours (REVIEW-ROUTING, OPE-11947)

- The review routing sweep wakes the reviewer of a stage on a bounded backoff (`REVIEW_WAKE_MAX_ATTEMPTS`, 6 attempts, each one recorded in the activity log with its `attempt` number). When the model pools were empty all six attempts burned at once; after that every pass (once a minute) wrote a new `issue.review_routing.wake_escalation_required` row for the stage (7 202 rows in a day on the production board) and never woke the reviewer again, so the stage stayed stuck until someone replayed the wake by hand.
- The escalation is now written once per exhausted series: a `wake_escalation_required` row of the same task, reviewer and stage that is newer than the last wake means the series was already escalated, and the warning is not repeated either.
- A series exhausted for at least `REVIEW_WAKE_REARM_AFTER_MS` (6 hours since its last attempt) is re-armed: the next wake is recorded with `attempt` 1 and the backoff counts from the start of the new series. A stage stuck behind an unavailable model comes back on its own within 6 hours instead of never; the earlier escalation stays in the log as a fact. The backoff inside a series, the one-wake-per-pass limit and the cancelled-run anchor are unchanged.

### A call-limit stop of a run that made changes continues the work instead of blocking the task (RUN-GUARD-CONTINUE)

- `model_call_limit` (150 model calls) also trips on productive work: runs that patched and wrote files
  were stopped and their tasks went to `blocked` with "give the assignee a new input". The run guard now
  counts the calls that change something (`writeCalls` in `RunGuard.stats()`, stored with the run next to
  `runGuardStats`): every tool call that is not read-only, the same classification as the exploration check.
- When a run stops with `model_call_limit` and `writeCalls > 0`, the task is not blocked and no "new input"
  comment is written. The work continues in a follow-up run, the way it continues after a max-turn stop (retry
  reason `max_turns_continuation`), within the same ceiling (`heartbeat.maxTurnContinuation.maxAttempts`,
  default 2, counted along the chain of follow-ups). When the ceiling is spent, the continuation policy is
  off, or the task is no longer `in_progress` with the same assignee, the stop is final as before: `blocked`
  plus the comment.
- Unchanged: `model_call_limit` with no changing call, and every other reason (`no_progress_exploration`,
  `repeated_tool_call`, `tool_retry_loop`, `idle_timeout`) stay final: no retry, `blocked`, comment. Adapters
  that do not feed tool starts to the guard report `writeCalls: 0` and keep the old behaviour.

### Call-limit continuations get their own ceiling, and a final guard stop wakes the manager (RUN-GUARD-CONTINUE, RUN-GUARD-ESCALATE)

- A run the run guard stopped at `model_call_limit` after it made changes (`writeCalls > 0`) is continued, as
  before, in a follow-up run. Those continuations no longer spend the max-turn ceiling
  (`heartbeat.maxTurnContinuation.maxAttempts`, default 2): three runs in a row of 150 calls and 16–27 writes
  each used to end with the task in `blocked` ("no automatic retry"). They have their own ceiling,
  `heartbeat.runGuardContinuation.maxAttempts` in the agent runtime config: default 6, at most 20, counted
  along the chain of call-limit continuations only (the count travels in the run context as
  `runGuardContinuationAttempts`). A max-turn stop later in the same chain still has its whole ceiling.
  `heartbeat.runGuardContinuation.enabled: false` or `maxAttempts: 0` makes the call-limit stop final again;
  `heartbeat.maxTurnContinuation.enabled: false` still does too.
- The stop is final, and the task goes to `blocked` with the "new input is needed" comment, when the last run
  made no change (`writeCalls` 0), when the own ceiling is spent, or for any other guard reason.
- A final guard stop now wakes the assignee's manager (`agents.reports_to`; without a usable one, the agent
  named `adm`; without that, nobody) with the wake reason `run_guard_stop_needs_input`. The wake carries the
  issue id and the stop text in its payload, leaves the assignee and the status as the escalation set them,
  and is sent once per block episode: while the task has not left `blocked` since the previous wake (no
  `issue.updated` activity moving the status away from `blocked` after it), there is no second one; once the
  manager put the task back and it stops anew, he is woken again at once. If the assignee is `adm` itself,
  nobody is woken. Both
  places that block a guard-stopped task send it: the stop handling in `heartbeat.ts` and the stranded-issue
  sweep. The bot skill (`skills/myrmidon/references/heartbeat-procedure.md`) tells the manager what to do: read
  the last run, put the point of the fix into the description or split the task into 1–2 hour subtasks, and
  return it to `todo` in one `PATCH`. The queued-run staleness check (`modules/run-dispatch`) lets this wake
  start although the manager is not the assignee, bound to the exact automation source and wake reason, to
  the issue being `blocked`, and to the run's agent being the assignee's `reports_to` or `adm`; any other
  agent, or a task that has moved on, is cancelled as before.

### Run guard stops read-only loops and repeated calls; no automatic retry after a guard stop (RUN-GUARD-LOOPS)

- The run guard has two new stop reasons. `no_progress_exploration`: 40 consecutive read-only
  tool calls (`search_files`, `read_file`, `skill_view`, `read_stale_tool_result`, and terminal
  commands made only of `sed`/`grep`/`rg`/`cat`/`ls`/`find`/`head`/`tail`/`wc`/`git log|show|diff|status`)
  with no write in between. `repeated_tool_call`: the same read-only call (same tool, same argument)
  for the 3rd time since the last write. Any other tool call, any other terminal command and any
  redirection into a file counts as a write and resets both counters. The hermes gateway adapter
  feeds the guard from `tool.started`; other adapters are unchanged.
- Both limits are configurable like the other guard limits (agent card `runGuard`, team liveness
  `runGuard`, environment) and `0` switches the check off.
- A run stopped by the guard (any of the five reasons) is no longer retried automatically. The
  five reasons are permanent failures in the run retry taxonomy, the bounded retry scheduler and the
  stranded-recovery enqueue refuse such a run, and when the run ends the assignee's issue goes to
  `blocked` with a comment that says why the run was stopped and that a new input is needed.
  Maintenance interruptions and transport failures keep their retry paths.

### Run-limits guide: the load view with the memory snapshot (1.6.5 C0-ui docs)

- [guides/run-limits.md](../guides/run-limits.md) gained a "The load view"
  section: the `memory` block of `GET /api/myrmidon/runtime-limits` (the
  host's available/total memory and the server container's cgroup v2 usage,
  each side `null` when unreadable), next to the queue and host-load
  snapshots, and the line both run settings panels show for it.

### Automatic retry of a failed run is one policy: failure class, exponential backoff, attempt limit, counter in the UI (1.6.6 RUN-RETRY-POLICY)

- A failed run is now classified before it is queued again. The classification
is `transient`, `permanent` or `unknown`, and it decides whether a retry is
queued at all: a transient failure is worth another attempt, a permanent one is
never retried automatically, an unclassified one keeps the historical
single-attempt treatment (the board has no evidence that repeating it would
help).
- The transient/permanent taxonomy and the attempt ceilings moved into one
module, `server/src/myrmidon/run-retry-policy`, which is now the only place that
answers those questions. The list of codes is unchanged: the six transient codes
(`adapter_failed`, `codex_transient_upstream`, `codex_harness_crash`,
`claude_transient_upstream`, `provider_quota`, `timeout`) and the eighteen
permanent ones (`setup_failed`, the five `workspace_git_scan_*` codes, the
`low_trust_*` family, `budget_*`, `issue_*`, `agent_not_invokable`,
`agent_not_found`, `adapter_engine_unavailable`) earn exactly the same verdict
they earned before, and the defaults reproduce the numbers the paths used
(bounded retry: 3 attempts; unclassified: 1; backoff base: 60 s, factor 2).
- The adapter's own verdict is consulted as one more signal: a run whose
persisted `errorFamily` is `transient_upstream` or `provider_quota` is treated
as transient even when its error code is generic, and one whose family is
`permanent_config_error`, `model_refusal`, `refresh_token_reused` or
`refresh_token_invalidated` is permanent — no repeated attempt against a
configuration or credential problem that cannot heal by itself.
- The backoff is exponential and censored: `base · multiplier^(attempt − 1)`,
capped by a ceiling, optionally jittered symmetrically, never below one second.
An operator can now reach the ceiling (`MYRMIDON_RUN_RETRY_MAX_DELAY_SEC`) and
the jitter (`MYRMIDON_RUN_RETRY_JITTER_PERCENT`) without a code change; with the
defaults the schedule is bit-for-bit the one the board produced before.
- The board shows the counter: the scheduled-retry card and the task properties
render "Attempt 2 of 3 · Transient failure" — how many attempts the scheduler
allowed and what kind of failure is behind the retry. A retry queued before this
change (no snapshot in the run context) keeps the bare "Attempt 2".
- This is not the stall path: RUN-STALL/F-26 interrupts a run that is still
*running* without progress. This policy is about a run that already *failed* and
about the retry the board queues for it, and it never touches a live run.

### Live runs execution phase metrics and reconnecting watchdog

- The `/metrics` endpoint exposes `myrmidon_runs_execution_phase{phase="working|reconnecting|finishing|retry_scheduled|recovery_needed|..."}` showing count of live runs by projection phase. Phases are computed using the standard `executionProjectionsForRuns` service.
- The `/metrics` endpoint exposes `myrmidon_runs_reconnecting_oldest_seconds` showing the duration in seconds of the oldest run currently hanging in `reconnecting`.
- An in-product monitoring watchdog checks live runs periodically: when >= 3 runs are in `reconnecting` for longer than 5 minutes OR > 50% of live runs are in `reconnecting`, an alert is raised in the board's alert recovery channel listing affected run IDs.
- Runbook `docs/myrmidon/runbooks/runs-reconnecting.md` documents diagnostic and remediation steps.

### Secret proposals can rotate an existing secret (SECRET-PROPOSAL-ROTATE)

- A `kind=secret` agent proposal now accepts `rotateSecretId`. On approval the
  proposed value becomes a new version of that secret (compare-and-set on the
  active version), and `@latest` bindings pick it up; rotation never renames
  the secret. The approve dialog shows the target, fingerprint and status.
- A proposal whose name is already taken now fails with `409` at creation (and
  at approval for old pending proposals) instead of becoming an unapprovable
  dead end.
- A `kind=binding` proposal may retarget a path that already holds a company
  secret reference (only the secret part is compared); plain values and
  user-secret bindings still require an exact match.
- Migration `0407_secret_proposal_rotation_target` adds the nullable column
  `company_secret_proposals.rotation_target_secret_id` with a foreign key.

### Processes apply committed instance settings across processes (SETTINGS-APPLIERS)

- A successful PATCH commits the settings document under the row lock, then publishes `settings_changed` with the changed keys. Each process treats the event as an invalidation hint and re-reads the committed row before applying local effects; it never applies request-body values from the event.
- The applier registry handles `runLimits`, `teamLiveness`, `myrmidonMaintenance`, and `processes`. Applies run one at a time per process in arrival order, and periodic sweeps remain the fallback for processes that were offline or temporarily disconnected.
- `taskDrain` is stored in `instance_settings.general`; each process re-reads the committed row through the registry before updating its local drain state.

### Correct the attention feed cache TTL default in the settings docs

- The English and Russian settings guides now show the current default of 60 seconds, not 45 seconds. The runtime default does not change.
- Correct the SETTINGS-UI C-4 row in the Russian settings registry to 60 seconds when the release collects this fragment.

### Compact Myrmidon skill core, details on demand (OPE-11947)

- The bot-facing `myrmidon` skill is loaded into the context of every agent run, and it was 62,839 bytes (12.4% of all request characters measured over 28,128 requests of 21 bots). `skills/myrmidon/SKILL.md` is now a compact core of under 10,000 characters: identity and run-audit header, the heartbeat procedure, the final-disposition contract (statuses, real review and waiting paths, verified writes), comment and handoff rules, the critical rules, the most used API calls, and an index that names the reference file for each situation.
- Everything else moved verbatim into topical files under `skills/myrmidon/references/` (`auth-and-run-context`, `chat-turns`, `heartbeat-procedure`, `disposition-and-monitors`, `tasks-blockers-approvals`, `interactions-and-decisions`, `topic-pointers`, `secrets`, `critical-rules`, `comments-and-planning`, `hot-routes-and-search`). The original text of every section is preserved verbatim there; the core carries only condensed summaries.
- New rules in the core: load the skill once per run and never re-open it after context compaction; never print full board JSON (select fields with `jq`, bound lists with `limit`/`view=compact`, use `Prefer: return=minimal` on `PATCH`).
- The runner capability inventory (`packages/paperclip-runner`) now lists the relocated reference files as skill sources and its generated baselines are regenerated (163 skill and reference headings, 164 in the generated contract).

### SKILLS-UI part A: skills from agentskills.io sites, verified by digest (SKILLS-UI-A)

- New server route `POST /api/companies/:companyId/skills/discover` with body
  `{ source }`: give it a bare vendor site (for example `https://kie.ai`) and it
  reads the published discovery index
  (`/.well-known/agent-skills/index.json`, HTTPS only, 15 s timeout, 2 MB cap)
  and answers `{ skills: [{ name, description, digest, url }] }` with absolute
  archive URLs. A site that does not publish the index, an unreachable host, or
  a malformed index each produce a clear 422 with a stable code. The route runs
  the same skill-import policy gate and activity log as the existing import.
- `POST /api/companies/:companyId/skills/import` now accepts
  `{ source, skillName }` for those sites. The server downloads the selected
  tar.gz (20 MB cap), verifies its SHA-256 against the digest the index
  advertises (a mismatch rejects the import with 422 and writes nothing), then
  unpacks it with a hardened reader that refuses absolute paths, `..` traversal,
  symlink and hardlink entries, and oversized expansion. The SKILL.md and the
  skill's files are stored under the company managed-skills root as a new
  `well_known` source; skills.sh-style sources keep their old behavior.
- Re-import is update: the same digest changes nothing, a new digest stores the
  new files and records a new skill version labeled with the short hash.
- Each imported external skill now carries `requiredEnv` in its metadata, and
  `GET /api/companies/:companyId/skills/:id` returns it as `requiredEnv:
  string[]`: environment names read from the SKILL.md text by pattern
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, explicit `os.environ` /
  `process.env` / `$VAR` references). It is advisory metadata for the
  key-provisioning UI (part B), never a credential.

### A scheduled retry is counted stale from its due time, not from its creation (STALE-QUEUED-AGE-FROM-DUE, OPE-11947)

- A scheduled retry (`scheduled_retry`) is created right after the failure it answers and enters the queue (`queued`) only when `scheduled_retry_at` falls due. The stale-queued-run sweep (`queuedRunStaleAfterSec`, 30 min by default) measured age from `created_at`, so a retry with a delay longer than the threshold (model-unavailable waits: 30 min, 1 h, 2 h, 4 h, 6 h) was cancelled as `queued_run_stale_timeout` the instant it was promoted, and the sweep then woke the agent with a fresh run on the same task at attempt 0. The long schedule never advanced: every task of an agent over quota was retried every ~30 minutes forever.
- A queued run that carries a `scheduled_retry_at` already in the past is now measured from that time; any other queued run, and a run whose `scheduled_retry_at` is still in the future, is measured from `created_at` as before. The same measure is used by the sweep's selection (`heartbeat.ts`) and by the guard inside `cancelStaleQueuedRun` (run-dispatch Postgres adapter), so a race between the two cannot cancel a fresh retry. A retry that has really stood in the queue past the threshold since it fell due is still cancelled.

### SWARM claim expiry provenance (1.6.6)

- Swarm claims now record whether they came from automatic matching or checkout. Expiry clears an assignee only for a released automatic-match claim that is still the current lease; legacy rows with unknown provenance remain assigned. Added a nullable migration and embedded regression coverage for unknown provenance.

### Adapters: add omp-local adapter for Oh My Pi runtime (OMP-LOCAL)

- Added independent local adapter `omp-local` (`adapterType: "omp_local"`, package `@paperclipai/adapter-omp-local`) for the Oh My Pi (`omp`) runtime, pinned to `@oh-my-pi/pi-coding-agent@18.9.2`.
- Implemented first-turn isolated session allocation in `~/.omp/paperclips/<companyId>/<agentId>` and turn resumption via session header validation without altering `pi-local` behavior.
- Supported custom model providers via deterministic `models.yml` generation from `PAPERCLIP_OMP_PROVIDERS` (falling back to `PAPERCLIP_PI_PROVIDERS`) and `omp models ls` model discovery.
- Materialized runtime skills into managed skills directories without `--skill` CLI flags, including remote execution staging under `<agentConfig>/skills`.
- Added allowlisted model provider credential environment variables (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`) for `omp_local` runs.
- Registered adapter across server, CLI, and UI registries with full capability declarations and environment diagnostic probes.

### Owner Telegram questions as plain text (U2)

- Deliver owner-only Telegram question and safe confirmation publications as readable text without inline buttons. Preserve option descriptions and the durable interaction publication contract. A question too long for one Telegram message, or a confirmation that cannot be shown as text, is replaced by a short "answer on the board" notice with the task link (and a log warning) instead of being dropped.

### Owner Telegram producer modes (U2)

- Preserve the configured owner-DM audience modes: `via_bot` produces no owner-DM publication, `owner_decisions_only` publishes human decisions, and `all` includes agent-addressed and operational interactions. Every eligible owner-only Telegram publication remains plain text without buttons; task-bound vendor routes are unchanged. The default mode is unchanged.
- The plain-text producer path, renderer, and Telegram no-keyboard payload contract are implemented and exercised by the merged baseline change in PR #1573 (`88442ae96`). This PR covers the owner-DM audience modes and their regression tests.

### Owner text answer in Telegram closes the question (U2)

- The owner's text message in the standing Telegram chat with the bot now closes the owner decision the bot explained there, attributed to the owner, and the task's agent is woken with the answer. A reply to a bot message is bound to the decisions that exact message explained; without a reply one open decision closes, and with several the bot asks which one. A reply to a message that explains nothing closes nothing.

### Telegram pool bridge for ChatGPT and Gemini (OPE-8077)

- Adds Telegram bridge support for ChatGPT and Google AI / Gemini pool modules using the pool-chat adapter.
- Configurable per module: allowed chat ID, model, bot token reference, and pool endpoint. Default disabled (`enabled: false`); operator-controlled activation.
- Strictly enforces chat allowlist: messages from unauthorized chats or strangers are refused without calling pool-chat and without debiting quota.
- Incoming Telegram updates are deduplicated: repeated deliveries of the same `update_id` return the existing result without repeating upstream provider I/O or charging quota again.
- Long answers exceeding Telegram's 4096 character limit are cleanly split into sequential parts and delivered via the outbox.
- History isolation prevents conversations from ChatGPT and Gemini from crossing, and prevents Telegram chats from intersecting with web-chat.
- Token redaction ensures bot tokens and API keys are never exposed in error responses, logs, or status payloads.
- Includes ChannelSettingsPanel UI integration, operator live acceptance runbook, and automated test coverage for redaction, allowlist, update deduplication, long answer chunking, and both pool modules.

### Bot input tokens: keep the provider prompt cache, bound what is new (TOKEN-BURN)

Quotas are consumed by fresh (uncached) input and by output, and a provider cache hits only on a byte-identical
prefix, so rewriting a message that was already sent turns the rest of the context into fresh input. The bot
runtime (patches `16`, `25`, `26`, `27`) now bounds what is new and what is rebuilt, and rewrites nothing
in the middle of a session. Every setting is a key of the `context_economy:` block of the bot's `config.yaml`
(environment `HERMES_CONTEXT_ECONOMY_<KEY>` overrides it).

- **Not rewritten any more.** Superseded wake messages (A) and stale tool results (B) are no longer replaced in the
  request by default (`stale_wakes`, `stale_tool_results`: `false`). Measure A had also gone dead at the product
  rename (it recognised only the identity head from before the rename); it now recognises both heads, and a build
  check ties the patch to the adapter's wording. `skill_view` results and reads of skill files are never replaced
  when B is on.
- **New huge results are cut once, when they are produced.** A tool result of more than `tool_result_max_chars`
  (16000) is stored and sent as its first 8000 and last 4000 characters plus a marker with the path of the spill file
  holding the whole text and how to read the middle (`read_file` offset, byte offsets, or a filtered re-run).
  `read_file` stays pinned by upstream, `skill_view` is exempt (`tool_result_exempt`).
- **The compaction is cheaper and keeps the cached prefix.** The summary is asked for at most
  `compaction_summary_max_chars` (8000) characters with `compaction_summary_max_tokens` (6144) as the call's output
  limit; a summary that stopped on the output limit is kept (cut at a line end) instead of failing the compression;
  board wake packages are not quoted into the summarizer input or the verbatim user messages; the anchor index and
  the verbatim user messages are bounded; the system prompt and the tool schemas are not rebuilt at a compaction
  (`compaction_keep_prefix`), so the prefix after it is the prefix before it.

### An agent no longer wakes itself with its own PATCH or comment-time bookkeeping (TOKEN-BURN-H, OPE-12049)

- On 07.11 the `adm` bot spent ten empty runs an hour on itself: each run released its task, assigned it back to
  itself and got "Wake from own PATCH (issue_assigned)"; the server then echoed the run's final text as a comment after
  the run closed, and the next `swarm_matched` wake read that comment as new input from the "previous round".
- `PATCH /issues/:id` no longer queues the two task-state wakes (`issue_assigned` after an assignee change,
  `issue_status_changed` out of backlog/blocked/closed) when the PATCH is made by the assignee itself from its own run
  on this very task. The skip is narrow: the actor is the assignee and its authenticated run's `issueId` is this task.
  An agent working from a run on another task, a user, a system actor or another agent still wakes the assignee exactly
  as before; comment and mention wakes already had their own self guards. The shared assignment service
  (`queueIssueAssignmentWakeup`: create, child_create, accepted-plan decomposition, status cards, summary slots) does
  not skip: an agent legitimately creates tasks for itself and each needs its run.
- The rewake throttle (`swarm_matched`, `idle_pickup`, ...) no longer counts the woken agent's own activity as "new
  input since the last run", and no longer counts a run's own bookkeeping (task release, assignment back to itself, the
  `run_presentation_resolver` echo of the final text) as issue progress. A real comment, a status change, a hand-off to
  another agent, a document or a work product still count.

### Per-role default tool lists: unused tool schemas leave the bot's request (TOOL-DIET-ROLES, OPE-11947)

- Every tool schema is sent on every model call. In a sample of 28k real requests of 21 bots, tools that were called
  less than 0.5 times per 100 requests still made up 5.5% of all request characters (engineers 6.4%, bbq bots 8.2%).
- The fleet list `MYRMIDON_BOT_DISABLED_TOOLS` now also holds `clarify` (the bots run behind the Hermes API server, which
  wires no clarify callback, so the tool only ever answers "not available") and `skill_manage` (unused; while it is
  present Hermes also adds its prompt guidance and forks a background skill review after every ten tool iterations).
- New role defaults on top of it, resolved from the agent's role (caste key) and card, never from the bot's name:
  roles `engineer`, `reviewer` and `release` (instance-configurable) lose the built-in `memory` tool and the Hindsight
  tools (the `memory` toolset is written to `agent.disabled_toolsets`; owner decision 26.10), the web tools, the browser
  tools and the image/media tools; every other role loses the browser and image/media tools.
- A card is never overridden against its will: a group stays when the card lists its toolset in `toolsets`
  (`memory`, `web`, `browser`, `browser-use`, `browser-cdp`, `image_gen`, ...); the new card key `keepTools` re-enables a
  group or a single tool (`["memory", "skill_manage"]`); the card's own `disabledTools` list still replaces every
  default list.
- A changed `config.yaml` restarts the bot container.

### Compatibility assessment for Paperclip v2026.1001.0 ideas (1.6.6 planning)

- The five proposed upstream directions were checked against the Myrmidon tree and the
  current release work. The result is a staged adoption plan, not a blind vendor merge:
  - task handoff (upstream #13686) is compatible in principle, but must use the
    Myrmidon CAS handoff contract and preserve existing replay holds, wake guards and
    rollback recovery;
  - atomic native reviewer admission (upstream #13581) is not a direct port because
    Myrmidon already has review-path recovery, execution participants and interaction
    gates. It needs a separate adapter that claims the reviewer run, wake and issue
    lock together, while leaving child ownership unchanged;
  - queued Wait / Steer / Interrupt responses (upstream #13539) are compatible and
    already landed in the server and UI. Interaction receipts remain immutable and do
    not coalesce with comments or other card responses;
  - the channel-connector direction (upstream #13638) is compatible as an incremental
    migration. The connector contract, registry and hub land first, followed by
    observe-mode wiring and one Telegram topic at a time. The vendor chat service
    remains the fallback until each topic is proven;
  - one Myrmidon plugin registration is compatible with the route surface, but must
    preserve the existing mount order and keep pre-auth mounts and startup schedulers
    outside the registry. Connector fail-closed behavior is retained separately.
- The assessment found no schema migration or setting change required by this planning
  step. It records sequencing and compatibility constraints for the implementation PRs.

### Wake keys `pause_resume` and stranded auto-policy retry are now unique in the database

- Two racing resumes of a paused agent, or two stale-run sweeps reaching the same stranded
  issue, could each insert a wake with the same idempotency key and start a duplicate run.
  Migration `0401_wakeup_key_partial_unique_indexes` adds partial unique indexes on
  `(company_id, idempotency_key)` for `pause_resume:%` and
  `myrmidon.stranded_autopolicy_retry:%` wakes; terminal wakes (`skipped`, `failed`,
  `cancelled`) stay outside the predicate.
- The migration first repairs duplicates a live board already holds: the most meaningful
  run-backed wake keeps the key, run-backed or running duplicates are re-keyed with audit
  metadata and keep their status, and only duplicates that never acquired a run are
  marked `skipped`. Running work is never cancelled.

### Merge queue: CI checks the candidate commit on top of fresh main (MERGE-QUEUE)

- `.github/workflows/myrmidon-ci.yml` and `myrmidon-hot-files-review.yml` gained the
  `merge_group: types: [checks_requested]` trigger. `plan` and `tests-affected` diff
  `merge_group.base_sha..head_sha` — the PR's own diff on top of the fresh main — so
  `plan`, `typecheck`, `build`, `tests-affected` and `ci-result` run on the queue candidate
  exactly as they do on the PR, and the `main-protection` ruleset requirements hold.
- A `merge_group` CI run is never auto-cancelled (`cancel-in-progress` off for that event):
  a cancelled run would evict the group from the queue.
- For `merge_group`, `hot-files-review` only reports success on the candidate: review is
  enforced on the PR via the `review-approved` label, the queue must not block on it.
- New guide `docs/myrmidon/merge-queue.md` (en; [русский](merge-queue.ru.md)): the queue
  process, reviewer/steward roles, `gh pr merge --auto`, what to do when a PR leaves the
  queue; the guide is listed in `docs/myrmidon/README.md`.

### A bot's card key follows the container, not the secret's head (1.6.6 BOT-KEY-401)

- The agent card's `adapterConfig.apiKey` secret_ref is now pinned to the exact
  numeric VERSION of the bot's API-server-key secret whose value the applied
  profile's `.env` carries — never `"latest"`. A version bump of that secret
  (a rotation, e.g. the gateway-token maintenance) only reaches the card after
  a pass whose container switch SUCCEEDED: a compile whose apply then fails
  (dockergate refuses the recreate, the maintenance window closes, the driver
  is unreachable) no longer leaves the old container running with the old key
  while the card already resolves the new one — the board's run calls answered
  401 "API server rejected invalid API key" from exactly that gap.
- The pin travels in the profile's restart hash: a key rotation with no other
  change is itself a reason to recreate the container, so the next successful
  pass puts the new key INTO the container and re-pins the card right after.
- Cards written before this pin existed (`version: "latest"`) are re-pinned to
  the version the RUNNING container carries on the next pass; nothing to do by
  hand.

### Telegram moves out of the core into a channel connector: the design (1.6.6, step 1)

- The design document for release 1.6.6 is approved and recorded in
  [design/chat-channel-connector.en.md](design/chat-channel-connector.en.md)
  (Russian original: [design/chat-channel-connector.md](design/chat-channel-connector.md)):
  everything that knows about Telegram moves into a
  `server/src/myrmidon/channel-connectors/telegram/` connector behind a hub,
  and the vendor `chat-channels.ts` keeps exactly one of our inserts instead
  of today's 66 channel inserts. Connect, configure and disconnect happen in
  the existing Chat endpoints UI with no server restart.
- The owner decisions are fixed in section 11: one on/off switch for the
  whole channel; the shared writer-access layer lands right after the switch,
  in this release; bridge topics move from lower risk to higher risk. The
  move runs as six steps, one PR each, accepted on a production-DB copy.
- This step ships no code: no behavior, settings, or schema changes until the
  implementation steps land.

### Knowledge module part K-9: the evals gate of knowledge (KNOWLEDGE-2.0 K-9)

- New `server/src/myrmidon/evals/knowledge-gate.ts`: the lifecycle hook —
  `rule.approved` / `skill.promoted` / `page.published` opens a judge run for
  the item (`eval_run` with `subject_kind` + `subject_ref`), and a drop beyond
  the threshold, **confirmed by the repeat run**, calls `knowledge.rollback`
  and leaves a card for the owner postfactum. A hallucination — a criterion
  named after the failure or the promise (`hallucination`, `no-invented-…`,
  `fabricat…`, `made-up`) scored zero — rolls back at once, without spending the
  repeat.
- New additive migration `0314_evals_knowledge_gate.sql`: nullable
  `subject_kind` / `subject_ref` on `myrmidon_eval_runs`, so a run names the
  knowledge item it gated. Runs that are not gate runs leave both null.
- The knowledge journal now carries a `knowledge.eval_gate` line per judged
  publication with `eval_run_id`, `delta`, `verdict` and `owner_notice`
  (`KnowledgeModule.recordGateJournal`), so the quality page answers "which
  judge run gated this item, and by how much did it move the caste".
- Budget by construction: at most two judge runs per publication (first +
  confirmation) — the threshold's repeat is the last run.
- Tests: `knowledge-gate.db.myrmidon.test.ts` — the decision table (pure) plus
  the end-to-end acceptance on a synthetic rule over embedded Postgres: a
  deliberately bad rule rolls back within ≤ 2 judge runs, a good rule stays on
  one run, a hallucination rolls back on one run, and the journal carries
  `eval_run_id` and `delta`.

### Knowledge module part A: domain and store (KNOWLEDGE-2.0 K-1)

- New server module `server/src/myrmidon/knowledge/`: `domain.ts` (pure
  domain: the revision state machine, invariants, `[[slug]]` link grammar,
  the deterministic markdown tree format, the `SearchIndex` port), `store.ts`
  (create/draft/submit/publish/approve/rollback/archive/supersede, link
  resolution and backlinks, tree export/import, events), `service.ts`
  (composition over a `Db`), `index.ts` (module barrel).
- New additive migration `0313_knowledge_module.sql`: tables
  `knowledge_items`, `knowledge_revisions`, `knowledge_links`,
  `knowledge_sources`, `knowledge_suggestions`, `knowledge_events` and the
  `knowledge_search` read model, all keyed by `nest_id` (today equal to the
  company id). FTS: a generated `tsvector` column plus `pg_trgm` indexes
  behind the `SearchIndex` port; an IMMUTABLE wrapper around `unaccent` keeps
  the generated column legal. No triggers, no dialect SQL inside the module.
- New `packages/db/src/knowledge-search.ts`: the Postgres implementation of
  the port (lexical rank + trigram tolerance, delivered revisions only).
- A new draft never moves `delivered_revision_id`; publishing a revision that
  requires approval without approval fails with HTTP 422; `approve` by an
  actor that violates the approver rules fails with HTTP 403; `rollback`
  copies the target revision forward and moves the delivery pointer;
  export → import → export is byte-for-byte.
- Every mutation writes a `knowledge.*` event into `knowledge_events` and an
  `activityLog` row.
- Tests: `knowledge-domain.myrmidon.test.ts` (20 tests, incl. a 1 000-page
  tree round-trip under 300 ms p95) and
  `knowledge-store.db.myrmidon.test.ts` (17 tests over embedded Postgres with
  real migrations). HTTP routes arrive with K-2.

### 1.6.6 LONG-TASK-CONTEXT: an ever-running task no longer kills its run on context compression (OPE-6816)

- The runtime's compression timeouts (`Context compression timed out:
  approximately 214 298 / 378 739 tokens`, `Context compression timed out
  without reducing this conversation`) now match the context-window signatures:
  such a run drops the task session and leaves the agent idle, instead of
  landing the agent in `error` until a human resets the session by hand.
- Live settings `instance_settings.general.longTaskContext` (`enabled`,
  `resetPct`, `fallbackWindowTokens`, `historyChars`): a task session already at
  `resetPct` (default 70%) of the model window is dropped BEFORE the next run
  resumes it — compression up to the threshold, not after it — and the reset is
  named in the run's own context.
- The launch payload's task history is bounded by volume as well as by count:
  `MYRMIDON_CONTINUATION_HISTORY_CHARS` (24k) of message text in total and
  `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` (8k) per entry; entries that do not
  fit are dropped and referenced through the issue API instead of travelling
  with every run of the task.
- Guide: [guides/long-task-context.md](../guides/long-task-context.md).

### Alert recovery: the owner task of an alarm and the automatic close (1.6.6-MONITORING-D)

- An alarm from Zabbix or Alertmanager now becomes a task of the owning role
  instead of a thread of messages: the task carries the numbered recovery steps
  of the runbook of that trigger, the link to its document, and the metric the
  owner checks when the steps are done. A trigger with no runbook of its own
  falls back to the generic runbook, which still ships steps and a document.
- The runbook registry (`server/src/myrmidon/monitoring/alert-recovery/runbook.ts`)
  selects by trigger key: an exact trigger match first, then the longest matching
  fragment (`disk`, `filesystem`, `space` → `disk-space-low`; `unreachable`,
  `icmp`, `zabbix agent` → `host-unreachable`; `scrape`, `prometheus` →
  `metrics-scrape-failing`). The documents live in `docs/myrmidon/runbooks/` and
  a test fails if a registered runbook has no document on disk.
- The task closes by itself once the alarm has stayed resolved for the hold
  (10 minutes by default): the scheduler tick closes it, comments the metric and
  the resolve time, and only ever writes to tasks it opened itself
  (`originKind = alert_recovery`), so a task a person took over is never
  overruled.
- A repeat alarm inside the recurrence window (60 minutes by default) comes back
  into the same task — a comment, the task is reopened if it had already closed —
  instead of opening a second one. A repeat before the hold is up cancels the
  automatic close and the hold restarts from the next resolve. A resolve event
  that arrives twice does not push the close away.
- Both numbers are instance settings, changed live through
  `GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (PATCH is instance-admin,
  the same rule as the rest of the instance settings), stored in
  `instance_settings.general.alertRecovery`, read over the environment on every
  event and every sweep pass. The GET reports, per key, whether the settings row,
  the environment or the default is in force, plus the runbook registry and the
  alert journal of the company with the due time of every automatic close.
- An operator or the intake can drive a real alarm through the lifecycle with
  `POST /api/myrmidon/monitoring/alert-recovery/events` — the normalized event
  (source, trigger, status, severity, hosts, time) that the Zabbix/Alertmanager
  intake of the monitoring part produces once an alarm fires again or resolves.
- Every settings change is written to the activity log for every company
  (`instance.alert_recovery.updated`).

### 1.6.6 MONITORING E: service keys of the linking components and the "I am alive" self-check (OPE-4973)

- New board key scope `monitoring_link`: the narrowest key on the board. A
  linking component (Zabbix aggregator, Alertmanager webhook, collector) gets
  its own key that can only create a task, update a task and report its own
  liveness — never the shared operator key.
- `POST /api/myrmidon/companies/:companyId/monitoring/links/pulse` — the
  link's "I am alive". The key identifies the link; a 200 is the board
  answering "I hear you". The pulse is the key's own `last_used_at`, so a
  second heartbeat store cannot disagree with the first.
- `GET /api/myrmidon/companies/:companyId/monitoring/links` — the live feed
  (`keyState`, `lastPulseAt`, `pulseAgeSec`, `staleAfterSec`, `verdict`,
  `unhealthy`) that the Zabbix item and the operator read.
- Board-side watchdog: a revoked or expired key, or a link that stopped
  pulsing, raises **one High task** for the observability role and closes it
  with a comment when the link is back. A task closed by a human while the link
  is still blind is reopened.
- Detection budget: the default 480s silence threshold plus the 60s pass and
  the 30s scheduler tick put the worst case at 570s — inside the ten minutes the
  issue asks for. A key that dies on the fly is caught on the next pass.
- A link key is confined to the company it was issued for and no longer follows
  its owner user's membership list into other tenants; an unreadable stored
  scope degrades to `read_only` instead of widening to full operator access.

### Assignment wakes are suppressed for closed issues (PLUGIN-REGISTRY 2/3)

- Ported the vendor guard from paperclipai/paperclip #13738: assigning or
  re-assigning an agent on an issue whose status is `done` or `cancelled`
  no longer queues a heartbeat wake. The check runs once, centrally, in
  `server/src/services/issue-assignment-wakeup.ts`, so every call point is
  covered at once — issue create, child create, accepted plan decomposition,
  interaction accept, status-card and summary-slot generation, chat, routine
  and secret-proposal wakes.
- `backlog` suppression stays as before; an explicit reopen transition
  (done/cancelled → todo) still wakes the assignee because the wake carries
  the issue's new status.

### The board database ships pgvector, and a fresh install switches the extension on (CORPUS-2.0 step 4)

- The board database image is now `pgvector/pgvector:0.8.7-pg17` in both the
  installer's generated compose and `docker/docker-compose.yml`, replacing
  `postgres:17-alpine`. The module of the knowledge corpus keeps its embeddings
  in a `vector` column, so the extension binary has to be in the image the
  database runs.
- The binary alone is not enough: the installer now enables the extension in
  the board database right after the database becomes healthy and before the
  board starts, checks the version the database reports and prints it. A version
  other than `0.8.7` fails the installation instead of leaving a board whose
  corpus cannot index. Immediately after a fresh install
  `SELECT extversion FROM pg_extension WHERE extname='vector'` returns
  `0.8.7` — the same version as the pilot and the production cluster.
  Re-running the installer is unchanged: the step is idempotent
  (`CREATE EXTENSION IF NOT EXISTS`) and only runs on a fresh install.
- Boards already installed on `postgres:17-alpine` keep the old image until
  their operator enables the extension by hand: the runbook
  [runbooks/pgvector-extension.md](runbooks/pgvector-extension.md) covers both
  cases — an image that already carries pgvector (one `CREATE EXTENSION IF NOT
  EXISTS vector;` in the board database, no image or cluster swap) and a plain
  `postgres:17-alpine` (maintenance window, `pg_dump -Fc`, move to the pgvector
  image, restore; an in-place image swap of a running cluster is not allowed).

### The board's process composition is a setting: `general.processes` (PROCS-J)

- The composition of the board — how many HTTP processes (`api`) and how many scheduler
  processes (`worker`) a deployment runs — is now read at startup from the instance
  settings key `general.processes`. An absent key (the usual case) means
  `{ api: 1, worker: 0 }` — today's single process — so a deployment that does not set it
  starts exactly as before.
- A composition that cannot be read refuses startup instead of being guessed: counts that
  are not whole numbers `>= 0`, or a row that asks for no process at all
  (`api + worker < 1`), stop the board with the key, the values and the fix in the log.
- PROCS-1.1 (the mode and the per-role gates of the same feature) stores its own fields in
  the same row; the counts are read on their own, so neither part of the feature refuses
  the other's row.

### PROCS-1.3: inter-process bus over Postgres LISTEN/NOTIFY (OPE-5410 ч.A)

- New `server/src/services/process-bus.ts` — the single bus the
  multi-process board design (OPE-5394 §3) routes through: one
  `sql.listen` per channel over postgres.js (its connection re-LISTENs
  itself after a reconnect and the `onlisten` callback becomes the
  `onReconnect` catch-up hook for subscribers), `publish` via
  `pg_notify`, an `origin = bootId` on every message so a process drops
  its own, a `schemaVersion` stamp validated on receive, and a hard
  refusal of any payload above the 8000-byte NOTIFY limit
  (`ProcessBusPayloadTooLargeError`).
- Channels: `run_queued`, `run_control`, `settings_changed`,
  `live_event`, `secrets_changed`, `bot_apply_requested`,
  `leader_changed`, wire-named `paperclip_bus_<channel>`.
- Default behavior is unchanged: nothing constructs or starts the bus
  until a later task (dispatcher, settings appliers) wires it behind the
  process-role profile.
- Unit tests cover the origin filter, the reconnect catch-up, the
  payload limit, the schemaVersion drop, malformed payloads, and the T6
  lost-NOTIFY case: a dropped signal is picked up by the periodic
  fallback sweep, with no double start once the fast path works again.

### PROCS-1.5: readiness of every process and the aggregate `/healthz` (ч.F)

- New `GET /internal/ready` on the app root: a process answers about itself,
  `200` when it can take traffic and `503` otherwise. The body names the role,
  the boot id, the `at` timestamp and the three cheap checks:
  `database` (one `SELECT 1` through the existing pool, with a 1 s deadline so
  a wedged connection cannot hold the request open), `migrations` (the in-memory
  boot phase of startup recovery, which only reaches `ready` after migrations
  ran) and `bus` (the subscription flag the bus wiring reports).
- New `GET /healthz` on the app root for the load balancer. With the process
  supervisor wired in (PROCS-1.2) it answers `200` only when **all N** api
  processes are ready and the supervisor's own checks pass — the supervisor is
  the process that applies migrations, so its state gates the switch to split.
  `startingSplit` is `503` by definition; the `single`, `emergencySingle` and
  `drainingToSingle` lanes answer with this process's own readiness, because in
  those lanes this process serves the board itself. Without a supervisor — in an
  api child, and on today's single process — the answer is this process alone
  and the body says `scope: "process"`.
- The aggregate body carries the counts an operator needs
  (`api: { desired, ready, starting }`), the supervisor state, the
  `reason` (`all_api_ready` / `api_not_ready` / `split_starting` /
  `process_ready` / `process_not_ready`) and the same check list as
  `/internal/ready`. Both endpoints set `Cache-Control: no-store`, read no
  credentials and expose no company data.
- The `bus` check is `not_applicable` — never blocking — until a process
  reports a subscription, so the check cannot report a healthy board as unready
  before a deployment that uses the bus exists. `bindProcessBusReadiness` wraps
  a bus so the flag turns on only after `start()` resolved and off before
  `stop()`.
- `createApp` takes an optional `processSupervisor` view; the split wiring of
  PROCS-1.2 passes it — or registers it once with `registerProcessSupervisor`,
  which the routes consult per request, because the split starts after the app
  is built. Default behaviour is unchanged: nothing new starts, and a
  process with no supervisor answers `/healthz` from its own checks.
- Unit tests cover the whole aggregate decision table (all lanes, the draining
  child, the N-th api still starting) and the route status codes and bodies of
  both endpoints. No process is spawned and no database is needed: the checks
  are injected, so the existing e2e harness of ч.C stays the only place that
  boots real processes.

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part A — server)

- A resolved interaction card (accept / answer / reject) submitted while the
  agent's run is active is now projected into the issue message queue as one
  immutable queue entry (`source.kind = "interaction"`): it cannot be edited,
  discarded or reordered, and the exact saved decision (selected options,
  approval revision) is what gets delivered.
- Delivery is explicit: ordinary run completion promotes the saved response
  (Wait), an explicit queue Steer delivers it into the compatible native turn
  with interaction provenance, and Interrupt stops the current turn and starts
  a fresh continuation — required for card answers that force a fresh session
  (e.g. plan approvals), which can no longer be steered.
- Answers to older questions no longer steer a different active run
  implicitly: the implicit steer path in question-response-delivery was
  removed (vendor PR #13539 behavior). A provider blocked on its own native
  question request still resolves that request directly.
- Anti-reassign guard: a card resolved by the finishing run — or a queued card
  response waiting for that agent — is a live review path, so an agent can no
  longer hand its issue back and orphan the owner's accepted response. The
  continuation wake is awaited (not fire-and-forget) before the queue projects
  it, and interaction receipts never coalesce with comments or other cards.

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part B — UI)

- The task-chat message queue now recognizes queue entries projected from a
  resolved interaction card (`source.kind = "interaction"`): such an entry is
  immutable — its drag handle and actions menu are disabled, no edit or
  discard is offered, and the row shows the first line of the saved response
  as its label.
- A fresh-session card answer (`source.requiresFreshSession`, e.g. a plan
  approval) or any entry on the legacy protocol offers Interrupt only; other
  interaction entries keep the Steer / Interrupt pair of the current
  steering rules.
- While an immutable interaction entry sits in the queue, reordering is
  frozen: a reorder request returns no change and positions are not
  rewritten.
- Normal queue behavior for ordinary comments (edit, discard, reorder, Steer
  / Interrupt rules) is unchanged; regression and interaction scenarios are
  covered in `ui/src/lib/issue-queued-comment-queue.test.ts` and
  `ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx`.
- Ported from upstream Paperclip PR #13539 (commit d0b67bfe7), marked with
  `myrmidon(UPSTREAM-13539)` in the touched code.

### A wake guard now also checks the issue version: a stale delivery no longer starts a turn (1.6.6 UPSTREAM-HANDOFF, part B)

- `issueStateGuard` gained the vendor's optional `statusVersion` (vendor PR
  #13686, commit `d82fbb0f`): a wake enlisted for an issue is admitted only
  while the issue still carries the version the wake was built for, so a
  delivery that waited behind a running turn and arrives after one or more
  later handoffs is dropped instead of starting an extra turn.
- The board's own queued-comment delivery now records the version it saw, and a
  dropped wake names `expectedStatusVersion` / `actualStatusVersion` beside the
  status and the assignee it already reported.
- A guard without the version keeps the previous behaviour, so every existing
  guard site stays unaffected.

### Channel allowlist — who may write to the bots (CA-A, OPE-4949)

- New general-channel-layer mechanism, not Telegram code: the board keeps a
  list of admitted channel writers. Admission is by the channel identity
  (numeric Telegram id, matched case-insensitively by @username too) — a
  board account is NOT required (owner clarification 06.10); when a person
  does have one, the row may store the link. One row covers all bots of the company
  or one specific bot endpoint; revoked rows never admit and stay for audit.
- New instance channel setting `channelAccessMode`
  (`MYRMIDON_CHANNEL_ACCESS_MODE`, default `sponsor`): `sponsor` keeps the
  vendor guest-sponsorship path byte-for-byte, `allowlist` makes the board
  list the sole decider for unlinked writers (linked members are untouched).
  Read live per message — a toggle applies without a restart.
- A writer whom neither mechanism admits is not served: their message does
  not execute, they get one refusal line without details, and the owner (or
  the admin tier, then operator — Part C adds a designated admin) receives a
  board access-request card with the channel identity needed to admit. One
  card and one notice per sender per UTC day; every refusal is journalled
  (`channel_allowlist.access_requested`).
- Board screen «Who may write to the bots» (Settings → Channel allowlist,
  `/company/settings/channel-allowlist`, EN+RU): mode select, admitted list
  with scope and revoke/restore, add-a-person form. API
  `/api/myrmidon/channel-allowlist` (GET/POST/PATCH, board-only, audited).
- Rights on the writer, the approve/deny buttons on the card, and the
  per-message audit marking arrive in the follow-up parts of OPE-4949 (B–D).

### Project token quotas: limits, usage counters, enqueue-time refusal (QUOTA-V2, OPE-6877)

- `packages/db/src/schema/project_token_quotas.ts` — the `project_token_quotas`
  table: one row per project (company scoped) with `daily_token_limit` /
  `weekly_token_limit` (null = that window is unlimited), the running
  `daily_tokens_used` / `weekly_tokens_used` counters, and the
  `daily_window_start` / `weekly_window_start` stamps that say which window
  each counter belongs to. Migration `0312_project_token_quotas` (additive:
  one table, two indexes).
- `packages/shared/src/myrmidon-project-token-quota.ts` — the shared contract:
  `projectTokenQuotaSchema` (PUT body: both limits at once, null = unlimited),
  `ProjectTokenQuota`, `ProjectTokenQuotaBlock`, the stable
  `PROJECT_TOKEN_QUOTA_EXCEEDED` code, and
  `projectTokenQuotaRejectionMessage()` — the code first, then a readable
  sentence (project, window kind, used-of-limit, when it resets).
- `server/src/myrmidon/project-token-quota/service.ts` — read/upsert/status
  (upsert validates weekly >= daily, rejects lower), the enqueue check
  `getProjectTokenQuotaBlock()` (no row / null limits = pass; daily checked
  before weekly; a counter from a previous window reads as zero), and the
  cost-event hook `recordProjectTokenUsage()` that folds run tokens into the
  counters and rolls the window columns over.
- `server/src/myrmidon/project-token-quota/routes.ts` —
  `GET /api/myrmidon/companies/:companyId/projects/:projectId/token-quota`
  (any company member: quota + live counters) and `PUT` (instance admin,
  validated body).
- Enqueue gate: the heartbeat run-enqueue path checks the quota after the
  budget gate; an over-limit project refuses the run with 409 +
  `PROJECT_TOKEN_QUOTA_EXCEEDED`, a skipped-request event
  (`project.token_quota_exceeded`) and the readable reason. Usage is recorded
  when the run's cost event is attributed to a project.
- Windows: daily = the UTC day, weekly = the ISO week (Monday 00:00 UTC) —
  the same anchors the heartbeat daily cap uses.
- Tests: `project-token-quota.myrmidon.test.ts` (windows, token arithmetic,
  body validation, enqueue-check decisions incl. window rollover, usage-hook
  set, refusal message) — no database, per the `*.myrmidon.test.ts` style.

### CONNECTORS S1: the channel connector contract, registry and hub (1.6.6)

- New `server/src/myrmidon/channel-connectors/` module. `contract.ts` fixes what
  one channel connector is — lifecycle (`start`/`stop`/`status`), links
  (`conversationKey`/`conversationUrl`/`route`/`bind`), inbound
  (`normalize`/`admit`/`intakeMedia`), outbound (`plan`/`send`), the media
  limits and settings (`keys`/`resolve`) — and it reaches the data only through
  one seam (`ChannelConnectorStore`), so no connector writes SQL of its own and
  every method takes an explicit context instead of module state.
- `registry.ts` — `registerChannelConnector(provider, factory)` and
  `getChannelConnector(provider, deps)`. A provider with no connector answers
  `null` and stays on the vendor path.
- `hub.ts` — `myrmidonChannelConnectorHub(db, deps)` routes inbound, outbound,
  lifecycle and settings by `endpoint.provider`. An unregistered provider, an
  unreadable endpoint and a connector that throws all pass through without
  decisions (fail-open, journaled).
- Default behaviour is unchanged: no connector is registered and no vendor file
  is touched, so the running board sends and receives exactly as before. The
  watchdog tests cover the contract structure, the registry and the hub
  routing.

### 1.6.6 SETTINGS-UI B: the bot-disk lifecycle screen, the agent daily caps (OPE-6258)

- Settings → instance now edits the whole `general.botDisk` object: alongside the
  cache/runtime fields the panel gained the lifecycle section — the sweep switch,
  the draft TTL, the mirror refresh interval, the shared-cache roles and the five
  workspace-lifecycle numbers (closing grace, scratch TTL, the three partition
  percents). Before this part a PATCH of any key silently dropped those five from
  the stored object; they now validate, merge and audit like the rest, and GET
  reports the value in force per key. New read routes power the screen:
  `GET /api/myrmidon/bot-disk/physical` (relays the dockergate C5 disk answer —
  partition, per-bot quota/used, no gate configured is a 200 with "no data",
  never an error) and `GET /api/myrmidon/bot-disk/reports` (the stored C4 per-bot
  reports with the board's receive time); `POST /api/myrmidon/bots/me/disk-report`
  (contract C4, implemented in 1.6.5 but never mounted) is mounted now.
- The agent card's Run Policy section gained the fields the heartbeat engine has
  always read: Max runs per day (`runtimeConfig.heartbeat.maxDailyRuns`), Max
  daily cost in cents (`maxDailyCostCents`) and the Skip-timer-when-no-actionable-work
  switch (`skipTimerWhenNoActionableWork`). 0 or empty in the cap fields means
  "no limit" — stored as `null`, never as `0` (a stored 0 blocks every run).
- Input limits: verified covered, no new UI — the prompt input budget is the
  model's `maxInputTokens` window with the warn/crit percents already editable
  in PromptBudgetSettingsPanel (1.6.3 PROMPT-BUDGET B); no env-only input-limit
  knob exists in `server/src/myrmidon/prompt-budget`.

### Review-wait cancellations no longer create execution holds (CONTINUATION-WAIT-HOLD)

- A legacy continuation cancelled while waiting for reviewer feedback or an
  unresolved response no longer creates `legacy_execution_requires_reconciliation`.
- The task therefore remains eligible for the normal idle-pickup path instead of
  requiring an operator to clear a hold for a provider that never started.

### The knowledge corpus has a screen (1.6.6 CORPUS, part E — web)

- Company Settings has a new **Knowledge corpus** section
  (`/company/settings/corpus`): the module switch, the settings of the module
  (address of the document-parsing service, embedder model, upload, document and
  chunk limits) and the datasets with their documents and a trial search.
- The settings are written back as one object, so fields the screen does not
  edit survive a save. The whole object is read back after a save instead of
  being assumed.
- Datasets can be created and deleted; each dataset lists its documents with the
  parse status (`queued` / `parsing` / `embedding` / `ready` / `failed`). While a
  document is still moving the list refreshes itself, so `ready` appears without
  a page reload. A file can be uploaded, a `failed` document retried and any
  document deleted.
- Trial search runs a query over the open dataset and shows the top-k chunks with
  their score and the document they came from.
- With the module switched off the screen says so and offers no parsing,
  embedding or search; a server that does not serve the corpus routes at all
  shows the screen as unavailable.

### Fleet dashboard data from VictoriaMetrics + Zabbix (1.6.6 MONITORING C)

- `GET /api/myrmidon/monitoring/dashboard` aggregates one fleet snapshot:
  host cards (CPU / memory / swap / disk percent) from VictoriaMetrics
  (node_exporter PromQL, VM wins per host) merged with Zabbix `host.get` /
  `item.get` readings, bot container usage (cAdvisor), the LiteLLM proxy
  rollup and the build-VPS rollup; every host card carries a `runbookKey`
  for the "create task with runbook" CTA of the fleet screen.
- Connection settings live under `GET/PATCH /api/myrmidon/monitoring`
  (instance-settings pattern): VM / Zabbix addresses, `env:`/`file:` token
  references and the VM job selector. Secret values are never returned and
  never logged; both sources are read-only (instant queries, `apiinfo.version`,
  `host.get`, `item.get` — no writes).
- `GET /api/myrmidon/monitoring/dashboard/selfcheck` probes every configured
  source and answers `{ok, vm_ok, zabbix_ok, sources:[{name, ok, latency_ms}]}`
  without any secret material.

### Asymmetric debates engine (DEBATE-ASYM A)

- The board runs a structured disagreement about a task question between
  models of different families: a generator (constructive pole), a critic
  (adversarial pole, told it is penalized for a missed error), and a judge
  outside the dispute (a third family). The first answers are independent —
  neither debater sees the other's before the exchange starts. At most three
  rounds; the exchange stops early when the critic writes the `[AGREE]`
  marker, or when the total token ceiling is reached (a call that crosses the
  ceiling is recorded but not charged). The result — positions, the judge's
  verdict and the cost per role — lands on the task as a `debate-result`
  document, and the spend is written as task-level cost events, so the budget
  enforcement (BUDGET-CONFIG) sees it.
- The role configuration is live: `GET`/`PATCH /api/myrmidon/debate/settings`
  and Instance → General → "Asymmetric debates" (board reads, instance admin
  writes, the source of the value shown). A symmetric configuration (both
  debaters from one family, or the judge sharing a debater's family) is
  refused with the exact reason; `MYRMIDON_DEBATE_CONFIG` is the forced
  environment override only while nothing is saved.
- Start a debate for a task: `POST /api/myrmidon/companies/:companyId/debates/
  issues/:issueId/run`. The board runs it directly; an agent caller is gated
  on the `spend_above_threshold` class of the autonomy matrix (a debate
  spends gateway calls) — forbidden answers 403, approval_required answers 403
  with the approval code. Models default to free ones: qwen generator, glm
  critic, deepseek judge. The gateway contour falls back to the evals one
  (`MYRMIDON_EVALS_BASE_URL` / `MYRMIDON_EVALS_KEY_SECRET`) when the debate
  variables are unset.
- Model families come from one extensible table (the same rules
  EVALS-JUDGE-FAMILY introduced), so the cross-family check answers
  "which family is this model" identically in both contours.

### UI copy debranded: visible "Paperclip" strings renamed to Myrmidon (DB1)

- All user-visible "Paperclip Cloud"/"Paperclip Labs"/"Paperclip EE"/"Paperclip Enterprise" strings across the web UI (pages, components, connection flows, OAuth handoff errors, placeholder examples) now read "Myrmidon …". Locales en/ru and the shared locale catalogs were swept in every language; MIT attribution lines (`about.base`, `about.attribution`) are untouched verbatim. Wire identifiers (`paperclip.*.v1` localStorage keys, adapter types, `paperclip_vault`, `X-Paperclip-*`, `@paperclipai/*`) keep their names until DEBRAND part c / stage 4.
- The branding-guard test (`ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts`) tightened to a bare `\bPaperclip\b` scan: the vendor-product-word exceptions (Cloud/Labs/EE/Enterprise) are removed from its allowlist, so any new visible "Paperclip …" copy fails CI.

### Corpus knowledge module core: ports, domain, migrations, PostgreSQL store/queue (CORPUS-A)

- `packages/corpus` (new, MIT) — the knowledge corpus module core: pure domain
  model and company-scoped ports (CorpusStore, SearchIndex, WorkQueue,
  BlobStore, DocumentParser, Embedder) plus PostgreSQL implementations of the
  store, the parse-job queue (idempotent on document+parser version, retries
  with backoff) and per-company settings, and a local-directory blob store.
- `packages/db` — additive migration `0309_corpus_module`: `corpus_datasets`,
  `corpus_documents`, `corpus_chunks` (pgvector `vector(1024)` with HNSW
  m=16/ef_construction=64, generated `tsvector` FTS with GIN, trigram GIN),
  `corpus_parse_jobs`, `corpus_settings`; requires `vector` and `pg_trgm`
  extensions (created by the migration itself).
- Tests: store/queue lifecycle on embedded PostgreSQL 18 with pgvector
  (queued → parsing → embedding → ready, enqueue idempotency, failed-job
  re-queue), domain invariant tests, local blob store tests.

### Knowledge corpus, server side: REST API, the instance block and the parse sweep (CORPUS-2.0 C)

- The board now serves the knowledge corpus over HTTP: datasets (`GET`/`POST`
  `/api/myrmidon/companies/:companyId/corpus/datasets`, `GET`/`PATCH`/`DELETE`
  `…/datasets/:datasetId`), documents (`GET`/`POST
  `…/datasets/:datasetId/documents`, `GET`/`DELETE …/corpus/documents/:id`) and
  search (`POST …/datasets/:datasetId/search`, a proxy to the `SearchIndex`
  port), plus `GET …/corpus/stats` for the screen counters.
- `corpus` is an additive block in `instance_settings.general`: eleven fields
  (module switch, parse-service base URL and timeout, embedder model /
  dimensions / base URL, document and dataset limits, parse concurrency and
  attempts, search top-K). An environment variable is the default at first
  start; afterwards the stored block is the truth, and every save writes one
  activity row per company naming the changed keys.
- The parse worker is a board sweep: it claims queued jobs, parses through the
  parser port, indexes the chunks and settles the document `ready`; a failure
  requeues the job until `maxParseAttempts`, then marks the document `failed`.
  A disabled module — or a process without wired ports — makes the pass a
  no-op, and the API answers 503 instead of pretending an empty corpus.

### Agents can resolve their own interaction cards on automation runs (1.6.6 OPE-6547)

- Accept/reject/respond/verdicts on an issue-thread interaction (`POST
  /api/issues/{id}/interactions/{interactionId}/...`) no longer require the run
  named in `X-Paperclip-Run-Id` to record the same responsible user as the agent
  API key that authenticates the call.
- Automation (heartbeat) runs record the issue's responsible user, a steering
  comment's author, or the company default — a service account — while a key is
  issued to a person, so every key-authenticated resolution was rejected with
  422 `interaction_run_attribution_required` and agent `request_confirmation`
  cards stayed pending forever.
- The gate keeps its real checks (the run exists, belongs to the same company
  and to the authenticated agent); who may resolve is still decided by the
  resolver audience (addressee, creator exclusion, human-only, governed
  actions), as it already was for the withdraw route.

### Plugin registry: connectors stay fail-closed by default; the agent permission-mode selector is pinned to three modes (PLUGIN-REGISTRY 3/3)

- Connector fail-closed properties (upstream #13758 pattern) are now pinned by
  tests in `server/src/__tests__/bundled-plugins.test.ts`
  (`describe("connector fail-closed properties")`):
  1. A self-hosted instance with no managed config auto-installs exactly
     `SELF_HOSTED_AUTO_INSTALL_KEYS = ["kubernetes"]`; the other six catalog
     entries (cloudflare, daytona, e2b, exe-dev, modal, novita) are never
     installed or loaded implicitly — not via `installPlugin`, not via the
     lifecycle loader, not even via a registry query.
  2. `ensureBundledPlugins` can never deinstall anything: the provisioner
     dependency surface exposes no uninstall/unload/remove capability, and
     with every connector already present, ensuring only `kubernetes`
     produces zero registry writes, zero lifecycle calls, and queries only
     its own key. Removing a connector or plugin record stays an explicit
     operator action in the plugin registry UI/API. No entitlement behavior
     changed: the myrmidon(PLUGIN-ENTITLEMENT C) gate in the plugin loader
     remains the only intersection point and was left intact.
- The agent card's "Permission mode" selector maps onto the three existing
  `permissionMode` values only: `approve-all` (full auto), `approve-reads`
  (restricted, the ACPX default), `deny-all` (forbidden). The operator-facing
  ACPX labels were renamed accordingly ("Allow Paperclip reads" →
  "Restricted (approve reads)", "Deny all" → "Deny all (forbidden)"); the
  runtime values are unchanged. The vendor's fourth mode
  (`approve-paperclip`) is deliberately not offered — it names vendor tools
  that do not exist in Myrmidon, and any such unknown value still fails
  closed to the provider default.
- Conscious Myrmidon defaults stay untouched: ACPX `approve-reads`, OpenCode
  `ask`, Codex `never`.
- The selector's hint now states explicitly that the chosen mode cannot
  relax the myrmidon(1.6-AUTONOMY) role × action-class gate: that server-side
  gate is stronger than any UI mode and denies or holds actions
  independently of this setting.

### Auto-update of auto-merge PRs without a GitHub merge queue (PR-AUTOUPDATE)

- `.github/workflows/myrmidon-pr-autoupdate.yml` — on every push to `main` (and
  every 30 minutes, and by hand) merges `main` into the oldest open PR that has
  auto-merge on and is behind `main`, then dispatches CI and `hot-files-review`
  on the new head. PRs in conflict get the `needs-rebase` label and a comment.
- `myrmidon-hot-files-review.yml` accepts `workflow_dispatch` with the PR number.
- The `main-protection` ruleset requires PRs to be up to date before merge.

### Board processes: the process registry and the «Processes» panel (PROCS-0.1)

- A board process now says that it is alive. The new table `board_processes` holds one row per
  running process — boot id, role, pid, host, container, version, start time, last pulse, api port
  and the measurements of the last pulse (event-loop lag and RSS). The boot id is a random UUID per
  process, exactly like the controller boot id, because a pid and a hostname survive neither a
  container restart nor a filename collision.
- Every process refreshes its own row every 10 seconds; rows older than two minutes are reaped by
  the process that owns the background timers. This is the fourth brick of the multi-process project
  (design §5.1): the split cannot be argued without a place that says which processes exist and
  which of them still answer, and ownership checks ("is the owner of this row alive?") need exactly
  this row.
- Instance → General carries the «Processes» panel: role, boot id, pid/host/container, api port,
  version, uptime, the age of the last pulse, the loop lag and the RSS of each process, with the
  process that answers the request marked as "this process". The panel polls at the pulse cadence,
  so a process that stops answering turns amber within one tick — no restart needed. A warning
  appears while this very process has no row of its own yet.
- `GET /metrics` answers one more family: `myrmidon_board_event_loop_utilization`, the share of the
  event-loop window the process was busy (0..1), from `performance.eventLoopUtilization`,
  read-and-reset so the number describes the interval between scrapes.
- The container name of a process is the container id Docker writes into `HOSTNAME`; the deployment
  setting `MYRMIDON_PROCESS_CONTAINER` overrides it when the operator's own container name is the
  one to show (the split layout of T1.1). Unset — the runtime name is used.
- The default mode does not change: with `mode=single` the one process writes one row with role
  `all` and does the reaping itself, so the behaviour of the board today is exactly what it was.
  Roles `worker`/`api` of T1.1 arrive with the same table and the same pulse; an `api` child writes
  its row and deletes nothing.

### The release cut cannot forget the changelog version section (RELEASE-CUT-CHANGELOG)

- On 05.10 the `myr-v1.6.3` tag was pushed without a `## 1.6.3` section in
  `docs/myrmidon/CHANGELOG.md` — the notes still sat under `## Unreleased`
  and the release publish refused with "release body could not be built
  (missing notes)"; the release page was published by hand. The cut step now
  fails before that can happen again.
- `node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z`
  verifies the collected changelogs before writing anything: a non-empty
  `## X.Y.Z` section and an empty `## Unreleased` / `## Без выпуска`, in EN
  and RU alike. A cut that would not pass CI fails locally.
- The new `--check` mode is the CI gate of a release tag:
  the `checks` lane of `myrmidon-ci-tag.yml` (the tag CI) fails
  a tag whose commit has no version section (or leftovers in the unreleased
  heading) — the tag is red before the image build and the release publish
  start.
- Guard tests: `scripts/myrmidon/release/collect-fragments.test.mjs` (the
  1.6.3 tag state fails, the 1.6.4 tag state passes, a non-empty unreleased
  section fails, an empty version section fails).

### Review routing: pull-request events and merge steward settings UI (REVIEW-ROUTING PR-events UI)

- The Review routing settings screen gains a "Pull request events" section: a
  toggle for creating review tasks from green pull requests, a `owner/repo`
  list editor (empty — every repository the board sees), limits for open
  reviews per reviewer and new assignments per pass, and the poll interval.
- A "Merge steward" sub-section edits the steward toggle, its caste roles
  (comma-separated) and its per-pass merge limit; the role and limit inputs
  disable while the steward is off.
- The screen reads and writes the settings through the existing review-routing
  settings API with full-object semantics: the PUT preserves every key the
  screen does not own. Client-side validation rejects malformed repository
  entries and out-of-range numbers before the save is sent.
- The `prWatch` block is sent only when the loaded settings already carry it
  (the server schema is strict, so a pre-PR-lane server would reject the key
  with 400): against such a server the "Pull request events" and "Merge
  steward" sections stay hidden and the task-lane save works unchanged. The
  client-side `owner/repo` validation mirrors the server's repository pattern
  exactly (`[A-Za-z0-9_.-]+` halves).

### Settings UI: attention feed windows screen (SETTINGS-UI C-4)

- The attention feed windows are editable from the instance settings: a new
  "Attention feed" panel edits how far back the feed looks for an unresolved
  failed or timed-out run (1–365 days, default 7) and how long it reuses the
  feed it built per company (0–300 seconds, default 45; `0` turns the cache
  off). The panel shows the bounds and the built-in default of each field, and
  marks whether the value in force comes from the saved settings row or from
  the default.
- The panel reads and writes through `GET`/`PATCH
  /api/myrmidon/attention-feed`, backed by the instance settings row
  (`attentionFailedRunHorizonDays`, `attentionFeedCacheTtlSeconds` in the
  general block). A save is a partial write: only the window the operator
  changed is written, and the change is audited per company. The feed picks the
  new value up on its next build — no restart. Neither window has an
  environment variable, so the stored row (then the built-in default) is the
  only source; a hand-edited value that is not a whole number within the bounds
  reads as the default, the same fallback the feed itself applies.
- The two windows are the stored keys introduced by the ATTENTION-WINDOW-CACHE
  change; this screen is their operator entry point, and the keys are defined
  once in `packages/shared/src/myrmidon-attention-feed.ts` so the feed, the
  route and the screen cannot drift apart.
- The panel is mounted in the instance general settings next to the other
  myrmidon panels; the other attention behaviours (the `AUTO-RESUME` and
  `EXECUTION-HOLD` attention passes) keep their own screens and are untouched
  here.

### Settings UI: document signing re-enable on the Browsers page (SETTINGS-UI C-3)

- The Browsers settings page now shows whether document signing is on. The
  block reads the bridge settings (`GET /api/myrmidon/browser-bridge/settings`)
  and says either that signing is on and the bridge signs under the policy of
  the connector panel, or that an emergency stop turned it off and every sign
  action is refused until it is turned back on.
- While signing is off, the block offers "Re-enable signing": the button opens
  a confirmation step first, and only the confirm writes — `PATCH
  /api/myrmidon/browser-bridge/settings` with `signing.enabled: true` plus the
  mode, types and daily limit that are stored right now, so a re-enable never
  rewrites the signing policy behind the operator's back. Cancel closes the
  step and writes nothing.
- The stored settings are re-read after a successful write, a write in flight
  disables the confirm and the cancel button, and a failed write is reported in
  the block while the displayed state stays as read.
- This is the operator counterpart of the kill switch in the connector panel
  (`POST /api/myrmidon/browser-bridge/signing/disable`), which until now could
  only be undone by hand-editing the instance settings row. Nothing on the
  server side changed: the settings `PATCH` already accepted `enabled: true`,
  and the bridge keeps auditing the change of `enabled` exactly as before.
- The block stays on screen while the browser registry is loading or has
  failed, so a stopped bridge is visible on the page even when the registry
  cannot be read; a failed read of the bridge settings is shown inside the
  block and does not take the registry down with it.

## 1.6.5

### `/agents` in Telegram answers with buttons (1.6.5 F-07 part B)

- `/agents` in the owner's bridged Telegram chat now opens the company's directions as buttons, each with the count of its live agents. A direction opens its agents (ten to a page, "More" for the rest), and an agent opens its own card with three actions: **Write to this agent** (the same effect as `/to <alias>`: the chat's default addressee becomes that agent), **Model** (the model this chat uses for that agent and the choices it has) and **Stop** (stops that agent's runs in this chat only). Paused, retired, service and terminated cards are not listed.
- `/agents text` keeps the plain grouped list for a client without buttons.
- The buttons work for ten minutes and only for the owner of that Telegram conversation; a stale button answers "send /agents again", another person's click changes nothing. Button and message texts follow the chat owner's language (en/ru catalogs).

### Racing "Apply now" presses no longer leak a wrapped unique violation (1.6.5 CI-RACE)

- When two POSTs raced for one bot, the loser of the `bot_apply_jobs`
  live-job unique index hit the database rejection and re-read the winner's
  row — but only when the error reached it as a plain Postgres error. Drizzle
  wraps driver failures in its own `Failed query: ...` error and the SQLSTATE
  code lives on `cause`, so the local copies of `isUniqueViolation` in
  `server/src/myrmidon/bot-containers/apply-jobs.ts` and
  `scope-wiring.ts` — which read only the top-level error — missed it and
  re-threw. The flake surfaced as a red CI on `rel/1.6.5-rc.7`
  ("two racing acquires of one bot end with one job and one creator").
- Both copies are deleted; the modules now import the canonical
  `isUniqueViolation` from `server/src/db-errors.ts`, which unwraps the
  `cause` chain (same helper the swarm-claim store and recovery service
  already use, covered by `server/src/__tests__/db-errors.test.ts`).
- Call-site behaviour is unchanged everywhere: losers still hand back the
  winner's row (`created=false`), scope-group conflicts still answer
  `null` / `"name-taken"`.
- Guard: `server/src/myrmidon/bot-containers/apply-jobs.myrmidon.test.ts`
  gains a deterministic test — a proxy over the real database throws the
  drizzle-wrapped 23505 exactly once (after the winner's row lands for
  real) and the store must return the winner instead of raising. Red on
  the old code, green on the fix.

### An agent can no longer bounce a task into blocked forever (BLOCKED-LOOP, 1.6.5)

- Every return to `blocked` is legal on its own and rewrites
  `blockedTransitionAt`, so a task whose agent re-blocked it again and again
  on a condition the board does not model woke the agent again and again.
- Now an agent that returns a task to `blocked` more than
  `MYRMIDON_BLOCKED_LOOP_MAX_RETURNS` times (default 3) in a row with the same
  blocker set and the same `unblockDescriptor` gets `422` with
  `code: "blocked_loop_limit"`; the message says to express the external wait
  with an issue monitor (`executionPolicy.monitor.nextCheckAt`) or
  `unblockDescriptor.reasonRef` kind `event`/`date`.
- The streak is reset by a change of the blocker set, a different
  `unblockDescriptor`, any action of a person, or a move of the task to
  `done`, `cancelled` or `in_review`. Board and other human actors are never
  limited. A rejection is recorded as the activity `myrmidon.blocked_loop.rejected`
  (streak, limit, task identifier) so the lead can see it.

### Bot disk: integration test of the whole mechanism and the canary / shutdown runbook (1.6.5 BOT-DISK-H)

- New `scripts/myrmidon/bot-runtime/bot-disk-integration.test.mjs` runs the botd
  loop, rules, archive module and the `myr-ws` inventory/close/restore together
  on real git: closing grace, clean-pushed removal, archive before removal of
  unpushed work, restore, fail-safe with the board down, orphan grace, drift
  prune, and a failing archive that keeps the copy.
- New runbook `docs/myrmidon/bot-disk-canary-runbook.md` (with a Russian
  version): what the test covers and what only a stand can, the canary on three
  development bots with its measurements, the stop switch, and the shutdown of
  the host-side cleanup scripts with preconditions, rollback and the 14-day
  deletion check.
- Fix: `myr-ws restore <KEY>` works after `myr-ws close` without a manual re-open. `close` passes the repository to the archive (it is stored in the manifest entry) and `restore` reads it from there when the registry has no entry.

### The bot image rollout script follows the async "Apply now" (BOT-IMAGE-ROLLOUT)

- Since 1.6.5 `POST /api/myrmidon/agents/:id/bot-container/apply` answers 202
  with `{applyId, status}`. `bot-image-rollout.sh` read `.outcome.kind` from that
  answer, found none and reported every bot as FAILED while the containers were
  switching in the background (the rc.12 rollout, 08.10).
- Now the script polls `GET .../bot-container/apply/:applyId` until
  `succeeded|failed` (at most `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC`,
  default 300, every `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC`, default 4).
  `failed` fails the bot with the job's error in the journal; a timeout is
  "deferred" (the sweep finishes it). The bots of a batch are therefore switched
  one after another again.
- `succeeded` is not taken as proof (a busy bot's deferred pass is recorded as
  succeeded): the bot counts as switched only when
  `GET .../bot-container/status` shows the container running on the release
  image, otherwise it is deferred and retried. The old synchronous answer
  (`outcome.kind`) is still understood.

### The bot image rollout ends with a card-vs-container fact check and a standard deferred re-run pass (BOT-IMAGE-ROLLOUT)

- After the switch loop `bot-image-rollout.sh` now verifies the FACT for every
  tracked bot: the image in the agent card (`adapterConfig.container.image`)
  against the image of the running container (`GET
  /api/myrmidon/agents/:id/bot-container/status`, the same board API the script
  already uses; the rollout host is the container host). A printed per-bot
  table classifies every bot `switched | deferred(<reason>) | failed |
  mismatch` and the rollout summary JSON gains `verdict` plus the per-bot
  verification rows, so `deploy.sh` and the operator see the fact, not the
  intent.
- Exit rules follow the fact, not the apply answers: `mismatch > 0` or
  `failed > 0` — `DEGRADED`, exit 1. Only deferred bots remain — exit 0 with a
  `WARNING` and the printed re-run command. A deferred bot whose card and
  container agree is still deferred, never a mismatch; a `failed` pass outcome
  outranks a agreeing fact.
- `--retry-deferred [--wait-sec N]` (default `N=30`,
  `MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC`) is the sanctioned repeat pass:
  it reloads the deferred list from the previous rollout's summary (missing
  summary — fail closed, exit 1; never a silent empty retry), re-switches only
  those bots with `N` seconds of patience per bot, then verifies and prints
  the same table. No pass ever interrupts a running bot.

### Bot-created skills are imported back into the board's skill catalog (1.6.5 BOT-SKILL-BACKIMPORT)

- A skill a bot creates at runtime lives in its container at
  `~/.hermes/skills` on the bot's volume and used to vanish with a volume
  recreation. With `MYRMIDON_BOT_SKILL_BACKIMPORT=1` (off by default) every
  reconcile pass of a live bot also reads that directory back out of the
  container (Docker archive API; no exec, no container change) and upserts
  the new and changed skills into the company's skill catalog as company-local
  skills (`sourceKind "managed_local"` — the same shape a UI-created local
  skill gets, key `company/<companyId>/<slug>`, a `bot_backimport_agent` marker in
  the skill's metadata distinguishes them). The import also adds
  `company/<companyId>/<slug>` to the author bot's desired skills, so the
  profile compiler delivers the catalog copy back into a recreated volume —
  that is the volume-recreation criterion. A newly imported skill is set to
  lifecycle *candidate* (a bot-written, untrusted skill: it reaches the
  company's pilot agents and its own author bot through the normal delivery
  path — the compiler delivers a candidate to the agent named by the skill's
  `bot_backimport_agent` marker even outside `MYRMIDON_SKILL_PILOT_AGENTS` — and
  an operator verifies it to fleet-wide; the import never promotes). A catalog entry the
  marker does not own (a human-created skill with the same slug, another
  bot's back-import) is never overwritten — the import refuses and records
  the failure. Factory-bundled Hermes skills are filtered out by
  `skills/.bundled_manifest`, and the Hermes category layout
  `skills/<category>/<name>/SKILL.md` is read natively.
- Change detection is a content hash over the skill's file set: a skill whose
  files match the catalog copy is skipped without a version cut, so an
  untouched bot skill does not grow a version per sweep. An update rewrites
  the catalog skill's managed directory to exactly the container copy (a file
  the bot deleted disappears) and cuts one version.
- The board's own delivery directory `hermes/skills-board` is never read
  back: it is the profile's managed content, and re-importing it would echo
  the catalog into itself. A skill the bot copied or edited under its own
  `hermes/skills` imports as the company's own copy — from the catalog's
  point of view that is what "the bot changed it" means.
- Containment: a skill over the file ceilings (200 files / 512 KiB per file,
  the compiler's own limits), with a binary or path-unsafe file, or without a
  SKILL.md is dropped whole; a failing import of one skill is recorded in the
  bot's activity log and never fails the reconcile pass or the other skills.
  A driver that cannot read the container filesystem (fleetd) simply has no
  back-import.
- Flag off = byte-identical previous behavior: the reconcile pass never
  touches the skill read.

### DEVBUILD-IN-BOTS: env-delivered key, a start self-check and a local heavy-run fallback (DEVBUILD-IN-BOTS)

- The `devbuild` CLI accepts the build-server key as the secret env
  `DEVBUILD_SSH_KEY_DATA` (the key text itself) when the
  `/opt/devbuild-ssh/id_ed25519` file is not mounted — this is how the board
  hands the key to a bot whose container has no mount. The key is
  materialized into a per-process private directory (0700 dir, 0600 file)
  under the run scratch — never into `/workspace` — and removed on exit. A
  readable key file still wins over the env key; the missing-everything error
  is unchanged.
- The bot entrypoint runs a devbuild self-check at start: when
  `DEVBUILD_HOST` is set it probes `devbuild 'true'` and logs one line
  (`devbuild self-check ok: …` or `ERROR: devbuild self-check failed: …`),
  plus a machine-readable `${HERMES_HOME}/.myrmidon/devbuild-check.json` for
  the board. The check never stops the gateway; bots without `DEVBUILD_HOST`
  stay silent; `MYRMIDON_DEVBUILD_CHECK=0` disables the probe.
- Heavy build commands that pass the devbuild gate (a build container, or a
  direct binary path in an ordinary bot container) now run with a
  container-safe heap cap: the wrappers append
  `--max-old-space-size=2048` (override `MYRMIDON_LOCAL_NODE_HEAP_MB`, `0`
  disables) to the child's `NODE_OPTIONS` — a caller's own
  `--max-old-space-size` wins — and print one stderr warning pointing at
  `devbuild`. Version/help probes skip both. This is the fallback that keeps
  an uncapped tsc from OOM-killing the bot container while the offload is
  being rolled out.

### The host-disk sweep measures the real mounted path and stops spamming when it cannot (1.6.5 F-03)

- `MYRMIDON_HOST_DISK_DATA_ROOT` points the sweep at the directory that is
  actually mounted into the server container (default `/data`). When the
  path is missing the sweep result switches to `state: "unmeasured"` with a
  `measuredPath: null` and an `error` text that names the missing path and
  the setting to fix — instead of one `host disk usage could not be read`
  log line per tick.
- The transition into `unmeasured` is logged once at error level; further
  failed ticks are debug, with the error repeated at most once an hour. When
  the path appears, the measurement resumes without a restart and one info
  line records the recovery.
- Every path in `MYRMIDON_HOST_DISK_CONSUMER_PATHS` is measured on its own
  filesystem (`usedPercent`/`usedBytes`/`totalBytes`/`freeBytes` per path) —
  a consumer can live on a different filesystem than the data root. The main
  result stays the data root; the per-path list is returned as
  `measurements` from `GET /api/myrmidon/host-disk` together with the new
  `state` and `error` fields.
- `post-boot-check.sh` fails red when the host-disk sweep reports
  `measuredPath: null`, so a board that boots blind does not pass the gate.
  `POST_BOOT_CHECK_HOST_DISK=off` disables the check.

### The deploy journal opens with the version of the deploy scripts (1.6.5 F-05)

- `deploy.sh` and `deploy-from-job.sh` now write `deploy scripts at <git describe --tags --always>` as the first line of the deploy journal (stderr, so it lands in `job-<id>.log` of a deploy started from the UI). When git or the clone is unavailable the line reads `deploy scripts at unknown`; the stamp never aborts a deploy.
- Guard: `scripts/myrmidon/deploy/deploy-hygiene.test.mjs` and `deploy-from-job.test.mjs` cover the first journal line, the failing-git and no-git fallbacks and the job log.

### Telegram `/model` and `/think` work for gateway agents (1.6.5-F06-A)

- The gateway adapter (`hermes_gateway`) is allowed for both `/model` and
  `/think`. It compiles the same hermes profile and hands `model`/`effort` to
  the run, so a chat override reaches it the same way it reaches `hermes_local`
  — the note that kept it out ("until the gateway passes a model") was stale.
- For a gateway agent `/model` lists the model catalog of the LLM gateway:
  this agent key's own allowlist when the gateway answers it, the whole catalog
  otherwise, and the reply says which of the two it is. The list is grouped by
  provider family (`dashscope-*`, `zai-*`, `nous-*`), the card's own model and
  its fallbacks stay on top, and the 30-model cap is unchanged.
- Writing a gateway agent's `/model` or `/think` now applies its profile
  without a restart: the reply says the change takes effect from the next
  reply. If the apply fails, the card is restored to its previous value and the
  reply names the reason; with the bot-containers feature off nothing is
  treated as broken — the value stays and the reply says the new profile is not
  applied yet.
- `/think` checks the chosen level against the model's own effort list
  (effort-policy): a level the model does not accept (e.g. `medium` for a GLM
  model) is not written, and the answer names the allowed levels.
- A refusal for an unsupported adapter now names the adapter type and the
  reason, in the language of the chat's user.

### The run journal names the model of a gateway run

- Runs of the Hermes gateway are no longer recorded with `unknown` as their
  model. The adapter now reads the model from the gateway's terminal answer in
  order of trust — the `model` field first, then the LiteLLM route name
  `model_group` (both at the top level and inside `usage`) — and falls back to
  the model the run was configured with when the answer names neither. An empty
  value or the `unknown` sentinel is not treated as a model.

### Telegram `/model` and `/think`: buttons, reply-pick, edited commands, a correct model list (F06-D)

- A plain `/model` (or `/think`) in a bridged Telegram DM answers with a card of inline buttons, two to a row,
  one per listed choice (the current one marked `✓`) and an "agent default" button. A press applies the choice
  exactly like `/model <name>` does (the value is resolved against the live list again, a running reply and the
  reasoning-effort policy still refuse, a gateway agent's profile is applied) and the bot confirms once. A
  second press, a press by anyone but the conversation's own linked person, or a press under another message
  changes nothing.
- A reply to a list message with its number (`2`), a name (`glm-5.3`) or `default` picks from it, no command
  needed; any other reply goes to the agent as before.
- An edited `/model …`, `/think …`, `/status`, `/help`, `/stop`, `/agents` or `/who` runs as a command instead
  of ending as a silently filtered lifecycle row. `/new`, `/plan`, `/accept` and `/reject` are never re-run from
  an edit.
- The list shows every chat model the agent's key may run, of every family, with no ceiling on the count;
  only non-chat models are dropped. "Chat" is decided by the mode the gateway declares for the model
  (`model_info.mode`: `chat`, `responses`, `completion`), which the cost sweep now stores with each model; for a
  model without a declared mode an id rule applies (embeddings, OCR, rerank, moderation, image/video/speech
  generation and recognition). The board's own `hindsight-*`/`-mem` models are dropped either way. Order:
  DashScope, then z.ai, then the other families, ids compared as numbers; the card's own models go through the
  same filter and stand in that order, not first. Family header lines are gone. The keyboard holds up to 98
  model buttons (Telegram's limit is 100 per message) plus "agent default"; with more models the rest are chosen
  by number or name from the complete list, and the reply says so.
- A model chosen for a native-provider card (`anthropic`, ...) from the gateway list is stored together with the
  provider that routes it (`custom`), so the run never sends the card's old provider with the new model; the
  card's own models keep its provider, and the pair is rolled back together if the profile apply fails.
- Why a gateway agent's `/model` kept listing the whole gateway catalog: the agent's own list was read with a
  per-agent key secret the bot profile never uses. It now reads the key the bot really sends (the card's own
  binding of `MYRMIDON_BOT_LLM_API_KEY_ENV`, else the shared company secret, then the per-agent secret), and a
  fallback to the whole catalog is logged with its reason code and named in the reply.

### Default language of the bridged Telegram DM comes from the instance (1.6.5 F-07 part C)

- The bridged Telegram DM now has an instance-wide default language:
  `instance_settings.general.bridgeLanguage`, changed on Settings → Language
  (or `GET`/`PATCH /api/myrmidon/bridge-language`). `GET` needs ordinary board
  access, `PATCH` needs instance admin rights and writes an `issue.updated`
  activity entry; the value is read through a 5-second cache, so a saved
  change applies from the next reply without a restart.
- The resolution order of the language a chat is answered in is now:
  `MYRMIDON_TELEGRAM_DM_LANGUAGE` (the operator's force) → the linked board
  user's Settings → Language choice → the instance default → English. The
  Telegram private-chat command menu follows the same order.
- `GET`/`PUT /api/myrmidon/ui2/language/me` reports the source of the value
  the chat really uses (`telegramBridge.source` = `user` | `environment` |
  `instance` | `default`, with the forced and instance values alongside), and
  the Settings → Language panel names that source instead of describing every
  unforced instance as the user's own choice.
- The refusal texts for a model or reasoning effort that the adapter does not
  serve now name the adapter, the reason and where the value is changed (the
  agent card) in both locales, instead of a bare "unavailable for adapter X".

### Telegram aliases and group are editable on the agent card (1.6.5 F-07 part D)

- The agent card now has a "Telegram" section: the aliases the bridge answers
  to (`agents.metadata.telegramAliases`) as an editable list of lowercase
  latin rows, and the `/agents` group title (`agents.metadata.telegramGroup`)
  as one text row with the company's existing group titles suggested through
  a `datalist`.
- With an empty alias list the section names the default alias the bridge
  computes from the agent name, so the card shows what the chat really uses
  before anyone edits it. The default rule is duplicated in the UI as a pure
  function marked as a consolidation point — part A kept it server-side.
- Saving goes through the existing `PATCH /api/agents/:id { metadata }`: the
  section re-reads the agent first and merges only the two Telegram keys, so
  every other metadata key keeps its value. Invalid (not lowercase latin) and
  duplicate alias drafts are blocked before the save.
- Board UI only: no server, schema or bridge change.

### Run limits: the admission's refusals are visible on the runs-and-queue screen (1.6.5 F-09 B)

- The Run limits section of Instance → General now shows the admission's own
  refusal counter: how many times a queue sweep left a queued run waiting
  because of a global or host ceiling, since the server started.
- The line carries the breakdown by reason (the concurrency ceiling, the start
  ramp, the server's memory floor, the host memory floor, the host CPU
  ceiling), largest first, and the reason and time of the most recent refusal.
  A reason the screen does not know is still shown under its own name.
- The counter is optional in the endpoint's reply: an older server that sends
  no `admissionDenials` renders no line at all — the screen shows nothing
  rather than a zero it invented, and the rest of the panel is unaffected.

### Wizard endpoints stuck in `verifying` are finished by live traffic (1.6.5 F-10 A)

- An endpoint whose setup wizard stopped at the test step no longer needs the
  owner to press "Finish setup" once real traffic has proven both halves of the
  round trip: the board delivered an outgoing message through it
  (`chat_publications` in the `published` state) and an incoming turn came back.
  Such an endpoint becomes `active` on its own, with the test step completed,
  the test timestamp cleared and the health line `Verified by live traffic`;
  its tool connection turns active and healthy. The completion is recorded in
  the activity journal (`chat_endpoint.auto_activated`, trigger
  `live_traffic`) and can never happen twice or half-way: an endpoint with only
  incoming or only outgoing traffic stays where the wizard put it, and for the
  first minutes after a test starts the wizard keeps its endpoint (the owner is
  looking at it).
- The endpoint detail and list responses now carry `verifyingStale` — an
  endpoint that has been sitting in the test step for more than a day while
  deliveries keep succeeding. It is an attention flag for the interface and for
  diagnostics, never a status change and never an error.

### A Telegram endpoint leaves the setup wizard on its first successful delivery (1.6.5 F-10)

- A Telegram endpoint that is still waiting for the wizard's test step (`status=verifying`, `setup.step=test`) now settles on its own, without the manual "test" click: the first publication the Telegram API accepts moves `setup.step` to `complete` and the endpoint status to `active` in the same transaction that saves the delivery receipt, and activates the endpoint's tool connection in that same save.
- The completion update re-checks the live row (status, `setup.step=test`, runtime generation and the test window) and merges the new step into the live `setup` JSON with `.returning()`; the tool connection is only activated when the endpoint actually flipped to active, so a concurrent reconnect that empties the update leaves endpoint and connection untouched (no wiped `lastError`, no divergent health). When the send fails, the endpoint keeps the wizard state and completes on the first successful retry.
- A manual test request against an already-active, completed Telegram endpoint returns the endpoint as an idempotent no-op instead of a 409 conflict.

### botd cleanup is idempotent, silent about foreign owners and never leaves work unarchived (1.6.5 BOT-DISK-H, F-13 part A)

- A removal of a path that is already gone is success: `guardedRemove` returns
  `already gone` instead of raising ENOENT, and `retain` drops manifest entries
  whose files all vanished silently. The ~160 ENOENT error lines per 1.5 h the
  journal carried are gone by design.
- A permission failure on a removal (`EACCES`/`EPERM` — the path belongs to another
  uid) is a deferred pass, not an error: the path stays exactly where it is, ownership
  is never changed, and `botd-attention.json` guarantees one attention line per path
  per hour carrying the blocking code and the owner uid from `lstat`. The write-access
  probe runs before any recursive removal or re-archival, so a foreign tree is never
  half-removed and a deferred legacy directory is not re-archived every pass.
- `verifyEntry` is a strict readability re-check of an archive that still exists: an
  entry whose files are all gone fails it ("already gone" remains only `retain`'s
  shortcut), so a vanished archive can never green-light the removal of source data.
- When `git bundle create` fails for a reason other than "empty bundle" (a damaged
  repository, a hung git), the whole directory — `.git` and untracked files included —
  goes into one fallback `<base>.full.tar.zst`; a tar that lists back is a complete
  copy of the directory, so it clears the removal (no more "archive-incomplete ... not
  removed" keeping the disk full), and the manifest entry is marked
  `incompleteBundle: true`. The fallback tar counts in the retention quota. The
  fallback is bounded: a directory over 2 GiB, or an archive filesystem without room
  for it, refuses the tar (nothing deleted) instead of filling the archive disk, and
  every spawned git/tar carries a 10-minute timeout so a hung tool cannot hold a pass.
  All `tar -tf` verification streams the listing to /dev/null or a chunked counter
  instead of buffering it in memory. If even the tar cannot be written or verified,
  nothing is deleted. The tar of a legacy directory without `.git` (`archiveTree`) has
  the same bounds: over 2 GiB (`.git` not counted) or without room in the archive root
  it refuses, and the directory stays. An unknown amount of free space (a failed
  `statfs`) counts as none.
- Archive retention (30 days / 2 GiB) runs once per executed botd pass, after the
  actions; the entries archived in that pass are never evicted by the quota.
- The rhythm of the rules: the same op on the same path is not attempted more than
  once per hour (`botd-cooldown.json`, keyed by path+op — a different op on the same
  path is a different decision); a repeat inside the window is a silent skip —
  no log line, no report row. Every executed pass ends with one summary line
  `botd loop: cleaned N, deferred M (reasons…)` instead of per-path noise.
- No new environment settings; the two caches live next to `disk-state.json` under
  `$MYRMIDON_WS_HOME`, are best-effort (an unwritable cache only loses the silence)
  and sweep entries older than a day on every write, so they never grow without a
  bound.

### Context compaction: per-pass batch ceiling as a live setting; the backup-source contract written down (1.6.5-F14B)

- The compaction pass's ceiling `CONTEXT_COMPACT_MAX_BATCHES` (batches of 500
  rows per company per pass) is no longer a build-time constant: the pass
  resolves `general.datastoreCare.retention.contextCompactMaxBatches` first,
  then the `MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES` environment override, then
  the default of 10, and re-reads it every pass — so the first live passes on
  an IO-starved board are throttled with a `PATCH /api/myrmidon/datastore-care`
  without a rebuild or restart. `GET /api/myrmidon/datastore-care` reports the
  ceiling with its source (`settings` | `env` | `default`).
- The agreed backup source of the retention gate is documented as a contract:
  the board's built-in DB Backup is the primary fresh-backup producer, a
  host-side `pg_dump -Fc` dump (`*.dump`) is accepted by extension as a
  fallback intended for shipping to external storage, and with the prefix
  knob unset or empty any `*.sql.gz`/`*.dump` in the dir counts (names not
  matching a set prefix are still reported as `candidates`). The row-deletion
  sweep (data retention) follows the same rule, so both gates agree.
- New setting "The machine is backed up externally"
  (`general.datastoreCare.retention.externalMachineBackup`, a checkbox in the
  Data retention panel, also `PATCH /api/myrmidon/datastore-care` and
  `PATCH /api/myrmidon/data-retention`). When the whole machine is backed up
  on another host and no local dump is produced, the backup gate of BOTH
  cleanups (run-context compaction and deletion of old rows) passes without
  looking for a local file; the persisted gate report then says
  `externalMachineBackup: true`. Off by default: with it off, the gates behave
  as before and wait for a fresh local dump.
- Fix: the data-retention windows no longer fall back to the defaults when the
  same stored block also holds the compaction keys (`heartbeatRunContextDays`,
  `contextLastRun`, ...): only the three window keys are validated there.
- The gate's contract is pinned by tests: a failed freshness check against an
  embedded Postgres still writes the full `contextLastRun.backupGate` report
  with honest field names and `waitingForBackup: true`, while the legacy trap
  field `backupCheckedAt` keeps its meaning (newest backup mtime, not check
  time) — it is deliberately not renamed (state migration).

### Attention feed: the decision-retention state is written in the background, not on the read (1.6.5 F-15)

- `GET /api/companies/:id/attention` used to upsert the decision-retention
  rows that back the feed (`decision_retention`) inside the request, so every
  poll of the screen wrote to the database and the feed's own latency included
  those writes.
- The read path now only projects the state already stored (a read-only batch
  read) and parks the fresh snapshot in a per-company debounced scheduler. The
  retention sweep — the periodic pass that also runs auto-archive — drains the
  parked snapshots on the server's schedule: one pass per company at a time,
  at most one pass per company per 30 seconds, only the newest snapshot kept.
- A read never waits for the sync and never fails because of it: a failed
  background pass is logged and dropped, and the feed keeps rendering the
  state the previous pass stored until the next snapshot retried by the sweep
  succeeds.

### Partial lifecycle index for the attention screen's exhausted-runs query (1.6.5 F-15)

- The attention screen (`server/src/services/attention-exhausted-runs.ts`)
  looks for runs whose bounded retry budget ran out: it filters
  `heartbeat_run_events` by `company_id` + `event_type = 'lifecycle'` +
  `message like 'Bounded retry exhausted%'` before joining the run rows. The
  two non-unique indexes on the table (`company_run`, `company_created`) do not
  carry `event_type`, so the leg read every event row of the whole table — a
  sequential scan, one of the measured legs behind the feed's p50 2.3 s / p95
  4.7 s, measured on a production trace.
- Migration `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql`
  adds one partial b-tree index
  `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id)`
  `WHERE event_type = 'lifecycle'`: the scan shrinks to the lifecycle slice of
  one company. Additive index-only migration: no query text, no schema and no
  behaviour change.
- Measured on embedded PostgreSQL with 83 200 seeded events across 20 companies
  (synthetic data, no production rows): the exhausted-runs leg went from
  `Seq Scan ... Rows Removed by Filter: 83 095` at 20.2 ms to
  `Bitmap Heap Scan ... Bitmap Index Scan on heartbeat_run_events_company_lifecycle_run_idx`
  at 0.87 ms — 23x faster, 1443 → 62 shared buffers.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — drizzle migrations run
  transactionally). `heartbeat_run_events` is bucketed "large" by the
  migration-safety checker (10 833 local rows × 250), so the statement carries
  the explicit `paperclip:migration-safety-ignore` note as 0307/0308 do for
  their large tables; production deploys run through the operator's maintenance
  mode and the partial predicate keeps the build cost at the lifecycle slice.
- Guard: `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts`
  checks the migration file, the journal entry and the snapshot statically,
  confirms on embedded Postgres that the leg is served by the index and falls
  back to the sequential scan after `DROP INDEX` (the assertions have teeth),
  and applies the migration statement twice on one database to prove
  idempotency.

### Issue list agent defaults: agents get compact, capped, description-free list responses (F16, part A)

- `GET /api/companies/:companyId/issues` used to answer 1.5–4 MB to a bare agent request, because the full response carries every issue's `description`. For an actor of type `agent` the endpoint now applies agent-oriented defaults: a request without `view` is answered as `view=compact`, `limit` defaults to 200, and the compact body omits `description` (the agent fetches the body of the one issue it needs via the detail endpoint).
- An agent's explicit `limit` above 500 is refused with 400 and a pagination hint (`offset` / `afterId`) instead of being silently clamped. The full view stays reachable through an explicit `view=full` together with an explicit `limit <= 100`; `view=full` without a limit is refused (the agent default of 200 already exceeds the full-view cap).
- The behaviour is gated by the instance setting `issuesListAgentDefaults` in `instance_settings.general` (changed without a deploy). The key is absent on instances that never toggled it, and absent means ON (defect-fix on). `{enabled: false}` restores the pre-feature agent behaviour byte-for-byte.
- The board actor is untouched: a bare board request keeps the full response, `limit=1000` is clamped as before, and `view=full` stays a 400 (the UI compatibility contract).

### Plugin worker errors no longer leak `err.data`; unknown tool key is 400 for agents too (F17 part 2)

- `packages/plugins/sdk/src/worker-rpc-host.ts`: a plugin handler's `err.data`
  is forwarded only for `UNKNOWN_ACTION` (RPC code `-32007`), and only when the
  payload round-trips through JSON. A cyclic reference or a `BigInt` in `data`
  previously threw inside the bare `JSON.stringify` of `serializeMessage`, the
  outer `.catch` retried with the same payload and swallowed — the host waited
  for the RPC timeout. Now the response goes out without `data`. For every
  other error code `data` is dropped entirely: an ofetch `FetchError` carries
  the external service's response body in `.data`, and the bridges forwarded it
  to the browser/agent as `details`.
- `server/src/routes/plugins.ts`: `POST /plugins/tools/execute` on the agent
  (toolGateway) path now maps `UNKNOWN_ACTION` (-32007) to **400** with
  `{ code: "UNKNOWN_ACTION", details }` — the same contract the board path
  already had — instead of 500/502.
- `packages/plugins/plugin-llm-wiki`: the «jobs ↔ handlers» guard actually
  fails now when a manifest job has no worker handler or vice versa (the old
  test spied on `runJob` itself and swallowed the rejection), and the
  package's tests run in CI again (`react` is a devDependency so vitest can
  load it inside the workspace; the host still supplies `react` at runtime
  per the `peerDependencies` contract).

### Scheduled wiki folder health check gets its missing handler (1.6.5-F17)

- The llm-wiki plugin's hourly `folder-health-check` job no longer fails with
  «No handler registered»: the worker now registers the handler declared by
  the manifest.
- Each run logs one line per company and one summary line, and writes a
  `folderHealth` metric point (gauge 1 while no configured wiki root is
  unhealthy, 0 otherwise; labels carry the healthy/unhealthy/notConfigured
  counts). Companies with no wiki root configured report a not-configured
  status (logged at debug level) and are not counted as unhealthy.

### Unknown plugin action/data/tool keys answer 400 UNKNOWN_ACTION with the list of known keys (1.6.5-F17)

- The plugin SDK worker host now reports an unknown action, data, or tool key
  as a structured error: JSON-RPC code `-32007`
  (`PLUGIN_RPC_ERROR_CODES.UNKNOWN_ACTION`) whose `data` carries
  `{ error, known }` — `error` is one of `unknown_action`,
  `unknown_data_key`, `unknown_tool`, and `known` lists the keys the worker
  actually registered. (Unknown job keys are not part of this contract:
  `runJob` for an unregistered job still throws a plain error.)
- The plugin bridge maps that code to a caller error. The four bridge routes
  (`POST /api/plugins/:pluginId/bridge/data`, `.../bridge/action`,
  `.../data/:key`, `.../actions/:key`) now answer `400` with
  `{ code: "UNKNOWN_ACTION", message, details }` instead of `502`, and the
  board path of `POST /api/plugins/tools/execute` answers `400` with
  `{ error, code: "UNKNOWN_ACTION", details }` (no `message` field)
  instead of `500` (`UNKNOWN_ACTION` joins `PLUGIN_BRIDGE_ERROR_CODES`). An
  unavailable or not-ready worker still answers `502`; only the unknown-key
  class moved.
- Handler errors from worker RPC methods now forward their `err.data` payload
  to the caller (error codes were already propagated before). The follow-up
  release entry «worker `err.data` is forwarded only for `UNKNOWN_ACTION`
  and only when JSON-serializable» covers how much `data` rides along.

### Tools gallery and connections accept a granted agent, not only a board actor (F22)

- `GET /companies/:companyId/tools/gallery`, `GET /companies/:companyId/tools/connections`,
  `GET /tool-connections/:id`, `POST /companies/:companyId/tools/connections`,
  `PATCH /tool-connections/:id` and `PUT /tool-connections/:id/installs` now admit an
  agent actor holding an explicit company grant: `tools:admin` or
  `tools:manage_connections` for reads, `tools:manage_connections` for mutations.
  Without a grant the agent gets 403; board actors keep their previous semantics.
- `DELETE /tool-connections/:id` stays operator-only for agents (403 with an
  explanatory message): removing a connection revokes every grant built on it, and
  the "with approval" interaction path is not reachable from this route without a
  task context.
- Every agent access on these surfaces writes a `tool_access_audit_events` row
  (actorType `agent`, action `tool_access.<surface>`, read/write or a denied
  delete), next to the unchanged activity-log rows.

### Off-run self-secret reads via a time-boxed `secrets:read_off_run` grant (F-23)

- New permission `secrets:read_off_run`. It is issued by board actors only (the
  agent card toggle, `PATCH /agents/:id/permissions` with `offRunSecretRead`, or the
  existing principal grants) and is always time-boxed: without an explicit
  deadline it expires 30 days out, and enabling it again renews the term to a
  fresh 30 days. An expired grant is denied centrally (`deny_expired_grant`).
- With an active grant, an agent acting without a run (operator CLI/session) may call
  `GET /api/agents/me/secrets` and gets the metadata of its own bound secrets, never
  values. Only an own agent key with the `standard` scope is admitted; automation and
  service keys are rejected. `GET /companies/:companyId/secrets` stays board-only.
  Without the grant the historical `403 "Run-bound agent authentication required"`
  is returned unchanged.
- Every off-run listing writes a `secret_access_events` row with
  `details = { offRun: true, access: "agent_self_metadata", keyId, remoteAddress,
  listedSecretCount }`; a failed audit write fails the request (500). `remoteAddress`
  is Express `req.ip` (honors `trust proxy`, by default the socket peer); a
  client-supplied `X-Forwarded-For` is never recorded.
- The attention feed gets two advisory items: `secret_off_run_reads` (reads in the
  last 24 hours) and `secret_off_run_grant_expiring` (a grant expires within 3 days).
- Migration `0382` adds `principal_permission_grants.expires_at` and
  `secret_access_events.details`. The agent card shows the grant state and expiry
  in the Permissions section; the full settings UI is deferred to 1.6.6.

### Automatic wakes without a task are closed before the model; stale tasks cool down (1.6.5 F-26 T5)

- A swarm wake (`swarm_matched`, `idle_pickup`, `issue_assigned`,
  `swarm_claim_queue`) that names no existing task — no issue id in the wake
  context or an issue that no longer exists — no longer starts a model run.
  It is recorded as skipped at the moment the wake is queued, before any
  adapter exists, so it costs zero tokens; each such closure lands in the
  activity journal as `heartbeat.wake_skipped_taskless` with the gate reason
  (`no_task` / `task_missing`). Manual wakes, chat and every other wake
  source are untouched: a manual wake of a user always passes, even for a
  deleted task.
- A task that produces no movement stops being woken in circles. When the
  last automatic run of a task ended stale — failed, timed out,
  `blocked`/`needs_followup`, or succeeded without advancing a `todo` task —
  and the task did not move since (a comment, or a status / assignee /
  description change; the row's `updatedAt` is not a signal, a finished run
  bumps it itself), the task
  cools down for `cooldownBaseMin · 2^(n-1)` minutes (base 30, capped at
  24 h), where n is the number of consecutive stale runs since the last movement.
  A comment or real task update by a user or by an agent other than the stale run's own lifts the window immediately; when it expires the
  task becomes a wake candidate again. Idle pickup obeys the window, and the
  new read-only `GET /api/myrmidon/companies/:id/swarm/cooling` lists every
  cooling task with its trigger, window length and next allowed wake time.
  System actors (the run itself, execution-recovery, automation) never count as movement.
- Both knobs live in instance general settings under `general.swarm`
  (`runWithoutTaskGate`, `cooldownBaseMin`, `cooldownCeilingHours`); absent
  settings mean the defaults above, and a malformed block degrades to
  defaults rather than breaking the wake path.

### Task pheromone strength and task caste (1.6.5 F-27 PHEROMONE, rework per architect project 09.10)

- Effective pheromone (design §2.3): the stored strength plus aging
  (+1 per 24 h waiting, cap +5) minus a penalty (−10 per failed run since the last
  task change), floored at 0. A "task change" is a comment, or an audit row by a
  person or an agent, written after the failed run (the system actor and the run's
  own release stamp do not count). The SQL twin in
  `server/src/myrmidon/swarm-claim/effective-pheromone.ts` orders every queue read
  (before the candidate LIMIT), so a strong fresh task is never cut off.
  Parameters live in `instance_settings.general.swarmClaim.pheromone`.
- UI: the issue card has "Caste" (directory select), "Pheromone strength" (number
  with an effective-strength hint) and a "P0" checkbox bound to `priority=critical`;
  the project card has "Default caste". The run-priority scoring gains a
  `pheromoneWeight × eff` term (default weight 1), bounded to 100 points so a huge
  strength cannot lift a run over the role and release bands.

### A task with a scheduled monitor is not picked up by idle pickup (IDLE-PICKUP-MONITOR)

- An issue whose `monitor_next_check_at` lies in the future no longer counts
  as a ready idle-pickup candidate: its wake already has an owner —
  `tickDueIssueMonitors` fires it exactly at the scheduled time (for the
  `in_progress`/`in_review` statuses). Until now the candidate prefilter never
  read the column, and such an issue burned a no-op run on every sweep pass
  until the monitor fired.
- The filter is one shared SQL prefilter, so both consumers follow at once:
  the periodic sweep and the WAKE-BIND binding (`findTopReadyIssueForAgent`),
  which picks the task a manual wake without an explicit issue binds to.
- An elapsed monitor (`monitor_next_check_at <= now`) is NOT excluded: the
  monitor tick owns that wake, and suppressing readiness there serves nothing.
- The behaviour is strict — no switch is added and none is needed.

### LITELLM-WORKERS-A: the LiteLLM worker-process count is stored, resized live and reported (1.6.5)

- The board stores a target number of LiteLLM gateway workers per company
  (instance settings key `myrmidonLitellmWorkersCompanies`, written under a row
  lock) and reports it with the CPU ceiling (`maxByCpu`) and the memory ceiling
  (`maxByMemory`, `floor(memoryGb / 1.5)`).
- `GET /api/myrmidon/companies/:companyId/litellm/workers` answers the current
  pool size, the target, the ceilings and the live metrics (per-worker CPU,
  median latency, queue depth); an absent number is reported as absent, not as
  zero. `perWorkerCpu` is a percentage (0..100), as the Costs page draws it.
  When no source knows the pool size (the declared baseline counts as one),
  `current` is `null` and `currentSource` is `unknown`; the Costs page shows
  "unknown".
- `PUT …/workers` with `{ "target": <integer> }` stores the target and moves the
  gunicorn pool to it with TTIN/TTOU signals, without a gateway restart. A
  target above the memory or CPU ceiling is a 400 with `details.reason`
  `above_memory` or `above_cpu`. When no source knows the pool size, the target
  is stored and the pool is left alone. Only an instance admin may PUT (the pool
  is one per instance), and whole resizes are serialised by a database advisory
  lock, so two concurrent PUTs signal only for the difference.

### LITELLM-WORKERS-UI: the "Gateway workers" tab on the Costs page (1.6.5)

- The Costs page gains a third gateway tab, "Gateway workers", beside
  "Gateway" and "Gateway keys": an input for the desired LiteLLM process
  count (seeded from the server's `target`), the CPU and memory ceilings
  shown as hints, an Apply button behind a confirm step, and a status line
  while `current` moves to `target`. A target above `maxByMemory` is caught
  on the client; a 400 from the server is shown with the server's own text.
- Metrics card: per-worker CPU bars, median response time and the request
  queue depth, refreshed every 30 seconds from
  `GET /api/myrmidon/companies/:id/litellm/workers`.
- Auto-select card: shows the switch state and turns it on or off through
  the same `PUT …/workers` (the threshold logic itself runs on the server).
  When the backend does not carry the optional `auto` field, the switch is
  disabled with an explanation — manual control keeps working.

### `myr-ws close` and `myr-ws restore` share one archive root (1.6.5 BOT-DISK-H)

- `close` called the archive module without a root, so the archive went to the
  module's production default while `restore` looked under
  `<MYRMIDON_WS_HOME>/archive`: with `MYRMIDON_WS_HOME` overridden a closed
  copy could not be restored. The root is now one function of the home
  (`archiveRootOf` in the `myr-ws` layout); `close` passes it to the archive and
  `restore` reads it. With the default home nothing changes.

### Board process registry, leader leases and the `general.processes` setting (PROCS-0.1)

The board now keeps a registry of its own OS processes. Migration `0388_board_processes`
adds two tables: `board_processes` (one row per running process: boot id, role, pid,
host, container, version, start and last-pulse time, API port, event loop lag, RSS) and
`board_leases` (named leader leases: holder boot id, epoch, acquisition and expiry
time). Each process writes its own row at boot and refreshes it every 10 seconds; rows
silent for more than 2 minutes are reaped by a process that owns background work. Two
read routes serve the «Процессы» panel: `GET /api/myrmidon/board-processes` (the rows
with age, status and the answering process marked) and
`GET /api/myrmidon/processes/leases` (the leases joined to their holder's row; an empty
list while nobody holds a lease). Both are for board members only.

The instance setting `general.processes` (`mode` single/split, `apiCount` 1..4,
`leaderLeaseTtlSec` 5..300, `liveEventsBus`, `admissionStore`, `singletonProxy`) is
stored and returned by the general settings API; absent means the defaults, which are
the single-process board. Nothing changes on a one-process board: it writes one registry
row and no leases. The setting is only stored for now — the supervisor that acts on
`split` lands in a later stage, so `split` has no effect yet.

### The leader lease of the board is visible in the panel (PROCS-1.7 part B)

Instance settings now carries a leader-lease block: one row per `board_leases`
entry — the lease name (scheduler, backup, bot operations), the holder (`boot_id`
plus the `hostname`/`pid`/role of its `board_processes` row while that row still
exists), `epoch`, `acquired_at`, `expires_at`, and whether the process behind the
panel is the leader of that lease.

- The block reads `GET /api/myrmidon/processes/leases` and refreshes every 10
  seconds; a `leader_changed` live event cuts the wait short, so a handover is
  visible without restarting the board. The route is part A of the same task
  (part A of the lease-route task) and is mocked with `docs/myrmidon/board-leases-contract/*.json`
  until that half merges — the two halves do not touch the same files.
- Every state is spelled out instead of showing an empty cell: a lease whose
  process row is gone, an expired lease with the epoch and lifetime that came
  with it, and an empty lease table. Timestamps are printed in UTC so the panel
  lines up with the server log.
- If the route is missing from the build (or the API is down), the block reports
  "No data" and the rest of the panel keeps working; the page does not fail.
- A single-process board behaves as before: one lease row, held by the running
  process. The block is self-contained, so the «Процессы» panel (PROCS-0.1) picks
  it up with one import and one line.

### Board process metrics: event loop delay, memory, live-event flow (PROCS-Q3)

`GET /metrics` now answers five more families: `myrmidon_board_event_loop_lag_seconds`
(p50/p99/max summary, measured between scrapes), `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes` (used/total), `myrmidon_board_live_events_total` and
`myrmidon_board_live_event_bytes_total` (per live-event kind, cumulative since boot).
This is the measurement half of этап 0 of the multi-process project: no scaling of the
board may be argued without these numbers first.

Nothing new stores or configures: the delay comes from Node's `monitorEventLoopDelay`
(read-and-reset, so a quantile describes exactly the scrape interval), the memory from
`process.memoryUsage()`, and the live-event flow from an ordinary subscriber of the
existing `services/live-events.ts` emitter — the publisher is not modified. The
observers start lazily on the first authorized scrape, so an endpoint nobody scrapes
costs nothing. A failing process read zeroes the five families by name in
`myrmidon_scrape_errors` and never kills the scrape, exactly as the DB families already
behave. Measured overhead of the per-event listener (Node 24, 100k events with JSON
payload serialization through the real `recordLiveEvent` path): **0.85 µs per event**,
85 ms total — at a sustained 1000 events/second that is 0.085 % of one CPU core, an
order of magnitude below the 1 % budget.

### Swarm self-organization: the board matches tasks to free agents itself (1.6.5-SWARM-SELFORG)

- One switch — **Instance → General → "Self-organization (swarm)" → "Enable the swarm"** — and the board itself matches every unassigned ready task with a free agent of the right caste and wakes it with that task in hand. Off by default; the role and company lists are gone — the swarm is either on or off.
- Queue order inside a caste: P0 (critical) first, then the task's effective pheromone strength (strength + aging − penalty for failed runs), then queue age. Tuned in the panel's "Pheromones" block (`general.swarmClaim.pheromone`).
- A task whose last automatic run moved nothing cools down — `general.swarm.cooldownBaseMin` (30 min) doubling per stale run, capped by `general.swarm.cooldownCeilingHours` (24 h); any comment or task change lifts the window at once.
- No more "wake up and look for work" passes: every automatic run starts with a concrete task; a wake without one closes as skipped before the adapter starts — zero tokens.
- User guide: [guides/swarm-self-organization.md](../guides/swarm-self-organization.md) (Russian: [swarm-self-organization.ru.md](../guides/swarm-self-organization.ru.md)).

### Swarm self-organisation panel, supervisor overview and menu entries (1.6.5 SWARM-T4)

- The Instance → General section is now "Self-organisation (swarm)": one master switch, a live status line, a Pheromones block (priority seeds, aging, evaporation penalty, cooldown) and an Advanced block (lease TTL, per-agent ceiling, sweep interval).
- The pilot lists are gone: the master switch is the only gate. The environment overrides `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` and `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` are removed in 1.6.5 and are no longer read; remove them from the environment.
- Swarm supervisor: queue rows carry the effective pheromone strength, the nest agent and the waiting time; the overview adds free agents, recent matches, cooling tasks and warnings. The pilot-report route is removed.
- The menu lists "Swarm: queues" and "Foraging"; the streamlined sidebar keeps both visible.

### Internal delegation no longer quarantines lead tasks, without weakening the trust check

- A task written from another agent's same-company run used to be sent to
  `low_trust_review/quarantined`, so its executor got no GitHub token. The
  quarantine is now lifted for that case only when both hold: the actor's run
  id is authenticated (the signed agent JWT `run_id` claim — the
  `X-Paperclip-Run-Id` header sent with an agent API key is client-supplied and
  never lifts a quarantine) and the run's provenance is on an explicit
  allowlist of internal sources (`assignment`/`automation`/`timer` invocations
  with scheduler-style wake sources). Answers to external-chat questions
  (`issue.interaction.respond`), comment wakes, chat/webhook markers and any
  unlisted source stay quarantined.
- Quarantined tasks are refused GitHub credentials with a structured reason and
  the release path (`POST /api/issues/:id/low-trust/promotions`).
- Migration `0387_low_trust_internal_release_candidates` is a dry run: it writes
  `issue.low_trust_release_candidate` audit rows (issue ids) for quarantined
  tasks with provably internal origin and changes no issue. An operator reviews
  the list and releases confirmed tasks through the promotion endpoint.

### Vendor-derived share in the release notes (1.6.5 VENDOR-SHARE-METRIC)

- Every release published by `publish-github-release.sh` now carries a
  `## Vendor-derived files` section: the share of files inherited from vendor
  code and its delta to the previous release —
  `Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)`.
  The numbers come from `scripts/myrmidon/vendor-share.mjs` (already in main),
  the previous line is parsed out of the previous release's own notes; a release
  published before the metric reads
  `нет данных (no vendor-share line in that release)`.
- The metric is advisory: when the share cannot be computed (no vendor base in
  the checkout, unreadable state file) the section says `не посчитано` with a
  warning and the release still goes out — a metric failure never fails a
  publish.
- `scripts/myrmidon/release/vendor-share-notes.mjs` (new) builds and parses the
  line; its unit contract is `vendor-share-notes.myrmidon.test.mjs` (11 tests),
  and the publisher integration lives in `release-publish.test.mjs` (3 more, the
  test suite).

### PREDEPLOY-PG-COMPAT: the version comparison and the extension read really run on Debian/PGDG servers (1.6.6)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — the dump-header parser
  kept only the leading major digits. A Debian/PGDG server records its version
  with the package tail (`; Dumped from database version: 18 (Debian
  18.6-1.pgdg12+2)`); the previous sed did not anchor the end, so the whole
  tail landed in `dump_major` and the arithmetic comparison died with
  `((: 18 (Debian 18.6-1.pgdg12+2): syntax error in expression` — bash does
  not abort on a failed arithmetic expression inside `if`, so the version
  check of the rc.11/rc.12 deploys (08.10) was silently skipped. The copy's
  `SHOW server_version` answer is parsed the same way.
- The two psql probes against the copy (`SHOW server_version`,
  `SELECT extname FROM pg_available_extensions`) no longer swallow stderr
  into `/dev/null`. They run through one helper that retries three times
  (`POLL_INTERVAL_SEC` apart) and captures the psql error; if the list still
  cannot be read, the WARNING names the captured error instead of failing
  silently. This is the second silent skip of the same deploys
  (`WARNING: the copy's extension list could not be read`).
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the fake
  docker answers the real Debian-tailed headers
  (`18 (Debian 18.6-1.pgdg12+2)`, `17.2 (Ubuntu 17.2-1.pgdg22.04+1)`) and can
  make each probe fail with a psql error. New cases: younger copy with a
  tailed header is refused with no `syntax error in expression` in the output,
  equal majors pass, the extension list is read and a missing extension is
  refused, a failing extension probe is retried and its error appears in the
  WARNING, the version WARNING carries the probe error. Every new case fails
  on the previous script.

### 1.6.5 F-26 T3 — castes become configurable, agents get nests (CASTES-AND-NESTS)

- Castes: `agent_castes.is_default` with a partial unique index per company
  (migration `0385_agent_castes_default_and_nests`, index
  `agent_castes_company_default_uq`; backfill to `engineer`, otherwise the first
  key). The catalogue moves the flag in one transaction on
  `PATCH /api/myrmidon/companies/:id/castes/:key {isDefault:true}`; clearing the
  flag on its holder answers `409 caste_default_required`, and deleting the
  default caste requires `reassignTo` — the flag moves to the target together
  with its agents.
- Nests: the table `agent_nests(company_id, agent_id, project_id)` and
  `GET/PUT /api/myrmidon/companies/:id/agents/:agentId/nests` — the project list
  of one agent, empty meaning the whole company. A foreign project or a foreign
  agent is rejected as a whole (400/404), the write goes into the company
  journal.
- Matcher ports in `server/src/myrmidon/castes/index.ts`:
  `resolveTaskCaste(db, {companyId, issueId})` (task caste → project default →
  company default) and `agentNests(db, agentId)`, plus the SQL fragments
  `taskCasteKeySql` / `agentNestsAllowSql` for a one-query filter — the contract
  T1 builds on. Castes are no longer hard-coded in the swarm logic: `AGENT_ROLES`
  is not read there, the 12 vendor roles are seeded as the default caste and
  marked "template" in the UI.
- UI: the default radio and the agent/queue/free counters on the castes screen,
  the nests section on the agent card, IA v2 routes (`…/settings/castes`,
  `…/settings/models`; the old `caste-directory` redirects) and i18n keys in
  every locale.

### Release freeze gate sees the tag CI (1.6.5)

- `scripts/myrmidon/release/release-freeze.sh` now selects the tag CI by
  `myrmidon-ci-tag.yml` runs with `head_branch == the tag` (the pipeline that
  runs on the tag itself), with `myrmidon-ci.yml` main-branch runs of the
  same commit kept as a fallback. Previously the gate filtered on
  `myrmidon-ci.yml` only, so the verdict stayed "missing" forever and the
  release freeze never cleared even with a green tag CI.
- `scripts/myrmidon/release/release-body.mjs` now refuses a release body over
  GitHub's 125000-character limit BEFORE the publish step, naming the byte
  count, instead of dying at `gh release create` with a bare HTTP 422 after
  all CI gates already passed.

### Board measurement instrumentation: load lanes, api-load p95, pg_stat_statements, cpu-profile (PROCS-0.3A, stage 0 of OPE-5394)

- `server/src/myrmidon/monitoring/board-load/lanes.ts` — the load lanes of the
  board as an `AsyncLocalStorage` seam: `http_route`, `heartbeat_tick`,
  `chat_reconcile`, `execution_control`, `bot_reconcile`, `run_supervision`.
  Work outside every lane is reported as `untagged` instead of being spread
  over the lanes, `laneInterval()` wraps a periodic pass in its lane without
  touching its period or `unref`-ability, and `resolveLaneMetricsSource()`
  mirrors the process-metrics source seam.
- `server/src/myrmidon/monitoring/board-load/request-load.ts` — a bounded ring
  journal of finished `/api` requests and the p50/p95/p99/max summary per
  route over a window. Percentiles are nearest-rank (the reported p95 is a
  request the board actually served), route labels collapse ids
  (`/api/issues/<uuid>/comments` → `/api/issues/:id/comments`) and keep the
  words that name the endpoint, and `boardRequestLoadMiddleware()` tags and
  journals every request on the api router.
- `server/src/myrmidon/monitoring/board-load/cpu-profile.ts` — capture of a
  `--cpu-prof`-shaped profile through the board itself: `inspector` session,
  60 s ceiling, one capture at a time (`CpuProfileBusyError`), and the last
  capture retained in memory for download. Nothing is armed until an operator
  asks for a capture, so the default behaviour of the board does not change.
- `server/src/myrmidon/monitoring/board-load/pg-stat-statements.ts` — the
  top-N statements by total time read off `pg_stat_statements`, with the three
  ways it can be missing (`extension_missing`, `extension_not_loaded`,
  `no_privilege`) answered as a report the operator can read rather than as an
  error. Installing the extension stays part B.
- `server/src/myrmidon/monitoring/board-load/routes.ts` — the operator surface
  under `/api/myrmidon/board-load/*`: `lanes`, `api-load`,
  `pg-stat-statements` (each read behind board-org access), `cpu-profile`
  status/capture/download (behind instance admin; `MYRMIDON_CPU_PROFILE_ENABLED`
  set to `false` takes the capability off the board without a deploy).
- `server/src/myrmidon/monitoring/board-load/index.ts` — the mount point:
  `boardLoadApp(db)` next to the other myrmidon routers, plus the request-lane
  middleware in front of everything the api router serves.
- `server/src/myrmidon/monitoring/metrics/metrics.ts` — the exposition gains
  `myrmidon_board_db_queries_total{lane}` and
  `myrmidon_board_lane_busy_seconds_total{lane}`, read through the same
  guarded scrape as the process families (a throwing lane read zeroes the
  families and names them in `scrape_errors` instead of failing the scrape).
- `packages/db/src/query-observer.ts` — `createDb({ onQuery })`, which reports
  each issued statement to the caller's lane. Statements issued inside
  `db.transaction(...)` do not pass through it (documented limitation).
- Wiring: the heartbeat tick, the chat-reconcile fallback, the
  execution-control sweep and the bot reconciliation timer run in their lanes;
  the run-event write is `run_supervision` when nobody else owns the context.
- Tests: `lanes.myrmidon.test.ts`, `request-load.myrmidon.test.ts`,
  `routes.myrmidon.test.ts` and two cases in `exposition.myrmidon.test.ts`;
  `selfcheck.myrmidon.test.ts` counts the seven board-process families.

### A busy bot no longer holds the bot image rollout (BOT-ROLLOUT-SKIP-BUSY)

- The batch pass of `bot-image-rollout.sh` no longer waits on a busy bot: a bot whose agent is not paused/idle (or whose apply answers `deferred`) moves to a tail list, and its batch ends as soon as the free bots are switched — the next batch starts at once. Before this, one busy bot held its whole batch for the full `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (the rc.3 / rc.5 fact: 15 batches stretched to 3.5–4 h).
- After the last batch a tail pass retries the deferred bots until the same deadline; a bot that frees up (paused/idle) switches at once, inside the same run.
- Past the deadline an optional force stage can apply the still-deferred bots without the status gate. It is OFF by default (`MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC=0`): the reconciler drains only 300 s and then the maintenance interrupts a longer run, so an operator opts in with an explicit number of seconds. Without it, a still-busy bot stays deferred and the reconciler's periodic sweep completes it.
- A failed apply (HTTP error, failed job, unexpected outcome) after the card PATCH returns the card to its previous container block, so the card names the image it had before; it is skipped when the container already runs the release image. Only the card's container block is restored: agent keys the apply pass re-issued are not rolled back. A failed revert is logged and journaled loudly.
- The final report lists every bot still not on the release image with its reason (agent status / the deferred reason of the apply outcome), and the summary JSON gains `deferredBots: [{id, reason}]` (an addition only — no existing field renamed).
- Ported from main (PR #820) onto the 1.6.5 release branch together with the async-apply work of the branch: one script, no duplicate pass.

### The bot runtime entrypoint sets umask 077: run files are born owner-only (BOT-UMASK)

- `docker/bot-runtime/entrypoint.sh` sets `umask 077` right after its `set
  -euo pipefail` prologue, before the first mkdir/write of the bot tree, and
  logs one line (`[bot-runtime] umask 077 (run files owner-only)`). The umask
  is inherited by every child of the entrypoint (gateway → session →
  terminal/tool processes), so every file a run creates — scratch dumps,
  cache, tmp helpers written by plain shell redirection — is born `0600`
  (directories `0700`) without any cooperation from the workload.
- Why: every bot on a host runs as uid `10001`; the mode bits are the only
  barrier between one run's scratch/cache and another bot's processes, and
  the default umask 022 made run artifacts world-readable inside the shared
  uid. There is no `UMASK` environment variable and no pam-umask (no login
  session), so the entrypoint is the only point that covers all children.
- Tested in `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`
  (`docker/bot-runtime/entrypoint.sh umask 077` describe): a static ordering
  check that the umask line precedes the first file write, and a behavioural
  probe that exec's a stub hermes recording its inherited umask — `0077`,
  with a file born `0600` and a directory `0700`. The probe is red on the
  base revision and green with the fix.

### Fix: chat reconciliation work gates failed on every call (DB-PERF-C-P5)

- The cheap work gates bound a JavaScript `Date` as a parameter inside raw
  `sql` templates (`next_attempt_at <= $1`, `updated_at > $1`), which the
  postgres-js driver cannot serialise. Every gate probe threw, so the log
  filled with `Failed to reconcile chat run milestones` and `Failed to
  reconcile chat publications` roughly every 30 seconds. Timestamps are now
  bound as ISO strings with an explicit `::timestamptz` cast. A regression test
  runs the gates against a real PostgreSQL.

### Cross-family judge for reference-task scoring (EVALS-JUDGE-FAMILY)

- The judge of an eval run is now picked from a model **family different from the evaluated agent's** model. `server/src/myrmidon/evals/model-family.ts` maps model ids to families (qwen, gpt, claude, glm, deepseek, kimi, gemini, llama, mistral, yi, phi, o1, o3 …; the table is extensible in code). Matching is token-anchored: a substring counts only at a token boundary (`deepyida` is not yi, `chaos` is not o3, `mystique`/`dolphin` are not phi).
- A prioritized judge list (UI setting / env forced override) is scanned top-down; the first entry whose family differs from the agent model family judges the run. Default list: the free models this deployment's gateway actually serves (`qwen-plus-free, qwen-max-free, qwen-turbo-free` — `SERVED_FREE_GATEWAY_MODELS`, the same trio `DEFAULT_EVALS_MODEL` verifies); a paid model judges only when the operator explicitly lists it.
- A gateway failure of the selected judge no longer aborts the run: the next candidate is tried, and when every priority candidate fails, the configured `MYRMIDON_EVALS_MODEL` gets a last chance. The run fails only if the whole chain fails; the last error is then re-thrown.
- When no cross-family candidate exists, the run is still scored and every task carries `sameFamily: true` in the result plus a server-log warning — the owner sees that the judge rated "its own". The same flag marks tasks judged on the last-chance configured model.
- The evaluated agent model and the judging model are reported per task; the agent model is resolved at run time from the subject role (`subjectModelFor`), so no schema change is needed.
- Guides: [evals-judge-family-selection.md](../guides/evals-judge-family-selection.md) / [RU](../guides/evals-judge-family-selection.ru.md).

### A queued run always says why it waits; non-startable runs are cancelled; the operator gets a `queue_stall` card (F-09)

- `server/src/services/heartbeat.ts`: every silent exit of the queued-run sweep
  now leaves a reason on the run (`waitReason`): `scheduling_suppressed` when
  the sweep is suppressed by scheduling, `maintenance` while the agent's
  maintenance window is open, `agent_not_invokable` for an agent that is not
  invokable without being cancelled. The runs the admission gate leaves queued
  carry the gate's reason, written in the same pass before the claim phase
  (the last observed denial, `global_cap` when none was recorded). A run that no
  exit explained keeps `waitReason = null` on purpose: the `queue_stall` card
  names it instead of a guessed reason.
- `server/src/modules/run-dispatch/domain/policy.ts`: a queued run whose task
  is in `backlog` is cancelled with the new error code
  `queued_run_issue_not_startable`, before the per-agent ceiling and fair-share
  exits, so a busy agent loses its backlog runs too. A run whose task is hidden
  stays queued (the Summarizer pattern).
- `server/src/services/attention.ts` + `server/src/myrmidon/stuck-queued/attention.ts`:
  new attention kind `queue_stall` — a queued run older than the stall
  threshold *and* without a `waitReason` raises a card whose subject is the run
  (`kind: "run"`, sourceId = run id), so several stalled runs never collapse
  into one card.
- `server/src/services/decision-queues.ts`: the `queue_stall` card resolves
  through the queue decisions; its verbs are `inspect` (open the run) and
  `dismiss` (the notice goes away, the run stays queued), both keyed by the run
  id the card was raised for.
- `server/src/myrmidon/run-admission.ts`: admission denials are counted
  (`admissionDenials`: total, byReason, lastReason, lastAt) and exposed on the
  runtime-limits view.

### Owner decision cards now expire on a TTL and close themselves (1.6.5-F21-B)

- `server/src/myrmidon/owner-reply/ttl-sweep.ts` — a scheduler-tick sweep:
  a pending owner `request_confirmation` card older than
  `MYRMIDON_OWNER_CARD_TTL_MS` (72 h) is closed in the first pass. A card with
  `payload.silenceMeansRecommended: true` outside the guarded classes
  (`money`, `external_world`, `deploy`) is resolved by its recommended option;
  every other overdue card goes `expired` with the "expired without an
  answer" comment on the task and ONE wake of the author with the reason
  `interaction_expired` (the `agentWakeupRequests` idempotency key limits the
  wake to one per card, repeat passes wake nobody). The sweep derives the
  delivery metadata (`sentTo`/`sentAt`/`answeredAt`) from the card itself and
  the existing owner-message comments, and folds it into the card payload.
- `server/src/myrmidon/owner-reply/attention.ts` — the attention-feed card
  «owner cards pending: N (older than 3 days: M)», computed live from the
  same interaction rows; a new `owner_pending_card` source kind.
- Tests: `ttl-sweep.myrmidon.test.ts` (the pure classification, TTL gate,
  decision-class boundary, payload pack, env parsing) and
  `ttl-sweep-sweep.myrmidon.test.ts` (embedded PG: overdue cards closed in
  one pass, exactly one wake, silence resolution, the money-class guard, the
  concurrency compare-and-set).

- hermes_gateway adapter now reconciles Paperclip-managed skills before POST
  /v1/runs: the run carries its desired skills in the paperclip_skills body
  field, the gateway materializes them into the agent profile's
  skills/paperclip-managed segment before the model starts, and the run fails
  with "Cannot start without the required Paperclip-managed skills" unless
  every desired entry is verified on the gateway side (re-read from disk).
  An unassigned skill is removed: an empty desired set is sent as [] and the
  gateway clears the profile's managed segment. Previously gateway
  agents silently ran without any company skills.

### Hermes profile skills are verified by fact, migrated, and never shared (HERMES-SKILLS-DELIVERY-CHECK)

- `reconcileHermesPaperclipSkills` proves the result instead of trusting the install
  calls: it reads the agent's skills directory again and names every desired skill whose
  link is absent, broken, foreign or pointed at the wrong source. A run that cannot
  deliver a desired skill now fails at start with the skill name and the reason instead
  of running without it.
- Reconcile migrates what an earlier rollout left behind in a profile: a link that
  resolves into the shared `~/.hermes/skills` tree is relinked to the managed source of
  the same skill, and a link whose destination is gone is moved to
  `<HERMES_HOME>/skills.pre-myrmidon/<name>.pre-myrmidon-<date>` — kept as evidence,
  never deleted — so the managed skill can take its place. Both steps apply to profiles
  only; without `HERMES_HOME` the agent keeps the vendor behaviour in the shared scope.
- The profile race is pinned by tests: two agents with different `HERMES_HOME` reconcile
  in parallel without overwriting each other's links, and a third agent without
  `HERMES_HOME` neither breaks nor gets broken by the profiles.

### The media MCP block joins a bot profile only when the bot's card carries a media token; without one the board shows a «media not connected» attention card instead of HTTP 401 noise (1.6.5 F-11 ч.A)

- Before this change the `media` MCP server (the sidecar of `tools/media-mcp`)
  was on the static per-card MCP list of 31 bots that had no token, so every
  media call returned `HTTP 401` — about 1 048 log lines an hour across the
  fleet. The profile compiler now decides per bot
  (`server/src/myrmidon/bot-containers/media-mcp.ts`, `profile-compile.ts`)
  on the single token source: the card env entry `MEDIA_TOOLS_TOKEN`
  (`mediaTokenFromEnv`, the frozen MEDIA-PROVISION contract of
  `media-acl-export.ts` — the same entry the board-side exporter hashes into
  the facade's `bots.json`). When the entry resolves non-empty, the profile
  gets the `media:` block in `hermes/config.yaml` plus `MEDIA_TOOLS_URL` in
  `hermes/.env`; the token itself travels in the card env, so the compiler
  never writes or resolves a second secret. The URL comes from
  `MYRMIDON_MEDIA_MCP_URL` (default `http://media-mcp:8080/mcp`).
- A statically declared `media` MCP server (a card's or the instance-wide
  `MYRMIDON_BOT_MCP_SERVERS`) no longer survives a missing card token: the
  compiler filters the name out and the compiled profile has no `media`
  server at all. Operators should still remove the static entry from the
  settings — until then the filter is what stops the 401 flood.
- Without a token there is no media block and no media env, so the bot never
  calls the sidecar and the 401 stream stops. Instead the compiler records a
  per-pass «media not connected» signal; the attention feed turns it into one
  card per bot of the new source kind `bot_media_mcp` (severity `low`,
  advisory rank 13 — one step below `model_fallback_alert` (medium)), cleared automatically as
  soon as a pass sees the token. The bot-side client
  (`tools/media-mcp/bot-scripts/media_client.py`) raises
  `MediaNotConnectedError` before any HTTP request when `MEDIA_TOOLS_TOKEN`
  is empty and the bot is not in peer-auth mode, and maps an unexpected 401
  to the same «media is not connected» state — a configuration state, not a
  runtime error.
- Peer-auth bots keep working, but they lose the `media` MCP block too: the
  block is emitted only when the card carries a bearer token
  (`MEDIA_TOOLS_TOKEN`). A bot that authenticates to the facade by `peer_host`
  (auth.py, `config.example.json`) sets `MEDIA_TOOLS_PEER_AUTH=1` in its card
  env — it calls the facade directly (its scripts already know the endpoint),
  without a bearer token; the client then sends no Authorization header and
  does not raise. `MEDIA_TOOLS_PEER_AUTH` only affects the bot-side client;
  the compiler does not read it and no `media` block is emitted either way.
- The media service registry (`bots.json`) has exactly one owner: the
  board-side exporter of MEDIA-PROVISION (`media-acl-export.ts`), which
  rewrites it from the cards and stores sha256 digests. The compiler and the
  bot scripts consume the registry's contract; no second generator exists.

### Gateway run reattach is lease-guarded and periodic (T1.6)

- A board process no longer steals gateway runs that belong to a live
  controller. The reattach sweep (startup and the new 30-second periodic
  pass) only claims runs whose legacy controller lease is absent or expired;
  a live lease under another boot id is reported as skipped and left to its
  owner. This removes the "Legacy controller lease lost" abort when a second
  board process starts alongside a running one.
- A graceful hot restart still adopts its predecessor's runs immediately:
  the departing process records its controller boot id in the restart-intent
  shutdown snapshot, and the successor's startup pass marks it adoptable, so
  no run is waited out or duplicated.
- When an executor process dies, its gateway runs are reattached on a live
  process by the periodic pass once the lease expires — before the orphan
  reaper's stale window finalizes them as "Process lost".
- Single-process boards keep the previous behavior: startup reattach runs
  exactly as before, plus the same sweep now also ticks periodically.

### 1.6.5 STACK-UPDATES: optional GitHub token for the stack release check

- `MYRMIDON_STACK_GITHUB_TOKEN` (secret class): an optional read-only GitHub
  token (fine-grained PAT with public-repo read, no scopes needed) for the
  scheduled and manual stack release check. When set, every api.github.com
  request of the check (release/tag lists and the compare API — one shared
  JSON port) carries `authorization: Bearer <token>`.
- Anonymous behaviour is the default: unset or blank env → no authorization
  header, the 60 requests/hour per egress IP budget. A valid token lifts the
  budget to 5000 requests/hour.
- An invalid or revoked token is ordinary data: GitHub answers 401/403 and the
  status is recorded per component as an HTTP error, the previous cache is
  kept — exactly like any other HTTP status. The value is never logged and
  never returned by any route.

### Stale-block watchdog: an event reason can carry a deadline (BLOCKER-WAKE-LOOP B)

- `unblockDescriptor.reasonRef {kind:"event"}` accepts an optional `dueAt`
  deadline. Once it passes, the reason is judged dead even while the
  `isEventStillSet` seam still reports the gate set — an unwired gate key can
  no longer hold a task blocked forever (the seam default is still-set).
- A deadline lift is reported as "the event deadline passed" in the system
  comment and the activity row. Event reasons without a deadline and all
  `kind:"date"` reasons are judged exactly as before (backward compatible).
- New executor-facing section "Waiting on an external condition" in
  `docs/myrmidon/guides/stale-block.md` (+ Russian mirror): express a date,
  tag or event wait as `reasonRef {kind:"date"|"event", dueAt}` or an issue
  monitor `executionPolicy.monitor.nextCheckAt` — never a homemade
  blocked↔todo wake loop; the watchdog is the ceiling, the monitor is the
  alarm clock.

### 1.6.5 F-07 /agents: grouped agent list with a role, a live status and default aliases

- `/agents` in a bridged Telegram DM prints one group per direction instead
  of a flat list: the title comes from the card itself
  (`agents.metadata.telegramGroup`) or, when it is absent, from the agent-name
  prefix (`adm-*` → Infrastructure / Myrmidon, `bbq-*` → bbq, `work-*` → work,
  the rest → Other). Group titles are catalogue strings (en + ru).
- Every line names the agent, its role (`agents.title`, one line), its live
  status (`agents.status`: idle / running / paused, localised) and its aliases;
  the current addressee is marked.
- Written-off cards no longer take a slot: terminated, pending-approval and
  retired-by-name (`-retired` suffix) agents, plus service cards without a live
  board presence, are hidden. Paused cards stay out of the default list and
  come back on request (`listCompanyAddressableAgents(..., { includePaused: true })`),
  and a group holding paused cards says how many wait. The fixed
  60-agent cut-off is gone — the Telegram transport splits a long reply itself.
- Default aliases: an agent without `telegramAliases` answers to the last
  dash-separated segment of its name, lower-cased (`qa-dev-eng-15` → `15`);
  collisions get `-2`, `-3` (`work-runner-2` → `2-2` when `2` is taken). It is
  computed on read only — nothing is written to the card — and `/to`,
  `/who` and `@mention` all resolve it through the same loader.

### 1.6.5 F-26 SWARM: board events reach the matcher

- The issue service (`services/issues.ts`) calls `notifySwarmIssueEvent`
  (`server/src/myrmidon/swarm-claim/events.ts`) after a create and after an update: a ready
  task created without an owner, and a change of status, of the owner (taken off), of the
  caste label or of the blockers on such a task, go to `matcher.forIssue`. The hook never
  throws into the caller and never blocks the write; inside someone else's transaction the
  pairing waits for the commit.
- Lifting an agent's pause (`resumeAgentAfterPause`) calls `matcher.forAgent`.
- Turning the swarm off takes effect without a restart: the matcher is built per event and
  reads the switch at that moment; a swarm that is off does not touch the database.
- `claimNextTaskForAgent` and `POST …/swarm-claim/claim` take the task through
  `matcher.forAgent` (an explicit pull: the agent's live run does not make it busy and nobody
  is woken) instead of inserting a lease of their own.
- The supervisor's lease release (`rebalance.ts`) now takes the owner off the task and calls
  `matcher.forIssue`; "wake the next agent of the role by load" is gone — it produced the same
  pair again and the `reassigned → skipped` cancellation.

### 1.6.5 F-26 SWARM (final review): castes in the supervisor rebalance, pilot leftovers, the real wake path

- The supervisor's rebalance matcher (`swarm-claim-supervisor/routes.ts`) is built with the caste
  directory (`createCasteDirectoryReader`), like the sweep and the claim API: a task released by the
  supervisor is not handed to an agent of a `swarmEligible=false` caste and respects the caste ceiling.
- Pilot leftovers are gone: the subtitle and the pilot report columns in the supervisor page locales,
  the "swarm claim pilot" paragraph and the `swarm_claim_queue` wake in the `paperclip` skill (now: the
  board itself assigns a task to a free agent of the caste and wakes it on that task), README lines.
- An embedded-Postgres test with the real wake path: the matcher assigns the task, the wake goes
  `queueIssueAssignmentWakeup` -> `heartbeat.wakeup`, a run for the task is created and is not closed as
  `skipped` / `issue_reassigned`.

### 1.6.5 F-26 SWARM (review of 09.10): the loop, the assignment transaction, castes and the host gate, a lease with a wake

- The loop on the release path is closed: a freed agent is not offered the task whose run has
  just ended (`excludeIssueId`); its own assigned `todo` task is woken only while idle pickup is
  on (instance switch and the agent card) and out of the company's shared per-minute wake
  budget. A task inside its cooling window is neither assigned nor woken: the matcher asks the
  product's one cooling rule — `isIssueCoolingDown` of `wake-task-guard.ts` (F-26 T5, design
  §4.3; the base and ceiling of the window are `general.swarm`) — through the adapter
  `swarm-claim/cooling.ts`. The matcher keeps no rule of its own. The rule now reads not only
  runs with `invocation_source = 'automation'` but also runs woken for `swarm_matched` /
  `swarm_claim_queue` / `idle_pickup` whatever their source: the matcher wakes the assignee
  through the assignment path (`assignment`), and a task it keeps handing out that keeps
  failing cools down too. A person's manual runs never start a cooling.
- The matcher's assignment is one transaction: a lock on the task row, the lease, the
  assignment through the issues service (its checks, its event and the `issue.updated`
  activity). The wake is queued after the commit with `rethrowOnError`; when it cannot be
  queued (an error or an admission refusal) the assignment and the lease are rolled back and
  `issue.swarm_matched_rolled_back` is logged. "Assigned, leased, no run" can no longer happen.
- The caste directory (`swarmEligible`, the caste ceiling) reaches the periodic pass and the
  release path (`createCasteDirectoryReader`). The release path and the re-match of an expired
  lease go through the host's real run-admission gate (memory and CPU); with the gate closed an
  expired lease is not released and its owner stays.
- A lease with no run does not expire while a wake for its task is in flight (`queued` /
  `deferred_issue_execution` / `claimed`, not parked on a hold). "Has a live run" at expiry
  means a live run of THIS task, not any run of the agent.
- Only an agent the wake layer will accept enters the matcher's pool: invokability
  (`evaluateAgentInvokability` — status and the reporting chain), the maintenance window and the
  budget block (`swarm-claim/availability.ts`). A wake refused anyway hands the same task to the
  next agent of the pool in the same pass — one agent that cannot be woken no longer starves a
  task or writes a rollback every 30 seconds. A task whose project hit its budget (the same block
  the wake layer checks with the task's issue and project) is skipped with no lease, wake or
  rollback; the agents stay free for the rest of the caste's queue.

### 1.6.5 F-26 SWARM: the supervisor's pilot report is removed

- There is no swarm pilot any more, and with it no "pilot vs BASELINE" report: removed
  `swarm-claim-supervisor/pilot-report.ts`, the route
  `GET …/swarm-claim/supervisor/pilot-report`, the variable `MYRMIDON_SWARM_PILOT_BASELINE_DOC`,
  the `pilotReport` client in `ui/src/api/swarmSupervisor.ts` and the "Pilot vs BASELINE" tab on
  the supervisor page. The role overview, the queues, the leases and the manual lease release stay.

### 1.6.5 SWARM-SETTINGS: the swarm has one switch, there is no pilot

- Instance → General → **"Self-organisation (swarm)"**: one `Swarm enabled` switch (off by
  default; in production it is turned on by `MYRMIDON_SWARM_CLAIM_ENABLED=1` or here). Which
  agents take part is decided by the caste directory (the caste's `swarmEligible` flag) and the
  switch in the agent's card (`swarmQueueEligible`), nothing else.
- Removed: the "Roles in scope" and "Companies in scope" fields, the "Idle wake batch" field,
  the variables `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES`, `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH`, the function `orderIdleWakeAgents`, and the hardcoded rule "an agent others report to takes no tasks"
  (`hasDirectReports`). A lead gets tasks when its caste is `swarmEligible`; to keep it out,
  give it a caste with the flag off or turn the switch off in its card.
- The swarm settings stay under `general.swarmClaim` (`general.swarm` is the F-26 wake-guard
  block: the run-only-with-a-task gate and the cooling window). A value saved by an earlier
  build with the pilot fields is read as is: the extra fields are dropped and the switch is not
  lost.
- The release reason for leases freed when the swarm is switched off is now `swarm_disabled`
  (was `pilot_disabled`); old activity rows stay as they were.
- How to check: turn the switch on and watch the status line under it —
  "claimed in the last hour" grows, "cancelled in the last hour" does not. Details in
  [guides/swarm-claim-settings.md](../guides/swarm-claim-settings.md).

### 1.6.5 F-26 SWARM: the board pairs a task with a free agent itself

- The board now has a matcher (`server/src/myrmidon/swarm-claim/matcher.ts`, design §3): for a
  ready task it finds a free agent of the task's caste in its nest, writes the lease
  (`issue_claims`) and sets the assignee in one transaction, and only then wakes that agent —
  a wake always carries the id of a task that already belongs to it (key
  `swarm_matched:<issueId>`). No free agent — nobody is woken. A pick refusing one task does
  not close the queue.
- The matcher is wired into the production path: the sweeper's safety net
  (`swarmClaimSweeper.sweep()`) calls `matchCompany` instead of the old idle pass; the release
  path of a run (`heartbeat.ts`) calls `forAgent` for the freed agent instead of idle-pickup
  while the swarm is on; a lease expired on a `todo` with no run behind it takes the owner off
  the task (activity `issue.swarm_claim.unassigned_on_expiry`) and re-matches it; the explicit
  pull `POST …/swarm-claim/claim` goes through the same `forAgent`.
- The agent's own assigned task comes first: it is woken on a ready task of its own that has
  neither a live lease nor a wake in flight. Assigning only `assignee IS NULL` tasks was a
  regression — such a task never reached its own agent again.
- There is no rotation, and none is written: the pick is the scent (T10), a full tie goes to
  the smallest `agents.id`; the "longest idle first" order is gone from the core.
- Removed with the pass: `sweepIdleWakes`, `idle-wake.ts`, `idle-queue.ts`,
  `MYRMIDON_SWARM_IDLE_WAKE_BATCH` and its read in `sweep.ts`, `wakeNextAgentForIssueRole`
  (releasing the lease and re-matching replaces "wake the next agent of the caste").
- The pilot is removed entirely (see the separate swarm-settings entry): the "Roles/Companies
  in scope" fields, the variables `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` / `_COMPANY_IDS` and
  `idleWakeBatch` are gone from the schema, the UI and the env. The swarm is turned on by one
  switch; whether an agent takes part is decided by the caste directory (`swarmEligible`) and
  the switch in the agent's card.
- The matcher has no order, routing or cooling rule of its own — it asks the ones the product
  has. A caste's pool is read with the F-27 queue SQL: the caste of an unassigned task is
  `unassignedTaskRoutedToRole` (the task's caste → the project's default caste → the `role:`
  label → the default role), the order is `swarmQueueOrderBy` (P0 → effective pheromone
  strength: strength + aging − the penalty for failed runs from `failedRunsDerivedSql` → age →
  id). The matcher walks the rows in that order and never re-sorts them. The cooling is
  `isIssueCoolingDown` of `wake-task-guard.ts` (F-26 T5) through the adapter
  `swarm-claim/cooling.ts`; a task inside its cooling window is neither assigned nor woken.

### The owner's answer in a chat does not wait for the automatic-run floors (1.6.5 OWNER-CHAT-ADMISSION, rc.7)

- An answer to a message the owner wrote in a chat (Telegram or web) is admitted by `minFreeMemoryMb`, the hard floor, applied to the server container's free memory and to the host's `MemAvailable` (less the budget of runs still starting). The host floor `minFreeHostMemoryMb` and the CPU ceiling `maxHostLoadPercentPerCore` pace the automatic runs (schedules, monitors, background follow-ups) and no longer hold the owner's own turn back: with the host between `minFreeMemoryMb` and `minFreeHostMemoryMb` the answer starts at once while the automatic runs stay `queued`; on a host below `minFreeMemoryMb` it waits too.
- The turn is recognised by its durable inbound chat receipt (`chat-inbound:…`, actor `user`) that the queued run points at; the chat's own "retry the failed run" button and a chat wake opened by a system actor are not the owner's turn. The sweep ranks the owner's turns ahead of every automatic run, whatever task state either has (a turn whose task waits for dependencies keeps its place behind the ready runs), so a turn that still waits is the first one started. The idempotency key prefix `chat-inbound:` is reserved: the public agent wakeup routes reject it (`422`).
- The chat notice is staged only while the turn really waits, i.e. while `minFreeMemoryMb` holds it (on the container or on the host); the old text "the server is short of memory" no longer appears for a merely busy host. The notice says the answer is first in the queue and that the queue is re-checked every 15 seconds; it does not promise a start time. Nothing changes for a run that stays `queued`: its wait reason still reads `host_memory` / `host_cpu` / `memory`.
- The pipeline, the operator's card and the queue screen say who waits at which value: the host floors and the CPU ceiling wait for the automatic runs, `minFreeMemoryMb` waits for everything.

### Multi-process board mode (BOARD-PROCESSES): operator documentation

The board can run as several Node processes in one container: one worker holds
the loops and singleton state, and N api children (1..4) serve HTTP with
`reusePort`. The mode is set in the interface at Instance settings → «Процессы»
and applies without a restart. The default stays `single` (one process does
everything) — nothing changes unless the operator explicitly switches to
`split`. An emergency fallback `PAPERCLIP_PROCESS_MODE=single` forces the
one-process mode on boot, bypassing the database. Documentation of the mode,
its settings, ports, and dockergate implications is in deploy.md, SETTINGS.md,
and dockergate.md.

### Prompt-budget advice and deep analysis (PROMPT-BUDGET part C)

- The agent card's Overview tab carries a "Prompt budget advice" panel: the last run's
  prompt breakdown by parts, a concrete recommendation for every part whose share crosses
  30% (Critical from 50%; below 2000 prompt tokens no advice is produced — the thresholds
  are code constants, not settings), and a "Deep analysis" button that files a task for a
  cheap-model optimizer agent. The optimizer drafts instruction edits as a comment on that
  task; nothing is scheduled and nothing is changed automatically.
- The optimizer agent is the instance general setting `promptBudget.optimizerAgentId`
  (no environment variable); the deep POST answers 422 with a clear message when it is
  absent, not a uuid, the analysed agent itself, or not an agent of the company. Dedup:
  one deep task per target agent per run.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member), `POST .../advice/deep` (board). Operator guide:
  [guides/prompt-budget-advice.md](guides/prompt-budget-advice.md).

### Review routing by pull-request events (REVIEW-ROUTING-PR-A)

- The review-routing sweep now also watches pull requests, so a review task is
  born the moment a PR turns green instead of waiting for the next manual
  "work through the PR queue" round. The shared `reviewRouting` settings gain a
  `prWatch` block (`enabled`, `repositories`, `maxOpenReviewsPerReviewer`,
  `maxNewAssignmentsPerPass`, `pollIntervalSec`, `steward.{enabled, roles,
  maxMergesPerSteward}`); every field absent or malformed falls back to its
  default without blanking the sibling keys, the same rule the outer block
  already follows.
- A pass resolves each open PR's head through GitHub (combined commit status —
  no statuses at all counts as green for repos without CI — plus the review
  decision derived from `GET /pulls/{n}/reviews`: latest verdict per reviewer on
  the current head; the REST PR object has no such field). The status read is
  cached per (repo, number, head sha) for 300 s, reviews are read fresh. A green head
  with no verdict on that exact head gets a review task assigned to the
  least-loaded eligible reviewer (board load and open PR-review load both
  capped, never the PR author's linked agent, never a non-invokable agent); an
  APPROVED green head additionally gets a merge-steward task for the
  least-loaded agent of the steward roles. Tasks are created through the normal
  issue path (activity log, checkout locks, review-stage machinery), carry a
  `pull_request` work product stamped with the head sha and the routing kind,
  and wake their assignee the same way board routing does.
- Pushing a new commit supersedes the open task of the same lane: it is
  cancelled with a system comment naming the new head, and the new head gets
  its own task on the same pass. Closed or merged PRs are left to PR-sync — the
  lane never settles them. When GitHub is unreadable the lane is inert: an
  unknown head creates nothing, closes nothing and counts no failure.
- New attention cards when nobody is eligible: `no_reviewer` for a green PR
  without a free reviewer, `no_steward` for an approved PR without a free
  steward, each carrying the PR coordinates (repository, number, head) for the
  settings screen and the attention desk. Activity actions
  `issue.review_routing.pr_task_created` and
  `issue.review_routing.steward_task_created` mark every created task, and the
  sweep result gains `prScanned`, `prTasksCreated`, `stewardTasksCreated` and
  `prSuperseded` counters.
- `pollIntervalSec` throttles only the PR lane; the board-task lane keeps its
  existing 60 s behavior, and a settings change applies on the next pass
  without a restart.

### An agent starts its most important ready task first, and starvation no longer outranks it (1.6.5 RUN-PRIORITY-PICK)

- The per-agent pass of the run sweep now starts the agent's **most important
  ready task** instead of merely the best of the runs already standing in the
  queue. An event run on a low-priority task (a comment, `issue_continuation_needed`,
  `execution_hold_cleared` and the like) no longer holds the agent while its
  critical task — assigned, ready and without a run — waits for a slot it never
  entered: the task that never got a run was the one the comparison could not
  see, because the single selection by task importance ran only for an agent
  without a live run. The pass reads the agent's top ready task with the idle
  pickup's own rules, compares **task** importance — the issue-priority step
  plus the pheromone strength, never the composed run weight, so a
  long wait can never outrank it — and when it is strictly more important than
  the best standing run, wakes it and leaves the standing runs queued with the
  wait reason `higher_priority_ready` (`Более важная готовая задача агента` /
  `the agent's more important ready task goes first` in the runs panel, en/ru).
  Only a real wake reorders anything: an exhausted wake budget, a paused agent,
  a coalesced duplicate or the idle-pickup behaviour switched off all fall back
  to the pass's own order, so the sweep can never hold an agent without giving
  it work instead.
- An operator's Stop stays durable: the cancelled task is not pushed back into
  the queue by the sweep alone — it becomes fair game again only on a newer
  event on that task.
- "Starved for longer than the limit" no longer means "above every critical
  task of any role": the starvation escape lift is bounded by the distance to
  the next issue-priority step, so it lifts a run inside its own importance step
  and can never reach a more important task, whatever the wait. A run of the
  heaviest step keeps the escape lane — nothing is more important than a
  critical task — and aging keeps its own, unchanged budget.

### Merge steward refreshes the head with update-branch and waits for green CI (UPDATE-BRANCH-STEWARD)

- The review-routing merge steward lands approved PRs in the open. When the
  sweep sees an APPROVED green head, the steward task it creates carries an
  explicit three-step landing path: `gh pr update-branch <repo>#<n>` (GitHub's
  `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` — a no-op when
  the branch is already current), then waiting for the refreshed head to go
  green, then `gh pr merge <repo>#<n> --merge`.
- The wait is enforced by the lane's own head rules, not by new code: the
  update-branch push moves the PR head, so the review verdict must be
  re-checked on the new head (the resolver filters reviews by the current head
  sha), and the old steward task is superseded and cancelled the moment the
  recorded head stops matching. The sweep creates a fresh steward task for the
  new head only when it turns green with APPROVED on it — which is precisely
  "wait for green CI on the updated branch, then merge".
- The freshness guarantee lives in the open: the `main-protection` ruleset
  runs with strict required status checks and GitHub refuses to merge a PR
  whose branch is behind its base, so update-branch before the merge is what
  keeps the landing head — and after it main — green. The refresh works on any
  repository, including `itkadr-git/myrmidon` (a personal account, where
  platform-side ordering features do not exist).
- No settings changed and no new environment variables: the merge-steward
  block (`prWatch.steward`) keeps its shape; only the action the created
  steward task instructs changed.

### Voice STT runtime settings: full contour over the API (VOICE-STT A1-fix)

- `PATCH /api/myrmidon/companies/:companyId/voice-stt` now accepts `baseUrl`,
  `keySecret` and `deepgramKeySecret` on top of the previous fields
  (`enabled`, `backend`, `model`, `language`, `diarization`,
  `maxDurationSec`): the whole STT contour (gateway/Deepgram address and the
  secret names) can be set per company without an env change or a restart.
  The fields share the null-semantics of `model`: an explicit `null` clears
  the stored value back to the environment default, an omitted field keeps
  the current one. The GET response (the `settingsView`) keeps `baseUrl` but
  does not return `keySecret` / `deepgramKeySecret` — secret names are
  write-only over the API, secret values are never returned. See
  [SETTINGS.md](SETTINGS.md), the VOICE-STT section.

### Central session history for gateway bots (MEMORY-CENTRAL-B)

- With `MYRMIDON_BOT_CENTRAL_HISTORY=1` (off by default) the Hermes gateway
  adapter saves the final output of every completed run as a session-turn record
  in the bot's own hindsight bank (documents keyed by the session key, tag
  `myrmidon-session-history`) and on the next wake of the same session restores
  the last turns (default 10, card field `centralHistoryMaxTurns`) into the wake
  input under a visible "restored conversation history" header. Recreating the
  container volume no longer loses the history.
- Store address, bank and key resolve in order (first hit wins): card fields
  `adapterConfig.centralHistoryUrl` / `centralHistoryBankId` /
  `centralHistoryApiKey` / `centralHistoryMaxTurns`; then
  `MYRMIDON_BOT_HINDSIGHT_API_URL` / `MYRMIDON_BOT_HINDSIGHT_BANK` /
  `MYRMIDON_HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY`; then the same names in the
  server environment. The bank defaults to the card's `hindsight.bankId`.
- Off or unconfigured, vendor behaviour is untouched. While on, a store failure
  never blocks a run (a failed read continues without the restored block, a
  failed save is logged). Only the redacted final output is stored, and the
  restored block is bounded by turn count and size.
- New: `packages/adapters/hermes/src/gateway/server/central-history.ts` and its
  suite; `execute.ts` gains three marked call sites.

### Build offload C: dev-variant bot containers get DEVBUILD env and the build-server ssh key (BUILD-OFFLOAD C)

- New board settings `MYRMIDON_DEVBUILD_HOST` / `MYRMIDON_DEVBUILD_USER`
  (default `devbuild`) / `MYRMIDON_DEVBUILD_BASE` (default `/srv/devbuild`).
  When HOST is set, every NEW dev-variant bot container (`myrmidon-hermes-dev`
  images, detected by the image reference's last segment) receives
  `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` in its container env — an
  internal hostname and paths, not secrets — plus a read-only mount of the
  build server's ssh key at `/opt/devbuild-ssh`; the key's host directory is
  taken from `MYRMIDON_BOT_MOUNT_SOURCES` (an entry ending in `devbuild-ssh`).
  The create body always carries `Env` (`[]` when the feature is off).
- The mount point `/opt/devbuild-ssh` is added to `RESERVED_CONTAINER_PATHS`:
  a card's own `extraMounts` cannot take it over. Secrets never travel in the
  container `Env` — docker inspect would disclose them; keys travel as files.
- dockergate learned the `Env` list of the bot create body: empty or exactly
  the three `DEVBUILD_*` entries in builder order, anything else is denied
  (`deny.JSONUnknownKey`/`deny.JSONValue`); contract fixtures regenerated.

### Flag-only guardrail detectors for run output (1.6-GRD, part A)

- New `guardrail_events` journal (migration 0311) plus a board-only read route:
  the secret/pii detectors fire on run output and record a flag-only event.
  The stored snippet has every detected secret/PII fragment replaced by a
  `[REDACTED:<subtype>]` placeholder (also in the activity log), is at most
  200 characters, and a run journals at most 20 events. Deleting a company
  removes its events; deleting a run keeps them with an empty run. Off by default; enabled per instance
  with `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED=1`, detector subset with
  `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` (csv of `secret,pii`).

### Model-provider registry syncs with the LiteLLM gateway (MODEL-PROVIDERS B)

- Part B of the model-providers epic: the enabled models of the company
  provider registry (part A) now propagate to the LLM gateway. At startup each
  company whose store holds the gateway admin key registers its enabled models
  in LiteLLM, reclaims stale registrations of its own provider credentials and
  re-applies the model allowlist of every agent gateway key; the
  enable/disable, key-rotation and provider-removal routes then propagate the
  same changes live. The gateway is configured with the single documented pair
  `MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` — the
  latter is the NAME of a company secret, the board authenticates with the
  resolved VALUE, and either unset keeps sync fully off (one skip line at
  startup, the provider routes behave exactly as part A). Requirement: the
  gateway runs with `STORE_MODEL_IN_DB=true` — model registrations reference
  provider credentials as `secrets/<name>`, which that mode resolves in the
  gateway's own store.
- A gateway failure during a live propagation answers 422
  `litellm_sync_failed`: the database state stays the source of truth and the
  gateway converges on the next mutation pass or the startup reconciliation.

### Agent pause by grant (ADMIN-AGENT D)

- `POST /agents/:id/pause` now authorizes agent actors through the same
  direct-grant ladder as resume: an agent holding `agents:configure` may
  pause an agent of its company, while `agents:suggest-changes` and
  ungranted peers stay denied. Board actors keep the previous semantics
  unchanged, and the pause activity entry now records the real acting
  principal (agent, run, API key) instead of a board placeholder.
  Drain-vs-cancel semantics are untouched.

### Wake resurrection for rejected wakeups (WAKE-STALL-ROOT A)

- A wakeup rejected by the board with `execution_reconciliation_required`
  is executed once after the execution reconciliation finishes (one bounded
  retry) instead of being lost. Adds `resurrectionCount` to
  `agent_wakeup_requests` (migration 0303); the rerun carries a fresh
  idempotency key and an incremented resurrection counter, at most one retry
  per wakeup, and no retry when `evidence.automaticRecovery.replay="blocked"`.

### 1.6.3 PROMPT-BUDGET B: prompt-size thresholds and over-threshold signals (OPE-4806)

- Live company settings `instance_settings.general.promptBudget`
  (`warnPct` / `critPct` / `enabled` / `fallbackWindowTokens`), edited on the
  Instance → General "Prompt budget" panel without a restart.
- Attention feed: one card per agent whose last run's prompt crosses the
  threshold (`sourceKind prompt_budget_alert`, warn → medium, crit → high);
  the detail names the top-3 prompt parts, the window and the crossed level.
- Agent card (Overview): "Prompt budget" section with the window share, totals
  and the per-part breakdown of the last run.
- API: `GET/PUT /api/myrmidon/companies/:companyId/prompt-budget/settings`,
  `GET .../prompt-budget/status`.

### The company agent list ships without adapter_config (PERF-DIET G2)

- `GET /api/companies/:companyId/agents` no longer returns `adapterConfig`:
  the heavy, secret-bearing column is not read at all for this response —
  the list selects a narrow projection and extracts the model in SQL into a
  new `adapterModel` field. The full configuration stays available through
  `GET /agents/:id`, `GET /agents/:id/configuration` and
  `GET /companies/:companyId/agent-configurations`; access rules and spend
  hydration are unchanged; an actor without `agent_config:read` gets the
  restricted list view with `runtimeConfig` and `adapterModel` blanked.
- The board UI follows: the agents list renders its model column from
  `adapterModel`; the new-issue dialog and the properties pane read the
  assignee's configuration on demand; Settings → Secrets reads the
  configuration endpoint.
- `paperclipai secrets migrate-inline-env` and the bot-image rollout follow
  on the same footing (the rollout reads bot cards from the
  agent-configurations endpoint; its fake-board test pins this).

### Autonomy matrix enforced in the tool gateway (1.6 AUTONOMY-MATRIX, gateway half)

- Before an agent's tool call is executed, the tool gateway maps the tool
  onto an action class by name and resolves the matrix verdict for the
  agent's role — at the point of action, before the access policy and before
  any provider dispatch. A `forbidden` verdict refuses the call with 403
  `autonomy_forbidden` (the upstream is never called); `approval_required`
  parks the call in the existing `tool_action_requests` holding conveyor
  (409 `approval_required`, an approval card, execution after approval via
  `approvedActionRequestId`); `allowed` and every non-agent caller pass to
  the ordinary policy path unchanged. A tool with no action class is not
  governed by the matrix.
- The tool → action-class mapping is configurable per instance without a
  restart: stored settings (`instance_settings.general.myrmidonAutonomyToolMapping`)
  win, then the `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` env override, then the
  built-in defaults (the three classes of the design — merge / deploy /
  external_message — with their common tool-name patterns). Operator guide:
  [guides/autonomy-matrix-tool-gateway.md](guides/autonomy-matrix-tool-gateway.md).

### The hermes_gateway adapter sends the task workspace in the run request (1.6.5 BOT-DISK-H, part H5a)

- A run of a task that has a repository now carries a `workspace` field in the
  `POST /v1/runs` body: `{key, repo, baseRef}` — the issue identifier, the
  project's repository as `owner/name` and the workspace ref (omitted when the
  workspace has none). The gateway uses it to open the task copy before the
  model starts.
- A task without a repository, or without a board identifier, sends no field.
  A `workspace` written into the card's `payloadTemplate` is overwritten, like
  `github_broker`: a card cannot forge it.

### A broken nested `.git` is not a repository: archived as files, the closed task directory goes (1.6.5 BOT-DISK-H)

- `archive-remove` of a closed task directory failed with `archive-incomplete: nested repository repo: bundle create failed: fatal: Need a repository to create a bundle` when a `.git` directory inside it was hollowed out by an old cleanup. botd now treats a `.git` that fails `git rev-parse --git-dir` as no repository: no bundle or patch is made, its files (without `.git`) go into the parent's `dir.tar`, and the directory is removed once the tar is verified. A real repository whose bundle fails is still kept.

### Board answers a bot's desired-state poll from a 5-minute cache (1.6.5 BOT-DISK-H LOAD)

- `GET /api/myrmidon/bots/me/workspaces` is polled ~30 times a minute across the
  fleet and every answer used to run the full store pass for the bot (assigned +
  reassigned issues, PR work products, project repo urls, settings). The service
  now caches the built desired state per bot (`companyId + agentId`) in process
  memory for 300 s — the same window as `nextReportSec` the bot is told to
  honor — so a bot costs the board at most one store pass per window. The route
  still serializes every reply (cached value included) through
  `wsDesiredStateSchema`.
- Event invalidation (review fix): TTL alone is not enough. When an issue's
  `status` or `assigneeAgentId` changes, the issue route drops the cached
  desired-state entries of the previous and the next assignee through a
  process-local registry (`bot-workspaces-invalidation.ts`), so the next poll
  rebuilds from the store: a reopened task is back in `protectKeys` at once
  (botd would otherwise archive-delete its directory mid-work), and a
  reassigned task moves between the bots' caches immediately.
- The `enabled` switch is read on every request, uncached: turning the
  mechanism off acts immediately, the reaper stops at the next poll.
- A failed build is not cached; the next request retries. Concurrent pollers
  of one bot collapse into a single store pass.
- `POST /api/myrmidon/bots/me/disk-report` verified to hold no DB await and no
  heavy work beyond validation plus the in-memory map write; no change needed.

### botd no longer deletes a repository with unsaved work while the bot has a live run (1.6.5 BOT-DISK-H)

- botd archived and removed `/scratch/repo` of a developer bot with 135 uncommitted edits during a run: any pressure level cut the scratch term to 1 hour and the run's state was never checked. Now a git directory with unsaved work (dirty or not pushed) in `/scratch` or `/workspace` is kept while a run is live, and when the run state is unknown (fail-closed); it is listed in the report as held (`unsafe-git-live-run`, `unsafe-git-run-unknown`). Pressure no longer shortens its term: it is archived and removed only without a run and after the full `scratchTtlHours` (24 h) of idle time. A run is live when the board lists an active task, a process of the container works under `/workspace` or `/scratch`, or a run woke the bot (SIGUSR1) in the last 30 minutes; for 30 minutes after botd starts the state is unknown. Clean and pushed copies and non-git data behave as before.

### botd paces its tick by the board's nextReportSec; errors back off exponentially (1.6.5 BOT-DISK-H LOAD)

- The fleet hammered the board with ~189 disk reports per five minutes instead
  of ~72: the loop paused on `min(intervalMs, nextReportSec)`, so the default
  60 s interval clamped the board's 300 s cadence and every tick re-polled
  desired-state. The pause after a successful pass is now the board's
  `nextReportSec` (floored 10 s, capped 1 h) stretched by one-sided 0..+10 %
  jitter — never shorter, so "not more often than once per nextReportSec"
  holds for both the disk report and the desired-state poll. `intervalMs` is
  only the initial value until the first accepted report.
- A failed pass (report rejected or desired-state poll failed) no longer keeps
  the flat cadence: the wait grows exponentially, `intervalMs * 2^k` over the
  consecutive failed passes, floor 10 s, cap 1 h, ±10 % jitter so the fleet
  does not resynchronise; the first success resets the streak and returns to
  the board's cadence.
- SIGUSR1 (a run woke the bot) stays an immediate trigger: it cancels the
  pending pause and is not bound by the pacing; the desired poll inside a pass
  remains single-flight.
- The desired-state client's own `start()` timer default moved from 60 s to
  300 s. botd never runs it — the entry wires `poll()` through the main loop
  only — but an autonomous `start()` can no longer add a parallel 60 s poll.

### The workspace mechanism reaches every bot and every task (1.6.5 BOT-DISK-H, rc.8: parts H4b/H5d)

- New instance setting `general.botDisk.defaultRepo` (`owner/repo`, empty by default;
  `PATCH /api/myrmidon/bot-disk` accepts `""`/`null` to clear it). It is the last-resort
  repository of a task: the run's `workspace` field and the desired state of the bot
  workspaces (`GET /api/myrmidon/bots/me/workspaces`) take the repository from the task's
  project, then from its latest pull request, then from `defaultRepo`. A task with no
  repository at all works as before, in `/scratch`, with the warning. Most dev tasks have
  neither a project nor a pull request, so without it the board never asked a bot for a
  working copy and every clone landed in `/scratch` (class G, 24 h TTL).
- botd learns its own key: the board writes `MYRMIDON_BOT_KEY=<bot id>` into the bot's
  `.env` (an id, not a secret), so a report that does not carry `botKey` is accepted under
  the caller's key (a body naming another bot is still 403). Until the bot's profile is
  re-applied after the update, its reports are refused as before.
- Disk pressure reaches the bots: the desired state's `pressure` is built from the measured
  partition (`soft` from `partitionThresholdPercent`, `hard` from
  `partitionRefuseOpenPercent`), not the constant `none`; `disk-state.json` and
  `myr-ws open` follow it.
- botd also takes the directories that already lie on the disk: copies that predate the
  mechanism (class X, kept in `/workspace/<KEY>` outside the registry) are archived when
  they hold unpushed work and removed under the same TTL/grace and the same live-task
  protection as scratch copies; their age ignores `.git` activity (a background fetch no
  longer resets the TTL).
- The workspace mechanism — the git wrapper, `myr-ws`, `botd` and Node 24 for them — is
  built into the base `runtime` stage of `docker/bot-runtime/Dockerfile`, so the default
  image and the Node.js variant carry it too, not only the development variant. A bot of
  any variant can now report to the board and have its old copies reaped.

### botd plans with a Date clock; the bot partition is measured over the dockergate socket (1.6.5 BOT-DISK-H, rc.9)

- botd deleted nothing on the production host: the loop handed the rules a
  `Date` as the clock, the rules only accepted a number or a string, read it as
  "no time" and returned an empty plan without a word. The rules now accept a
  `Date` (finite check included) and the loop passes epoch milliseconds.
- The host-disk sweep never measured the bot partition on a host where
  dockergate listens on a unix socket only: the client was built only from
  `MYRMIDON_DOCKERGATE_URL` (TCP), so the pressure stayed `0 / none` and the
  log said "host disk usage could not be read" every five minutes. The sweep
  now takes its client from the same socket the docker driver uses
  (`MYRMIDON_BOT_DOCKER_SOCKET`); the TCP client is built only when
  `MYRMIDON_DOCKERGATE_URL` is set and no socket is configured. A failing gate is
  still "not measured", never an error in the sweep.
- Deletion policy under `/workspace` is decided by the board's word about a task key, not by a
  timer. The directory name is normalized to a key (`ope3282v2`, `scratch-ope3213`,
  `.trash-OPE-4331`, `OPE-4915-stale-rootowned` -> `OPE-3282`, ...) and, in this order: the copy of
  an active task is never touched; a key in `protectKeys` (open, assigned to the bot) is kept and
  reported as `legacy-open`; a key in the new `closedKeys` (done/cancelled, no lookback limit) is
  archived and removed after the closing grace; a key the board lists elsewhere (reassigned, in
  review) is kept and reported `legacy-open-elsewhere`; a key-like name the board does not know is
  reported `unknown-key`; a name that is no task (`shared`, `tmp`, `work`, `srv-dev`) is reported
  `non-task`, and removed only when empty or regenerable. Under hard pressure the last three are
  archived after `legacyPressureIdleDays` (default 7; setting `general.botDisk.legacyPressureIdleDays`,
  also in `grace`), except `shared`. A timer applies to `/scratch` only. Without `closedKeys` (an older
  board) nothing under `/workspace` is removed.
- Nested repositories (a `.git` up to three levels below the directory) are seen by the classifier
  and archived one by one (`<KEY>--<relpath>`: bundle, patch, untracked files) before the
  directory is removed, next to a tar of the rest of the tree. A failed, missing or truncated archive
  of any part keeps the whole directory (`archive-incomplete`).
- The botd tick is the board's `nextReportSec` (300 s), clamped to 10 s..1 h. Directories that are
  only held are listed in the report as skipped actions (`legacy-open`, `legacy-open-elsewhere`,
  `unknown-key`, `non-task`).
- `botd --once --plan` is a dry run: it prints the inventory plan as JSON, executes nothing,
  writes no `disk-state.json` and sends no report.
- `general.botDisk.enabled=false` makes `GET /api/myrmidon/bots/me/workspaces` answer 503, which botd
  reads as "no desired state": nothing is removed.
- Operator note: `/cache/pnpm-store` is mounted read-write; the host source
  directory must belong to uid/gid 10001 (documented in the shared package cache
  steps).

### The bot partition threshold is read from the partition's physics (1.6.5 BOT-DISK-H, part H10)

- New instance settings `general.botDisk.partitionThresholdPercent` (85),
  `general.botDisk.partitionRefuseOpenPercent` (90) and
  `general.botDisk.partitionCriticalPercent` (95), validated as an ordered
  triple (85<90<95). Readable and writable without a restart via
  `GET`/`PATCH /api/myrmidon/host-disk/partition` (PATCH is instance-admin
  only); env vars `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT`,
  `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT`,
  `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` are the first-start defaults.
- The host-disk sweep measures the bot partition through dockergate
  `GET /myrmidon/disk` (contract C5) instead of inferring it from the server's
  own `/data`: on 07.10.2026 the partition filled to 100 % while `/data`
  stayed fine. The `host_disk_alert` card counts against the partition from
  the warn threshold and goes critical at the critical threshold. Without
  dockergate data the previous statfs behaviour is unchanged and the
  partition is reported as not measured. Set `MYRMIDON_DOCKERGATE_URL` to the
  dockergate base URL to enable the measurement.
- From the refuse-open threshold the desired state of the bot workspaces
  reports `pressure.level = "hard"` (grace 0): `myr-ws open` refuses new
  copies. The board side of the C3 route is part H1c; H10 exports the
  evaluation (`botPartitionThresholdRuntime`) the route reads.
- At the critical threshold the owner receives a Telegram message through the
  existing owner-cards channel (the telegram-notify outbox), once per
  crossing — the latch re-arms only after the partition drops below the warn
  threshold.

### The bot runtime is mounted read-only from one copy on the host (1.6.5 BOT-DISK-H, part H11)

- New instance setting `general.botDisk.sharedBotRuntimePath`: an absolute host
  directory whose `bin`, `lazy-packages` and `lsp` subdirectories every bot on
  the default host mounts read-only over its own runtime paths — one host copy
  instead of one per bot (5–7 GiB per copy on the production fleet). Unset (the
  default) keeps today's behaviour: every bot has its own copies. Changed on the
  Instance → General page or via `PATCH /api/myrmidon/bot-disk`; the next
  reconcile pass applies it, without a restart.
- The three read-only binds land at the real path inside the bot's own mount:
  `/bot/hermes/{bin,lazy-packages,lsp}` for a single-layout bot,
  `/bot-scope/<botKey>/hermes/…` for a member of a shared isolation scope, and
  `/data/hermes/…` for a contract-`1` (legacy three-bind) image.
- A bot card may mount an allowlisted host directory read-only at a path inside
  the bot's own tree, but only under `/data/hermes/.hermes/shared`,
  `/data/hermes/media` or `/data/hermes/work` (epic design, class J); the board
  binds it at that subtree's real path inside the bot's tree. Every other
  reserved path — the three runtime paths included — is still refused, so a card
  can neither shadow the shared runtime nor write into it.
- dockergate: `botRuntimeRoot` in its configuration (the same path; unset
  accepts no runtime bind) and the class J mount points.

### Parser of `git clone` arguments for the bot git wrapper (1.6.5 BOT-DISK-H, part H1a)

- New pure module `docker/bot-runtime/git-reference/clone-args.js` (no dependencies):
  from the arguments of `git clone` it tells a GitHub repository (https, ssh, scp-like,
  with or without `.git`, with or without a token in the URL) from any other host
  (`kind: "foreign"`, the real git runs) and returns `{kind, owner, repo, dir,
  ignoredFlags, hadUserinfo}`. The URL, the token and option values never enter the
  result. Nothing is wired in yet: the wrapper switches over in part H1c.

### The bot git wrapper turns `git clone` into `myr-ws open` and strips credentials from remote URLs (1.6.5 BOT-DISK-H, part H1b)

- `git clone <GitHub repository> [dir]` (https, ssh, scp-like, with or without a token
  in the URL) no longer clones: the wrapper runs `myr-ws open` (key from
  `MYRMIDON_TASK_WORKSPACE`, otherwise `--scratch <dir name>`), so the copy is a worktree of
  the bot's shared base. `--filter`, `--depth`, `--mirror`, `--bare` and the other
  history options are dropped with a line on stderr. The exit code and stderr of `myr-ws`
  (3 = quota) are passed through. A clone of another host, a missing `myr-ws` or
  `clone-args.js`, or `MYRMIDON_GIT_INTERCEPT=0` keeps the previous behaviour.
  `MYRMIDON_WS_BIN` replaces the `myr-ws` binary.
- `git remote add|set-url` and `git config remote.<name>.url|pushurl` with a credential
  in the URL are rewritten without it. `clone-args.js` is now copied into the image next
  to the wrapper.

### `myr-ws open`: a task copy is a worktree of the bot's base, refused under disk pressure (1.6.5 BOT-DISK-H, part H2b)

- `myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch <name>] [--json]`
  creates `/workspace/<KEY>` as a git worktree of the bot's class-D base on the
  branch `bot/<KEY>`: the copy has no object store of its own, so it weighs the
  working tree and an index, not a clone. `--scratch <name>` makes
  `/scratch/<name>` (a detached worktree with a repository, an empty directory
  without).
- `open` is idempotent: a registered copy is returned as it is (`reused: true`);
  a branch `bot/<KEY>` left by an earlier copy is reattached, not reset. Every
  new copy is written to `ws-registry.json`.
- Before creating anything `open` reads `disk-state.json`; with `pressure: hard`
  it exits with code 3 and `BOT_DISK_QUOTA_EXCEEDED:` and names the five
  largest registered copies to close. A missing, broken or stale (older than two
  botd ticks) file counts as no pressure. Reusing an existing copy is never
  refused.
- A key must look like `PREFIX-123`, a scratch name may hold only letters,
  digits, `.`, `_`, `-`; anything with `/` or `..` is refused with code 2.

### `devbuild` understands a git worktree copy (1.6.5 BOT-DISK-H, part H2g)

- A task copy opened as a worktree of the bot's bare base has a one-line `.git`
  file (`gitdir: <base>/worktrees/<name>`) instead of a `.git` directory.
  `devbuild` now resolves it (`resolve_git_dir`: plain clone, worktree with an
  absolute or relative gitdir, or neither), ships the bare base (without other
  worktrees' admin directories) and this worktree's admin directory to a
  per-bot place in `/srv/devcache/git-wt/` on the build VPS, and repoints the
  `.git` file and the admin directory's back-reference at the VPS paths, so
  every git command in the synced copy works. Only bases under
  `/data/hermes/.myrmidon/git-base` are shipped; anything else is refused.
- A plain clone, including the `--reference` clone with alternates, is synced
  exactly as before.
- Fixed: a missing `$HERMES_HOME/.env` made `devbuild` exit silently under
  `pipefail`.

### botd deletion rules as a pure function (1.6.5 BOT-DISK-H, part H3b)

- New `docker/bot-runtime/botd/lib/rules.js`: `decide(inventory, desired, now,
  settings)` returns the list of actions (`remove`, `archive-remove`, `prune`,
  `delete-base`, `delete-archive`) for the table of the bot-disk design, section
  2.3. It only returns data; nothing is executed and nothing is read from disk.
- A closing copy goes after the grace period (30 minutes by default): only when
  it is clean and pushed (a merged PR does not relax this) — removed; anything
  else, including unknown (null) facts — archived first. A copy missing from the board's list is treated as closing with
  a 24-hour grace. A copy of an active task is never removed; a vanished
  directory is only pruned.
- Pressure from the board (`soft`) drops the grace to zero, the scratch TTL to
  one hour and archive age to seven days; `hard` does the same and `plan()`
  also returns `blockOpen: true`. A base repository with no worktree for 30 days
  is deleted (never when it holds local branches not on origin or this is unknown), over eight bases the oldest idle one goes, archives expire after
  30 days or past the 2 GiB cap (oldest first).
- The inventory shape (`worktrees`, `scratch`, `bases`, `archives`) is the main
  one; the classifier of #745 maps to it with an adapter. Any other shape yields
  no actions.
- No desired state from the board (error, 401/403/503) deletes nothing.

### botd classifier of foreign copies and scratch (1.6.5 BOT-DISK-H, part H3d)

- New `docker/bot-runtime/botd/lib/classify.js`: walks `/workspace`, `/scratch`
  and `/data/hermes/cache/scratch` and puts every directory into class E (task
  copy), G (scratch) or X (foreign) with a sign: `promisor`, `token`,
  `no-remote`, `trash`, `full-clone`. Output is a list of
  `{path, class, sign, ageSec, sizeBytes}` plus an action per item for the
  lifecycle rules (scratch removed after a 24 h TTL by mtime/ctime; foreign
  copies get a card at once and are held while a task with the same key is
  active; nothing is removed when the board is unreachable).
- Repositories are read as text (`.git/config`), never through git, because a
  repository's own config can name programs git would run. A credential in a
  remote URL is only ever reported as the flag `token`; the first pass can
  rewrite `remote.origin.url` without userinfo with `git remote set-url` and
  returns the count.
- `toInventory(items)` adapts the result to the inventory of the deletion rules
  (`worktrees`, `scratch`, `bases`, `archives`, ISO `mtime`). `clean` and
  `pushed` stay `null` (git is never run on a bot's repository), which the rules
  read as "archive before removing". The `action` hints of `classifyAll` are
  advisory; deletion is decided by the rules only.

### The board tells each bot which task copies it should keep (1.6.5 BOT-DISK-H, part H4a)

- New route `GET /api/myrmidon/bots/me/workspaces`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). It answers with the
  desired state of the bot's task copies: `active` for the bot's tasks that are
  not terminal, `closing` for tasks that are done, cancelled, hidden, reassigned
  to someone else, or whose pull request is merged (read from the work products
  that the task PR sync keeps current). A task with one merged and one still
  open pull request stays `active`.
- The repository of a copy is the Repo URL of the task's project workspace, or
  the repository of the task's latest pull request. The `grace` block follows
  `general.botDisk.graceClosingMinutes` / `scratchTtlHours` (defaults 30 min /
  24 h); `pressure` is `none` until a dockergate snapshot is wired in.
- The lifecycle rule is a pure function (`workspaceStateOf`), the answer is
  checked against the C3 schema from `@paperclipai/shared` before it is sent.

### The board receives the disk report of every bot (1.6.5 BOT-DISK-H, part H4b)

- New route `POST /api/myrmidon/bots/me/disk-report`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). The body is checked
  against the C4 schema from `@paperclipai/shared`: a broken body is 400 and the
  previous report stays, a body over 1 MiB is 413, a report that names another
  bot is 403. The answer is `{ok, nextReportSec}` (300 s).
- The last report of each bot is kept in memory with its receive time, the same
  way the in-container clone report is; `readBotDiskReports()` hands them to the
  Attention cards and the panel. The clone report path is unchanged.

### Attention cards for the bot-disk lifecycle (1.6.5 BOT-DISK-H4c)

- New cards on the attention queue, computed from the bots' disk reports:
  `agent-silent` (a running bot container that has reported before and whose
  last report is older than 30 minutes; a bot that never reported raises none), `drift` (the copy of a closed task is alive longer than the
  grace plus 15 minutes, with the reason from the report), `foreign` (a copy
  outside the managed layout, raised at once with path and sign).
- `bot_disk_archive` sits on the task while its archive of unpushed work can be
  restored and disappears on restore or after 30 days; `bot_image_stale` is raised
  for a bot whose image generation has not been current for over 24 hours.
- Card wording never carries remote URLs, tokens or e-mail addresses from a report,
  including bot-supplied paths and task keys.

### A run's `workspace` field opens the task copy before the model starts (1.6.5 BOT-DISK-H5b)

- The bot runtime's gateway patch `10-run-workspace-open.patch` makes `/v1/runs`
  accept an optional `workspace` field (`{"key", "repo", "baseRef"?}`). Before the
  model starts the gateway runs `myr-ws open <key> <repo> [--base <ref>] --json`
  (120 s limit) and starts the run in the opened copy: it becomes the run's
  working directory and `MYRMIDON_TASK_WORKSPACE` for its terminal commands.
- Exit codes 3, 4 and 5 (quota refusal, base limit, network) never fail the run
  silently: it starts in `/scratch` and the run's event stream carries a
  `run.workspace_fallback` warning. Any other failure fails the run loudly.
- A run without the field behaves as before, and its commands never inherit
  another run's workspace path.

### One pnpm store per partition, imported by reflink (1.6.5 BOT-DISK-H, part H8a)

- The pnpm store of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/pnpm-store` on the host, bound
  read-write at `/cache/pnpm-store` into every bot of `sharedCacheRoles`.
  `npm_config_store_dir` points at it. It replaces the per-bot
  `/workspace/.pnpm-store` (eight stores of about 2.4 GiB each on the production
  fleet).
- `npm_config_package_import_method` is `clone` by default: a reflink, the copy
  shares the store's blocks and a write to a file in `node_modules` never reaches
  the store. Strictly `clone`: `clone-or-copy` and `hardlink` are refused by
  `PATCH /api/myrmidon/bot-disk` with a message, because pnpm copies silently
  where a reflink is refused.
- Values stored by an earlier release read as today's: `pnpmStoreDir`
  `/workspace/.pnpm-store` as `/cache/pnpm-store`, `pnpmImportMethod`
  `hardlink` or `clone-or-copy` as `clone`. Each migration is logged as a
  warning, as is a store inside a bot's own tree (a store per bot, not shared).
- dockergate: the `pnpm-store` pair joins the writable package cache mounts.
  Update dockergate BEFORE the board, otherwise the create of a bot with the
  shared cache is refused with `mount_source_not_allowed`.

### Bot containers prove at start that pnpm can reflink (1.6.5 BOT-DISK-H, part H8b)

- The container entrypoint replaces the hard-link self-check with a reflink
  self-check: a probe file in the pnpm store is copied with
  `cp --reflink=always` into `/workspace`, `/scratch` and `/data/hermes`. The
  result goes to `${HERMES_HOME}/.myrmidon/reflink-check.json` (the old
  hardlink-check.json format plus `method: "reflink"`). A refusal (EXDEV,
  EOPNOTSUPP) logs an ERROR and raises the `bot_disk_lifecycle/reflink`
  Attention key; the gateway still starts.
- The image CI check is `pnpm-reflink-check.sh`: it installs a fixture package
  offline from every clone root and reports whether the file shares physical
  extents with the store (`filefrag`). A store on another superblock is a
  silent copy; the negative test proves the check sees it, and is skipped with
  its reason where the runner cannot make a second filesystem.

### The board enforces bot disk quotas through dockergate (1.6.5 BOT-DISK-H, part H9c)

- The bot disk quota sweep now puts the quota it resolves (card, per-agent,
  per-caste, default) as the hard xfs project limit of the bot
  (`PUT /myrmidon/disk/<botKey>/quota` of dockergate), once per change: a quota
  already in force or already applied is not sent again, and a refused PUT is
  retried only after the remeasure interval.
- Usage for the 80 % / 100 % `bot_disk_quota` signals and for the clone admission
  check is the physical figure of `GET /myrmidon/disk`. When quotas are not
  enabled on the bot partition, or dockergate does not answer, the previous du
  walk is the estimate and the signal says so (`usageSource: "estimate"`).
- An unreachable or off-contract dockergate never fails a sweep tick.

### One uv cache per partition, imported by reflink (1.6.5 BOT-DISK-UV, part A)

- The uv cache of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/uv` on the host, bound read-write at
  `/cache/uv` into every bot of `sharedCacheRoles`. `UV_CACHE_DIR` points at it,
  `UV_LINK_MODE` is written next to it; both land in the profile's `hermes/.env`
  and win over the card's value (the dropped card value is logged as a warning,
  like the other cache variables).
- `UV_LINK_MODE` is `clone` by default: a reflink on a copy-on-write filesystem.
  `clone`, `hardlink` and `copy` are accepted. `symlink` is refused by
  `PATCH /api/myrmidon/bot-disk` with a message: environments reached through
  symlinks in the shared cache break bot isolation. Unlike pnpm, `hardlink` is
  allowed — it is a documented uv value, and uv itself fails loudly with an
  EXDEV error when a hard link cannot cross the bind; uv's own
  clone→hardlink→copy fallback (logged in the bot) is accepted, so there is no
  `clone-or-copy` analog and no separate ban.
- A cache inside a bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is
  accepted with a warning — it is a cache per bot, counted against the quota,
  not a shared one. Any other path is refused. This is a new feature: nothing to
  migrate, a stored profile without the keys reads as today's defaults.
- dockergate: the `uv` pair joins the writable package cache mounts. Update
  dockergate BEFORE the board, otherwise the create of a bot with the shared
  cache is refused with `mount_source_not_allowed`.

### Bot containers prove at start that the shared uv cache can clone (1.6.5 BOT-DISK-UV, part B)

- The container entrypoint runs a uv cache self-check at every start: a probe
  file in `UV_CACHE_DIR` is copied with `cp --reflink=always` into
  `/data/hermes`, `/workspace` and `/scratch`; where `filefrag` is available
  the result is confirmed by shared physical extents. For `UV_LINK_MODE=hardlink`
  the probe checks the inode instead (`stat -c %i`), because a hard link is the
  success case there and a reflink proof would report the opposite.
- The result goes to `${HERMES_HOME}/.myrmidon/uv-cache-check.json`
  (`method` = the uv link mode, same shape as reflink-check.json: `version`,
  `checkedAt`, `cache`, `ok`, `roots[]`). A refusal or a silent full copy logs
  an ERROR and does not stop the gateway: a bot with a broken shared cache
  works, it just wastes space and traffic (same logic as the pnpm check).
- The check is gated by `MYRMIDON_UV_CHECK` (the entrypoint reads it from the
  bot's `hermes/.env` first, then the process environment; default `1`) and
  its roots by `MYRMIDON_UV_CHECK_ROOTS`. The cache keys
  (`general.botDisk.uvCacheDir`, `general.botDisk.uvLinkMode`) are documented
  by part A.

### The bot image rollout script follows the async "Apply now" (BOT-IMAGE-ROLLOUT)

- Since 1.6.5 `POST /api/myrmidon/agents/:id/bot-container/apply` answers 202
  with `{applyId, status}`. `bot-image-rollout.sh` read `.outcome.kind` from that
  answer, found none and reported every bot as FAILED while the containers were
  switching in the background (the rc.12 rollout, 08.10).
- Now the script polls `GET .../bot-container/apply/:applyId` until
  `succeeded|failed` (at most `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC`,
  default 300, every `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC`, default 4).
  `failed` fails the bot with the job's error in the journal; a timeout is
  "deferred" (the sweep finishes it). The bots of a batch are therefore switched
  one after another again.
- `succeeded` is not taken as proof (a busy bot's deferred pass is recorded as
  succeeded): the bot counts as switched only when
  `GET .../bot-container/status` shows the container running on the release
  image, otherwise it is deferred and retried. The old synchronous answer
  (`outcome.kind`) is still understood.
- A POST `apply` refused with 409 (`bot_container_not_applicable`: the agent
  went running between the status read and the apply) is deferred, not failed.
- A failed or deferred bot never interrupts the run: the loop reaches every
  remaining bot, the end-of-run line is `WARNING` when bots stayed deferred
  and `DEGRADED` only when at least one actually failed.

### Deferred bot image rollout applies itself when the bot frees up (BOT-ROLLOUT, part C)

- A bot busy when its image rollout arrived (running turn, owner in chat, or
  someone else's maintenance window) no longer waits for the next deploy: the
  reconcile pass records the deferral in the `myrmidonBotRolloutDeferred` key of
  `instance_settings.general` (row-locked like the maintenance and canary keys)
  and a watcher in the same 60-second sweep retries the recorded bots.
- A retry goes out once the bot reports no running work, through the regular
  `applyBotContainerNow` (same per-bot lock, fresh card read); on success the
  record is removed.
- A bot busy longer than `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (default
  3600) is retried without the busy gate: the reconciler opens the maintenance
  window, drains the in-flight run (runs are never interrupted, OPE-3638) and
  switches the container after the current turn.
- A record not converged within 4x the max wait is retired: dropped and logged
  to the reconcile log and the audit feed (`myrmidon.bot_rollout.deferred_retired`).

### Idle-skip measurement and prompt cache by answer cost (1.2-COST-CACHING)

- `MYRMIDON_IDLE_SKIP_METRICS` (off by default) counts every skipped empty timer wake and the model calls it saved, and logs the running totals.
- `MYRMIDON_PROMPT_CACHE_MIN_COST` (unset = off) lets a timer wake with an identical context snapshot reuse the previous finished run's recorded answer when that answer cost at least the threshold. Cheap answers are always recomputed. The skipped wake names the source run.

### docs: custom castes (CUSTOM-CASTES A) — the company agent-role directory

- A new guide (EN+RU) describing the agent_castes directory: the fields of a caste, the twelve seeded built-ins, the REST contract under /api/myrmidon/companies/:id/castes including the DELETE reassignTo flow, and live reads with no restart.
- The stale 'until part A lands' wording in the CUSTOM-CASTES B section of SETTINGS.md/SETTINGS.ru.md is corrected (part A is in; the directory section itself comes from the 1-6-1-custom-castes-a fragment). The guides table points at the new guide, and the wiki settings page mentions the Agent castes screen.

### Snapshots and audit reports of the board's own database (1.6.5 DBC-4)

- Storage optimisation becomes a board function: the module
  `server/src/myrmidon/datastore-care/` collects one snapshot an hour of the
  datastore it runs on — total size (`pg_database_size`), per-table and TOAST
  bytes, index bytes, the heaviest `pg_stat_statements` queries, the settings
  the audit criteria watch, the age of the last backup — and keeps both
  snapshots and audit reports for 90 days of its own.
- Two myrmidon-owned tables, `datastore_snapshots` and
  `datastore_audit_reports` (migration
  `packages/db/src/migrations/0310_datastore_care.sql`, additive only), plus
  the granularity the module reports on: per-table bytes, transitions and the
  growth between neighbouring snapshots.
- `GET /api/myrmidon/datastores` answers the targets with their live size and
  the newest snapshot; `POST /api/myrmidon/datastores/:key/snapshots` takes an
  out-of-band snapshot; `POST /api/myrmidon/datastores/:key/audit-reports`
  writes the report of the section-6 criteria as it stands at that moment and
  `GET .../audit-reports/:id/export` returns it as the `db-audit.md` markdown
  (the top-25 queries and every criterion with its measured value).
- The routes are instance-admin only (`assertInstanceAdmin`): the numbers are
  the instance's own — database size, catalog contents, server parameters — so
  a board member of a company has nothing to read there. A snapshot keeps the
  indexes as aggregates (total, unused and their bytes, the largest unused, the
  invalid count) and not as the full list of ~1040 rows: kept hourly over the
  90-day retention that list alone would add ~200 MB per target.
- The collector is parameterised by connection and by `dbId`
  (`pg_database.oid`) from its first day, so DBC-5 only adds targets to the
  same code; the board target is implicit. pgvector and full-text-search
  metrics appear only when the extension is installed. `engine` stays
  `"postgres" | "clickhouse-ro"`.
- The hourly job runs behind the kill switch `MYRMIDON_DATASTORE_CARE_ENABLED`
  (any of `0/false/off/no/disabled` turns it off); no rules and no automatic
  actions are attached to the numbers collected — the module only measures and
  reports.
- The release gate `scripts/myrmidon/release/db-audit-gate.sh` turns one audit
  report into a release decision. For 1.6.5 it runs in **warning** mode:
  findings are printed and the release is not blocked; the next release runs
  the same script with `--mode block`, and `--strict` also fails on warnings.
- The 1.6.5 audit itself ships with the release:
  `docs/myrmidon/releases/1.6.5-db-audit.md` (the path the release checklist
  names for every final tag) carries the sizes slice, the criteria with their
  measured values, every adopted change with its effect, and the "after"
  slice to be taken on the live database; `releases/1.6.5/db-audit.md` is the
  short entry point that points at it.

### Migration 0380 removes the historical executionContinuation duplicates from run snapshots

- `heartbeat_runs.context_snapshot` keeps one copy of the `executionContinuation`
  envelope: the top-level key. Rows written before the single-copy writer also
  carry a nested duplicate in `paperclipWake.executionContinuation`. Migration
  `0380` removes the nested duplicate in primary-key batches of 200 rows. A row
  that has the envelope only in the nested place (written by an external adapter
  under the old contract) gets it lifted to the top level first, so the read
  path keeps seeing it. A second run changes nothing. The migration is heavy on
  the production database: apply it in a maintenance window.

### The host-disk sweep measures the real mounted path and stops spamming when it cannot (1.6.5 F-03)

- `MYRMIDON_HOST_DISK_DATA_ROOT` points the sweep at the directory that is
  actually mounted into the server container (default `/data`). When the
  path is missing the sweep result switches to `state: "unmeasured"` with a
  `measuredPath: null` and an `error` text that names the missing path and
  the setting to fix — instead of one `host disk usage could not be read`
  log line per tick.
- The transition into `unmeasured` is logged once at error level; further
  failed ticks are debug, with the error repeated at most once an hour. When
  the path appears, the measurement resumes without a restart and one info
  line records the recovery.
- Every path in `MYRMIDON_HOST_DISK_CONSUMER_PATHS` is measured on its own
  filesystem (`usedPercent`/`usedBytes`/`totalBytes`/`freeBytes` per path) —
  a consumer can live on a different filesystem than the data root. The main
  result stays the data root; the per-path list is returned as
  `measurements` from `GET /api/myrmidon/host-disk` together with the new
  `state` and `error` fields.
- `post-boot-check.sh` fails red when the host-disk sweep reports
  `measuredPath: null`, so a board that boots blind does not pass the gate.
  `POST_BOOT_CHECK_HOST_DISK=off` disables the check.

### Telegram `/model` and `/think` work for gateway agents (1.6.5-F06-A)

- The gateway adapter (`hermes_gateway`) is allowed for both `/model` and
  `/think`. It compiles the same hermes profile and hands `model`/`effort` to
  the run, so a chat override reaches it the same way it reaches `hermes_local`
  — the note that kept it out ("until the gateway passes a model") was stale.
- For a gateway agent `/model` lists the model catalog of the LLM gateway:
  this agent key's own allowlist when the gateway answers it, the whole catalog
  otherwise, and the reply says which of the two it is. The list is grouped by
  provider family (`dashscope-*`, `zai-*`, `nous-*`), the card's own model and
  its fallbacks stay on top, and the 30-model cap is unchanged.
- Writing a gateway agent's `/model` or `/think` now applies its profile
  without a restart: the reply says the change takes effect from the next
  reply. If the apply fails, the card is restored to its previous value and the
  reply names the reason; with the bot-containers feature off nothing is
  treated as broken — the value stays and the reply says the new profile is not
  applied yet.
- `/think` checks the chosen level against the model's own effort list
  (effort-policy): a level the model does not accept (e.g. `medium` for a GLM
  model) is not written, and the answer names the allowed levels.
- A refusal for an unsupported adapter now names the adapter type and the
  reason, in the language of the chat's user.

### The run journal names the model of a gateway run

- Runs of the Hermes gateway are no longer recorded with `unknown` as their
  model. The adapter now reads the model from the gateway's terminal answer in
  order of trust — the `model` field first, then the LiteLLM route name
  `model_group` (both at the top level and inside `usage`) — and falls back to
  the model the run was configured with when the answer names neither. An empty
  value or the `unknown` sentinel is not treated as a model.

### Attention feed: one query for per-agent prompt-budget runs (1.6.5 F-15 D)

- The Attention feed reads each agent's last run with a measured prompt size
  for the prompt-budget cards. The old code sent one `heartbeat_runs` query
  per agent. On the audited board that was about 84 round trips in a cold
  feed build.
- The feed now fetches all agents in one statement: one lateral top-20 scan
  per agent, joined through a single round trip. The selection rules — scan
  window, ordering, the fallback from `finished_at` to `started_at`, and the
  "first row with a usable prompt size" pick — did not change. Feed
  composition stays identical.
- Tests: an embedded-Postgres equivalence test seeds 5 agents × 10 runs and
  compares the batched read against the old per-agent loop, row for row; the
  perf test seeds 1 000 runs across 80 agents and fails if the read stops
  being a single statement (100 ms budget) or, when
  `MYRMIDON_PROMPT_BUDGET_PERF=1` is set, exceeds 300 ms on embedded
  Postgres.

### Partial lifecycle index for the attention screen's exhausted-runs query (1.6.5 F-15)

- The attention screen (`server/src/services/attention-exhausted-runs.ts`)
  looks for runs whose bounded retry budget ran out: it filters
  `heartbeat_run_events` by `company_id` + `event_type = 'lifecycle'` +
  `message like 'Bounded retry exhausted%'` before joining the run rows. The
  two non-unique indexes on the table (`company_run`, `company_created`) do not
  carry `event_type`, so the leg read every event row of the whole table — a
  sequential scan, one of the measured legs behind the feed's p50 2.3 s / p95
  4.7 s (OPE-6346 trace).
- Migration `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql`
  adds one partial b-tree index
  `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id)`
  `WHERE event_type = 'lifecycle'`: the scan shrinks to the lifecycle slice of
  one company. Additive index-only migration: no query text, no schema and no
  behaviour change.
- Measured on embedded PostgreSQL with 83 200 seeded events across 20 companies
  (synthetic data, no production rows): the exhausted-runs leg went from
  `Seq Scan ... Rows Removed by Filter: 83 095` at 20.2 ms to
  `Bitmap Heap Scan ... Bitmap Index Scan on heartbeat_run_events_company_lifecycle_run_idx`
  at 0.87 ms — 23x faster, 1443 → 62 shared buffers.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — drizzle migrations run
  transactionally). `heartbeat_run_events` is bucketed "large" by the
  migration-safety checker (10 833 local rows × 250), so the statement carries
  the explicit `paperclip:migration-safety-ignore` note as 0307/0308 do for
  their large tables; production deploys run through the operator's maintenance
  mode and the partial predicate keeps the build cost at the lifecycle slice.
- Guard: `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts`
  checks the migration file, the journal entry and the snapshot statically,
  confirms on embedded Postgres that the leg is served by the index and falls
  back to the sequential scan after `DROP INDEX` (the assertions have teeth),
  and applies the migration statement twice on one database to prove
  idempotency.

### The board raises an attention card when the gateway model catalog is empty (1.6.5 F-18)

- The spend collection sweep refreshes the model catalog from
  `/v1/model/info` on every pass. A successful refresh that returns 0 models
  now records an operator attention card: "Gateway model catalog is empty —
  check the accounting key". The usual cause is an accounting key created
  with a restricted model list (no default models): the gateway answers an
  empty list on a successful request, and every feature that reads the
  catalog (prices, model lists, entry limits) silently stops working.
- The card is per company and deduped: repeated empty sweeps keep the same
  card, and the first sweep that sees a non-empty catalog clears it — no
  dismissal bookkeeping. The first sweep right after the server start records
  the same way, so a misconfigured key surfaces immediately, not after one
  interval.
- The fix is operational, not a code change: re-create the accounting key
  (`MYRMIDON_LITELLM_KEY_SECRET`) with access to `/spend/logs/v2` and
  `/v1/model/info` and an empty model list (all models visible). The
  SETTINGS.md row now spells this out.

### The owner's own words close the pending owner card (1.6.5-F21-A)

- An answer written by the owner in a chat (a Telegram DM with the authoring agent, or a comment the owner leaves on the task) now closes the freshest pending owner card of that task. The decision talks to the existing resolution services; the owner is attributed as the resolver, so nothing about the card state machine changes.
- The same wording is used in both places: the inbound chat writer reads the owner's message with this parse (it can name an option by number or letter and pick the card's recommended option) and keeps its own free-text reading as the fallback for cards that accept a typed-in answer.
- The sentence is read against a RU/EN phrase table: "да / ок / делай / согласен / go ahead" accepts a confirmation, "нет / стоп / не надо / cancel" rejects it. Option cards match an option by number ("2) да"), by letter ("вариант б"), by the option's own wording, and "по твоим рекомендациям / the recommended one" picks the option the card marks as recommended. A free-text answer lands in the question's own free-text option when it has one.
- A sentence that decides nothing is never treated as a decision: the text is kept as the owner's comment, the card stays pending with a note saying the answer did not decide, and the question is re-sent with buttons — once per answer.
- Cards raised before the owner ever received a DM carry no message binding. They are closed by the same task-level rule, which is why no data migration is needed.
- When several cards of the task are pending, one line with buttons asks which question the answer belongs to instead of guessing.
- Setting: none. The behaviour rides the existing owner delivery mode (`via_bot`); in every other mode the path is inert.

### Register a GitHub App in one click from the company settings (GITHUB-APP-MANIFEST)

- Company settings → "Shared GitHub authorization" can now register a GitHub
  App through GitHub's manifest flow instead of hand-filling GitHub's form
  and pasting a .pem: `POST
  /api/myrmidon/companies/:companyId/github-shared-identity/app-manifest/begin`
  returns the GitHub form URL, the manifest JSON (private app, webhooks
  off, exactly contents + pull requests write and metadata read) and an
  unguessable anti-CSRF `state` the form posts alongside the manifest; the
  browser callback converts GitHub's one-time code only when the `state`
  GitHub echoes back matches the one begin issued for this company and actor
  (one-time use, ten-minute TTL) — a code without a live state is refused
  before GitHub is called — and stores the App's private key
  straight into a company secret — the key never appears in a response, a log
  line or an error — and `GET
  /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/install`
  returns the App's "Install on GitHub" URL. The callback redirects back to
  the settings with `github_app_created=1` or `github_app_error=<message>`.
- The App entry gains a nullable `slug` (additive; no migration — the
  document lives in `instance_settings.general`); the manual path (App id +
  key secret) keeps working unchanged, with or without a slug.

### The managed GitHub launcher reaches agents that start through the gateway (GITHUB-SHARED-IDENTITY)

- The launcher — the `git` and `gh` wrappers plus `git-credential-paperclip` —
  is staged by the board in its own filesystem for a run with a local or SSH
  execution target. A run that starts through the `hermes_gateway` adapter has
  no execution target on the board side, so those paths never existed where the
  run happens: the agent pushed and opened pull requests with the static
  `MYRMIDON_GITHUB_TOKEN` from its environment, and its `run_identity_contexts`
  row stayed without a GitHub identity.
- The gateway adapter now ships the launcher bodies with the run request, and a
  gateway stages them per run: under its own temporary root, in a directory
  named by the run id, first on that run's `PATH`, with the login-shell profiles
  and `GH_CONFIG_DIR` that keep the staged directory in place. Only that run's
  terminals and `execute_code` children see it — one gateway process serves many
  concurrent runs from threads that share one environment, so the binding is
  per-context, never process-wide.
- The bodies are program text and carry no credential: the token still comes
  from the run's broker capability, and the staged helper asks for it per
  invocation for the repository the operation names. A run without a capability,
  or a request whose launcher payload is malformed (wrong version, a file name
  outside the fixed set, an oversize body), stages nothing and behaves exactly
  as before — no partial directory, no directory another run could be pointed
  at. Nothing is written to a file, and no static token is needed anywhere.

### A retried run replaces its failed attempt's prompt in the hermes session (1.6.5)

- The bot runtime's gateway patch `12-stranded-run-turn-replace.patch` makes a
  `/v1/runs` run supersede the unanswered prompt(s) that earlier failed attempts
  left at the end of the session, instead of adding one more user row per retry.
  Before, a session that kept failing grew one row per attempt and the replay
  merged them into a single user message of megabytes, so every retry hit the
  provider's input limit again.
- Only stranded plain-text prompts that share the new prompt's first 256
  characters are replaced; answered turns, unrelated text, images and compaction
  summaries are never touched. `HERMES_KEEP_STRANDED_RUN_TURNS=1` turns it off.

### Memory is written once per run; run-start recall is conditional (1.6.5 PERF-DIET HS/D1)

- The hindsight memory fork (`0.3.0-myrmidon.2`) no longer writes one memory
  per ticket comment: a run's comments wait in run-scoped plugin state and
  are retained as one `Run <runId> digest` per bank at run end (metadata
  carries `kind: "run-digest"`, run/agent/issue ids, comment count; duplicate
  ids collapse, short bodies and board-machinery comments drop). A comment
  outside a run is retained immediately, as before. A failed retention is a
  warning; the run never fails because of memory.
- Run-start recall takes the plugin config field `recallOnRunStart`:
  `new-issue` (default — search only when the agent has not already searched
  this ticket), `always` (old behaviour) or `never`. `hindsight_recall` still
  searches on demand. Bank routing is unchanged.

### Company-wide wake budget for idle pickup (IDLE-WAKE-BUDGET)

- The board wakes at most five ready agents a minute per company (was: every
  idle agent with a ready task in one pass). The wakes go out in batches: one
  sweep pass emits at most `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` wakes for a
  company, the rest follow on the next pass inside the same minute.
- The ceiling is shared by both idle-pickup paths — the periodic sweep and the
  pickup that runs right after a run releases its task — so a fleet of
  finishing runs cannot burst past it either.
- Two new environment knobs: `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN`
  (default 5, the ticket's number) and `MYRMIDON_IDLE_PICKUP_WAKE_BATCH`
  (default 5, never above the minute budget).
- A wake denied by the budget is not lost: the same candidate is re-evaluated
  in the next window, and both paths report how many candidates waited.

### Wake carries its task id; run liveness follows gateway events (N4)

- A wake whose task id reaches `heartbeatService.wakeup` only via
  `contextSnapshot.issueId` (for example the run-stall sweep's
  `issue_stalled_run`) is now stored and delivered with that id in the wake
  payload: the wake carries its task context to the agent, and every
  downstream consumer (wake payload renderer, coalescing key,
  execution-blocker check) sees the same `issueId`.
- Run liveness can follow gateway progress instead of the wall clock. With
  `MYRMIDON_RUN_LIVENESS_EVENTS=1` (default off) the hermes_gateway adapter
  replaces its fixed `timeoutSec` watchdog with a silence watch: a run that
  keeps emitting gateway events past its timeout is alive and is left alone,
  and only a run whose event stream has been silent for the whole budget is
  reported timed out. Per-agent opt-in via the card's «Liveness by gateway
  events» toggle. Off — the old fixed timeout, unchanged.

### Owner decisions find their owner when the task has none (1.6.5-OWNER-FALLBACK)

- Fixes the `via_bot` mode (1.6.5-OWNER-VIA-BOT) for tasks created by agents or by the operator service account: the owner was computed as `responsibleUserId ?? createdByUserId`, so on such tasks the author was never woken (`skipped_no_owner_dm`) and the owner of the company received nothing.
- One shared rule now picks the human who receives an owner decision: the interaction's human addressee, then the task's responsible user, then its creator, then the active owner(s) of the company (`company_memberships.membership_role = 'owner'`). The first candidate with a live Telegram DM with the author agent wins; a candidate without one is skipped.
- The same choice drives the wake of the author, the message to the owner, the "open decisions" list in the run prompt, the card-delivery lookup of the other delivery modes and the check that closes an interaction from the owner's text answer, so the person who got the message is the person whose answer is accepted.
- When nobody qualifies, the behaviour is unchanged: the question stays on the board only.
- The "explain it to the owner" wake no longer merges into the author's still-running run (which raised the question in the same turn, so the explanation block never reached its prompt). It waits behind that run and starts a separate run with the block. The response that creates a human-only interaction now carries `ownerExplain: { required: true, tool: "myrmidonMessageOwner", interactionIds }`, so the author can explain at once; a message sent in the same run cancels the deferred wake.

### The owner's own message closes the decision it answers (1.6.5-F21-AUTOCLOSE)

- Closes the gap left by the `via_bot` mode (1.6.5-OWNER-VIA-BOT) and by its guard: closing an owner decision required a live owner DM, an agent message bound to the interaction, the answer inside that DM and the author agent's live run (`authorizeOwnerReplyResolution`). A card raised before the mode existed — and any answer that arrives as a plain sentence in the task's own chat — satisfied none of that, so it stayed pending until a human resolved it by hand.
- The ingest of an inbound comment now closes the decision it answers by itself: when exactly one open owner decision of that task waits for the writer, the card is closed through the ordinary resolution path (`issue-thread-interactions`) with the owner as the acting user — the same thing the board would do — so the author agent's continuation is woken through the same continuation outbox as after a board click. No agent run is needed, which is what makes this path instant.
- A sentence closes a card only where the card itself asks for one: a single question with `allowOther`, or with an option marked `freeText` (the platform's inline-text choice, whose typed value is returned as the question's `otherText`). A closed select ("2) да" must pick option 2), a card with several questions and a worded confirmation stay pending for the owner-reply parser (1.6.5 F-21 part A).
- Refusals are deliberate and reported, never guessed: several open decisions of the same writer, a writer who is not the card's owner, a comment written before the card, a quarantined comment origin, a governed payload (`toolAction`/`secretProposal`) or a review verdict. Nothing in the path throws into the ingest.
- Expired cards (pending longer than TTL) remain the TTL sweep's business (1.6.5 F-21 part B).

### PREDEPLOY-DB-CHECK: the predeploy token file is checked with the other inputs of the step, before the first docker call

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — when
  `MYRMIDON_PREDEPLOY_TOKEN_FILE` (optional) is set, the file is validated next
  to the other step inputs (`MYRMIDON_PREDEPLOY_POSTGRES_IMAGE`,
  `*_BOARD_ENV_FILE`), BEFORE the first docker call: "set but not a file",
  "set but not readable" and "set but empty" each stop the deploy with a
  message naming the input. Before this, only the setting being filled was
  checked, and a set-but-unreachable file surfaced later, in
  `auth_header_args` on the health-wait step — after Postgres was up and the
  dump restored. The token stays optional: without it the route walk gets
  401/403 and that is still a warning.
- `scripts/myrmidon/deploy/deploy.env.example` — a comment on the setting.
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the 401/403
  case now uses a real token file (its previous `/nonexistent/token`
  configuration is exactly the case that moved earlier), plus a new case: a
  missing file, a directory, an empty file and (only when not run as root) an
  unreadable file stop the deploy and docker is never called.

### Plugin cron job launches are captured with a database CAS (PROCS-Q2 part B)

A plugin job fired by the scheduler is now claimed atomically before it runs:
`UPDATE plugin_jobs SET status='running' WHERE id=? AND status<>'running'
RETURNING`. Only the caller whose statement returns the row dispatches the
worker; every other concurrent tick — a second scheduler process, or a
double pass of the same tick — receives no row and skips the launch as a
normal, silent outcome (not an error). This closes the double-execution race
for plugin cron jobs under the multi-process board (OPE-5394 §4, §5.5).

The capture is released in the same dispatch path after the run reaches a
terminal state and the schedule pointer has advanced, so no process can
re-dispatch with a stale `nextRunAt`. The release is conditional on the job
still being `running`: an operator pause recorded mid-run is never clobbered
back to `active` by a finishing run. `running` joins the job status enum as a
transient, host-managed state: `GET /plugins/:id/jobs?status=running` can
filter on it, but it remains non-settable through the API (pause/resume still
accept only `active`/`paused`/`failed`). Default single-process behaviour is
unchanged apart from the guard itself. A capture left behind by a process
that died mid-run is reclaimed back to `active` by the scheduler tick once it
is older than two job timeouts, so a crashed owner can never wedge a job.
Covered by an embedded-Postgres test:
two scheduler instances ticking the same due job produce exactly one worker
execution and one run row.

### Release publish fits GitHub's size limit

- A release body over GitHub's 125 000-character limit was refused (HTTP 422, 1.6.5-rc.11). The notes section is now cut at a line boundary to keep the body under 120 000 characters and ends with a link to the full section of `docs/myrmidon/CHANGELOG.md` on the same tag; the component digest table is never cut.

### Run lists and the attention feed read thin run-context columns (OPE-5007 П2)

- `heartbeat_runs` gained nine nullable text columns (`context_issue_id`,
  `context_task_id`, `context_task_key`, `context_comment_id`,
  `context_wake_comment_id`, `context_wake_reason`, `context_wake_source`,
  `context_wake_trigger_detail`, `context_run_summary`) that mirror the small
  hot fields previously buried in the `context_snapshot` jsonb. The run list,
  the attention feed and the exhausted-runs query read the columns with a
  `coalesce(column, context_snapshot ->> key)` fallback, so historical rows
  keep resolving while the board's hottest queries stop detoasting dozens of
  kilobytes of snapshot per row. Migration `0313` only adds the columns (no
  table rewrite); a background job fills historical rows in small primary-key
  batches, committing each batch and pausing between them, so the hot table is
  never held by one long transaction. `context_snapshot` is stored unchanged.

### One stored copy of the execution continuation per run (1.6.5 RUN-SNAPSHOT-DEDUP)

- A run snapshot now holds the execution continuation envelope once, at
  `context_snapshot.executionContinuation`. The structured wake payload no
  longer carries its own copy: dispatch re-attaches the canonical envelope to
  the payload the adapter and the native runner receive, so the delivered
  prompt is unchanged. The duplicated envelope was ~90-100 KB, written twice
  into every run snapshot.
- The run detail response (`GET /api/heartbeat-runs/:id`) drops a nested
  copy that is byte-identical to the canonical one, so runs written before this
  change stop sending the envelope twice. A payload that differs from the
  canonical copy is left untouched, and no response loses information.
- The run-ownership probe (`getConversationOwnershipBlocker`) selects the six
  columns it reads instead of the whole `heartbeat_runs` row. It runs several
  times per dispatched run, and every candidate row used to arrive with its
  snapshot and result JSON attached.

### Task clones share one git object store per bot and per scope (1.6.5 BOT-DISK-G)

- Bot task clones copied the whole git history each (~0.4 GB; the volume grew
  ~4 GB/h): a bot terminal rebuilds PATH without the 1.6.2 git wrapper. The
  image now shadows git with `/usr/local/bin/git` and runs the wrapper with an
  absolute interpreter.
- The wrapper keeps one bare mirror per repository in the bot store (or the
  shared `/bot-scope/.git-objects` of an isolation scope); later clones borrow
  it with `--reference-if-able`. Measured here: first clone 414 MB / 144 MB
  `.git`, later clones 272 MB / 2 MB `.git`. Mirrors never prune objects a
  clone borrows; every failure falls back to a plain clone.
- The store used to stay empty next to live task clones: those clones run with
  `--reference <neighbour clone>`, the wrapper read that as the clone's own
  storage decision and stepped aside silently. Now only options that pick the
  storage of the clone's own objects opt out (`--dissociate`, `--shared`,
  `--local`, `--mirror`, `--filter`); clones naming `--reference`,
  `--reference-if-able` or `--no-local`, bounded clones (`--depth`,
  `--shallow-since`, `--shallow-exclude`) and non-GitHub clones keep the
  store's mirror as an extra alternate. `devbuild` follows the alternates.
- A clone the store does not serve is no longer silent: one `[myrmidon-git]`
  line on stderr plus `<HERMES_HOME>/.myrmidon/git-objects-last-error.json`.
  The start-time self-check (reported as `gitRefCheck`) runs a real offline
  reference round trip, plus `store-fills` and `store-in-use`; a failure raises
  an attention card (`gitref`, `bot_disk_lifecycle`).
- Switches: `MYRMIDON_GIT_LOCAL_MIRROR=""`, `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0`,
  `MYRMIDON_GIT_OBJECTS_CHECK=0`. See [bot-disk-cache.md](bot-disk-cache.md).

### STARTUP-WATCHDOG-PAUSED: a paused watchdog agent no longer stops the board; the predeploy copy uses the production secrets key

- `server/src/services/task-watchdogs.ts` — when waking the watchdog agent
  fails with 409 ("Agent is not invokable in its current state": paused or
  disabled), that watchdog is skipped with a warning (counted as `skipped`),
  and the remaining watchdogs are processed as before. Other errors still throw.
- `server/src/index.ts` — the startup `reconcileTaskWatchdogs` call is
  best-effort: an error is logged as a warning and startup continues. Before,
  a restart with a paused watchdog agent ended in `startup heartbeat recovery
  failed` / `Paperclip server failed to start`.
- `scripts/myrmidon/deploy/predeploy-board-check.sh`,
  `scripts/myrmidon/deploy/deploy.env.example` — new optional
  `MYRMIDON_PREDEPLOY_MASTER_KEY_FILE`: that single file (production
  `instances/default/secrets/master.key`) is mounted read-only into the
  throwaway board, with `PAPERCLIP_SECRETS_MASTER_KEY_FILE` set. Without it the
  copy creates its own key (stored secrets fail with "Secret decryption
  failed") and the check prints a WARNING. The key is never printed.
- Tests: `server/src/__tests__/task-watchdogs-scheduler.test.ts`,
  `scripts/myrmidon/deploy/predeploy-board-check.test.mjs`.

### Release tags get their own un-cancellable CI; the publish gate reads it (1.6.5 TAG-CI)

- The 1.6.4 incident: the tag was pushed, bots merged four PRs into `main` a
  minute later, and the shared concurrency group of `myrmidon-ci.yml`
  (`cancel-in-progress: true`) cancelled the CI run of the tag's commit — the
  automatic publish refused, the tag CI and the release were re-run by hand.
- New workflow **Myrmidon CI (tag)** (`.github/workflows/myrmidon-ci-tag.yml`):
  the full CI tier on every `myr-vX.Y.Z` tag push (including `-rc.N`) and via
  `workflow_dispatch` with a mandatory `tag` input. Own concurrency group
  `myrmidon-ci-tag-<tag>` with `cancel-in-progress: false` — a push to `main`
  can no longer cancel it.
- The publish gate (`publish-github-release.sh`) now waits for the tag's own
  CI run only (`head_branch == tag`): a green main run of the same commit no
  longer satisfies the gate, and a cancelled tag run refuses the publish
  loudly with the recovery path (instead of timing out).
- The release tag pattern accepts `-rc.N` tags end to end (gate, tag CI,
  publish workflow trigger).

### Team liveness: a 24-hour health card (TEAM-LIVENESS-METRICS)

The company settings (health) page gains a "Team liveness" card with the four
counters of the last day for the selected company: **auto-resumes** (agents the
board brought back out of `error` by itself), **resumes given up** (attempts
ran out, so a human has to look), **wakes** (wake requests the board created)
and **stalled runs** (runs progress-based run liveness interrupted).

Nothing new is stored: the numbers are read from the rows the three behaviours
already write — the activity log for auto-resume, `agent_wakeup_requests` for
the wakes, and the run error code for the stalls. `GET
/api/myrmidon/team-liveness/metrics?companyId=…` serves them to the board; the
route is company-scoped, the same access rule the fleet console uses.

To be read: a nonzero "stalled runs" is the sweep doing its job, not a broken
server; a nonzero "resumes given up" is the one number that asks for a human.

### Team liveness settings on the instance and per agent (TEAM-LIVENESS-SETTINGS)

- The three automatic behaviours — AUTO-RESUME, RUN-STALL and IDLE-PICKUP —
  no longer read their `MYRMIDON_*` variables only at construction. Their knobs
  are now one settings area: stored in
  `instance_settings.general.teamLiveness`, resolved over the environment on
  every sweep pass, and changed on the Instance → General page ("Team liveness")
  or via `GET`/`PATCH /api/myrmidon/team-liveness`. A saved change takes effect
  on the next pass, with no restart and no run dropped in flight.
- Precedence is per key: a stored value wins, otherwise the environment
  variable, otherwise the built-in default. A key the operator never saved stays
  unsaved, so removing a variable later really takes effect; the settings page
  reports, per key, which of the three layers is in force.
- An agent card can switch a behaviour off for that one agent
  (`adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`,
  "Team liveness" on the card). The card carries no numbers: the company-wide
  wake ceiling and the wake throttle stay on the instance settings page, so no
  single agent can raise them.
- Every change is written to the activity log for every company
  (`instance.team_liveness.updated`), with the previous values and the changed
  keys.

### Team liveness: the stand scenario that lets the watchdog be switched off (TEAM-LIVENESS-STAND)

`scripts/myrmidon/team-liveness/stand-recovery.ts` rehearses the situation the
epic exists for: the gateway dies mid-run and the team comes back by itself. It
has no liveness logic of its own; the product passes (RUN-STALL by progress,
AUTO-RESUME, IDLE-PICKUP) decide, built as the server builds them. The runner
seeds the situation, SIGKILLs the process, steps the clock and reads the
database back.

The verdict names three legs: the run is settled, the task is not left waiting
(it left `in_progress` and has a wake or a live run), the agent is not stuck in
`error`, all inside a budget (10 minutes by default); the exit code carries the
result. `rehearse` is self-contained (throwaway embedded database, a real
gateway process) and writes the knobs through the instance settings API;
`watch` is read-only against the live board database. Runbook:
[guides/team-liveness-stand-scenario.md](../guides/team-liveness-stand-scenario.md).
The default stall threshold (20 min) exceeds the budget, so the rehearsal sets
it lower through the settings area.

### PREDEPLOY-PG-COMPAT: the version comparison and the extension read really run on Debian/PGDG servers (1.6.6)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — the dump-header parser
  kept only the leading major digits. A Debian/PGDG server records its version
  with the package tail (`; Dumped from database version: 18 (Debian
  18.6-1.pgdg12+2)`); the previous sed did not anchor the end, so the whole
  tail landed in `dump_major` and the arithmetic comparison died with
  `((: 18 (Debian 18.6-1.pgdg12+2): syntax error in expression` — bash does
  not abort on a failed arithmetic expression inside `if`, so the version
  check of the rc.11/rc.12 deploys (08.10) was silently skipped. The copy's
  `SHOW server_version` answer is parsed the same way.
- The two psql probes against the copy (`SHOW server_version`,
  `SELECT extname FROM pg_available_extensions`) no longer swallow stderr
  into `/dev/null`. They run through one helper that retries three times
  (`POLL_INTERVAL_SEC` apart) and captures the psql error; if the list still
  cannot be read, the WARNING names the captured error instead of failing
  silently. This is the second silent skip of the same deploys
  (`WARNING: the copy's extension list could not be read`).
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the fake
  docker answers the real Debian-tailed headers
  (`18 (Debian 18.6-1.pgdg12+2)`, `17.2 (Ubuntu 17.2-1.pgdg22.04+1)`) and can
  make each probe fail with a psql error. New cases: younger copy with a
  tailed header is refused with no `syntax error in expression` in the output,
  equal majors pass, the extension list is read and a missing extension is
  refused, a failing extension probe is retried and its error appears in the
  WARNING, the version WARNING carries the probe error. Every new case fails
  on the previous script.

### LiteLLM budget projection (BUDGET-CONFIG C)

- Limits saved on the board are projected into the LLM gateway's own budgets
  without a restart and within a minute: per-key budgets via `/key/update`
  (addressed by the M2-B key alias) and tag budgets via `/budget/update` on
  the stable `myrm-<level>-<scope>` tag. One point of change: the limit is
  edited on the board. A per-company sweep (interval from the stored
  document, default 30 s; env is a forced override only) pushes changed
  limits and compares both sides: a manual gateway edit is a divergence —
  signalled as a system-notice comment, never silently overwritten; the way
  out is re-saving the limit or `POST …/litellm-budget-sync/re-sync`. The
  global signal-only mode is on by default, so no projected limit stops work
  until the owner turns it off.

### Spend limits per hierarchy level, API and change journal (1.7-BUDGET-CONFIG-A)

- The board stores spend limits per hierarchy level — nest (company/project), caste (role),
  foraging, issue — one row per `(company, level, ref)` with `amountCents`, `period`
  (`calendar_month_utc`/`lifetime`), `mode` (`hard` refuses, `soft` pauses with a card to the
  owner) and `is_active`. Full change journal (`budget_limit_changes`): every create/update/delete
  with before/after snapshots and the actor.
- API under `/api/myrmidon/companies/:companyId/budget-limits`: CRUD on limits (mutations are
  board-only, each mutation writes a journal row and an activity-log entry), the journal (newest
  first, filterable by level), `usage` — the "spent in period" of every limit computed from
  `litellm_cost_events` per level (foraging reads the FORAGING sweep budget state, absorbing
  OPE-3964) with an `overLimit` flag.
- The global "signal only" mode (`instance_settings.general.budgetLimits.signalOnly`) is ON by
  default: limits never stop work until the owner explicitly turns it off. Runtime-mutable via
  `GET/PATCH …/budget-limits/signal-only`; the env variable `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY`
  is a forced override only, and the GET reports the effective value's source
  (`stored`/`default`/`env`).
- DB: tables `budget_limits` and `budget_limit_changes` (migration 0312, additive only). See
  [guides/budget-limits.md](guides/budget-limits.md).

### Tab and home-screen icon — Myrmidon ant mark (1.7 FAVICON)

- The browser tab and the phone home screen ship the Myrmidon ant mark from
  the design-system export (`ui/public/brand/myrmidon/`): `favicon.svg` (the
  bare mark, adaptive navy/white), `favicon.ico` (16/32/48), 16/32 px PNGs for
  the tab, `apple-touch-icon.png` (180) and `android-chrome-192/512.png`
  (maskable 512 included) for the home screen, referenced from `index.html`
  and `site.webmanifest`; no vendor paperclip artwork ships. Icon and manifest
  URLs are served with `?v=<build version>` so a deploy refreshes the browser
  icon store.
- New guard test `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts`: the
  page links the full tab icon set, the manifest carries the 192/512 icons
  (incl. maskable), a built `ui/dist` ships the same ant files, and no
  paperclip artwork remains in `ui/public`.
- Guide: [favicon.md](../guides/favicon.md) (EN) and
  [favicon.ru.md](../guides/favicon.ru.md) (RU).

### Telegram bridge texts follow the user's language (TG-LOCALE)

- Service prose of the bridged Telegram DM (command replies, statuses,
  refusals, the migration notice, the unlinked refusal) moved from hardcoded
  Russian literals to server-side locale catalogs
  (`server/src/myrmidon/agent-chat-bridge/locales/{en,ru}.ts`): EN is the
  base, RU keeps the pilot wording key for key. The linked board user's
  Settings → Language choice decides per message (read again on every
  command, no restart); English is the default.
- `MYRMIDON_TELEGRAM_DM_LANGUAGE` forces one language instance-wide — the
  only env knob, operator override; the Telegram private-chat command menu
  (one menu per bot) follows this instance decision, per-message replies
  follow the user.
- The Settings → Language screen shows the source of the bridge value
  (user preference vs environment force, with the forced language named),
  recomputed on every read; `GET /api/myrmidon/ui2/language/me` carries
  `telegramBridge`. The current-interface language switch in the account
  menu now persists to the same server preference row.
- Ratchet test forbids Cyrillic string literals in bridge sources outside
  the catalogs; acceptance tests prove an EN user gets English and an RU
  user Russian end to end (embedded Postgres), including the live switch of
  a preference taking effect on the next reply.

### The real git leaves PATH in the bot image (1.6.5 BOT-DISK-H, part H1c)

- In the development image the Debian `git` moves to
  `/opt/paperclip/libexec/git` (a `dpkg-divert`, so a package upgrade does not
  bring it back) and `/usr/bin/git` becomes a symlink to the git wrapper, like
  `/usr/local/bin/git`: a bare `git` in any terminal PATH answers through the
  wrapper. The wrapper's default real git is the libexec path
  (`MYRMIDON_GIT_REAL` still overrides it).
- `myr-ws` (`/opt/paperclip/bin` and `/usr/local/bin/myr-ws`) and `botd` are
  installed from the build-context directories `docker/bot-runtime/myr-ws/` and `botd/` (whole, into `/opt/paperclip/myr-ws` and `/opt/paperclip/botd`, symlinked)
  when present; the image still builds without them.
- The entrypoint starts `botd` instead of `bot-clone-hygiene`; an image without
  `botd` keeps the old reporter.

### `myr-ws`: per-bot base repository and CLI frame (1.6.5 BOT-DISK-H2a)

- New `docker/bot-runtime/myr-ws`: the CLI frame (command parsing, `--json`,
  the exit codes of the bot-disk contract) and the class-D base library. A base
  is one bare repository per `owner/repo` under
  `/data/hermes/.myrmidon/git-base/<owner>/<repo>.git`, with the standard
  refspec `+refs/heads/*:refs/remotes/origin/*` (a fetch never overwrites a
  bot's local branches), `fetch.prune=true`, `gc.auto=0` and
  `gc.pruneExpire=never`. The origin URL carries no credentials: git asks
  `git-credential-paperclip`.
- A base is fetched at most every `MYRMIDON_WS_REFRESH_SEC` (default 900 s); a
  ninth repository is refused with exit code 4; names that are not a GitHub
  `owner/repo` (`..`, extra `/`, URLs, userinfo) are refused with exit code 2
  before anything touches the disk. Real git comes from `MYRMIDON_GIT_REAL`.
- `open`, `list`, `close` and `restore` are stubs here (exit 2, "not
  implemented"); their own tasks fill them in. Nothing calls `myr-ws` yet and
  the image does not ship it yet, so bot behaviour is unchanged.

### `myr-ws close`: the regular removal of a task copy (1.6.5 BOT-DISK-H2d)

- New `docker/bot-runtime/myr-ws/lib/close.js`: `close <KEY> [--force]`. A clean
  copy whose commits are all on `origin/*` is removed with `git worktree
  remove`, its branch `bot/<KEY>` is deleted from the base, the base is pruned
  (`git worktree prune`) and the entry leaves `ws-registry.json`.
- A copy with uncommitted/untracked files or commits that no `origin` ref holds
  is refused with exit code 7 and nothing is touched. With `--force` the
  archive module of botd (`archive(copyPath, key)`) runs first; the copy is
  removed only after it reported ok, otherwise it stays. An unknown key exits 6;
  a registry path outside `/workspace` and `/scratch` is refused (exit 2).
- The `close` verb is registered in `lib/cli.js` (integration BOT-DISK-H).

### `myr-ws migrate`: the old object mirror becomes the class-D base (1.6.5 BOT-DISK-H2f)

- New `docker/bot-runtime/myr-ws/lib/migrate.js`: a one-shot, idempotent
  migration of `.myrmidon/git-objects/<owner>/<repo>.git` (refspec
  `+refs/heads/*:refs/heads/*`) into `.myrmidon/git-base/<owner>/<repo>.git` with
  the standard refspec. Objects are hardlinked (copied across devices), the
  mirror's heads become `refs/remotes/origin/*`, the origin URL is rebuilt
  without the mirror's credentials, and the base is built beside its final path
  and renamed only after `git fsck --connectivity-only` passes.
- The mirror is only read, never changed or deleted, so existing clones that
  borrow its objects through `objects/info/alternates` keep working. After a
  successful check it gets a `.migrated` marker; on a failed check it stays
  unmarked, no base is left behind and the command exits non-zero. A second run
  is a no-op. The ninth base is refused with exit code 4.
- The result is the contract shape `{ ok, repo, basePath, refs }`. The verb is
  not wired into `cli.js` or the entrypoint yet (`command` in `migrate.js` is
  the handler), so bot behaviour is unchanged.

### botd reads the desired workspace state from the board (1.6.5 BOT-DISK-H, part H3a)

- New module `docker/bot-runtime/botd/lib/desired.js`: the client of
  `GET /api/myrmidon/bots/me/workspaces` (contract C3). It authenticates with the
  bot's `PAPERCLIP_API_KEY`, times out after 10 s, validates the answer against
  the C3 schema, keeps the last good answer with its `fetchedAt`, and polls every
  60 s and on SIGUSR1 (run wake-up).
- Fail-safe: 401/403, 5xx, network errors, timeouts, broken JSON and an answer
  that does not match the schema (an unknown `state` included) return
  `{ ok: false, reason }`; the caller deletes nothing and only reports. The API
  key is never written to a log or a reason.

### botd archives unpushed work before a copy is deleted (1.6.5 BOT-DISK-H, part H3c)

- New module `docker/bot-runtime/botd/lib/archive.js`: `archive(copyPath, key)` writes
  `<KEY>-<ts>.bundle` (the copy's branch and stash minus `origin`), `<KEY>-<ts>.patch`
  (`git diff HEAD --binary`) and `<KEY>-<ts>.untracked.tar` (untracked files, ignored
  excluded; over 200 MB only bundle+patch and `truncatedUntracked: true`), and appends
  `{key, repo, bundle, patch, untrackedTar, createdAt, sizeBytes, truncatedUntracked}`
  to `manifest.json`.
- It returns `ok: true` only after the bundle verified (header and the pack itself) and the
  tar was listed back; otherwise `ok: false`, nothing stays on disk, and botd must not delete
  the copy.
- `retain()`: 30 days or 2 GiB per bot, oldest first; the entry just created is never evicted.

### botd main loop, action executor and disk report (1.6.5 BOT-DISK-H, part H3e)

- New `docker/bot-runtime/botd/botd` (CommonJS entry), `lib/loop.js` and
  `lib/report.js`. Every 60 s (and on SIGUSR1) botd takes the desired state from
  the board, gathers the inventory, asks the rules for actions, executes them,
  writes `disk-state.json` from the board's pressure and posts the C4 report
  to `POST /api/myrmidon/bots/me/disk-report` (three attempts with backoff).
- Fail-safe: without the board's desired state, or with a failed inventory, nothing
  is removed — only the report goes out with the reason. One failing action is
  reported as `error` and does not stop the others.
- The desired/rules/classify/archive modules are loaded by their contract
  interfaces; while one is absent from the image the loop works with an inert
  stand-in and removes nothing.

### Bot disk panel and working-copy line (1.6.5 BOT-DISK-H, part H4d)

- Instance → General, "Bot disk": a physical section (partition, quota, other consumers) and a per-bot table: quota and usage, number of E/G/X copies, archives, report age (stale after 30 minutes is flagged), image generation; expanding a bot lists its copies with key, task status, branch, clean/pushed state and age.
- New `BotDiskWorkspaceRow`: on a task, "working copy: bot, path, state" and "archive: path, size, retention". Old reports without some fields render without errors.

### dockergate reports the physical state of the bot partition (1.6.5 BOT-DISK-H, part H9a)

- New dockergate route A14, `GET /myrmidon/disk` (outside the Docker API prefix; the daemon is not
  called): the partition of the volume root from `statfs` (total, used, free, percent) and the project
  quotas from `xfs_quota -x -c 'report -p -b -N' <volumeRoot>` as `{botKey, projectId, usedBytes,
  softBytes, hardBytes}` per bot, plus `other.usedBytes` (project 0, unnamed projects and names that
  `/etc/projid` does not list). The answer is the C5 shape of the bot-disk contract.
- A partition mounted without `prjquota` (the quota command fails) is a normal answer: HTTP 200,
  `quotaEnabled=false`, no projects. A volume root that cannot be read, or a report that cannot be
  understood, is `upstream_error` (502); a quota command that hangs is `upstream_timeout`.
- The route is one exact target and GET only; every other method or path under `/myrmidon/` is
  `route_not_allowed`. Operator note: dockergate must be able to run `/usr/sbin/xfs_quota -x` and read
  `/etc/projid` (open question 9 of the epic design).

### dockergate sets a bot's disk quota (1.6.5 BOT-DISK-H, part H9b)

- New dockergate route A15, `PUT /myrmidon/disk/<botKey>/quota` with `{"bytes": N}`
  (contract C5). `N` must be in [64 MiB; 1 TiB], otherwise `bad_quota` (400).
  dockergate gives the bot a stable XFS project id (kept in `/etc/projid` and
  `/etc/projects`, both replaced atomically), points the project at the bot's
  volume `<volumeRoot>/<botKey>` and sets a hard limit of `N` and a soft limit of
  0.8 of it with `xfs_quota`. Answer: `{"ok": true, "projectId": ..., "hardBytes": ...}`.
- The same request again keeps the project id and the files. If the bot
  partition is mounted without `prjquota`, the answer is `quota_unavailable`
  (503) and nothing is written. A key that is not a lowercase UUID, another
  method or a query string is `route_not_allowed`; a bot that is not enrolled is
  `bot_not_enrolled`. The route never reaches the Docker daemon.

### the execution continuation leaves `context_snapshot` (DB-CARE DBC-3)

- New table `heartbeat_run_continuations` (migration `0330_heartbeat_run_continuations`,
  one row per run, unique on `run_id`). The continuation envelope of a run is written
  there by `heartbeat.ts` instead of `heartbeat_runs.context_snapshot`; the row also
  carries `envelope_chars` for the DB audit and `wake_links` (run id, origin comment
  ids, source run id, interaction id) that reference the wake payload instead of
  copying it a second time. `heartbeat_runs.context_snapshot` stops carrying the task
  history, so the average snapshot size drops from the 31 KB the 08.10 audit measured.
- Readers (`execution-continuation.ts`, `run-continuation-snapshot.ts`,
  `native-completion-feedback.ts`, the interaction origin lookups) read the envelope
  from the new table and fall back to the legacy `context_snapshot` copy, so runs
  written before this change resume unchanged and a failed continuation write degrades
  to the old behaviour instead of stopping the run.
- `limitExecutionContinuationHistory` now also caps the message list by characters
  (`MYRMIDON_CONTINUATION_MESSAGE_CHARS`, default 32 000, 0 disables it). Bodies of the
  oldest messages that carry no direction become references (`bodyOmitted`): the id and
  freshness stay, the text lives in the task thread. Direction always survives — the
  original request, the latest request and the triggering comments keep their bodies,
  and a pinned body that alone exceeds the per-body budget
  (`MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS`, default 8 000) is shortened with an
  explicit marker instead of being dropped. The resume delta treats a reference as
  already delivered, and the cut is deterministic, so a capped message never comes back
  as new.
- `completedActions` of the envelope no longer collects tool receipts from every run the
  task ever had: only the previous context run (or the handoff source run) contributes,
  which is what made the envelope grow with the age of the task.

### The board no longer burns CPU on abort listeners of long bot runs (GATEWAY-DELAY-LEAK)

- The hermes gateway adapter waits between status polls with a helper that
  hung an `abort` listener on the run's signal and removed it only on abort.
  Every poll tick of a long run left one more listener behind; with thousands
  of them, every add/remove on that signal (undici adds one per fetch) walked
  the whole list. A live CPU profile of the board on 06.10 showed ~40 % of the
  single board process in `addEventListener`/`removeEventListener`, and API
  answers took 20–30 s. The helper now removes its listener when the timer
  fires.

### Hot board queries without full-row reads + company/issue index as a migration (OPE-4131 part B, closes OPE-4106)

- `getConversationOwnershipBlocker`
  (`server/src/services/conversation-continuation.ts`) selects only the columns
  it checks and returns (`id`, `agent_id`, `process_pid`, `process_group_id`,
  `process_started_at`) instead of the full `heartbeat_runs` row, which dragged
  the multi-KB `result_json` / `runner_profile_json` / `context_snapshot`
  through the executor about 10 times per run (planning alone took 74 ms in
  production).
- Migration `0302_heartbeat_runs_company_issue_coalesce_created_index.sql`
  persists `heartbeat_runs_company_issue_coalesce_created_idx` on
  `(company_id, coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at desc, id desc)`,
  created manually in production (OPE-4106); `IF NOT EXISTS` keeps the manual
  index and makes a re-run a no-op.
- Migration test
  `packages/db/src/heartbeat-runs-company-issue-coalesce-index.myrmidon.test.ts`:
  the full chain applies, EXPLAIN uses the index for the blocker predicate,
  replaying the statements is a no-op. DIVERGENCE row: `OPE-4131-B`.

### Forgotten-pause guard: the board lifts operator pauses left behind (1.6.5 PAUSE-GUARD)

- The board resumes, on its own, an agent that an operator paused and left
  paused longer than the threshold (20 minutes by default). The pause is the
  operator's own (`pause_reason = manual`); pauses the board sets for its own
  reasons — budget, archived company, import, a plugin note — are never
  touched. A resumed agent goes through the same wake chain the resume route
  uses, so its queued runs and its stranded `todo`/`in_progress` tasks come
  back to life instead of waiting for someone to notice.
- A pass resumes at most `maxResumesPerPass` agents (20 by default). The
  ceiling is what keeps a fleet-wide resume after a long night from starting
  every stranded backlog at the same instant: the remainder waits for the next
  pass and raises ONE notice per company on the attention desk, which
  disappears in the pass that finds nothing left over. Every resume is written
  to the activity log as `agent.pause_guard_resumed`.
- Settings live on the instance settings page next to "Run limits" (switch,
  threshold in minutes, interval in seconds, an allowlist of agent names, the
  per-pass ceiling) and change while the server runs — no restart, no run in
  flight is dropped. Saving re-arms the guard, so the next tick applies the new
  values. Names on the allowlist are never resumed: a maintenance window on a
  named agent is an operator decision, not a forgotten pause.
- This replaces the maintenance script that used to run from the host every 10
  minutes with a journal file and a fleet allowlist. The allowlist starts
  empty; the values an operator kept in the host file are moved in by hand.
- `MYRMIDON_PAUSE_GUARD_*` stays the default for an instance that has never
  saved the block; once saved, `instance_settings.general.pauseGuard` is the
  source of truth. The feature ships enabled: it is a defect fix (an operator
  pause that is forgotten is a stopped agent nobody decided to stop). See
  [SETTINGS.md](../SETTINGS.md).

### Run admission decides on CPU utilisation, not load average (1.6.5 RUN-ADMISSION, rc.3)

- Admission moved from the host load average to measured CPU utilisation: the
  non-idle share of all cores from `/proc/stat` over a window of at least 250 ms,
  and optionally PSI cpu pressure (`some avg10` of `/proc/pressure/cpu`). Load
  average stays in the gate report as an auxiliary number. On 06.10 load1 65.7 on
  16 cores held 11 runs while the CPU was only 60-75 % busy: load average also
  counts tasks blocked on disk or a lock.
- New limits: `maxHostCpuBusyPercent` (`MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT`,
  default 90, absolute percent of the whole CPU) and `maxHostCpuPsiSomeAvg10`
  (`MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10`, off unless set). The ceiling closes
  when either threshold is reached.
- A settings row saved before rc.3 has neither key (absent = off) and keeps
  deciding on load average as in 1.6.5 until a CPU ceiling is set. An unreadable
  `/proc/stat` (or pressure file with its ceiling set) leaves the gate `unknown`
  and the ceiling inactive, logged once; paths `MYRMIDON_HOST_PROCSTAT_PATH`,
  `MYRMIDON_HOST_PRESSURE_CPU_PATH`.
- `GET /api/myrmidon/runtime-limits` and the attention card gained
  `cpuBusyPercent`, `busyThresholdPercent`, `psiSomeAvg10`, `psiThresholdPercent`
  and `source` (`cpu-busy` / `load-average`).

### Run admission by host CPU load (1.6.5 RUN-ADMISSION)

- A new run starts only while the host's 1-minute load per core stays under
  `maxHostLoadPercentPerCore` (`MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE`,
  default 90 % of one core); otherwise it stays `queued` and the 15 s queue
  pass retries it. The night of 05.10: 43+ simultaneous run starts pushed the
  host to load 95 on 16 cores and the board's API fell over on timeouts.
- Load is read from `/proc/loadavg`, cores from `os.cpus()`; an unreadable
  reading logs once and leaves the ceiling inactive. The setting lives in
  Run limits (Instance → General, Settings → Runs & queue) and applies
  without a restart; the swarm idle-wake pass holds while the ceiling is
  closed, and a hold over 10 minutes raises an attention card.
- rc.2: the ceiling counts ABOVE the host's background floor (the lower of
  the 1-/15-minute averages per core, ratchet-stored, rising ≤1 % of a core
  per minute), so a host with always-on services is no longer held shut by
  its own baseline, and a burst of runs cannot raise the floor.
- Settings → «Runs & queue» shows the current load, floor and ceiling state.

### Per-agent start share setting and the queue snapshot in run limits (1.6.5 RUN-FAIRNESS)

- A new run limit, `maxPerAgentStartSharePercent`
  (`MYRMIDON_MAX_PER_AGENT_START_SHARE_PERCENT`, default 15): the share of the
  global concurrency ceiling's start slots one agent may take while the
  ceiling is busy. It lives in the same Run limits settings (Instance →
  General, Settings → Runs & queue, `PATCH /api/myrmidon/runtime-limits`),
  changes on the fly without a restart, accepts 1–100, and `null`/`off`
  switches it off. A row saved before 1.6.5 keeps working and takes the
  environment value or the default.
- `GET /api/myrmidon/runtime-limits` now carries a `queue` snapshot: runs in
  flight against the ceiling, runs still waiting, the timestamp of the oldest
  waiting run and the agent waiting longest — so the operator sees the real
  state of the queue next to the limits instead of guessing from the counters
  page. `queue` is `null` when the admission or the database is unavailable.
- Part 2 of RUN-FAIRNESS; the fair admission pass that enforces the share
  lands separately (part 1) and reads this key.

### Fair-queue controls in the run settings (1.6.5 RUN-FAIRNESS, UI)

- Both run settings panels (Instance → General «Run limits», Settings →
  «Runs & queue») now edit the single-agent start share,
  `maxPerAgentStartSharePercent` (1..100 or off, default 15): the most starts
  one agent may take in a 10-minute window before its new runs wait for the
  other agents' turns, so a hot agent can no longer occupy the queue while
  the global ceiling is full.
- Both panels show the queue snapshot from `GET /api/myrmidon/runtime-limits`:
  runs in flight against the concurrency ceiling, how many runs wait, and
  since when the oldest one waits (with its agent).
- The «Runs & queue» screen names why the head of the queue still waits —
  the run's `contextSnapshot.waitReason` (ceiling full, start ramp, memory
  floors, host CPU, the fair share, the agent's own concurrency limit), in
  both locales. See [SETTINGS.md](../SETTINGS.md).

### A fair queue for the global run cap, and the wait reason on the run itself (1.6.5 RUN-FAIRNESS)

- While the global ceiling is busy, a freed slot goes to the longest-waiting
  queued run: the sweep visits agents in the order of each agent's oldest
  queued run, and a per-agent share gate (`maxPerAgentStartSharePercent`,
  default 15, over the sliding 10-minute window) holds back an agent that took
  its share while other agents wait. A lone queue is never throttled by the
  share.
- A queued run now says why: `waitReason` (`global_cap`, `start_ramp`, `memory`,
  `host_memory`, `host_cpu`, `agent_fair_share` or `agent_concurrency`) is written
  into its `contextSnapshot` by the queue pass and removed on the claim that
  starts the run.

### Memory snapshot in the run load view (1.6.5 C0-ui)

- `GET /api/myrmidon/runtime-limits` now ships a `memory` block next to
  `hostLoad` and `queue`: the host's available and total memory (the numbers
  the memory floors `MYRMIDON_MIN_FREE_MEMORY_MB` /
  `MYRMIDON_MIN_FREE_HOST_MEMORY_MB` decide on) and the server container's
  cgroup v2 usage against its limit (`memory.max` − `memory.current`, with
  the reclaimable `inactive_file` page cache counted as free — the same rule
  the admission's memory guard applies). Either side is `null` when the
  server cannot read it (no cgroup limit, host memory unreadable), so a
  consumer shows nothing rather than a number the server made up.
- Both run settings panels (Instance → General «Run limits», Settings →
  «Runs & queue») show the snapshot next to the queue line: the load screen
  now covers the queue, the ceiling, and the memory of the host and the
  server container in one place. See [SETTINGS.md](../SETTINGS.md).

### The queue starts reviews, releases and current-release work first (1.6.5 RUN-PRIORITY, part A)

- While run admission is closed, a freed slot no longer goes to whoever queued
  first: every queued run now carries an effective weight banded by its agent's
  role — the role opens the band, and the issue priority, the current-release
  lift and the aging step only order the runs *inside* it. The role therefore
  decides who starts whatever the issue priority is: a review or release run
  goes before an engineer's critical-issue run, and a run carrying the current
  release goes before every other role, one whole band above the heaviest one.
  Default role weights put `review` and `release` on top, `lead` next, then
  `engineer` and `docs`, everything else at the floor; default issue weights
  follow the familiar critical > high > medium > low order inside the band.
- Both queue paths apply it: the global sweep visits agents by their
  best-weighted queued run (weight, then the age of that run, then id) before
  starting anything, and the per-agent comparator sorts each agent's own queue
  by the same weight inside each readiness rank, with a `createdAt`
  tie-break. The admission gates themselves (load, memory, starts per
  minute, per-agent slots, the fair share) are unchanged — priority only
  reorders the choice inside the slots admission admits.
- The waiting run also says where it stands: with priority on, every pass writes
  `queuePosition` of `queueLength` into each queued run's `contextSnapshot` (the
  rank that pass's order gave it), and a run left behind by a pass that did start
  runs of its agent gets `waitReason: "priority"` — its slot went to a heavier
  run. The claim that starts a run clears both fields, so they describe the
  current wait only; the run card renders the position beside the reason (UI,
  part B).
- Against starvation: the effective weight grows by a configurable step per
  configurable waiting minutes (capped by a maximum bonus) *inside* the band,
  and a run that waits past the starvation limit takes the escape lane outright
  — one that outranks every role and the current-release lift, so no queued run
  can stay behind the queue forever.
- The weights are live settings, the run-limits pattern: the sweeps read them
  fresh every pass, so a change through `PATCH /api/myrmidon/run-priority`
  (or the environment at boot) reorders the very next sweep without a server
  restart. Turning the feature off falls back to the pre-feature ordering
  (fair-share oldest-first globally, priority-rank + `createdAt` per agent).

### Run stall detection settings without a restart (RUN-STALL-SETTINGS)

- The progress-based run liveness sweep (RUN-STALL) is configured from the UI:
  `GET /api/myrmidon/run-stall` reports the effective values — the master
  switch, the silence threshold, the sweep interval and the scan page size —
  together with where each value came from (`settings` for the stored
  document, `env` for the deployment environment, `default` for the built-in
  fallback); `PATCH /api/myrmidon/run-stall` (instance admin only) writes
  `instance_settings.general.runStall`, records the change in the activity log
  for every company (`instance.run_stall.updated`, old and new values) and
  applies the values to the live sweep, so the very next pass works with the
  new threshold and interval. No restart — a restart drops every run in
  flight.
- The environment keeps its role on an instance that never saved the settings:
  unset `MYRMIDON_RUN_STALL_*` are the built-in defaults, and the values the
  deployment sets are read with the sweep's own semantics (an unrecognized
  switch value keeps the fix on). A stored value wins over the environment;
  out-of-range writes are refused with 400 (threshold 60 s – 24 h, interval
  15 s – 24 h, page size 1 – 200).
- One source of truth: whether the sweep runs and its silence threshold belong
  to the team-liveness settings (`runStallEnabled`, `runStallThresholdSec` at
  `/api/myrmidon/team-liveness`), which the sweep already obeyed. `GET` reports
  those two values from there (with their source); `PATCH` accepts only
  `checkIntervalSec` and `pageSize` and answers 409
  (`run_stall_managed_by_team_liveness`, with the team-liveness path) when the
  body names `enabled` or `thresholdSec`.
- Instance → General carries a «Run stall detection» section: the interval and
  the page size are editable, the switch and the threshold are shown read-only
  with a link to the Team liveness section.
- The sweep itself does not change: only where it reads its settings from.

### Session generations: a task's bot session no longer grows forever (PERF-DIET K)

- The session key of a task's container bot now carries a generation:
  `paperclip:company:<cid>:agent:<aid>:issue:<iid>:g<N>`. A new generation
  starts when the current one passes its threshold — more than
  `general.sessions.maxMessages` messages (default 400) or older than
  `general.sessions.maxDays` days (default 14) — and Hermes then opens an empty
  session for the new key instead of resuming a transcript that has been growing
  since the task started (80–110 MB of `state.db` on a long task).
- The first generation has no suffix, so nothing changes — for a task below its
  thresholds, and for every session that is already running — until a threshold
  is actually crossed. The wake that starts a new generation carries the board's
  existing continuation summary plus a session-handoff note naming the previous
  session, the reason and the last run's summary; the generation change is
  recorded in the run log and, with its reason, in the board's log.
- Other adapters and the `agent`, `run` and `none` session-key strategies are
  untouched.

### Agent pause by grant (ADMIN-AGENT D)

- `POST /agents/:id/pause` now authorizes agent actors through the same
  direct-grant ladder as resume: an agent holding `agents:configure` may
  pause an agent of its company, while `agents:suggest-changes` and
  ungranted peers stay denied. Board actors keep the previous semantics
  unchanged, and the pause activity entry now records the real acting
  principal (agent, run, API key) instead of a board placeholder.
  Drain-vs-cancel semantics are untouched.

### Bot-card "Apply now" now shows the async apply: progress, applied time, failure text (ASYNC-BOT-APPLY-UI)

- After `POST .../bot-container/apply` answers 202 + `applyId` (ASYNC-BOT-APPLY,
  server side), the agent card polls `GET .../bot-container/apply/:applyId`
  every 2 s instead of holding a 36 s request open. While the pass is live the
  button reads "Applying…", is disabled, carries a spinner, and a progress
  line explains that the result will appear on the card.
- The outcome is rendered on the card: a succeeded job shows the finish time
  ("Applied at 14:03:12."), a failed one shows the server's error text — on
  screen, not only in the console. The live `applyId` is kept in
  `sessionStorage`, so reloading the page in the first minutes resumes the
  same job and the outcome (error included) is not lost with the component;
  the first poll after resume catches a job that finished while the page was
  closed.
- A poll round lasts at most ~2 minutes; then the card says the apply is still
  running and to check again in a few minutes, and the button becomes
  pressable again. Pressing it again returns the still-live job's id from the
  server (one pass, not two). An unknown job id (404 — e.g. the instance was
  rebuilt while the page was open) stops the poll and shows that reason.
- Backward compatible: a server older than ASYNC-BOT-APPLY still answers the
  POST synchronously with an `outcome`, and the card words it exactly as
  before, so this UI can merge before the server part.

### "Apply now" on the bot card is asynchronous: 202 + apply id, background pass, DB status (ASYNC-BOT-APPLY)

- The apply button used to run the whole reconcile inside the HTTP request and
  held it for ~36 s on a cold restart (facts §6.3). `POST
  /api/myrmidon/agents/:id/bot-container/apply` now validates what the old
  route validated inline (feature flag, runtime presence, saved-card
  applicability — same 409/503 answers as before), journals one row in the new
  `bot_apply_jobs` table and answers **202 `{ applyId, status }` in under a
  second**. The reconcile pass runs in the background of the same process
  (fire-and-forget; every outcome is written to the job row, no unhandled
  rejection, no new dependencies, no restart).
- `GET /api/myrmidon/agents/:id/bot-container/apply/:applyId` reads **only the
  database** and answers `{ status, error, startedAt, finishedAt }` with
  `status` walking `pending → running → succeeded | failed`. A failed pass
  stores the (clipped) failure text in `error`, so the outcome a presser needs
  is never lost in a catch. Unknown/foreign ids answer 404; the route is
  board-actor-gated like the POST.
- Idempotency: while a bot has a live (`pending`/`running`) job, a repeated
  POST returns that job's id instead of queueing a second pass; the
  `bot_apply_jobs` partial unique index enforces one live row per bot across
  racing POSTs and api processes, and the store re-reads the winner's row on a
  unique violation. A live job older than ten minutes is an orphan of a
  stopped board process: the next POST closes it as `failed` (the reason stays
  readable through the status route) and starts a fresh pass, so a crash never
  pins the bot to a dead job id.
- Contract for the board UI (part B of the parent task): after the 202, poll the GET
  status until it leaves `pending`/`running`; render `error` on `failed`.

### Attention feed: stale-while-revalidate cache, one background rebuild (ATTENTION-FEED-SWR)

- The per-company attention feed snapshot is now served while it is stale. A
  snapshot older than the TTL is returned at once, and one background rebuild
  refreshes it; the reader does not wait for that rebuild. Parallel callers
  share the single rebuild of a cache key, so a poll from every open tab costs
  one feed build instead of one per tab.
- Past `2 × TTL` the read waits for a rebuild again. A reader therefore never
  receives a snapshot older than `2 × TTL`.
- The TTL default is now 60 seconds, the UI poll interval (was 45 seconds).
  `instance_settings.general.attentionFeedCacheTtlSeconds` still takes 0 to
  300, and `0` disables the cache.
- Invalidation stays TTL-based. The existing explicit invalidation (dismiss
  and snooze writes) additionally discards a rebuild that started before that
  write, so such a write is still visible on the next read.
- `generatedAt` now carries the build time of the served snapshot instead of the
  request time. A feed served from the cache therefore reports the age of its
  data rather than the age of the poll, and two reads of one snapshot return the
  same value.
- Unit tests with fake timers cover the three windows: fresh, stale (served at
  once, one rebuild for N parallel callers), and older than `2 × TTL` (waits).

### Attention feed: bounded failed-run window and a per-company cache (ATTENTION-WINDOW-CACHE)

- `GET /api/companies/:id/attention` recomputed the whole feed on every
  request and read every unresolved failed run of the company. The query
  window grew with the age of the oldest unresolved failure, so on
  production-like volume the route answered in tens of seconds.
- The failed-run window is now bounded by a horizon: exhausted runs created
  older than `now − horizon` never enter the feed, and the follow-up run
  lookup is additionally constrained by `created_at > greatest(oldest failed
  run, now − horizon)`. The horizon is an instance setting
  (`instance_settings.general.attentionFailedRunHorizonDays`, default 7
  days). Card semantics for fresh failures are unchanged.
- The built feed snapshot is cached per company in an in-process TTL cache
  (`instance_settings.general.attentionFeedCacheTtlSeconds`, default 45
  seconds). The cache key is the company, the request options
  (`all`/`queue`/`userId`/`includeDismissed`) and the horizon. Writes
  (dismiss, decisions) are visible with up to the TTL delay; there is no
  invalidation event and no new table, and no redis.
- Unit tests cover the horizon (an old failure stays out, a fresh failure is
  in, the second query window is bounded) and the cache (a second `list()`
  inside the TTL serves the stored snapshot and runs no new feed queries;
  after expiry the feed is rebuilt). Existing attention suites pass; the
  read-after-write suites opt the cache out per service instance.

### Backup retention: a "keep only the latest backup" option in instance settings (BACKUP-KEEP-LAST, UI part)

- The general instance settings page shows a "Keep only the latest backup"
  option next to the daily/weekly/monthly retention presets. It is active when
  `backupRetention.keepLastOnly` is `true` and is saved through the existing
  `PATCH /api/instance/settings/general` with
  `{"backupRetention": {..., "keepLastOnly": true}}`.
- Picking any daily/weekly/monthly preset turns the mode back off
  (`keepLastOnly: false`) so the two ways of configuring retention never fight
  each other; while the mode is on, a hint under the presets explains that the
  presets are ignored.
- The contract is additive (`keepLastOnly?: boolean` on
  `BackupRetentionPolicy`); the server part ships separately.
- A safety note under the option states the server behaviour: older backups are
  deleted only after the new dump passes verification, so a broken new dump
  leaves the older copies in place (nothing is lost, but disk space is not freed
  until the next successful run).

### Keep only the last verified database backup (1.6.5 BACKUP-KEEP-LAST)

- `instance_settings.general.backupRetention.keepLastOnly` (default off): when
  on, a backup run ignores the tier presets — after the new dump is written it
  is stream-verified (full gunzip pass plus a dump-completion marker in the
  decompressed tail, holding only a 64 KiB buffer) and only then every
  previous `<prefix>-*` backup is deleted.
- A new dump failing verification is deleted on the spot, all previous backups
  kept: the mode can never trade a good old backup for a bad new one. Both
  engines (pg_dump and the JavaScript logical dump) verify and prune
  identically; a verification failure is never retried on the other engine.
- Independent of the mode, pruning first removes orphaned unfinished `.sql`
  files older than one hour (leftovers of interrupted runs); the live run's
  own writer is never touched.
- Additive: payloads written before 1.6.5 parse unchanged. The UI toggle ships
  separately; server contract `keepLastOnly` on
  `PATCH /api/instance/settings/general`.

### Container bot cards are complete, and the image rollout names every bot (1.6.4-BOT-CONTAINER-CARD)

- Migration `0299_bot_container_card_complete`: cards with a `container` block
  get `enabled: true` and the product defaults for missing limits (`memoryMb`
  2048, `cpus` 1, `pidsLimit` 512); values already on the card win. Such cards
  were refused at apply and skipped by the bot-image rollout before.
- Saving an incomplete `container` block is refused 422 naming the fields; the
  card UI shows and fills what is missing.
- The bot-container status API carries `imageTracking`
  (`tracks_release` / `pinned` / `not_applicable`); the rollout reports every
  bot in one of these categories and its card PATCH sends the whole
  `container` block (an image-only patch dropped the limits).
- Clone-hygiene reports are collected per bot by name (the old container
  listing was on dockergate's closed list and answered 403); dockergate gained
  the narrow read-only archive route A13 for the report file (one fixed file of the main container).
- Contract test: every Docker API path in the board driver must be in the
  gate's allowed-routes table.

### A bot can no longer fill the host disk (1.6.1-BOT-DISK-C)

- Per-bot disk quota: instance setting `general.botDiskQuota` — a default in MB
  for every bot, per-caste (`agents.role`) and per-bot overrides, plus a
  `container.diskQuotaMb` override on the bot card (it wins). Set in the panel on
  the instance general settings page or through `GET`/`PATCH /api/myrmidon/bot-disk-quota`
  (instance admins only); applies without a restart.
- Usage is the bot's own volume `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes,
  workspace, scratch), measured by the maintenance-tick sweep one page of bots
  per tick; a hard-linked pnpm store counts once per bot, deep or huge volumes
  stop at caps and report a lower bound.
- Approaching (>=80%) or exceeding the quota raises an attention card
  (`bot_disk_quota`) on the board's attention queue; while a bot is over quota a
  NEW execution workspace clone is refused before its directory is created, and
  the bot sees `BOT_DISK_QUOTA_EXCEEDED:` with its usage, the limit and the setting
  to fix. Existing workspaces keep working; deleting old drafts frees room.
- With no `MYRMIDON_BOT_VOLUME_ROOT` on the board's host, or no quota saved, the
  feature is inert: no measurement, no card, no refusal. Details:
  [bot-disk-quota.md](bot-disk-quota.md) / [bot-disk-quota.ru.md](bot-disk-quota.ru.md).

### Bot task workspaces are owned by the board: `myr-ws`, worktrees off a per-bot base, removal on task lifecycle events (1.6.5 BOT-DISK-H, parts H1–H5, contract H0)

- A task's working copy is now a **git worktree** of a per-bot bare base
  (`<HERMES_HOME>/.myrmidon/git-base/<owner>/<repo>.git`, standard refspec
  `+refs/heads/*:refs/remotes/origin/*`, `fetch.prune=true`, `gc.auto=0`), not a
  clone the bot made itself: no per-copy objects, no `--filter` promisor packs,
  no token in `.git/config`. The base limit is 8 repositories per bot
  (`WS_GIT_BASE_LIMIT`), a base fetch is throttled to one per 900 s
  (`WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC`).
- New in-image CLI `myr-ws`: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
  `list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`.
  `open` is idempotent (`reused: true` for an existing copy). Task copies live at
  `/workspace/<ISSUE-KEY>` on branch `bot/<KEY>`; scratch copies (class G) at
  `/scratch/<name>`.
- The git wrapper no longer adds `--reference`: a `git clone` of a GitHub
  repository is intercepted into `myr-ws open` (the task key comes from
  `MYRMIDON_TASK_WORKSPACE`, otherwise the clone becomes a scratch copy);
  `--filter`/`--depth`/`--mirror`/`--bare` are ignored with a message — the
  objects are already in the base. The real git moves to
  `/opt/paperclip/libexec/git` outside PATH; the credential helper stays the
  only source of auth, so a token never lands in a repository config.
- The board, not a timer, drives removal: the in-container agent `botd` fetches
  the desired state `GET /api/myrmidon/bots/me/workspaces` (`state:
  active|closing` per copy, grace `closingMinutes` 30, `scratchTtlHours` 24) and
  removes the worktree when the task turns terminal / is reassigned / its PR
  merges. A copy with unpushed work is **archived first** (branch bundle +
  patch + untracked files under `archive/<KEY>-<ts>.*` with a manifest, cap 2
  GiB and 30 days per bot) and can be brought back with `myr-ws restore <KEY>`.
  When the board is unreachable botd is fail-safe: it deletes nothing.
- Refusals are explicit, with stable exit codes parsed by the gateway:
  `3` quota/disk — the message starts with `BOT_DISK_QUOTA_EXCEEDED:` —
  `4` repository over the base limit, `5` network/fetch, `6` no such
  copy/archive, `7` unpushed work without `--force`. A run whose `workspace`
  field cannot be opened (codes 3/4/5) still starts, in `/scratch`
  (`RUN_WORKSPACE_FALLBACK_DIR`), with a warning event — never a silent
  failure.
- Observability: botd posts `POST /api/myrmidon/bots/me/disk-report`
  (bases, copies with clean/pushed flags and sizes, archives, actions, foreign
  copies with their sign; body ≤ 1 MiB, at most 200 actions) and the answer
  sets its next tick (`nextReportSec`). Attention cards:
  `bot_disk_lifecycle/agent-silent` (report older than 30 min),
  `bot_disk_lifecycle/drift`, `bot_disk_lifecycle/foreign`,
  `bot_disk_lifecycle/ws-cli`, `bot_disk_lifecycle/reflink`,
  `bot_image_stale`, `bot_disk_archive`.
- New instance settings under `general.botDisk.*`: `graceClosingMinutes` (30),
  `scratchTtlHours` (24), `partitionThresholdPercent` (85),
  `partitionRefuseOpenPercent` (90), `partitionCriticalPercent` (95),
  `pnpmStoreDir`, `pnpmImportMethod`; the per-bot quota setting is the existing
  `general.botDiskQuota`. See SETTINGS for the full table.
- Interface contract H0 (directory layout, CLI, desired state, disk report,
  dockergate routes, `/v1/runs` field, settings) is fixed in
  `docs/myrmidon/bot-disk-contract/README.md` with JSON fixtures that validate
  against the Zod schemas in `packages/shared/src/myrmidon-bot-workspace.ts`
  (PR #702). This change documents and implements against that contract;
  neighboring parts land as their own PRs.

### Selectable disk isolation scope for bots (BOT-DISK-F)

- Each bot keeps its own disk by default. The owner can now set a scope
  instance (named group, caste, reporting subtree, project, catalog team, or
  the whole company) to shared root: members share one host directory and one
  pnpm store, so hard links work across the bots of the instance. The most
  specific level wins.
- Groups are a first-class entity, managed in Instance settings or through
  `/api/myrmidon/companies/:id/bot-scopes`, with no restart.
- A change marks bots `restart required`; apply runs a checked sequence per
  bot (pause, dry-run of the move, build the replacement, stop, rename, swap,
  start-time self-check, resume). Nothing restarts by itself.
- dockergate accepts the shared bind only for enrolled bots; deploy the gate
  and the board together and enrol before applying.
- Trade-off: members share one uid and directory — share only between bots
  that trust each other. DB: four `myrmidon_scope_*` tables (migration 0300).

### The driver normalizes the bot root's traversal at apply; a blocked /bot fails with its own error (BOT-ROOT-TRAVERSE)

- A bot mounts `<volumeRoot>/<botKey>` at `/bot`, but the prepare helper only
  fixed the three subdirectories behind it: a root left `0710` by an external
  operation (51 of 74 production bots) hid `/bot` from the bot's uid 10001 and
  surfaced as a misleading "API_SERVER_KEY is required".
- The prepare helper (driver, template, dockergate mirror, contract fixtures)
  now also binds the bot root and ends with one non-recursive `chmod 0711` —
  the bot can enter `/bot` without browsing it; idempotent, no recursion or
  globs. The shared-scope layout needs no extra line.
- dockergate's isolated helper accepts exactly the four binds; the gate
  deliberately lets mode `0710` pass so the helper can reach and fix it.
- entrypoint.sh: an unexecutable bot root fails in one line naming the
  problem (recreate the bot) instead of falling through to the API-key error.
  Tests: prepare-root-traverse, entrypoint, driver/scope/gate units.

### Auxiliary calls of a bot have a cheap ceiling, never a paid fallback (1.6.5 BOT-RUNTIME-TUNING-AUX-CEILING)

- The instance setting `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (a list of gateway
  model aliases) is written by the profile compiler as
  `auxiliary.title_generation.fallback_chain` and
  `auxiliary.compression.fallback_chain` in the bot's `hermes/config.yaml`.
- Hermes walks that chain before the main chain and the gateway ladder, so a
  refused auxiliary request is served by another cheap model instead of
  climbing into a paid one (02.10: a rejected `json_schema` in title
  generation was served from a paid model). Dropping unsupported
  `response_format` needs no change — Hermes keeps a per-route memo.
- Each entry resolves its own base URL and key env; an entry repeating the
  task's model is dropped; an unresolvable route drops the chain with a
  compile warning. The ceiling never covers `auxiliary.vision`.

### Compression threshold in tokens comes from the agent card; the fleet compacts at 100 000 (BOT-RUNTIME-TUNING A)

- A bot profile now carries `compression.threshold_tokens: 100000` by default, so a
  long session compacts at that count instead of at half the model's window (for
  `dashscope-glm-5.3` that was ~255k tokens and multi-minute compactions).
- The agent card gained a **Compression threshold (tokens)** field
  (`adapterConfig.models.compressionThresholdTokens`): one agent can be tuned
  without touching the instance. Empty keeps the company default.
- `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` is now an override of that company
  default instead of an on/off switch, and an explicit `0` turns the cap off
  (Hermes's own 256 000 applies). `model.context_length` and its own card field
  are unchanged.

### BOT-RUNTIME-TUNING, part C: per-model effort validation and safe default instead of medium (1.6.5-BOT-RUNTIME-TUNING)

- The agent card's "Thinking effort" field now offers only the values the
  selected model accepts (GLM models via DashScope: low/high/max), and saving
  the card rejects (422) a value the model refuses.
- An empty effort on the card no longer reaches Hermes as its global default
  "medium": the profile compiler (bot containers) and the single-run config
  overlay (hermes adapter) write the model's own safe default instead
  (GLM → high), so DashScope no longer rejects the effort and the LLM gateway
  no longer falls back to another model on every call.
- The effort registry (`effortsForModel` / `effortForModel`) is the single
  source; a future model-provider registry entry overrides the static table.

### Model fallback signal: the threshold is a board setting, and the signal shows on the bot's card (1.6.5 BOT-RUNTIME-TUNING-D2)

- The model fallback signal thresholds are instance settings, not startup
  values: `GET`/`PATCH /api/myrmidon/model-fallback/settings` read and write
  `instance_settings.general.modelFallbackSignal` (board reads, instance-admin
  writes); every key reports its origin (`settings`, `env` or `default`). The
  sweep re-resolves the row each tick and schedules the next pass by the
  returned interval, so a change of N%, the window, the minimum call count or the
  sweep period applies without a restart. `MYRMIDON_MODEL_FALLBACK_*` variables
  keep working as per-key overrides.
- The signal shows on the agent's card, not only in the attention feed.
  `GET /api/myrmidon/companies/:companyId/model-fallback/status` returns the last
  sweep's rows per agent (attributed calls, fallbacks, share, serving models,
  above-threshold flag) with the effective numbers; the agents list renders a
  `fallback N%` badge for an agent above the threshold.
- With the switch off the sweep makes no gateway request: it reads one settings
  row per interval and clears both registries, so no stale card or badge
  lingers, and turning it on takes effect within one interval.
- Built on the 1.6.1 module `server/src/myrmidon/litellm-fallback-signal/`
  (attention kind `model_fallback_alert`); the existing policy tests stay green.

### One mount per bot container, hard-linked node_modules (BOT-DISK-D)

- A bot container has one bind for its writable data: `<volume root>/<bot key>`
  at `/bot`, with `hermes/`, `workspace/` and `scratch/` inside; `/data/hermes`,
  `/workspace` and `/scratch` are links made by the image. link(2) cannot cross a
  mount point, so with three binds (and the pnpm store on a fourth) every `pnpm
  install` silently copied each package into each clone and a bot's disk grew
  ~5 GB per hour. The host layout is unchanged; helper containers keep their
  three narrow binds; dockergate accepts the single-bind body (deploy dockergate
  and the board together, as in ONE-DEPLOY).
- The pnpm store lives inside the mount (`/workspace/.pnpm-store`) and pnpm runs
  with `package-import-method=hardlink`. pnpm 9 still copies silently when the
  kernel refuses a link, so the guard is the start-time self-check, not pnpm.
  `/cache/pnpm` stays a download cache only. Settings `general.botDisk.pnpmStoreDir`
  and `pnpmImportMethod` replace `pnpmStore` (`workspace`/`shared`), applied on
  the next reconcile pass (Instance -> General).
- Every container start checks that a hard link from the store into
  `/data/hermes`, `/workspace` and `/scratch` works; a failure is logged and
  shown as an attention card (`bot_disk_lifecycle`) via the clone-hygiene report.
  The image build checks all three roots and the repository test runs the script.
- Migrating running bots: [bot-disk-cache.md](../bot-disk-cache.md#migrating-running-bots-to-the-single-mount).
  Removed: the `pnpmStore` key (a stored value is ignored) and its `shared` mode.

### `devbuild`: bot builds and tests on the build VPS (BUILD-OFFLOAD B)

- The dev bot image carries `/opt/paperclip/bin/devbuild` (root-owned, from
  `docker/bot-runtime/devbuild/devbuild`): it rsyncs the `/workspace` repo
  copy (`.git` included, `node_modules` and build outputs excluded) to
  `$DEVBUILD_BASE/<bot>/<repo>/` on the shared build VPS over ssh, runs the
  given command there with the shared caches exported
  (`npm_config_store_dir=/srv/devcache/pnpm`, `GOMODCACHE`, `GOCACHE`,
  `GRADLE_USER_HOME` — created on first run, shared by all bots) and passes
  the exit code through. Heavy jobs (`pnpm -r typecheck`, full test suites,
  `go test`) run there instead of inside the 1 CPU / 3 GB bot container;
  editing, git and pushing stay local.
- Connection settings come only from the bot profile env (`DEVBUILD_HOST`,
  `DEVBUILD_USER`, `DEVBUILD_BASE`) — nothing is baked into the image or
  tests; without them the script prints a pointer to the `devbuild` skill and
  exits 1. The ssh key is read from `/opt/devbuild-ssh/id_ed25519`, mounted by
  the runtime template; key authorization and remote resource limits are the
  fleet operator's part. The image adds `rsync` for the transport.
- New skill `skills/devbuild/SKILL.md` documents when to use it, the env
  table, where the caches live, how to collect results and the typical
  errors, with pnpm/tsc/go examples.

### Change fragments: new sections, prose, row replacement and a converter (CHANGE-FRAGMENTS)

- A fragment can now carry what used to force a hand edit of the shared
  registry documents: whole new `##` sections for DIVERGENCE.md / SETTINGS.md /
  SETTINGS.ru.md (`…-new`), prose or tables inside an existing section
  (`…-append`) and rewritten table rows (`…-replace`), each with an anchor by
  section heading, occurrence number or exact line. Fragments are applied in
  plain code-unit order of their file names, so the assembled documents do not
  depend on how the file system lists them.
- `scripts/myrmidon/release/fragments-from-diff.mjs` converts a branch that
  already edited the shared documents: it writes the equivalent fragment,
  reverts the documents, and checks that assembling the fragment reproduces
  the branch's own edit (a mismatch stops the run). Format and usage:
  `docs/myrmidon/changes/README.md`.

### Chat reconciliation asks a cheap "is there work" gate before each lane (DB-PERF-C-P5)

- The chat reconciliation coordinator ticks once a second and ran every durable
  lane on every tick, whether or not the lane had anything to do. Measured over
  04–06.10 on the production database: the run-milestone projection 37k calls ×
  58.7 ms (≈2197 s CPU), the `chat_actions`/`agent_wakeup_requests` sweeps 34k ×
  74.6 ms (≈2556 s CPU) and ~921k sequential scans over `chat_publications`
  (~1.65e9 tuples) — ≈5.5k s of CPU in a 13.6 h window while the queues were
  almost always empty.
- Every gated lane now answers one cheap question first, with ONE statement of
  the shape `select 1 where <probe> limit 1` over the lane's own outbox (module
  `server/src/myrmidon/chat-reconciliation/work-gates.ts`): the publication
  flush probes the due `chat_publications` rows (`chat_publications_work_idx`),
  the delivery lane probes `chat_deliveries` plus every `chat_actions` kind it
  drains (`chat_deliveries_work_idx`,
  `chat_actions_inbound_wakeup_sweep_idx`), the Slack lanes probe their own
  `chat_actions` kind, and the run-milestone lane probes runs of live chat
  conversations updated after the last completed pass
  (`heartbeat_runs_company_ctx_issue_created_idx`). A gate that answers "no
  work" skips its lane for that tick.
- The probes are deliberately conservative: a probe may report work for a queue
  that turns out to be empty (the lane then behaves exactly as before), never
  the other way round. Nothing was rewritten inside the lanes themselves.
- `notifyPublications()` — the live "a publication was committed" signal —
  bypasses both gates for exactly one forced pass of the publication and
  milestone lanes, so a fresh commit cannot wait for the next tick that happens
  to have other work. Periodic recovery polls do not force anything.
- The run-milestone lane keeps a watermark of its last completed pass in
  process memory. The first tick after a start/restart is always a full pass
  (nothing accumulated while the process was down is lost), a pass that
  inserted anything does not move the watermark (the projection may have
  stopped at its own row budget with older candidates still unprocessed), and
  one full pass per 10 minutes bounds the delay of a candidate that becomes
  eligible without a run being updated.
- The Telegram-notify proactivity sweep used to sit in front of the publication
  flush inside the same lane. It is a producer for that queue, so it moved to
  its own lane and keeps its cadence while the flush is gated.
- The publication lane also runs two notice producers
  (`enqueueInboundWakeupPublications`, `enqueueFailedChatRetryPublications`)
  whose condition is "a settled wakeup whose notice publication is still
  missing". That one question cannot be asked inside a cheap index probe — it
  costs a scan of the whole settled-wakeup population plus one publication
  probe per row, and measured slower than the sweep it would replace — so the
  lane reaches those producers through a safety window instead: one forced pass
  every 5 seconds. An idle instance therefore pays for the sweep a fifth as
  often (a fifth of its previous share of the tick), and a notice waits at most
  that window; any other publication work, or a live commit signal, opens the lane
  immediately.
- Left ungated on purpose: provider-runtime reconciliation, GitHub webhook
  delivery recovery, and the periodic Telegram endpoint state-repair staging
  inside `processPendingTelegramMaintenance` (its condition is a
  runtime-derived scope that SQL cannot reproduce, and the same staging is
  reached from the endpoint lifecycle paths).
- No migration: the gates use the index set of the release they land in.

### Fix: chat reconciliation work gates failed on every call (DB-PERF-C-P5)

- The cheap work gates bound a JavaScript `Date` as a parameter inside raw
  `sql` templates (`next_attempt_at <= $1`, `updated_at > $1`), which the
  postgres-js driver cannot serialise. Every gate probe threw, so the log
  filled with `Failed to reconcile chat run milestones` and `Failed to
  reconcile chat publications` roughly every 30 seconds. Timestamps are now
  bound as ISO strings with an explicit `::timestamptz` cast. A regression test
  runs the gates against a real PostgreSQL.

### Knowledge corpus pilot: pgvector search matches RAGFlow (CORPUS-2.0 step 3)

- The step 3 pilot of the corpus epic measured retrieval on PostgreSQL +
  pgvector against the RAGFlow baseline: recall@5 0.8429 vs 0.829, nDCG@10
  0.7056 vs 0.663, p95 search latency ~0.1 s vs ~15 s (gate p95 < 2 s passed
  with a wide margin). Recommendation for the future corpus module: DashScope
  `text-embedding-v4` (1024 dimensions) via the LiteLLM gateway, HNSW index
  (`m = 16`, `ef_construction = 64`, `ef_search = 64`), hybrid retrieval with
  RRF (`k0 = 60`, `k_candidates = 100`) and a `pg_trgm` GIN full-text index;
  embedding cost ~$1.64 per 100,000 chunks. The pilot ran outside the product
  and changes nothing in this build; the record and the decision are in
  [design/corpus-pgvector-pilot.md](design/corpus-pgvector-pilot.md).

### Data retention: the run and log windows in instance settings (1.6.5-DB-RETENTION, UI part)

- The general instance settings page shows a "Data retention" panel that edits
  the three whole-day windows of the grown tables: "Run history"
  (`heartbeatRunsDays`), "Activity log" (`activityLogDays`) and "Access audit
  logs" (`accessAuditDays`). `0` keeps the rows forever. The values are saved
  through `PATCH /api/myrmidon/data-retention` and the cleanup sweep re-reads
  them on every run, so a saved value applies without a restart.
- An input accepts only a whole number of days (`0` or more); anything else —
  a negative or fractional draft — shows an inline error and no request is
  sent, the same draft pattern the host disk panel uses.
- The panel reads `GET /api/myrmidon/data-retention` and shows the state of the
  last cleanup: the time of the last sweep and of the last backup check, how
  many rows were deleted and how many bytes were freed per table group, and the
  total freed.
- While the sweep is waiting for a fresh backup (`waitingForBackup: true`) the
  panel shows a visible note that cleanup starts once a backup younger than
  24 hours exists — nothing is deleted until then.
- Each window also shows whether its value comes from the stored settings or
  from the default. On an instance that does not serve the route the section is
  not rendered at all, so the settings page never shows an empty block of dead
  inputs. The server side of the feature ships separately; until it lands, the
  panel reads the contract above.

### Retention of runs and logs: settings, sweep and backup gate (1.6.5 DB-RETENTION, server core)

- Finished heartbeat runs and access-audit rows now age out on a schedule
  (the activity log is the audit trail and is kept forever by default —
  `activityLogDays: 0` — until the instance admin opts into a limit). Three
  new instance settings —
  `instance_settings.general.datastoreCare.retention.heartbeatRunsDays`,
  `...activityLogDays` and `...accessAuditDays` — set the retention per table
  group in whole days (defaults: runs 90, activity log 0 = kept forever — it
  is the audit trail, access audit 180; `0` keeps the group forever). The
  settings live in the datastore-care object of the §3.6 "Хранение" panel
  (`general.datastoreCare.retention`); the stored value is the single truth,
  an absent row applies the defaults.
- A retention sweep runs at most one pass per 10 minutes (the 30 s scheduler
  tick no-ops in between), deleting in batches of 5000 rows (at most 100
  batches per table per pass, under a 60 s statement timeout) — every batch
  is its own transaction, so a failed batch rolls back only itself, and a
  batch that hits the timeout writes one `data.retention_sweep_throttled`
  activity line instead of being swallowed silently. The sweep state
  (`lastRun`) is written only when a pass actually deleted something or the
  backup-gate flag changes — not on every idle tick. A run is deleted only
  when it is finished, past the retention and not referenced by open work:
  runs of open issues (execution/checkout), retry parents of live runs and
  the sources of unresolved failed-run attention items survive, as do the
  activity rows of every surviving run (the audit trail stays complete). A
  run referenced by any decision-making or native completion record
  (decisions, decision bundles, status decisions, work assessments, native
  run results) is never deleted — those records outlive the run. Run events
  go with their run; financial rows keep their record with the run reference
  cleared.
- The sweep never deletes without a fresh verified database backup: when the
  newest `<prefix>-*.sql.gz` in the configured backup directory is older than
  24 hours (or missing), the pass deletes nothing, writes one
  `data.retention_waiting_for_backup` activity line (at most once per hour)
  and reports `waitingForBackup` in its status; the gate lifts on the next
  pass once a fresh backup appears. The filename prefix is configurable via
  `MYRMIDON_DB_BACKUP_FILE_PREFIX` (default `paperclip`) — see
  [SETTINGS.md](../SETTINGS.md).
- `GET /api/myrmidon/data-retention` (board-readable) reports the three
  values with their source (`settings` | `default`) and the last pass
  (timestamp, per-table deleted counters, a freed-bytes lower bound, the
  backup-gate state, all persisted across restarts).
  `PATCH /api/myrmidon/data-retention` (instance-admin) changes the values;
  the sweep re-reads them at the top of every pass, so no restart is needed.
  The settings UI ships separately (part P2).

### Four audit indexes for the heartbeat_runs and issues hot paths (1.6.5 DB-AUDIT-INDEXES)

- The PostgreSQL audit measured four hot query groups that the planner could
  not serve with any existing index: the attention feed over `heartbeat_runs`
  (company + agent id + created_at window — 1 926 s per 13.6 h statistics
  window), the chat-reconcile milestone projection (company +
  `context_snapshot->>'issueId'` + status — 2 197 s), and the issue claim
  lockup (`FOR UPDATE` on company + execution_run_id / checkout_run_id —
  2.6k s, a Seq Scan that also locked neighbouring rows).
- Migration `packages/db/src/migrations/0306_audit_indexes_heartbeat_issues.sql`
  adds four plain b-tree indexes:
  `heartbeat_runs (company_id, agent_id, created_at)`,
  `heartbeat_runs (company_id, (context_snapshot->>'issueId'), status)`,
  `issues (company_id, execution_run_id)`,
  `issues (company_id, checkout_run_id)`.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. Both tables are bucketed "medium" by the migration-safety
  checker, so a plain build is the accepted form here; production deploys run
  through the operator's maintenance mode.
- The audit's blocker expression index (company, coalesced issue reference,
  created_at) is not in this migration — the hot-queries PR persists it as
  migration 0302, and this branch deliberately does not duplicate it.
- Guard: `packages/db/src/audit-indexes-migration.myrmidon.test.ts` checks the
  migration file, the journal entry and the snapshot statically, confirms the
  four audited query shapes plan onto the new indexes on embedded Postgres, and
  applies the migration twice on one database to prove idempotency.

### Five audit indexes and lz4 column compression, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created five indexes by hand on the
  production board database. Migration
  `packages/db/src/migrations/0308_db_care_audit_indexes.sql` persists the five
  statements verbatim, each as `CREATE INDEX IF NOT EXISTS`, so the deploy on
  production is a no-op and a fresh installation builds the same indexes.
- The five indexes: `activity_log_issue_last_activity_idx` (partial
  `(company_id, entity_id, created_at DESC)` without the read/inbox marker
  actions), `issue_comments_body_lower_trgm_idx` (partial GIN on
  `lower(body) gin_trgm_ops` without deleted rows),
  `heartbeat_runs_attention_feed_idx` (`(company_id, agent_id, created_at,
  context_snapshot->>'issueId', context_snapshot->>'taskId')`),
  `heartbeat_runs_ctx_paperclip_issue_id_idx` (partial
  `(company_id, context_snapshot->'paperclipIssue'->>'id')`) and
  `heartbeat_runs_updated_at_idx` (`updated_at`).
- No `CONCURRENTLY`: drizzle migrations run transactionally. `activity_log` and
  `issue_comments` are bucketed "large" by the migration-safety checker, so
  those two statements carry the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note.
- Migration `packages/db/src/migrations/0309_db_care_lz4_compression.sql` sets
  the compression method `lz4` on the three largest varlena columns of
  `heartbeat_runs` (`context_snapshot`, `result_json`, `stdout_excerpt`). The
  statement is catalog-only: a short `ACCESS EXCLUSIVE` lock, no row rewrite, and
  the rows already stored keep their method until they are rewritten. On
  production the three columns already carry `l`, so the statement is a no-op
  there.
- That migration is one procedural block on purpose. PostgreSQL has no catalog
  view of the available compression methods, and a build configured without
  `--with-lz4` rejects the statement (the project's own embedded-Postgres test
  harness is such a build). A plain statement would stop the whole migration
  chain on those installations for a storage tuning that is not a correctness
  requirement. The block applies `lz4` where the build offers it and otherwise
  keeps the current method and writes a notice to the deploy log.
- The Drizzle schema declares the five indexes
  (`packages/db/src/schema/activity_log.ts`, `heartbeat_runs.ts`,
  `issue_comments.ts`, label `myrmidon(DB-CARE)`), and the `0308`/`0309`
  snapshots record them, so `db:generate` stays clean and the schema tells the
  same story as production's `pg_indexes`. Compression is a storage parameter,
  so it adds no schema object and `0309_snapshot.json` repeats the `0308`
  snapshot.
- The identifier indexes of `issues` need no change: production carries
  `issues_identifier_idx` (unique btree) and `issues_identifier_search_idx`
  (GIN `gin_trgm_ops`), which are two different indexes and both are already
  declared in the schema.

### Previous-assignee index on the activity log, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created `activity_log_issue_prev_assignee_idx`
  by hand on the production board database: the attention feed resolves, for one
  agent, the issues whose assignee *left* that agent, reading the audit rows'
  payload `details->'_previous'->>'assigneeAgentId'` for `issue.updated` rows of
  a company and ordering by `created_at`.
- Migration `packages/db/src/migrations/0307_db_care_issue_prev_assignee_index.sql`
  persists the statement verbatim (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, ((details -> '_previous' ->> 'assigneeAgentId')), created_at)
  WHERE entity_type = 'issue' and action = 'issue.updated'`). On production it
  is a no-op; a fresh installation builds the same index.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. `activity_log` is bucketed "large" by the migration-safety
  checker, so the statement carries the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note,
  as the earlier activity_log indexes do.
- The Drizzle schema declares the index (`packages/db/src/schema/activity_log.ts`,
  label `myrmidon(DB-CARE)`) and `0307_snapshot.json` records it, so
  `db:generate` stays clean and the schema tells the same story as production's
  `pg_indexes`.
- The remaining production objects of the same audit (five more indexes and the
  `lz4` column compression) land with the same pull request as migrations `0308`
  and `0309` — see `docs/myrmidon/changes/db-care-audit-indexes-lz4.md`.

### DB-TUNING: the PostgreSQL settings of the database audit are applied declaratively by the deploy (deploy.sh / rollback.sh)

- `scripts/myrmidon/deploy/db-tuning.sql` and
  `scripts/myrmidon/deploy/db-tuning-rollback.sql` — the declarative source of
  the settings from the OPE-4270 audit lives in the repository: `jit=off`,
  `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`
  (with `0.02` for `heartbeat_runs`, `agent_wakeup_requests`,
  `company_secrets`), `autovacuum_analyze_scale_factor=0.02` for `issues`, plus
  `pg_reload_conf()`. The rollback file resets exactly those. No manual
  `ALTER SYSTEM` on the live server anymore.
- `scripts/myrmidon/deploy/lib.sh` — four new optional deploy settings
  (`load_config`): `DB_TUNE_COMMAND` applies the tuning file (empty — the step
  is skipped), `DB_TUNE_SHOW_COMMAND` prints a `SHOW` value for the parameter
  name in `DB_TUNE_PARAM`, `DB_TUNE_EXPECTED` lists the `name=value` pairs to
  verify, `DB_TUNE_ROLLBACK_COMMAND` returns the previous settings (empty — the
  settings rollback is skipped with a warning). Before the first apply the
  live values are recorded to `$STATE_DIR/db-tuning-previous`.
- `scripts/myrmidon/deploy/deploy.sh` — a new step after the health check:
  apply, then verify every expected pair through SHOW; a mismatch is
  DEPLOY FAILED — maintenance stays on, the rollback command is printed, and
  the half-applied settings are returned via `DB_TUNE_ROLLBACK_COMMAND`
  (same failure shape as the health step). The dry-run plan describes the step
  like the others.
- `scripts/myrmidon/deploy/rollback.sh` — after the image and health steps:
  apply `DB_TUNE_ROLLBACK_COMMAND` and verify the same parameters SHOW against
  the recorded previous values; a mismatch fails the rollback loudly with
  maintenance staying on.
- `scripts/myrmidon/deploy/deploy.env.example` — the four settings documented
  with production examples.
- `docs/myrmidon/deploy.md` / `docs/myrmidon/deploy.ru.md` — a "DB-TUNING"
  section: the audit values, where the declarative source lives, how the
  deploy applies and verifies (SHOW), how the rollback returns, and the exact
  `pg_stat_statements` query for the before/after top-query timing.
- Tests: `scripts/myrmidon/deploy/deploy.test.mjs` — the step is skipped when
  `DB_TUNE_COMMAND` is empty; a matching SHOW passes; a SHOW mismatch fails the
  deploy, keeps maintenance on and rolls the settings back; `rollback.sh`
  applies `DB_TUNE_ROLLBACK_COMMAND` and restores the previous values.

### Run-context retention: heartbeat_runs context compaction as a board function (1.6.5-DBC1)

- The bulky continuation payloads of finished runs (`executionContinuation`,
  `paperclipWake`, `paperclipTaskMarkdown`/`…Compact`,
  `paperclipWakeComment`, `paperclipSessionHandoffMarkdown`,
  `paperclipContinuationSummary`, `externalChatContinuation` — the O1a key
  list) are now compacted out of `heartbeat_runs.context_snapshot` by the
  board itself: every terminal run older than
  `instance_settings.general.datastoreCare.retention.heartbeatRunContextDays`
  (env `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS`, default 7 days, 0 =
  disabled) has those keys stripped and `_compactedAt` stamped in its
  snapshot. Small keys (taskKey, issueId, wakeReason) survive; attention-feed
  derivations and audit queries keep working. Compaction is a rewrite, not a
  row delete.
- The compaction runs on the maintenance sweep tick under the maintenance
  gate (it does nothing while an instance window is open), in batches of 500
  rows per statement with a 250 ms pause between batches and a 30 s
  statement timeout per batch, and only when the backup precondition holds:
  the newest matching backup (`<prefix>-*.sql.gz` or `<prefix>-*.dump`; with
  an empty `MYRMIDON_DB_BACKUP_FILE_PREFIX` any `*.sql.gz`/`*.dump` in the
  dir) in the configured backup dir must be under 24 hours old. Without a
  fresh backup the pass rewrites nothing and logs one throttled
  `datastore.retention_waiting_for_backup` line (at most once per hour),
  carrying the checked dir, prefix and the names it saw; the pass state
  keeps the full gate verdict under `contextLastRun.backupGate`.
- Each pass writes one `datastore.retention_applied` activity line per
  company that had work, carrying `compactedRows` and `freedBytes` (the exact
  `pg_column_size` delta of the rewritten snapshots), and persists its state
  in `general.datastoreCare.retention.contextLastRun`, so the counters survive
  restarts.
- `GET /api/myrmidon/datastore-care` (board-readable) reports the resolved
  window with its source (`settings` | `env` | `default`) and the last pass;
  `PATCH /api/myrmidon/datastore-care` (instance-admin) changes the window —
  the sweep re-reads it every pass, no restart needed. The retention
  sub-block is the same `datastoreCare` block the row-deletion limits
  (OPE-5011) live in, so the UI shows one "Storage" panel. The settings UI
  ships separately.
- With the board compaction live, the host-side O1b cron job becomes
  redundant and must be removed at rollout (recorded in the deploy repo, not
  here).

### Deploy hardening: a deploy that fails early and says why (DEPLOY-HARDENING)

- One source of truth per component image: the generated override file is
  what the deploy writes, the rollback restores and the boot unit reads; the
  previous image comes from `docker inspect`, not a file, and a stale
  override is corrected before the deploy starts.
- `--dry-run` runs the real preflight: compose project, boot unit, service
  and health settings and the dockergate config check on the edited copy —
  the dry run fails exactly when the real run would.
- dockergate health is proven by its log (`self-check ok` /
  `config_reloaded` reporting the new version and config hash), not by a
  `_ping` the host cannot make through the socket; rollback uses the same
  proof.
- Config writes keep the file's owner and mode (a strict umask no longer
  makes dockergate's config unreadable), and after SIGHUP the deploy verifies
  the loaded config hash and fails loudly otherwise.

### The board image is proven on a copy of the production database before the window; rollback without a live board (PREDEPLOY-DB-CHECK)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (new): before the
  maintenance window the production dump is restored into a throwaway Postgres
  and the new board image runs next to the new dockergate on an isolated
  network; it waits for `/api/health` `ok` with the image's version, walks the
  attention list and main routes, and any failure stops the deploy with
  nothing changed on production (the 1.6.3 crash on production data inside
  the window is why it exists).
- deploy.sh step 3b runs it pre-window; changed components roll out BEFORE
  the board switch; rollback of the board happens only if its image line was
  written.
- rollback.sh no longer needs the board API to enter/leave maintenance — a
  rollback usually runs BECAUSE the board is down; the image switch and health
  check still decide. `maintenance_enter` reports a failed enter honestly.
- New `MYRMIDON_PREDEPLOY_*` settings (check on by default); tests walk the
  whole throwaway stack against fake `docker`/`curl`.

### The board no longer storms dockergate; a fleet rollout fits the gate's limit (1.6.5-DOCKERGATE-A2A3-STORM)

- On 05.10 (rc.1) the board sent 5 395 allowed A2/A3 requests to dockergate
  in three minutes (~30/s against the gate's global 50/s bucket, 394 429
  refusals); a five-bot rollout batch took 6–10 minutes with most applies
  failing on 429. Four stacked causes fixed: the clone-hygiene report
  collector asked every bot every 5 s maintenance tick; the reconcile pass
  inspected each bot twice; the post-apply health wait polled every second;
  a 429 failed the pass only to hammer the gate on the next tick.
- The collector moved to its own timer (`MYRMIDON_CLONE_REPORT_INTERVAL_SEC`,
  default 300 s — reports are valid 24 h), reconcile
  probes status and drift from one inspect (2 gate requests per bot per pass
  instead of 3), the health wait polls every 5 s (was 1 s), and the gate client
  has a token bucket (`MYRMIDON_DOCKERGATE_MAX_RPS`, default 20/s across all
  loops) and a 429 retry with exponential backoff and jitter, honouring
  `Retry-After`, up to 5 retries.

### The board generates the media ACL registry and the facade reloads it without a restart (MEDIA-PROVISION, part B)

- New exporter in the bot-container sweep (`server/src/myrmidon/bot-containers/media-acl-export.ts`):
  every reconcile pass collects the fleet's cards and rewrites the media MCP
  `bots.json` itself — for every container bot whose card env resolves a
  non-empty `MEDIA_TOOLS_TOKEN`, one entry `{token_sha256, peer_host, tools}`
  keyed by bot key, `peer_host` the container's docker-DNS name, `tools` the
  default allowlist of `tools/media-mcp/config.example.json`. A card without a
  token contributes no entry. The exporter never creates tokens (provisioning
  is the separate card-side half of the track) and never writes or logs the raw
  token — the file carries only its sha256.
- The rewrite is atomic (temp file + rename, mode 0600) and deterministic
  (bot keys sorted): the file is touched only when its text or mode actually
  changed, so the facade sees exactly the card changes. A failed export leaves
  the previous registry in place and is recorded in the reconcile activity log;
  a single card whose env cannot be resolved is skipped (counted), not fatal
  for the fleet.
- Because the exporter owns the file, hand-narrowed per-bot entries are
  rewritten back to the default allowlist on the next pass. Per-bot tool
  narrowing needs a card knob of its own (out of this part's scope).
- The media MCP facade hot-reloads the registry (`tools/media-mcp`): the
  authenticator now revalidates `bots.json` by an `(mtime_ns, size)` stamp
  before each authentication (stat at most once per `MEDIA_BOTS_RELOAD_INTERVAL_S`,
  default 1s) and re-reads it only when the stamp changed. A broken or vanished
  rewrite keeps the last valid registry and logs a warning — the facade stays
  up for the bots that already authenticate against it. Card changes reach the
  facade without a process restart.
- New settings: `MYRMIDON_MEDIA_BOTS_FILE` on the board server (where the
  exporter writes; default `/config/bots.json`, the facade's own
  `MEDIA_BOTS_FILE` default, so one shared bind of the same path needs no
  second setting) and `MEDIA_BOTS_RELOAD_INTERVAL_S` on the facade service.
  The exporter runs only while `MYRMIDON_BOT_CONTAINERS` is enabled.
- One-time rollout is NOT part of this change: regenerating the registry for
  the whole fleet and issuing tokens to the bots still without one stays an
  operator/release step after merge (it happens on the first enabled pass by
  itself — the exporter writes whatever the cards carry).

### Fragments with a settings-ru section fold into the RU settings document again

- `collect-fragments.mjs` resolves the `settings-section` heading inside
  SETTINGS.ru.md by a language-independent key (release version + the all-caps
  feature-id tokens of the heading) when the exact EN heading is absent, so a
  fragment that names the EN section — as every fragment does — folds its
  `settings-ru` rows into the Russian variant of that section instead of
  failing the release cut (the RU file never carried the EN headings, contrary
  to what the fragment README claimed; `bot-disk-quota.md` hit exactly this).
  An exact heading still wins; an ambiguous key match is not guessed and fails
  loudly as before.
- `change-fragments-gate-selftest.test.mjs` now also runs
  `collect-fragments --version 0.0.0 --dry-run` over the checked-out tree: a
  fragment the collector cannot fold turns the PR red before merge instead of
  breaking the next release cut. No workflow file was touched — the check
  rides the existing `node --test` step of the `checks` job.

### The shared git object store shows its facts, and one command accepts it on a live bot (1.6.5 BOT-DISK-G, part B)

- The start-time self-check records the store's state (`storeState` in
  `git-objects-check.json`: path, enabled, mirrorCount, totalBytes, bounded
  `repos[]`), the same facts ride the clone-hygiene report, and the board
  parses both; an older image reads as `null`, never as an error.
- `GET /api/myrmidon/agents/:id/bot-container/git-store` answers the facts to
  an agent key — the one bot-container route that is not board-only. It reads
  the report file only: no exec into the bot.
- Acceptance is one command on the board host:
  `scripts/myrmidon/deploy/git-objects-live-acceptance.sh --bot <container>` —
  it clones twice inside one live bot and checks that the store holds a mirror
  (≥100 MiB default) and the second clone borrows from it (alternates entry,
  ≤20 MiB `.git`); prints PASS/FAIL per criterion.

### GitHub wiki: installation is one command, requirements with real numbers

- `docs/wiki/Installation`, `docs/wiki/Quick-start` (EN+RU) — rewritten around
  the one-line installer: `curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash`.
  The page walks what the installer does step by step, what the user sees at
  the end, what to do when a step fails, and the options (`--version`,
  `--dir`, `--port`, `--interactive`, `--lang`, `--uninstall`).
- `docs/wiki/System-requirements` (EN+RU) — real numbers instead of "the docs
  do not name them": the installer's minimums (Ubuntu 24.04 / Debian 13,
  x86_64/aarch64, 2 CPU, 4 GB RAM, 10 GB disk, port 3100) and recommendations
  from the project's own production server (16 cores / 64 GB RAM for 74
  agents; 1–4 GB per agent, 8 GB for the board and database).
- `docs/wiki/Manual-deployment` (EN+RU, new) — the hands-on `deploy.sh`
  maintenance-window flow moved off the front pages, for experienced
  administrators.
- `docs/wiki/Upgrading-and-rollback` (EN+RU) — the installer re-run is now
  the primary update path (database dump and automatic rollback included);
  the `deploy.sh` flow remains as the operator reference.
- `docs/wiki/Home` (EN+RU) — the page list reflects the new structure.

### Run-ownership probe no longer reads the whole runs table (1.6.5 HEARTBEAT-POLL)

- The wake path's ownership question (`getConversationOwnershipBlocker`)
  filters one company, terminal legacy runs and the issue reference, plus
  correlated `exists` predicates — with no index carrying the issue
  reference, the planner read the whole runs table per call.
- Migration `0301_heartbeat_run_ownership_index.sql` adds one partial index
  on `(company_id, coalesce(native_issue_id::text,
  context_snapshot->>'issueId'), created_at DESC, id DESC)` where the run is
  legacy and terminal, making the equality selective and the `ORDER BY` free.
  No query, schema or behaviour change.

### Apply wipes the vendor's config backups out of hermes volumes (HERMES-CONFIG-BACKUP-SECRETS)

- The vendored Hermes CLI snapshots `config.yaml` into `hermes/backups/config/` on
  every successful config load and offers no switch to disable it, so those copies
  (which can carry the gateway credential once the CLI resolves it) reached host
  backups. The generated profile apply script now removes `data/hermes/backups` as
  a best-effort step after the staged files land and before the applied-state
  marker, so a leak is cleaned up on the next profile rebuild of every bot and an
  `rm` failure can never abort the apply.
- The dockergate gate's embedded apply-script template and contract fixtures carry
  the same step; tests pin the cleanup's presence and its order relative to the
  marker, and that the compiler never writes a secret value into `config.yaml`
  (only a `${VAR}` reference; the key lives in `hermes/.env`, mode 0600).

### Bot runtime builds hermes from the author's repository (HERMES-UPSTREAM)

- The bot image now clones hermes-agent from `NousResearch/hermes-agent` at the pinned tag and commit (`HERMES_GIT_REF`, `HERMES_GIT_SHA`) instead of a separate mirror fork. The fork was a byte-identical mirror; our hermes changes already live in `docker/bot-runtime/patches/`. The pinned commit keeps the build reproducible.

### A review that waits on a person is a lawful wait state (HUMAN-REVIEW-WAIT)

- An issue delivered to review (`in_review`) that stays assigned to its agent
  executor can now declare `reviewPolicy: "human_only"` as its review path.
  The board then treats the review as covered by a human reviewer: the executor
  is not woken, no "review path lost" recovery fires, no disposition is
  demanded, and automatic review routing never hands the verdict to an agent
  reviewer. A human comment or attachment still wakes the assignee as usual.
- Before the fix, a review the owner (a person) must approve looked stalled to
  the board's liveness mechanism: after every finished run the executor got an
  `issue_review_path_lost` wake every few minutes and each turn ended with
  another "waiting for the owner" comment. A deliberate `blocked` wait with an
  `unblockDescriptor` was also rolled back to `in_progress` minutes later by
  the stale-block watchdog when the reason was an event gate without a readable
  key, and the liveness sweep then demanded a disposition. Key-less event
  reasons are now unknown facts: the watchdog leaves the block alone.
- Agents moving an issue to `in_review` may set `reviewPolicy: "human_only"`
  in the same update as the review path; the invalid-disposition guard accepts
  it next to an interaction, approval, human assignee, review participant or
  monitor.
- The decisions feed shows only reviews that genuinely lack a maintained path
  (PAP-16080): a covered human wait is by definition not a stalled-review
  card, so no "choose review path" demand appears while the person reads.

### The model input limit is checked before a run is sent (1.6.5-INPUT-LIMIT, OPE-6168)

- The board resolves the agent model's input limit from the model catalog (`litellm_models.maxInputTokens`; override with adapter config `inputLimitTokens` / `inputLimitChars`) and passes it to the adapter.
- When the task's session already holds so many prompts that the next one would not fit, the run starts a fresh session (new `hermes_gateway` session-key generation) and records a `fresh_session` lifecycle event instead of sending into the full session.
- The `hermes_gateway` adapter trims a request that alone exceeds the budget (head and tail of the input kept, the cut named in the middle) instead of sending it to a provider that rejects it.
- Tunables: `MYRMIDON_INPUT_LIMIT_PRECHECK=0` (off), `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` (3), `MYRMIDON_INPUT_LIMIT_SAFETY` (0.9). See `docs/myrmidon/input-limit-precheck.md`.

### Input-overflow guard and fresh session on automatic retries (1.6.5-INPUT-OVERFLOW, OPE-6168)

- Automatic `transient_failure_retry` runs start a fresh task session instead of resuming the failed attempt's session (upstream #15487); the codex same-session first step is kept.
- New error family `input_overflow` for provider input-length rejections (DashScope, OpenAI, Anthropic, Gemini, generic wording table); `hermes_gateway` sets it and the server also detects it by text.
- After an overflow failure the next attempt uses a fresh session (task session dropped, `hermes_gateway` session key gets a generation suffix); after N consecutive identical failures on one issue (`MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES`, default 3) automatic retries stop and the issue is escalated with the facts. See `docs/myrmidon/input-overflow-guard.md`.

### Task list orders by a stored last-activity column (DB-PERF-P7)

- `GET /issues` and the blocked-inbox list no longer recompute the "last activity" of every
  candidate task with two correlated `MAX` subqueries (`issue_comments`, `activity_log`) before
  the `LIMIT` — that per-row aggregate was the endpoint's dominant cost. The value is now
  stored in `issues.last_activity_at` and indexed by `(company_id, last_activity_at)`.
- The stored value is `greatest(updated_at, newest comment, newest activity row)` per company,
  exactly as before; local inbox bookkeeping (`issue.read_marked`, `issue.read_unmarked`,
  `issue.inbox_archived`, `issue.inbox_unarchived`) still does not count as activity.
- The column is maintained by triggers, not by call sites: a new comment or activity row raises
  it, an issue update that moves `updated_at` raises it, and it never moves backwards.
- Migration `0355_issues_last_activity_at` is additive (new column with a default, new index,
  triggers); the previous image keeps working on the new schema. Existing rows are backfilled
  with the expression the endpoint used before.

### Bots' Hermes local memory behind an instance switch (MEMORY-CENTRAL-A)

- `MYRMIDON_BOT_LOCAL_MEMORY_OFF` (off by default): when set truthy (`1`/`true`/`yes`/`on`), every bot container's compiled `hermes/config.yaml` gets `memory.memory_enabled: false` and `memory.user_profile_enabled: false` — the vendor flags behind the built-in MEMORY.md/USER.md file stores — so a bot's durable memory lives only in the shared hindsight service. `memory.provider: "hindsight"` and the hindsight rule (mode `local_external`, never cloud) are unchanged either way.
- Off (or an unrecognized value — a typo must not silently disable a bot's memory) the memory block compiles byte-for-byte as before, so turning the switch off restores the previous restartHash and needs no bot restart beyond the normal config change.
- Carrying over the existing bots' local memory files into hindsight is a separate operator step and not part of this change.

### Learning switch and spend limits (FORAGING-LIMITS-UI)

- The learning switch, the pass interval, the same-host read pause, the
  per-pass budget, the **daily** and **monthly** company ceilings, the per-agent
  and per-role limits, the hard/soft (ask the owner) enforcement mode and the
  cost-per-task auto-off threshold are instance settings now: the "Learning
  (foraging)" section of Instance → General
  (`GET`/`PATCH /api/myrmidon/foraging-settings`), key `general.foraging`.
- No restart: the sweep re-resolves the settings row before every pass, a
  changed value applies with the next pass. The 1.6 env variables
  (`MYRMIDON_FORAGING_*`) stay forced per-key overrides of the matching field,
  the built-in default is the floor; the panel shows the origin of each value.
  `MYRMIDON_FORAGING_KEY_SECRET` stays env-only: it names a company secret, not
  a limit.
- When a limit stops a pass (sources after the stop stay untouched), a
  `foraging_limit` card lands in the attention feed (it clears when a pass
  runs without a stop; the auto-off card stays until learning is re-enabled).
  Soft mode marks the signal as a question to the owner: raise the limit or
  switch learning off.
- The learning spend is tracked on its own: a `foraging_spend_events` table
  (cents, role, agent, source URL) and one `training_charge` finance event per
  pass — Costs shows learning as its own "Training" line, by agent and source
  (`GET /api/myrmidon/companies/:companyId/foraging/spend`).
- Cost auto-off: when the mean cost per task (BASELINE) rises above the
  threshold from the settings, learning switches itself off and signals the
  attention feed.

### Telegram notify: one rarelyMaxPerDay range (TG-NOTIFY)

- The `rarelyMaxPerDay` range is now single: 1-50, the merged proactivity contract. The
  settings schema, the stored-document parser and the panel input all enforce it; an
  out-of-range stored value falls back to the default of 3.

### Baseline snapshots API: freeze a window, label it, pin it (1.6.2 BASELINE-SNAPSHOTS)

- Three endpoints join the BASELINE metrics route: `POST
  /api/myrmidon/companies/:companyId/baseline/snapshots` computes the metrics
  for the window in the body, stores the whole answer in
  `baseline_metric_snapshots.payload` and returns the stored row;
  `GET .../baseline/snapshots` lists the company snapshots and
  `GET .../baseline/snapshots/:snapshotId` returns one row (404 when the
  company has none).
- `from` and `to` are required; `label` and `pinned` are optional. Pinning a
  snapshot clears `pinned` on the company's previously pinned snapshot, so a
  company keeps a single reference point.
- Creating a snapshot is board-only (`assertBoard` plus the company access
  check); reading is the usual company access check.
- Two additive columns (`label`, `pinned`) with a partial index on the pinned
  snapshots of a company. The vendor tables are only read.
- Guide: `docs/myrmidon/guides/baseline-snapshots-api.md`.

### Authorize GitHub once for the whole server with our own GitHub Apps (GITHUB-SHARED-IDENTITY)

- Development agents could push only with an OAuth GitHub identity connected
  per person or per agent through the vendor's cloud connector and the
  vendor's GitHub App (a third party with write access to the code); bot
  containers strip raw tokens from the terminal, so agents without such an
  authorization could not push at all.
- Company settings → "Shared GitHub authorization"
  (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`)
  lists **our own GitHub Apps**: App id, private key (a company secret),
  installation, the agents (roles and/or agents) and the allowed
  repositories (`owner/repo` patterns). Applied without a restart.
- The board mints the installation tokens itself — no external broker — for
  the one target repository with contents/pull requests read-write and
  metadata read only. The App is picked by the target repository of each
  operation: products under different accounts never mix; a repository
  matched by no App stays absent, by two is an error. A dedicated per-agent
  grant (and the run's personal grant) still wins.
- The commit author and committer stay the agent; each issuance is audited
  (`myrmidon.github_app.issued`); the key and the token are never logged.
- The vendor cloud GitHub connector is **off by default**
  (`MYRMIDON_GITHUB_VENDOR_CONNECTOR=1` turns it on).
- Bot image: patch 09 keeps stripping raw tokens; `git-credential-paperclip`
  (`useHttpPath = true`) and the `gh` wrapper send the target repository to
  the broker. [guides/github-shared-identity.md](guides/github-shared-identity.md).

### Review-return loop: a RETURN verdict opens the rework task itself (REVIEW-REWORK)

- A review verdict that returned a pull request used to hang: no rework task, the
  review stayed in `todo`, and the reviewer was woken every 10-30 minutes on an
  unchanged lane (OPE-4417 waited 7 hours on PR #484; OPE-4360 kept a todo card
  on an already-merged PR). A sweeper (every 60 s, per company) now reads the
  verdict (a `VERDICT ...#<N>: RETURN` marker on the review task, or the PR's
  GitHub `CHANGES_REQUESTED` decision; the newest word wins) and:
  1. opens a rework task (child of the review, linked to the verdict comment and
     head sha) for the executor chosen down the ladder: the review's return
     assignee (PR author) -> assignee of the task the PR delivers -> instance
     fallback setting -> nobody (role queue for SWARM-CLAIM); the executor is
     woken;
  2. moves the review to `blocked` pointing at the rework, so the reviewer stops
     being woken;
  3. when the PR head moves past the baseline, lifts the block to `todo`, records
     a `HEAD-ACK <pr>: <sha>` line (retiring the verdict signal) and wakes the
     reviewer with the new head;
  4. closes the review (`done`) when every linked PR is merged or closed, and
     reopens the same rework task (never a duplicate) when a newer RETURN lands.
- Instance -> General gains "Review-return loop (REVIEW-REWORK)": master switch
  and fallback executor, `GET`/`PATCH /api/myrmidon/review-rework`, stored in
  `instance_settings.general.reviewRework` with a change journal; applied without
  a restart. Off restores the old behaviour exactly.
- An unresolvable PR (no token, GitHub outage) moves nothing: the loop never
  invents a merge, head move or verdict.

### Quality screen: comparison with the pinned baseline snapshot (1.6.5-BASELINE-COMPARE-UI)

The Quality screen (`/quality`) gains a "Comparison with the pinned snapshot" block below the two metrics tables. For the same window the page shows, it reads the compare endpoint (merged in 1.6.2, PR #484) and lists, per project and per role: the current window value, the pinned snapshot value and the delta (absolute + percent; the return rate delta in percentage points; green = better, red = worse). A row without a counterpart on either side shows "—" instead of a delta.

- No pinned snapshot is a normal "no baseline yet" state, not an error, and the metrics tables stay intact.
- A failed comparison request is shown as its own error state and does not break the tables above.
- The block follows the page's range preset / custom dates; a guide describes the flow (docs/myrmidon/guides/baseline-comparison.md).

### The bot's volume layout follows its image's runtime contract (BOT-LAYOUT-V)

- A bot container is now created and recreated with the volume layout its IMAGE
  declares: contract "1" (the 1.6.4 and older images) keeps the three separate
  binds the image boots from; contract "2" gets the single /bot mount; the
  transition images (contract "1" plus the scope label) also get /bot. Template
  drift is compared against a create body built for the image's own contract,
  so a card on an old image neither reports a phantom Binds drift nor gets
  recreated under a layout its image cannot start with.
- The board reads the applied marker and the clone-hygiene report of a
  legacy-layout container through /data/hermes; dockergate allows exactly that
  path and nothing else under it.
- An image without a recognized contract is still refused before anything is
  created. Old 1.6.4 images stay supported under the new board for a smooth
  rollout; the bot-runtime Dockerfile is unchanged in this PR (the transition
  rule classifies it) — the image itself moves to contract "2" together with
  the myrmidon-bot-image.yml check in a release-engineering step.

### GitHub App permissions are set per App entry, Workflows can be allowed (GITHUB-APP-SCOPES)

- Every App entry in Company settings → Shared GitHub authorization now
  carries a permission list — `actions`, `checks`, `contents`, `deployments`,
  `environments`, `issues`, `pull_requests`, `workflows` — each `none` /
  `read` / `write`. The broker requests exactly that list on every
  installation token (`metadata: read` is always added, which GitHub grants
  to every token anyway); secrets, administration and organization keys are
  not on the allow-list and are rejected on save, so a stored document can
  never widen the broker beyond it. `workflows` is write-only — GitHub's
  token API has no `workflows: read`.
- The default is the historical fixed set (Contents + Pull requests write,
  everything else none), so an upgraded installation keeps minting exactly
  the tokens it minted before until the operator widens an entry.
- The permission list is part of the token cache key: widening an entry
  re-mints instead of reusing the narrower token. The issuance audit
  (`myrmidon.github_app.issued`) now records the permission list.
- To let agents edit `.github/workflows/*`: first enable **Workflows: Read
  and write** on the GitHub App registration and accept the updated
  permissions on the installation, then set **Workflows** to `write` on the
  App entry and save — no restart. The guide has the steps
  ([guides/github-shared-identity.md](guides/github-shared-identity.md)).

### The GitHub App of the board serves non-container runs too (GITHUB-SHARED-IDENTITY)

- A run whose execution target is local or SSH (the development agents on the
  build machine, and bots whose container `fleetd` starts on a second machine)
  had no GitHub credential path: the launcher staged for it asked the broker
  without naming a repository, so a run whose only identity is a self-hosted
  GitHub App never got a token and the agents kept pushing with a static token.
- The launcher now stages `git-credential-paperclip` next to its `git` and `gh`
  and gives Git the configuration the bot image installs in `/etc/gitconfig`: the
  leading empty `credential.helper`, ours scoped to github.com over https, and
  `useHttpPath = true`. git hands the helper the repository path and the helper
  asks the broker for exactly that `owner/repo`; the `gh` wrapper names the
  repository from `-R`/`--repo`, `GH_REPO` or the `origin` remote, and a `git`
  command from the remote in its arguments or the `origin` of its directory.
- An operation that names no usable repository, or one no App serves, stays
  without managed credentials and works as before. Only the token, the
  terminal-prompt switch and the commit identity are taken from the broker's
  answer, so a broker-supplied helper never replaces the staged one. No token is
  written to a file.
- Once the second list's agents are moved over, their static GitHub tokens
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) are removed.

### 403 "key not allowed" is a permanent configuration error, not a retry (PERF-DIET-I)

A run whose Hermes gateway turn ended with the LiteLLM 403 message "key not
allowed to access model <model>" used to fall into the generic retry path:
every retry re-issued the same 403 (257 empty retries a day, perf-plan-v2
§1.4).

- The `hermes_gateway` adapter now tags such a failed run with the new
  `permanent_config_error` error family (case-insensitive signature match;
  the "Connection error." transient marking is unchanged).
- The recovery classifier routes both the new family and the raw 403 text
  (historical runs, other adapters) to the existing `configuration_incomplete`
  escalation: the issue goes to `blocked` with the cause recorded in the
  comment, no retry is scheduled, and the operator gets the deduplicated
  recovery-action attention card.

### Review-return loop: a work product without a repo no longer fails the pass (REVIEW-REWORK)

- A `pull_request` work product whose metadata has no `repo` (an older record
  that carries only a number or a URL) used to crash the sweep with
  `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  while the PR coordinates were being collected, so the whole task failed
  every pass. Now the loop reads the repo from the work product's
  pull-request URL when the metadata has none, and silently skips the entry
  when neither the metadata nor the URL yields coordinates — one bad record
  never fails the task's pass again.

### Review-return loop finds the delivering task by PR url again (REVIEW-REWORK F-02)

- The url branch of the delivering-task lookup built `like $n%` — the wildcard
  sat outside the bound parameter, so Postgres answered every call with a
  syntax error and the review-return loop was dead for tasks whose PR is
  reachable only through a pull_request work-product url. The branch now
  matches the PR exactly: query/fragment parts are stripped and the url is
  anchored on `/github.com/<repo>/pull/<number>(/|$)`, so `/pull/12` and
  `/pull/12/files` match PR 12 while `/pull/123` no longer matches a search
  for 12. The metadata repo/number branch is unchanged.
- New guard: `scripts/myrmidon/ci/sql-template-lint.mjs` (CI step in the
  `checks` job) flags a `%` wildcard glued to a `sql` template interpolation
  edge — the exact bug class — across `server/src`; its node:test suite runs
  with the other script tests. Embedded-Postgres regression test:
  `server/src/myrmidon/review-rework/store.db.myrmidon.test.ts`.

### Channel settings: the Telegram bridge and the chat limits without a restart (SETTINGS-TO-UI)

- `GET /api/myrmidon/channel-settings` reports the effective value of every
  channel setting — the Telegram DM bridge list and status, the split and
  attachment limits, the cross-channel numbers and the chat reconcile interval —
  together with where each value came from (`ui` for the stored document, `env`
  for the deployment environment, `default` for the built-in fallback) and
  whether the environment pins it.
- `PATCH /api/myrmidon/channel-settings` (instance admin only) writes
  `instance_settings.general.channelSettings`, records the change in the activity
  log for every company and answers with the settings now in force. The
  deployment environment keeps winning over a stored value: a set `MYRMIDON_*`
  variable stays the forced override and the answer marks the key `overridden`.
- The document is registered in the instance settings contract
  (`instance_settings.general.channelSettings`), so the stored value survives a
  read-write of the general block instead of being dropped as an unknown key.

### REBRAND-C env alias: codemod repair after main merge (OPE-4561)

- The REBRAND-C codemod had rewritten `delete process.env.X` into
  `delete readProductEnv(From)(...)` in the hermes adapter, the CLI onboard
  command and the native-session executor — a no-op at runtime that left the
  variable in the child environment and stopped type-checking after the main
  merge. Removal now goes through `deleteProductEnv`, dropping both the
  `MYRMIDON_*` and the legacy `PAPERCLIP_*` spelling.
- Call sites that used the `readProductEnv(From)` result as a guaranteed
  string (opencode-local / pi-local command override, server config path,
  agent-assigned-tools API base URL, startup-banner JWT file check) now bind
  the value once and narrow `undefined` explicitly.
- A stray commit `7b22807f` (Telegram `/accept` `/reject` commands, not part
  of this PR) and the OPE-4131 heartbeat list-perf edits it had pasted into
  `server/src/services/heartbeat.ts` were removed by a revert commit.

### Metrics self-check probe (1.6.6 METRICS annex)

- `GET /api/myrmidon/monitoring/selfcheck` — the link self-check of the
  metrics module: one scrape of every family, answered as the aggregate
  `{ok, families_ok, families_failed, scrape_ms, checked_at}` with no
  secret and no metric value. The probe rides the same origin-root router
  and the same single scraper bearer token as `GET /metrics` — no board
  rights, no second credential. 200 on a green scrape, 503 when a family
  read failed (the names it lists are exactly what `myrmidon_scrape_errors`
  exposes for the alerting half to open a task for the owning role), 500
  with the shape when the probe itself crashes.
- A failing family now reports by name: the collector returns the failed
  family list alongside the snapshot; `myrmidon_scrape_errors` keeps the
  counter role.

### Prompt-budget advice and deep analysis (PROMPT-BUDGET C)

- The agent card (Overview) shows what the last run's prompt was made of —
  which part dominates it and what to do about it. The advice is computed on
  request from the recorded breakdown; a "Deep analysis" button files a task
  for a cheap-model optimizer agent, which drafts instruction edits as a
  comment on that task. Nothing is scheduled and nothing is changed
  automatically.
- The static thresholds are code constants, not settings: a part is worth a
  recommendation from 30% of the prompt, is critical from 50%, and no advice
  is produced below 2000 prompt tokens.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member) returns the breakdown and the recommendations;
  `POST .../advice/deep` (board) answers 201 with the filed task, or 422 with
  a clear message when no optimizer agent is configured
  (`promptBudget.optimizerAgentId` in the instance general settings). See
  [SETTINGS.md](../SETTINGS.md).

### Bot replies are no longer cut at 2000 characters (TG-REPLY-FULL)

- The Hermes adapters (local and gateway) used to copy only the first 2,000
  characters of the answer into the run summary, which the chat bridge delivers to
  the owner when the run has no separate final message. Long answers therefore
  arrived in Telegram cut off. The summary now carries the whole answer; the
  existing Telegram publication path then splits anything above the 4,096 limit into
  ordered messages at paragraph, line, then word boundaries (and sends long
  structured Markdown as one attached document). Nothing is silently dropped.

### ONE-COMMAND-INSTALL: one command brings a fresh server to a working board

- `scripts/myrmidon/install/install.sh` (new) installs a fresh server. It checks
  the machine and names what is missing (root, Ubuntu 24.04 / Debian 13, arch, 2
  CPU, 4 GB memory, 10 GB free disk, a free port), installs Docker and the
  compose plugin if absent, resolves the latest release (`releases/latest` or
  `--version myr-vX.Y.Z`) and its manifest `release-components.json`, and pins
  the board, dockergate and bot images BY DIGEST (no flag skips it). It
  generates every secret, writes `deploy.env` (0600), `compose.yml` and the
  dockergate configuration, starts the database, board and dockergate, waits for
  `/api/health` `status: ok` and prints the address, the first-administrator
  link and the written paths.
- Re-running it is the update path: dump the database before the image line
  changes, switch digests, check health, roll back to the previous digests if the
  new board is not healthy. `--uninstall` removes the stack (data kept);
  `--uninstall --purge` also deletes the database volume and install directory.
  It asks nothing by default (`--interactive` enables three questions) and
  speaks Russian or English by locale (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` attaches the installer to
  every release as `install.sh`, so
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  serves the latest one; the committed file is the single source.
- Tests: `scripts/myrmidon/install/install.test.mjs` runs the real script against
  fake `docker`, `curl`, `ss`, `systemctl`, `apt-get`: digest pinning and secrets,
  update with a dump, rollback on an unhealthy release, no-op on the same
  release, foreign directory refused, uninstall/purge, Russian locale, malformed
  `--version` refused.

### Dockergate poll storm removed (OPE-4789, second half of OPE-4752)

The board talked to dockergate far more than the planned once-a-minute sweep:
~30 requests/s on a 74-bot fleet, hour-and-a-half rollouts, 28 refusals.

- The clone-report collector runs at most once a minute and asks only about
  running bots.
- One reconcile pass costs one inspect and one marker read; the create-body
  template context is cached 60 s per bot instead of re-read three times.
- The health wait after a start polls every 3 s, matching the image's 30 s
  HEALTHCHECK cadence.
- A duplicated apply within 30 s answers from freshness; real changes (Apply
  now, secret rotation, canary wave) pass `force: true` and always run.
- A 429 is retried by the call that got it — after `Retry-After` or a capped
  backoff (1/2/4/8 s, max 4 attempts) — not by every caller at once.

Measured on the fake daemon: a plain sweep costs 2 gate requests (was 3+), a
canary-overlapped pass 2 (was 6).

### Predeploy database check restores the dump with --no-owner --no-acl by default (1.6.5 PREDEPLOY-NO-ACL)

- The default restore command of the predeploy database check
  (`predeploy-board-check.sh`, `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`) now
  carries `--no-acl` next to the existing `--no-owner`. The production dump
  contains GRANTs to roles that exist only on the production server (e.g.
  `backup_ro`); the throwaway Postgres of the check does not have them and
  `pg_restore` aborted with `role "backup_ro" does not exist`, so the check
  died on the restore step of every such dump before the board was ever
  started (OPE-4875, 06.10).
- The check proves the board reads the production DATA on the copy, not the
  production grants model, so skipping ownership and ACL statements is the
  correct default. An operator who wants the grants modelled on the copy
  pre-creates the roles and overrides `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`;
  the override is still used exactly as given.
- `scripts/myrmidon/deploy/deploy.env.example` documents the new default and
  the reason; the script test suite now models a dump with a GRANT to a
  missing role and proves the old command aborts on it while the new default
  restores.

### Company base skills reach every agent automatically (1.6.5 BASE-SKILLS)

- The company now keeps a **base skills** list on the Skills screen: the skills
  every agent of the company is supposed to have. A base skill is given to an
  agent automatically — a new one at creation, an existing one the moment the
  skill joins the list, and again whenever the board presses "Apply to all
  agents". The fact of 06.10: `parallel-helpers` was attached to 52 of 82
  agents by hand, the other 30 silently missed it, and the SMM bot could not
  start the viewer flow it needed.
- The panel lists each base skill with the count of agents that carry it and
  names the agents that do not, so a gap is visible instead of silent. An agent
  whose adapter cannot receive skills at all is reported as such, and a base
  key that no longer exists in the skill library is flagged as "not in the
  library" — it can reach nobody.
- A base skill cannot be taken away from a single agent: the agent's own skill
  screen keeps it in the selection (it is the company list that decides).
  Removing a skill from the base list stops the automatic assignment; the
  agents that already carry it keep it.
- The registry is additive: a new `company_base_skills` table, board-only
  mutations (`GET/POST/DELETE /api/companies/{companyId}/base-skills`, plus
  `POST …/base-skills/apply`), and one activity-log entry per change
  (`company.base_skills_added` / `_removed` / `_applied`). A company without
  base skills behaves exactly as before.

### Text search: trigram indexes now cover the coalesce-wrapped predicates too (1.6.5 PERF-DIET-P)

- Both search paths match task text with `ILIKE '%…%'`, and both already ran on
  pg_trgm GIN indexes: the plain-column ones shipped by the vendor in migrations
  `0051`/`0079` — `issues(title)`, `issues(description)`, `issues(identifier)`,
  `issue_comments(body)`, `documents(title)`, `documents(latest_body)` — and the
  task-search statement matches those columns bare, so it uses them.
- Company search has a second family of predicates that wraps the column in
  `coalesce`: `coalesce(title, '') ILIKE '%…%'` over `documents` and
  `coalesce(identifier, '') ILIKE '%…%'` over `issues`
  (`server/src/services/company-search.ts`, `company-artifacts.ts`). A wrapped
  expression cannot use the plain-column index, so the planner sequentially
  scanned `documents` — the table whose `latest_body` column is the heavy one —
  and `issues`.
- Migration `packages/db/src/migrations/0314_search_coalesce_trgm_indexes.sql`
  adds one expression index per emitted shape,
  `gin ((coalesce(col, '')) gin_trgm_ops)`. It also repeats
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` (idempotent; vendor migration
  `0051` already creates it) so the file is self-contained. It is an additive
  index-only migration: no query text, no schema and no behaviour change, and the search
  semantics stay identical (a NULL column and the empty string are both
  non-matching, and the predicates sit in positive OR/AND chains).
- Measured on embedded PostgreSQL, selective term, 20 000 documents / 50 000
  issues: `coalesce(documents.title, '')` sequential scan 13.3 ms → bitmap index
  scan 0.6 ms; `coalesce(issues.identifier, '')` 37.3 ms → 2.6 ms.
- Guard: `server/src/__tests__/task-search-trgm-index.myrmidon.test.ts` asserts
  every search index exists as a GIN index, that each emitted predicate is served
  by its index instead of a sequential scan, that dropping the expression index
  puts the statement back on a sequential scan (the assertions have teeth), and
  that company search returns the same hits with and without the expression
  indexes.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — the migration runner wraps
  every file in a transaction) on the medium-bucket tables `documents` and
  `issues`; an operator who wants to build it on a live board without the
  migration's brief lock uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the
  same definition, and the idempotent statements then skip the finished work.

### Deploy hygiene: the deploy no longer fills the disk it deploys from (OPE-5107)

On 06.10 the deploy host's root filesystem went from 86 % to 92 % in the hour of
one rc.3 deploy: the predeploy database copy kept its Postgres data in an
anonymous volume `docker rm -f` never removes (3.4 GB + 3.6 GB orphaned), images
of past releases were never deleted (~33 GB), and the deploy pulled new images
without checking the free space.

- PREDEPLOY-DB-CHECK: the copy's data lives in a named volume
  (`myr-predeploy-dbvol-<digest8>-<pid>`) removed by the run's EXIT trap on
  success, failure and interrupt. `MYRMIDON_PREDEPLOY_KEEP=1` keeps it and
  prints its name.
- Disk precheck before the first pull and the dump (deploy.sh, standalone
  bot-image-rollout.sh / rollout-component.sh): free space of the filesystem
  holding /var/lib/docker must reach `MYRMIDON_DEPLOY_MIN_FREE_GB` (default 15
  GiB, 0 = off), otherwise the deploy stops before anything changed and names
  the cleanup candidates (`docker system df`). A dry run prints the check.
- Image retention after a successful deploy: local images of
  `MYRMIDON_DEPLOY_IMAGE_REPOS` (board, dockergate, fleetd, three bot images)
  older than `MYRMIDON_DEPLOY_IMAGE_KEEP` previous releases (default 1; 0 = off)
  are removed. An image used by any container is never removed; a cleanup
  failure is a warning, not a failed deploy.

### Active issue claims are unique at the database (1.6.5 SWARM-CLAIM-UNIQUE-INDEX)

- The swarm-claim capture path checked the live lease with a SELECT and then
  INSERTed, so two board processes racing for the same issue could both pass
  the check and both take the task — the same issue ran twice at once, and the
  lost racer on the older single-writer path surfaced a raw unique-violation
  error instead of a busy answer.
- Migration `packages/db/src/migrations/0360_issue_claims_active_unique.sql`
  first folds the historical duplicates: for every issue with more than one
  live claim (`released_at IS NULL`) the earliest row by `claimed_at` (ties
  broken by `id`) stays live and the rest get `released_at` with
  `release_reason = 'migration_dedup_0360'`. Then it builds the partial unique
  index `issue_claims_issue_active_uq` on `(issue_id) WHERE released_at IS
  NULL` — one live claim per issue, enforced by PostgreSQL, not by application
  order. `IF NOT EXISTS` and the dedup predicate exclude already-released
  rows, so re-applying the migration on a database that already moved is a
  no-op.
- The capture store (`server/src/myrmidon/swarm-claim/store.ts`) now maps a
  23505 from the claim INSERT to the same `null` the pre-check returns —
  «занято», not a 500. Non-uniqueness errors still propagate unchanged.
- Default behavior does not change: the claim API contract, the lease fields,
  the sweep and the supervisor rebalance are untouched; the index only closes
  the window where two winners were possible.
- Guards: `packages/db/src/issue-claims-active-unique-migration.myrmidon.test.ts`
  (static: migration file, journal entry, 0360 snapshot index; embedded
  Postgres: dedup keeps the earliest live claim and releases the rest, the
  index is partial and unique, a second live INSERT for the same issue raises
  23505, released rows do not collide, re-application is idempotent) and
  `server/src/myrmidon/swarm-claim/claim-race.myrmidon.test.ts` (two parallel
  claims of one issue on embedded Postgres — exactly one succeeds, the other
  gets the busy answer, never an exception; the mapped 23505 seam and its
  narrowness are pinned with fakes).

### Concurrent instance-settings PATCHes no longer lose edits (PROCS-Q5)

- `updateGeneral` and `updateExperimental` read, merge and rewrite the whole
  settings document of the singleton `instance_settings` row. Two PATCHes that
  overlap in time could both read the same state, and the later commit wrote a
  merge of that stale read — the earlier edit disappeared without any error.
  Both paths now run as one database transaction that first takes the row with
  `SELECT … FOR UPDATE`, so concurrent PATCHes serialize on the row: order of
  application = order of commits, and every edit survives.
- The general and the experimental documents share the same row, so both write
  paths take the same lock: a general PATCH and an experimental PATCH can no
  longer clobber each other either. The first-writer insert also happens under
  the lock, so two brand-new instances cannot deadlock on the singleton insert.
- API behavior is unchanged: same routes, same validation, same response
  bodies, same preserved keys (maintenance, deploy jobs, access hub and the
  rest of the `preserve*` keys keep working — they now re-read the locked row).
  A single-process deployment with no overlapping PATCHes sees identical
  results, one write at a time.

### Run queue wait reason and priority settings in the UI (RUN-PRIORITY B)

- `ui/src/components/myrmidon/runQueueApi.ts` — client for the server core:
  `GET/PATCH /api/myrmidon/run-priority` (switch, role weights, default role
  weight, current-release line and bonus, aging step/weight/cap, starvation
  limit) and the queued run's own waiting state — `waitReason` plus its
  `queuePosition` of `queueLength` — read from
  `GET /api/heartbeat-runs/:runId`. A 404/405 answers `null`: an older server
  shows no data instead of an invented number.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — the line under a queued
  run's chat card: "waiting: the host CPU ceiling is closed". The core publishes
  the run's rank in the waiting queue (`contextSnapshot.queuePosition` of
  `queueLength`, written by the priority sweep), so the line shows "queue
  position 3 of 12" beside the reason; a server that publishes no rank degrades
  to the reason alone instead of an invented number. Renders nothing for a run
  that has left the queue.
- `ui/src/components/IssueChatThread.tsx` — mounts the wait line under the
  queued run card (the same card that already shows the "Queued" badge).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` and
  `ui/src/pages/InstanceGeneralSettings.tsx` — the queue-priority section of
  Instance → General, on the runtime-limits pattern: five role weights
  (review, release, lead, engineer, docs; an empty one falls back to the
  default role weight; roles set through the API are kept on save), the
  priority switch, the current-release line and bonus, the aging step, step
  weight and cap, and the starvation limit. Values are checked against the
  server bounds before the save; the section says whether the stored row or
  the environment decides. Saving applies on the next admission pass without a
  restart.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `runQueue` catalog (en+ru,
  parity-checked).

### Drizzle snapshot chain repaired and checked (1.6.5 OPE-5575)

- `meta/0305_snapshot.json` carried the same `id` as 0304 and a `prevId` pointing at itself, so `drizzle-kit generate` stopped with a parent-snapshot collision. 0305 gets a new unique `id`; 0306 `prevId` follows it. Migrations and the journal are untouched, so the runner is not affected.
- `check:migrations` now also runs `src/check-migration-snapshots.ts`: unique ids, no self-reference, no cycles, and from 0296 on every snapshot names the preceding snapshot as its parent. Older snapshots with dangling parents (0027, 0039, 0077, 0091, 0292, 0295) are tolerated.

### Deploy scripts and the predeploy check no longer assume the built-in database container: shared PostgreSQL 18 (1.6.5 PREDEPLOY-PG-COMPAT)

- The board's database may live on a SHARED PostgreSQL 18 server (its own
  database and role; the same server hosts other products). The dump and
  restore commands were always pure configuration (`DUMP_COMMAND`,
  `RESTORE_COMMAND`), and `deploy.env.example` now carries both profiles: the
  built-in `db` container (unchanged default) and the shared server —
  `pg_dump "$DATABASE_URL"` / `pg_restore -d "$DATABASE_URL" --no-owner
  --no-acl`, run with a pg_dump 18 client from the deploy directory. On a
  shared server `--no-owner --no-acl` is required and the connection string
  must be only the board database and the board role. No container name is
  compiled into the scripts.
- The predeploy board check gained `PREDEPLOY-PG-COMPAT`: after the throwaway
  copy starts, the dump's own TOC (`pg_restore --list`) and the copy are
  compared — the server major the dump came from must equal the copy's major,
  and every extension the dump restores must be available in the copy image;
  after the restore, `SELECT extname FROM pg_extension` must show them
  installed. A mismatch (for example a copy image without `vector`, which the
  board has needed since migration 0051) stops the deploy before the
  maintenance window with a clear message. `MYRMIDON_PREDEPLOY_PG_COMPAT=off`
  skips the comparison; the ANALYZE step (PREDEPLOY-ANALYZE) is unchanged.
- `deploy.env.example` sets the copy image default to
  `pgvector/pgvector:pg18` for a new shared-server profile: PostgreSQL 18 with
  pgvector compiled in (the stock `postgres:18` image has no `vector`).

### Board database on a shared PostgreSQL 18 server

- Installation and Upgrading-and-rollback wiki pages document running the
  board's database on a shared PostgreSQL 18 server (pgvector, a dedicated
  database and role per program): connecting the installer to an external
  server through its database-address parameter, the `DATABASE_URL`-based
  `DUMP_COMMAND` /
  `RESTORE_COMMAND` shape for backups and rollback, the PostgreSQL 18 client
  requirement for `pg_dump`, and `MYRMIDON_PREDEPLOY_POSTGRES_IMAGE` for the
  predeploy check. Moving an existing production database to the shared
  server is the operator's one-time zero-downtime task (logical
  replication), outside the scripts.

### 1.6.5 F-07 /agents: grouped agent list with a role, a live status and default aliases (OPE-6323)

- `/agents` in a bridged Telegram DM prints one group per direction instead
  of a flat list: the title comes from the card itself
  (`agents.metadata.telegramGroup`) or, when it is absent, from the agent-name
  prefix (`adm-*` → Infrastructure / Myrmidon, `bbq-*` → bbq, `work-*` → work,
  the rest → Other). Group titles are catalogue strings (en + ru).
- Every line names the agent, its role (`agents.title`, one line), its live
  status (`agents.status`: idle / running / paused, localised) and its aliases;
  the current addressee is marked.
- Written-off cards no longer take a slot: terminated, pending-approval and
  retired-by-name (`-retired` suffix) agents, plus service cards without a live
  board presence, are hidden. Paused cards stay out of the default list and
  come back on request (`listCompanyAddressableAgents(..., { includePaused: true })`),
  and a group holding paused cards says how many wait. The fixed
  60-agent cut-off is gone — the Telegram transport splits a long reply itself.
- Default aliases: an agent without `telegramAliases` answers to the last
  dash-separated segment of its name, lower-cased (`adm-dev-eng-15` → `15`);
  collisions get `-2`, `-3` (`work-runner-2` → `2-2` when `2` is taken). It is
  computed on read only — nothing is written to the card — and `/to`,
  `/who` and `@mention` all resolve it through the same loader.

### Database backup and restore sessions ignore the database-level statement_timeout (1.6.5 BACKUP-STATEMENT-TIMEOUT)

- Automatic database backups failed on stand Postgres instances that set a
  database-wide `statement_timeout` (the live board ran 120 s): the long
  `COPY ... TO STDOUT` of a big table was cancelled mid-dump with
  PostgresError 57014 and the run lost its dump.
- Every connection the backup and the restore open now sets session
  `statement_timeout = 0` (postgres.js startup parameter, and
  `PGOPTIONS=-c statement_timeout=0` for the spawned pg_dump/psql children),
  so a dump or a restore can never be cut short by the database default. A
  startup-packet/session value overrides `ALTER DATABASE ... SET`, while all
  other board connections keep the database limit unchanged.
- The override is scoped to `packages/db/src/backup-lib.ts` only: backup and
  restore are the sole users of `backupClientOptions` / the PGOPTIONS env. No
  app or migration connection is affected.

### Database backups work against a shared PostgreSQL 18 server (1.6.5 SHARED-PG-BACKUP)

- The board's dump path never shells into a container: `runDatabaseBackup`
  dumps exactly the database and role of the configured connection string
  (`DATABASE_URL` / `config.database.connectionString`), with the host's
  `pg_dump` as a plain client binary. No code or packaging reference to
  `paperclip-db-1` / the compose database service remains in `packages/db` or
  `cli`.
- Before the first dump row is read, the pg_dump engine now compares the
  client major (`pg_dump --version`) with the server major (`SELECT
  version()`). A client older than the server — the pg_dump 17 vs PostgreSQL
  18 case, where libpq refuses with a raw "server version X is newer than
  client version Y" mid-spawn — is diagnosed up front: `backupEngine:
  "pg_dump"` fails immediately with `BackupClientVersionError` naming the
  fix, and `backupEngine: "auto"` (the scheduled default) warns and falls
  back to the JavaScript dump, which streams the same tables over the already
  compatible wire protocol and always produces a backup.
- The warning travels to operators: `RunDatabaseBackupResult.warnings`, the
  one-line `formatDatabaseBackupResult` summary, the CLI `db:backup` output
  and its `--json` payload, and the scheduled-backup logger.
- The dump client is configured, not assumed: `PAPERCLIP_PG_DUMP_PATH` points
  the engine at a client of the server's major or newer (e.g. the PGDG 18
  `pg_dump` on a board host whose distro still ships client 17); the same
  idea for the restore path via `PAPERCLIP_PSQL_PATH`. Both were already read
  by the engine; the compatibility check is what makes setting them
  observable instead of trial-and-error.

### Owner-DM delivery filter, part B: the mode switch (OWNER-DM-FILTER)
- Company Settings has a new **Owner Telegram delivery** section. It picks which cards an agent raises are sent to the task owner's Telegram DM: **Owner decisions only** (the default — only the cards that wait for the owner) or **All cards** (everything, the behaviour before this change).
- The current mode is read with `GET /api/myrmidon/owner-delivery` and saved with `PATCH /api/myrmidon/owner-delivery` (`{ mode }`, instance administrator). A missing or unreadable setting shows `owner_decisions_only`.

### Owner-DM delivery filter: only cards addressed to a human reach the task owner's Telegram (1.6.5-OWNER-DM-FILTER)

- Owner-DM delivery filter (U2): in the default mode `owner_decisions_only` the task owner's Telegram DM receives only cards addressed to a human — interactions whose effective resolver policy is `human_only`, or whose `addresseeUserId` is the task owner.
- Agent-addressed and purely operational confirmations (resolverPolicy `anyone`/`not_creator` without a human addressee) stay board-only instead of flooding the owner's DM.
- The mode lives in `instance_settings.general[ownerDelivery]` and is read/written via `GET/PATCH /api/myrmidon/owner-delivery` (read: any board member, write: instance admin); `mode: "all"` restores the pre-filter behaviour.
- Cards delivered to the owner DM carry a human-readable header line ("Нужно ваше решение: <prompt>") built from the interaction's own fields — vendor bindings keep the vendor card text byte-for-byte.

### Owner decisions arrive as a message from the bot, not as a card (1.6.5-OWNER-VIA-BOT)

- New owner-delivery mode `via_bot`, now the default (`instance_settings.general[ownerDelivery]`, `GET/PATCH /api/myrmidon/owner-delivery`). In this mode the owner's Telegram DM receives NO card with buttons. `owner_decisions_only` and `all` keep their previous behaviour for instances that store them.
- When an agent creates a human-only question or confirmation for the task owner, the author is woken on that task with the open decision in its prompt and must explain it to the owner in one plain message: what to decide, why, each option with its consequence, a recommendation.
- New agent tool `myrmidonMessageOwner` (`POST /api/myrmidon/owner-message`) writes that message into the owner's standing Telegram DM conversation from a run on any task. Only the author of an open owner decision may use it; one message per question; several open questions must be covered by one summary message (`409 summary_required`).
- The owner's text answer reaches the agent as a normal DM turn marked as a reply to the open interaction. The new tool `myrmidonResolveInteractionByOwnerReply` (`POST /api/myrmidon/owner-message/resolve`) closes the interaction as the OWNER (the ordinary accept / reject / respond route runs with the owner as the acting user) and only when the owner's own comment in that chat, written after the bound message and received from Telegram, is named. Tool-action, secret and connection confirmations are not closable this way.
- The Paperclip skill documents both tools (`references/owner-dialogue.md`); the owner-delivery settings screen offers the new mode.

### The predeploy copy gets planner statistics before the board is checked (1.6.5 PREDEPLOY-ANALYZE)

- The predeploy board check now runs `ANALYZE` on the throwaway database right
  after the dump is restored, as a separate step logged as `analyze`. A restored
  dump carries rows but no planner statistics, so on the copy the issues list
  ran on default estimates and missed the 30 s route budget (the rc.8 rollout
  stopped there on 07.10 while the same route answered on production).
- The step runs after any restore command, including an overridden
  `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`. Its command can be overridden with
  `MYRMIDON_PREDEPLOY_ANALYZE_COMMAND`. A failed ANALYZE is a warning, not a stop.

### Release candidates publish with notes from change fragments (RC-NOTES)

- A release candidate is cut before the changelog is folded, so `release-body.mjs` now builds its notes from the pending change fragments (`docs/myrmidon/changes/*`, "changelog-en" blocks) when CHANGELOG has no section for the version. Final releases still require their CHANGELOG section. 1.6.5-rc.1 and rc.2 failed to publish for this reason.

### Release candidates and the `latest` marker only after the production proof (RC-VERSIONS)

- Releases now go through a trial run: the tag `myr-vX.Y.Z-rc.N` builds every
  component image as `X.Y.Z-rc.N` (the version `/api/health` reports), and the
  release publish goes out as a GitHub **pre-release** `Myrmidon X.Y.Z-rc.N
  (RC N)` with the base version's changelog notes and its own digest manifest.
  `deploy.sh --release myr-vX.Y.Z-rc.N` works like any release; the CI-image
  gate (deploy scripts and the board's deploy/canary checks) accepts the rc
  tag as release proof.
- A publish — rc or final — NEVER moves the GitHub `latest` marker:
  `publish-github-release.sh` no longer passes `--latest`. An rc supersedes
  nothing, and a final tag never supersedes its own release candidates.
- The marker moves only by the explicit step
  `scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z`: it refuses an
  rc tag, a pre-release, a release commit not on `main`, and — the point of
  the requirement — any case where our production board's `/api/health`
  reports a version other than `X.Y.Z`. The board address comes from
  `--health-url` / `MYRMIDON_PROD_HEALTH_URL` (fallback `HEALTH_URL`) and, in
  `authenticated` mode, `--health-token-file` / `MYRMIDON_PROD_HEALTH_TOKEN_FILE`
  (fallback `HEALTH_TOKEN_FILE`). The full flow: rc → deploy to our
  production → verify (health, attention list, fleet taking tasks, bot
  images) → final tag `myr-vX.Y.Z` on the SAME commit → promote to Latest.
  See [deploy.md](deploy.md), "Release candidates and the `latest` marker".

### One read per reconcile sweep, not one per bot (PERF-DIET-G)

The bot container reconciler compiles a profile for every bot on every sweep
(once a minute), and most of what it read is company- or instance-scoped: the
company's skill lifecycle delivery, the runtime skill catalogue and files, and
the instance settings (compression defaults, helper ceiling, language-server
policy, shared package cache, pnpm store, clone TTL). A fleet of N bots paid N
reads a minute.

- A sweep now shares one pass: the first bot of a tick reads those values, the
  others get the same. The pass is dropped at the end of the sweep, so a settings
  or skill change still reaches the bots within one reconcile interval and
  nothing is cached between ticks. A skill carried by several bots is read from
  disk once per pass.
- `pnpmSettings` was read twice per bot per compile; now once per pass.
- The agent card behind a profile is read as one row by id instead of `getById`,
  which also hydrates the company and the agent's month spend.
- "Apply now" and the canary wave reconcile one bot with no shared pass and
  behave as before. Reconciler log, interfaces and UI are unchanged.

Measured over a sweep of three bots with counting fakes: 21 instance-scoped port
calls before, 6 after; skill catalogue 3 -> 1, lifecycle company-wide reads
3 -> 1, a skill directory carried by two bots 2 -> 1, the card read 3 rows
instead of 3 x 3 queries.

### Release freeze: merges into main wait until the release tag's CI is green (RELEASE-FREEZE)

- A new PR check, `freeze` ("Release freeze gate"), fails while the newest
  release tag (`myr-vX.Y.Z` or `myr-vX.Y.Z-rc.N`) has no green Myrmidon CI.
  The tag workflow opens one issue `release-freeze: <tag>` at the cut and
  closes it when the tag CI succeeds. The gate fails closed on lookup errors.
- This prevents the 1.6.4 incident: merges right after the cut cancelled the
  tag's CI run and the publish gate refused the release.
- Operator step: add the `freeze` check to main's required status checks to
  make the freeze binding.

### SHARED-PG: a fresh install stands up one PostgreSQL 18 + pgvector shared database

- `scripts/myrmidon/install/install.sh` — the database layer of a clean
  install is now a PROFILE, not a hard-coded `postgres:17-alpine` container.
  The default (internal) profile runs ONE PostgreSQL 18 image with the
  pgvector extension (`docker.io/pgvector/pgvector:pg18`, overridable with
  `MYRMIDON_DB_IMAGE`, digest pinning included) and creates, on first start,
  a separate database and login role per service: the board (`paperclip`)
  plus the shared services `litellm`, `langfuse` and `hindsight`
  (`MYRMIDON_SHARED_SERVICES`); every service database gets the `vector`
  extension. The generator lives in `db-init/01-shared-roles.sh`, mounted
  into `/docker-entrypoint-initdb.d` — it is idempotent (a role/database that
  already exists is reused) and re-applies the memory parameters with
  `ALTER SYSTEM` so the sizing survives in the cluster.
- The server's memory parameters (`shared_buffers`,
  `effective_cache_size`, `maintenance_work_mem`, `work_mem`, `shm_size`)
  are sized for the SUM of all services sharing the cluster: by default from
  the host's `MemTotal` (capped at 16 GB) — shared_buffers = 1/4 RAM,
  effective_cache_size = 3/4 RAM, maintenance_work_mem = RAM/64 (>= 64 MB),
  work_mem = 16 MB, shm = RAM/8 clamped to 128 MB..1 GB. Every value is
  overridable in the install environment (`MYRMIDON_DB_TOTAL_MEMORY_MB`,
  `MYRMIDON_DB_SHARED_BUFFERS`, `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE`,
  `MYRMIDON_DB_MAINTENANCE_WORK_MEM`, `MYRMIDON_DB_WORK_MEM`,
  `MYRMIDON_DB_SHM_SIZE`) and is written into `deploy.env`, so the numbers a
  cluster actually runs with are visible in one place.
- External shared server: `--database-url postgres://...` (or
  `MYRMIDON_INSTALL_DATABASE_URL` / the `DATABASE_URL` the operator exports)
  switches the installer to the external profile — no db service is written
  into `compose.yml`, no pgdata volume, the board's container points straight
  at the operator's server through `MYRMIDON_DATABASE_URL` in `deploy.env`.
  A non-`postgres://` URL is refused. The databases and roles on the external
  server are provisioned by the operator; the installer only validates the
  connection string shape.
- Existing installs are never migrated implicitly: a stack whose compose file
  carries a literal `image: postgres:` line and whose `deploy.env` names no
  profile gets the `keep` profile — re-running the installer (including
  `--version`) leaves its database container and data volume untouched.
  Moving a PG 17 database onto the shared PG 18 server is an operator task
  with its own procedure, not a side effect of an update.
- `docker/docker-compose.yml` and `docker/quadlet/paperclip-db.container`
  (the manual-deployment variants) move to the same
  `pgvector/pgvector:pg18` image; the compose variant gains the `db-init`
  bind mount and the sizing command line, mirroring what the installer
  generates.
- Tests: `scripts/myrmidon/install/install.test.mjs` gains the profile
  cases — a fresh install renders compose with the PG 18 + pgvector image,
  the sizing command line and the `db-init/01-shared-roles.sh` generator
  that creates the four databases and roles; `--database-url` produces no db
  service and no init directory; a malformed external URL is refused; an
  existing pre-profile stack is marked `keep` and its compose file is not
  rewritten.

### Guide: address any agent from one Telegram chat (TG-MULTI-AGENT)

- New operator guide
  [telegram-multi-agent](guides/telegram-multi-agent.md):
  `@`-mention addressing and the `/agents`, `/to`, `/who` commands of the
  bridged Telegram DM — aliases (`telegramAliases` in the agent card), the
  sticky default addressee (`telegramStickyAgentId`), and the protection
  rules (own bridged conversation only, same-company agents only, polite
  list of valid aliases for an unknown alias). X9a/X9b are already in main;
  X9c ships with the code PR.

### Telegram notifications (TG-NOTIFY-SETTINGS, part A: the settings core)

- The company-level settings that say what the board sends to the owner in
  Telegram: the daily digest, error notifications, inbound rules, escalations
  and head-bot proactivity, as ONE runtime-changeable contract
  (`packages/shared/src/myrmidon-telegram-notify.ts` — types and zod
  validators shared by the server and the UI). Storage without migration:
  the `myrmidonTelegramNotifySettings` key of `instance_settings.general`,
  company-keyed. API: `GET /api/myrmidon/telegram-notify` answers the full
  document (every field of every section always present), `PATCH
  /api/myrmidon/telegram-notify` applies a partial update; each changed
  field is recorded in a bounded changelog (200 entries) with the actor, the
  field path and the from/to values. Reads need company access; PATCH is
  board only. Every section defaults to OFF — with the defaults the owner
  keeps receiving only the replies to their own messages and the U2 decision
  cards; the parts that actually send (digest, errors, inbound, escalations,
  proactivity) consume this contract. No environment variables are added.

### Telegram group topics as a task inbox (TG-NOTIFY part D)

- A message in a forum topic of a connected Telegram group can now become
  work on the board: the message continues the task already bound to that
  topic, or a new task is created with the first words of the message as the
  title and the thread link in the body. Both switches
  (`telegramNotify.inbound.enabled`, `telegramNotify.inbound.requireMention`)
  are off by default; the require-mention default keeps the group privacy
  contract, so commands in a topic work only when the bot is addressed. See
  [telegram-topic-inbound](../guides/telegram-topic-inbound.md).

### Tool gateway policy reads are served from a per-company cache with a live TTL (1.6.5 DB-PERF-C-P4)

- Every `tools/list` and every tool call decides access by reading
  `tool_profile_bindings`, `tool_profiles`, `tool_profile_entries` and the
  enabled `tool_policies` of the company. The tables are nearly empty, so the
  cost is the round trips: by the measurement of 06.10 that was ~5.4M statements
  over three days of statistics, with `POST /mcp/gateways` taking 18–26 s on
  average. The four row sets are now served from an in-process cache keyed by
  company (`server/src/myrmidon/tool-policy-cache/`, one cache per server
  process), and the cache stores exactly the rows the gateway read before, so a
  cached read returns the same row sets as a fresh one.
- Setting: `instance_settings.general.toolPolicyCache = { ttlMs }`, changed
  from `GET/PATCH /api/myrmidon/tool-policy-cache` (GET is open to board
  members, PATCH is instance-admin only). Default 30 s, minimum `0` (cache off),
  maximum 300 s. The field is also on the instance settings page ("Tool gateway
  policy cache", in seconds). The cache reads the row on every access, so a change
  applies to the next gateway call without a restart.
- Every write drops the company snapshot, and not only inside the two access
  services: create, update, delete, duplicate and reorder of policies, the
  trust-rule create/revoke and the trust-rule hit (it rewrites
  `tool_policies.config`) in `server/src/services/tool-access-policy.ts`, every
  profile, binding and profile-entry mutation in
  `server/src/services/tool-access.ts`, plus the writers outside both of them —
  the email-channel setup (creates a profile with its entries and bindings), the
  named MCP gateway (binds a profile) and the smoke lab (rewrites and removes its
  own profile rows). A changed policy is therefore visible to the very next
  decision instead of living until the TTL, which closes the risk the database
  audit raised. A load that was already running when the write landed cannot
  put its stale rows into the cache: every invalidation bumps a per-company
  generation counter and a load whose generation moved is dropped and redone
  once. Writes made on a caller's transaction handle (a remembered approval, a
  connection-intent completion, a catalog refresh) invalidate after the commit as
  well, and a service built on a transaction reads straight from the database. A write made
  straight through the database handle (a fixture, a manual fix) is likewise out
  of the cache's reach until the window ends, so the vendor tests that seed these
  four tables directly drop the snapshot themselves — the same way
  `tool-access-service.test.ts` already does for the cloud-connector cache.
- Deliberately not cached: rate-limit counters, audit events and principal
  permission grants. They are per-principal state and the gateway writes to
  them; they stay direct reads and writes.
- `ttlMs: 0` restores the previous behaviour exactly: the cache answers "no
  snapshot", the gateway runs its own statements unchanged, and the statement
  set is the one it had before the cache existed. The only read the cache adds
  in that mode is the settings row that carries the switch itself.
- Guard: `server/src/myrmidon/tool-policy-cache/tool-policy-cache.myrmidon.test.ts`
  drives the cache directly (TTL window, invalidation, eviction cap, the
  switched-off mode) and through the real `toolAccessPolicyService` on a fake
  database handle that counts the SELECTs per table: two decisions inside the
  window cost one snapshot load, a policy change through the API is visible to
  the next read and to the next decision with the clock untouched, and with
  `ttlMs: 0` every decision reads the policy tables again.

### VOICE-STT part C: the speech recognition settings screen (VOICE-STT-C)

- Company Settings gets a "Speech" screen (`/company/settings/voice-stt`): enable
  recognition, pick the provider (DashScope or Deepgram), the model, the
  language (auto or Russian), speaker separation and the recording length limit.
  Only changed fields are saved. Secret values never reach the screen.

### VOICE-STT part B: speaker diarization and the meeting protocol (VOICE-STT-B)

- The recognition path now answers the speaker-label outcome as a value: which
  call asked for diarization, whether the answer carried labels, how many
  speakers it found and, when labels are missing, the stable marker
  `diarization_no_speakers`. The LiteLLM/DashScope path asks the model for
  labels the way the Deepgram path already did — with the setting on, a
  recording with two voices comes back as «Говорящий 1/2» lines.
- A model that cannot separate voices is no longer a silent single-voice
  transcript: the task comment carries the marker line «Говорящие не размечены:
  diarization_no_speakers», and the meeting protocol reports the participants
  as unmarked instead of naming one.
- The work bot builds the meeting protocol from the labeled transcript — a
  deterministic pass (participants, decisions, action items) exposed as the
  function `buildMeetingProtocol` and as
  `POST /api/myrmidon/companies/:companyId/voice-meeting-protocol`, which
  answers the ready markdown document plus the facts it was built from. Naming
  the people behind «Говорящий N» stays with the bot's own meeting skill.

### VOICE-STT part A: Telegram voice and audio are recognized at intake (VOICE-STT-A)

- The shared speech-to-text core (`server/src/myrmidon/stt/`) is now wired into
  the inbound Telegram lane: with the feature enabled, a voice note or audio
  file arrives as a task comment whose body carries the transcript next to the
  kept attachment, so the bot reads it as user input on the same wakeup.
- The feature can be enabled per company from the STT settings screen — no
  server restart: the stored setting is read on every voice message. The
  environment variable `MYRMIDON_TELEGRAM_VOICE_STT` stays the instance-wide
  master switch and, when it names a value, wins over the company setting in
  both directions.
- A recognition failure (gateway unavailable, recognition model not registered,
  timeout, oversized or too long recording) is a skip, never a delivery
  failure: the comment keeps the vendor body and its metadata carries the
  redacted `stt_skipped: <code>` code.

### LLM Wiki plugin install/upgrade guide and release wiring test (WIKI-PLUGIN-RELEASE)

- `docs/wiki-plugin-install-guide.md` — installation, folder configuration,
  upgrade and troubleshooting steps for `@paperclipai/plugin-llm-wiki`.
- `scripts/myrmidon/wiki-plugin/wiki-plugin-release.test.mjs` — static
  `node:test` contract that pins the plugin's release wiring (esbuild build
  script, SDK from the repository workspace, `paperclipPlugin` entry points,
  packaged file list, esbuild config, guide presence) inside the cheap
  `checks` tier, without running a build.

## 1.6.4

### Fix: the board failed to start when a synthetic attention card was present

- The attention list looks up agent names with `agents.id IN (...)`. The
  bot-disk lifecycle card uses a key (`bot-disk-lifecycle`) as its subject id,
  not an agent id, and that key went into the lookup; Postgres rejected the
  uuid cast and the board exited at start. Agent-name lookups now take only
  uuid-shaped ids (`isAgentIdLike`), and the clone-hygiene lookup skips the
  query when no bot key is a uuid.

### Registry entries as per-PR change fragments (CHANGE-FRAGMENTS)

- The shared registry documents — `docs/myrmidon/CHANGELOG(.ru).md`,
  `DIVERGENCE.md`, `SETTINGS(.ru).md` — are no longer appended to by hand.
  Every PR adds its entry as one file in `docs/myrmidon/changes/` (format and
  template: `docs/myrmidon/changes/README.md`), so two PRs with changelog
  entries merge back to back without conflicts instead of re-resolving the
  same append conflict in a circle.
- At release cut `node scripts/myrmidon/release/collect-fragments.mjs
  --version X.Y.Z` folds every fragment into the shared documents (changelog
  sections under a new `## X.Y.Z`, an empty `## Unreleased` /
  `## Без выпуска` left on top; divergence/settings table rows into the
  section the fragment names) and deletes the fragment files.
- A CI gate (`scripts/myrmidon/ci/change-fragments-gate.mjs`, running inside
  the existing node:test step of the checks job — no workflow change) refuses
  a PR that edits a shared registry document by hand and prints the hint:
  restore the file, add a fragment. The release-cut PR is recognized by the
  fragment deletions it carries and passes.

### Vendor share metric: measuring files inherited from the vendor (VENDOR-SHARE-METRIC)

- `node scripts/myrmidon/vendor-share.mjs` measures how many tracked files the
  fork still inherits from the pinned vendor base commit
  (`scripts/myrmidon/vendor-base.txt`, refreshed per vendor import). A file is
  inherited when its path existed at the base (renames followed via
  `git diff -M`) and its line similarity against the base revision is at or
  above the threshold (`--threshold` flag → `MYRMIDON_VENDOR_SHARE_THRESHOLD`
  → built-in 0.5; the report names the source it used). Output is JSON or a
  short Markdown table; the release ritual records the number, replacing the
  hand audit.

### Board MCP tool names renamed to `myrmidon*` with one-release aliases (1.7 REBRAND D)

- The board MCP server (`packages/mcp-server`) publishes every tool under a
  `myrmidon*` name (`myrmidonMe`, `myrmidonListIssues`, `myrmidonUpdateIssue`,
  …). Each old `paperclip*` name stays registered as a deprecated alias bound
  to the same handler for exactly one release, so existing agent skills and
  installed systems keep working; the alias is marked in the tool description.
  The `connections_search`/`connection_request` tools have no vendor prefix
  and are unchanged. Details and the 1.8 removal plan:
  [guides/mcp-tool-names.md](guides/mcp-tool-names.md).
- Guard test: `packages/mcp-server/src/tool-aliases.test.ts` (both names call
  one handler; every old name mapped and marked deprecated; catalog-drift
  guard).

## 1.6.3

### One deploy for every component (ONE-DEPLOY)

- A release deploy now updates every component in one maintenance window:
  `deploy.sh --release myr-vX.Y.Z` reads the release's component digests (board,
  dockergate, fleetd, bot images) from the new machine-readable release asset
  `release-components.json` (the release publish step uploads it; the digest table of the
  release body is the fallback for older releases). On 04.10 the board moved to 1.6.2 while
  dockergate stayed on 1.3.0 and the shared package cache did not work until dockergate was
  updated by hand.
- Components that already run their release image are not restarted; a release with
  missing digests, or a component that cannot roll out, is refused before the window.
- The window is all-or-nothing: a failing component rolls the changed components, the
  dockergate config and the board back together (`MYRMIDON_COMPONENT_AUTO_ROLLBACK=0` keeps
  the manual contract).
- dockergate: `dockergate check-config` runs with the new image before the service is
  recreated; after the recreate the startup self-check version is verified; the release bot
  images (including the dev variant) are added to `images[]`.
- Bot cards that track the release image (a previous release image of the same repository)
  switch in batches of at most 5, only while the agent is paused or idle; pinned cards are
  left alone; progress and failures are reported. Includes BOT-IMAGE-ROLLOUT (PR #454).
- `component_host_service_exists` no longer reports a service as missing when `grep -q`
  closes the pipe early (SIGPIPE under `pipefail`).

### Prompt-budget advice and deep analysis (PROMPT-BUDGET part C)

- The agent card's Overview tab carries a "Prompt budget advice" panel: the last run's
  prompt breakdown by parts, a concrete recommendation for every part whose share crosses
  30% (Critical from 50%; below 2000 prompt tokens no advice is produced — the thresholds
  are code constants, not settings), and a "Deep analysis" button that files a task for a
  cheap-model optimizer agent. The optimizer drafts instruction edits as a comment on that
  task; nothing is scheduled and nothing is changed automatically.
- The optimizer agent is the instance general setting `promptBudget.optimizerAgentId`
  (no environment variable); the deep POST answers 422 with a clear message when it is
  absent, not a uuid, the analysed agent itself, or not an agent of the company. Dedup:
  one deep task per target agent per run.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member), `POST .../advice/deep` (board). Operator guide:
  [guides/prompt-budget-advice.md](guides/prompt-budget-advice.md).

### Agent memory works without a key and is set in the UI (MEMORY-UI)

- The Memory tab on the agent card no longer says "Agent memory is not enabled on this
  instance" for a memory service without authentication. The API key is optional: the
  section is on whenever an address is known, and the key is sent only when a key secret
  is named.
- The address defaults to `MYRMIDON_BOT_HINDSIGHT_API_URL` (the same service as the bots
  use) when `MYRMIDON_HINDSIGHT_API_URL` is unset. Precedence: instance setting, then
  environment, then the bot address.
- New instance setting `general.agentMemory` (`enabled`, `apiUrl`, `keySecretName`) with an
  "Agent memory" panel in Instance settings → General and `GET`/`PATCH
  /api/myrmidon/agent-memory`. It is re-read on every request: no restart. See
  [SETTINGS.md](SETTINGS.md).

### Automatic reviewer for tasks in review (REVIEW-ROUTING)

- A task that moves to `in_review` with no reviewer no longer waits for a manual
  assignment. A board sweep (every 60 s) gives it a one-stage review with the
  least-loaded agent of the reviewer roles that is below the load ceiling — never
  the task's author or assignee — leaves a system comment and an activity entry,
  and wakes the reviewer. The review is the ordinary execution review stage:
  approving closes the task as done, requesting changes returns it to the previous
  assignee.
- When no reviewer is available the task raises an attention card
  (`review_routing`) instead of staying silent. A review this routing started that
  has no verdict after the configured hours raises a card and moves to another
  reviewer (never one that already had it).
- Settings — enabled, reviewer roles, max load per reviewer, reassign-after hours —
  are on the new Company Settings → Review routing screen (stored in the instance
  settings) and apply on the next pass, without a restart. See
  [SETTINGS.md](SETTINGS.md), section "REVIEW-ROUTING".

### Live progress steps in the Telegram DM status message (DM-PROGRESS)

- The owner reported that a bot in a bridged Telegram DM only says "queued",
  "working" and then the result, with nothing in between. While a run is
  active the one status message now shows what the bot is doing — "читаю
  презентацию deck.pptx", "правлю слайды 4, 9", "проверяю результат" — plus the
  last few finished steps and the elapsed time, and is edited in place until
  the answer replaces it.
- Steps come from the run's native step events and, for adapters that write
  none (the Hermes gateway and local adapters), from a small in-memory step
  history fed by the runtime status and the run-log tool lines. A tool call
  reaches the chat only as a short phrase with at most a file basename or
  slide numbers; commands, paths and arguments never do.
- Edits are throttled: a milestone change posts at once, a change of the step
  kind (reading, editing, checking) after about 5 seconds, anything else only
  once the configured interval has passed (default 45 s).
- On/off and the interval live in Instance settings → General ("Telegram DM:
  live progress", `GET`/`PATCH /api/myrmidon/telegram-dm-progress`) and apply at
  the next status update without a restart. Environment overrides:
  `MYRMIDON_TELEGRAM_DM_PROGRESS`, `MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC`;
  the default of "on" follows `MYRMIDON_TELEGRAM_DM_STATUS`. Turning it on also
  turns the status message on for bridged DMs.
- The queued and working texts of the status message are now in Russian, like
  the step labels. Guide: [telegram-dm-status.md](guides/telegram-dm-status.md).

### Idle engineers take unassigned ready work (1.6.2 SWARM-UNASSIGNED-ROUTE)

- The swarm idle pass paired free agent number i with queue slot i. The engineer
  queue is ordered by priority and also held the tasks already assigned to busy
  peers, so those filled every slot and the unassigned tasks behind them were
  never offered: idle engineers and ready unassigned `todo` tasks coexisted for
  hours. Now each free agent takes its own assigned task first, else the top
  unassigned task of its role; a peer's task is never offered to it, and tasks
  already covered by a live claim or a wake in flight no longer take a slot. The
  claim path (`claimNextTaskForAgent`) reads the same membership: the agent's own
  tasks plus the unassigned tasks of its role.
- An unassigned task is queued for one role: the one its `role:<key>` label
  names, the engineer when it has no such label (before, every role was offered
  every unassigned task).
- A config gap is a signal, not idleness: ready tasks routed to a role with no
  agents are reported on every pass (`idleUnstaffedRoles` in the pass result and
  a warning naming the role and the tasks).

### Heavy builds blocked inside the dev bot image (1.6.1 BUILD-OFFLOAD, part A)

- The development variant of the bot image (`runtime-dev`,
  `ghcr.io/itkadr-git/myrmidon-hermes-dev`) no longer relies on convention to keep
  heavy repository operations off the bot container: `pnpm`, `tsc`, `vitest`,
  `gradle` and `go` shims in `/opt/paperclip/bin` (first on `PATH`, ahead of the
  real binaries) refuse every non-trivial invocation with exit 1 and a stderr
  message naming the exact `devbuild …` replacement, unless an executable
  `/usr/local/bin/devbuild` exists in the container. That gateway file is never
  baked into the image — the part-B driver mounts it into the per-invocation
  build container — so the barrier is always closed in the ordinary bot
  container. See
  [docker/bot-runtime/README.md](../../docker/bot-runtime/README.md), section
  "Heavy builds are blocked at the image level".
- Light probes keep working locally: `pnpm --version`, `pnpm config …`,
  `pnpm store status`/`path`, and bare `--version`/`--help` of the other wrapped
  tools. `git`, `node`, `cargo`, `gh` and `docker` are deliberately not wrapped —
  the light, editing half of the cycle still runs in the container. To run a
  build: `devbuild pnpm install`, `devbuild pnpm exec tsc --noEmit`,
  `devbuild pnpm vitest run`, `devbuild go build ./...` — the workspace is
  mounted into a build container on the build VPS and the same command runs
  there.

### Release publish waits for the tag's own image runs (RELEASE-PUBLISH-WAIT)

- Pushing the `myr-v1.6.1` tag failed to publish the Release on the first
  try: the publish gate matched workflow runs by the tag commit's
  `head_sha` only, so it saw the already-green `main`-branch run of the
  same commit (which builds the `main`/`sha-` image tags) instead of
  waiting for the tag's own board image run, and then the digest probe
  failed with "component image digests missing … board". The gate now
  also filters runs by `head_branch == the tag`, so the publish waits for
  every required image workflow of the same tag (up to ~40 minutes) and
  a failed tag run still refuses the publish with the workflow's name.
  Follow-up (same day): the CI gate accepts a green main-branch run of the
  same commit — `myrmidon-ci.yml` has no tag trigger, so a tag never has a
  CI run of its own and the strictly tag-scoped gate would have refused
  every publish after ~20 minutes of polling.
- A manual re-run from the `main` branch no longer overrides the typed
  tag: `myrmidon-release.yml` resolves the tag as
  `inputs.tag || github.ref_name` (checkout `ref`, `TAG` env and the
  concurrency group), so `gh workflow run myrmidon-release.yml -f tag=…`
  from `main` publishes the given tag without `--ref`.

### Chats are never held; an owner message always wakes (CHAT-HOLD)

- Incident: a host OOM cancelled the run of a perpetual Telegram DM chat;
  execution recovery closed it as "do not replay" and set the chat issue
  `blocked`, and every later owner message was parked as
  `deferred_issue_execution` behind that hold. The owner saw only "Your
  follow-up is queued" for hours.
- A chat is a conversation, not a work ticket. An issue that backs a chat (a
  bridged chat thread, or a board Agent Chat conversation) is never put into
  `blocked` by automatic recovery and gets no replay hold: its stopped turn
  is settled as `chat_continuation`, the issue returns to the idle
  `in_review` state, and the next message is a fresh turn. Ordinary work
  issues keep the existing recovery unchanged.
- A new message a person writes in a chat is an explicit human action: the
  wake admission passes any settled hold of the chat, lifts it with the
  successor run (the same clear path as the board unblock), moves a chat the
  recovery had blocked back to `todo`, and records it in the activity log
  (`issue.execution_recovery_settled`, `continuation: chat_owner_message`).
  A "retry the failed run" wake is not a message and stays withheld.
- No silent queue: when a message in a bridged Telegram DM cannot start (the
  previous turn is winding down, recovery, a pending decision, a paused
  agent, an exhausted budget, the host memory gate), the chat is told why in
  plain Russian, with a time estimate where one is known (the memory gate
  re-checks every 15 seconds). Guide: [telegram-dm-status.md](guides/telegram-dm-status.md).

### Shared package cache for development bots (1.6.2, BOT-DISK B)

- An instance setting, `general.botDisk.sharedPackageCachePath` (Instance → General or
  `PATCH /api/myrmidon/bot-disk`, instance admins only), gives every bot on the board's host
  read-write mounts `/cache/{pnpm,go-mod,go-build,gradle}` from one host directory, and the
  profile points `npm_config_store_dir`, `GOMODCACHE`, `GOCACHE` and `GRADLE_USER_HOME` at
  them, so downloads are kept once instead of once per bot. Applies on the next reconcile pass
  without a restart; off by default. Bots on a fleetd host are not affected.
- dockergate: new `packageCacheRoot` key (default empty: no cache bind). **Operator step:** set
  it to the same directory and send `SIGHUP`, and create the four subdirectories owned by
  uid/gid 10001 — see [bot-disk-cache.md](bot-disk-cache.md).

### Bot workspace duplication: shared git objects, hard-linked node_modules, clone hygiene (1.6.2, BOT-DISK C)

- Shared git objects. `general.botDisk.gitMirrorRepos` lists GitHub `owner/repo` names; the board
  keeps one bare mirror of each under `<sharedPackageCachePath>/git/<owner>/<repo>.git`
  (refreshed by `git fetch --prune` every `gitMirrorRefreshMs`, default 15 minutes, under a lock;
  gc never prunes), and bots mount it **read-only** at `/cache/git`. The dev image's `git`
  wrapper adds `--reference-if-able` to `git clone https://github.com/<owner>/<repo>` when the
  mirror exists, so a clone stores only objects the mirror lacks; every other git invocation is
  unchanged and `git-credential-paperclip` keeps working. Off by default (empty list). dockergate
  accepts `<packageCacheRoot>/git` only as a read-only bind to `/cache/git`.
- Hard-linked node_modules. A hard link cannot cross a mount, and `/workspace`, `/cache/pnpm`
  and the image's previous store `/data/hermes/.pnpm-store` are three different mounts, so pnpm
  silently **copied** every package into every clone. The store now defaults to
  `/workspace/.pnpm-store` (image and profile), on the clones' mount; `general.botDisk.pnpmStore:
  "shared"` keeps it on `/cache/pnpm` and sets `package-import-method=clone-or-copy` for
  reflink-capable filesystems. The dev image's build runs `pnpm-hardlink-check.sh` and fails on a
  copy; CI runs the same proof, including the cross-mount copy.
- Clone hygiene in the BOT-DISK A lifecycle. A git clone is no longer reaped by its directory's
  mtime. The board server has no mount of the bot volumes, so the BOT-DISK A sweep found no root
  and reclaimed nothing in production; it now logs one warning, does nothing, and raises a
  "Lifecycle not effective" Attention card when no bot reports either. The deletion runs inside
  each bot container (`bot-clone-hygiene`, policy `MYRMIDON_CLONE_IDLE_TTL_SEC` written into the
  profile): a clean, fully pushed, idle clone is removed, a clone with unpushed work (dirty tree,
  operation in progress, stash, commits on no remote) never is, and the board reads the report to
  raise an Attention card (source `bot_disk_lifecycle`) for it. The workspace pnpm store is
  never swept.
- Scope: the shared package cache and the git mirror now apply only to bots whose role is in
  `general.botDisk.sharedCacheRoles` (default `engineer`, `reviewer`, `devops`, `release`, `qa`;
  editable without a restart). Other bots (e.g. marketing) get no cache mounts or variables, so
  enabling the cache no longer recreates them.
- **Operator steps:** see [bot-disk-cache.md](bot-disk-cache.md#enabling-git-mirrors-operator-steps)
  — create `<cache>/git` owned by the board's user (mode 0755), then
  `PATCH /api/myrmidon/bot-disk` with `{"gitMirrorRepos": ["owner/repo"]}`. The bot image must be
  rebuilt (the wrapper, the reporter and the store default are in the image); older images keep
  working without them.

### A board unblock lifts a settled replay hold; a parked wake is not "covering" (HOLD-READY)

- A task with a closed recovery action whose `evidence.automaticRecovery.replay`
  reads `"blocked"` stayed stuck for good: the wake admission parked every
  automatic wake of it (`deferred_issue_execution`, `executionWait`
  `process_identity_missing`), idle pickup and the swarm sweep then counted that
  parked wake as "already covering" the task and skipped it, and a manual
  `POST /api/agents/:id/wakeup` without `issueId` answered 409 "no ready task".
  Moving the task from `blocked` back to `todo` on the board did not help: the
  status-change and comment wakes of that PATCH are not explicit wakes and were
  parked as well. Agents sat idle with a full `todo` queue.
- Now a board person (not an agent's run) who moves a task out of `blocked`
  (to `todo`/`in_progress`) or reassigns a workable task clears its settled
  replay holds in the same transaction, the same operator resolve as
  `recovery-actions/resolve` (activity `issue.execution_recovery_replay_cleared`).
  After commit one wake of the assignee (`execution_hold_cleared`) re-plans the
  wakes parked on the hold through the ordinary admission. Active/escalated
  recovery actions are not touched.
- A deferred wake parked on an execution hold no longer counts as covering the
  task in idle pickup, the manual-wake task binding or the swarm sweep, and the
  ready-task prefilters of idle pickup and the swarm queues skip a task that is
  really held (the same predicate the admission reads), so a held task is not
  reported as ready. No settings change.

### Gateway spend attributed through per-bot secret references (1.6.2 hotfix, M2-A)

- The gateway cost sweep wrote no rows: every collected spend row was counted as
  unattributed. Bot cards carry their gateway key as a `secret_ref` binding
  (`adapterConfig.env.<MYRMIDON_BOT_LLM_API_KEY_ENV>` = `{ type: "secret_ref", secretId, version }`,
  one company secret per bot), and the key lookup only understood an inline value or the one
  shared secret. The lookup now resolves the card's secret reference by id and version, the
  same reference the bot's container is compiled from, so the key hash matches the gateway
  ledger and rows are attributed to the agent and its run. Inline values still work; the
  shared secret (`MYRMIDON_BOT_LLM_API_KEY_SECRET`) is read once per pass and only for cards
  without their own binding; a reference to a secret that cannot be read skips that card
  instead of falling back to the shared key. The model fallback signal, which reuses the
  lookup, is fixed by the same change. No settings change.
### Plugin bridge: invocation-scope attribution from any in-flight invocation (PLS1 -> PLS2)

- The plugin bridge attributes an un-echoed worker call (a worker whose bundle
  carries a plugin SDK that predates invocation-id echo) to the company of ANY
  in-flight host-issued invocation — a plugin API route, `onEvent`,
  `performAction`, `getData`, `executeTool` or an environment call — instead
  of only an in-flight API route call. Bridge entry points register their
  invocation scope without the apiRoute marker, so nested calls issued from
  those handlers (the LLM Wiki plugin's `localFolders.*` calls) were answered
  with "missing, expired, or unknown invocation scope"; this change closes the
  same gap on `bridge/data`, `bridge/action` and plugin tool calls, fixing the
  empty page list, pages that would not open and the failing
  `wiki_write_page`-style tools of plugins built with the old SDK.
- The safety guard is unchanged: attribution applies only while every
  in-flight invocation of any kind belongs to one company; an in-flight call
  of another company keeps the call denied (`INVOCATION_SCOPE_DENIED`), and a
  call carrying an unknown or forged invocation id is still rejected.
- The scope is always the host-issued one (the company the entering call
  resolved and authorized); a value from the worker is never taken. No rights
  are widened: the worker received the invocation ids of those calls and
  could echo any of them.
- The resolver moved from `server/src/myrmidon/plugin-api-route-scope.ts`
  (deleted) to `server/src/myrmidon/plugin-invocation-scope.ts`; the vendored
  worker manager marks the new branch `myrmidon(PLS2)` and the divergence
  registry entry in [DIVERGENCE.md](DIVERGENCE.md) was rewritten for the
  all-entry-points semantics. The removal condition stands: once the plugin
  is rebuilt from `packages/plugins/plugin-llm-wiki` with the current SDK
  (the worker echoes the invocation id itself), the PLS1/PLS2 branch, the
  `apiRoute` field and the resolver files go away.
- Guard test: `server/src/myrmidon/plugin-invocation-scope-bridge.myrmidon.test.ts`
  with the fixture
  `server/src/__tests__/fixtures/plugin-worker-invocation-scope-bridge.cjs`
  covers the three bridge entry points (red without the fix, green with it)
  and the cross-company denial.

### Automatic rollback by health: operator guide (AUTO-UPDATE-SETTINGS A)

- Docs only: the existing R5-C behavior (a failed post-deploy health check rolls
  the board back to the remembered previous image, `auto_rolled_back` /
  `failed_rollback`) gets its operator guide,
  [guides/deploy-auto-rollback.md](guides/deploy-auto-rollback.md)
  ([RU](guides/deploy-auto-rollback.ru.md)): when the rollback fires, the job
  and report phases, where the failure reason is recorded (job steps, activity
  log, the executor log), what the owner sees when a rollback fails (the
  maintenance banner, the Board update panel, the Telegram digest), and the
  settings of both halves of the switch. The `MYRMIDON_DEPLOY_AUTO_ROLLBACK`
  row of [SETTINGS.md](SETTINGS.md) links the guide. No code change; the
  acceptance test of the behavior is the R5-C block of
  `server/src/myrmidon/deploy-jobs/service.myrmidon.test.ts` and
  `scripts/myrmidon/deploy/deploy-from-job.test.mjs` (a deliberately broken
  image against the fake driver).

### Budget enforcement modes (1.7 BUDGET-CONFIG B)

- What a crossed spend budget limit does is now a mode, not a fixed stop:
  `signal_only` (the default — the incident and the owner signal appear, but
  the scope is not paused and runs start), `soft` (pause plus the "raise the
  budget or keep paused" card; raising resumes the scope), `hard` (new runs
  of the over-limit scope are refused with the budget reason). One mode for
  the whole instance, changed live from Instance → General or
  `PATCH /api/myrmidon/budget-enforcement` — no restart; every change is
  audited, and the value's source (saved / environment / default) is shown.
  The environment override is `MYRMIDON_BUDGET_ENFORCEMENT_MODE`. Guide:
  [guides/budget-enforcement.md](guides/budget-enforcement.md).

### Maintenance: asynchronous exit and the post-deploy fleet check (EXIT-ASYNC + POST-DEPLOY-CHECK)

- Leaving maintenance mode is asynchronous (#268): the `exit` call returns as
  soon as the window is marked `leaving`, and the leave tail (resuming the
  queued wake backlog, the exit hook, retiring the window) runs on the
  maintenance tick (`MYRMIDON_MAINTENANCE_TICK_SEC`, default 5 s). `leaving`
  already reopens admission, so the fleet keeps working while the tail runs.
- The deploy waits on the state, not on the HTTP call: after the exit POST,
  `deploy.sh` polls the maintenance state until the instance window is `off`,
  bounded by `MAINTENANCE_EXIT_WAIT_SEC` (default 120 s). A timeout is logged
  loudly and does not fail an already switched and healthy deploy; a failed
  exit request still aborts it.
- The deploy ends with a read-only post-deploy fleet check (step 9,
  `post_deploy_fleet_check`): with `BOARD_API_URL` and `BOARD_COMPANY_ID` set
  it asks the board for issues that are `blocked` with an update since the
  deploy started and re-reads the maintenance state. A hit, an unreadable
  board or a window that did not retire prints `degraded: ...` and the run
  ends with `DEPLOY DEGRADED` — the verdict does not fail a switched and
  healthy deploy. Without the two settings the check is skipped.

### WIP limit (WIP-LIMIT parts A + B)

- The per-agent work-in-progress limit: a company-wide default and
  per-agent overrides edited on the "WIP limit" screen in Company Settings
  (sidebar item after Autonomy); each agent's live
  `in progress + in review` load shows in the screen's table, as a
  `wip/limit` badge on every agent row of the agents page (red over the
  limit, bare count when the limit is off, no badge without a status
  entry), and in the attention feed (source kind `wip_limit`, one card per
  over-limit agent). A periodic sweep on the heartbeat scheduler (300 s)
  writes one system-notice comment per over-limit agent per UTC day
  (dedup key `wip-limit:<agentId>:<utc-day>`) on the agent's most recent
  in-progress task. The settings live in
  `instance_settings.general.wipLimit` — no environment variables; an
  absent limit means count-only (status and badge still work, nothing
  signals). A lead (an agent with direct reports) has an implementation
  limit of 0 — any task it holds in flight is over the limit by
  definition. See [wip-limit](guides/wip-limit.md).

### Telegram notification settings UI (TG-NOTIFY-SETTINGS part F)

- The "Telegram notifications" panel on the System screen of the 2.0 UI: all
  five sections of the telegramNotify settings are visible and editable
  (digest, errors, owner messages, escalations, head-bot proactivity), every
  section off by default, with the settings change log rendered from the
  document the settings core serves. Saving sends one PATCH with only the
  changed fields. Depends on the settings core (part A); while that is not
  merged the UI is covered by tests against the mocked JSON contract.

### Voice STT, server core (VOICE-STT part A)

- The server-side speech-to-text core (#418): `server/src/myrmidon/stt/` with
  the `dashscope` (multipart `POST /v1/audio/transcriptions` on the shared
  LiteLLM gateway) and `deepgram` backends, a pure-TypeScript long-recording
  split (OGG page / MPEG frame boundaries, no ffmpeg) with timecode-offset
  merge and record-scale speaker renumbering, and the
  `transcribeAudio({companyId, bytes, mimeType, durationSec?})` contract with
  the stable error codes `stt_disabled`, `stt_unconfigured`, `audio_too_long`,
  `audio_too_large`, `stt_timeout`, `stt_upstream_error`. Off by default:
  without `MYRMIDON_STT_ENABLED` the path makes no outbound request. Backend
  keys are company secrets referenced by name only (read per call, never
  cached, never logged). Per-company runtime overrides live under
  `instance_settings.general.myrmidonSttCompanies[companyId]` and are managed
  through `GET`/`PATCH /api/myrmidon/companies/:companyId/voice-stt` (GET is
  company access, PATCH is board only; every save is journaled as
  `myrmidon.stt.settings_saved`). See [SETTINGS.md](SETTINGS.md), the VOICE-STT
  section.
## 1.6.2

### Run admission by host free memory and a start ramp (RUN-ADMISSION)

- The run admission gets a host free-memory floor, `minFreeHostMemoryMb`
  (`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`, default 15360 MB): a new run, whatever
  woke it (on demand, assignment, idle pickup, swarm idle wake, automation),
  starts only while the host's `MemAvailable`, minus the per-run budget of runs
  started in the last 30 s, stays at or above the floor. Otherwise it stays
  `queued` and the 15 s queue pass retries it. The existing
  `minFreeMemoryMb` measures the server cgroup and cannot see the bot
  containers, which is how 23 concurrent runs exhausted the host while the
  server looked healthy.
- Host memory is read from `/proc/meminfo` (the host's file inside a Docker
  container without lxcfs); a container-scoped meminfo (lxcfs) is detected and
  refused, and `MYRMIDON_HOST_MEMINFO_PATH` points at a mounted host file.
- The start ramp `maxStartsPerMinute` now defaults to 5 (was off). An instance
  that already saved its run limits keeps its saved value; change it on the
  settings page.
- The swarm idle-wake pass wakes nobody while the floor is closed and logs the
  reason (at most once per 5 minutes).
- When the floor holds runs back for more than 10 minutes, the attention desk
  shows "Runs held: host memory" with the current free memory and the floor.
- Both values are edited without a restart on Instance → General "Run limits",
  Settings → "Runs & queue" and `PATCH /api/myrmidon/runtime-limits`. A stored
  row from an older version (without the new key) keeps working; the floor
  comes from the environment or the default until the next save.
- `0`/`off` switches the floor or the ramp off from the environment; a
  malformed value keeps the default. See [SETTINGS.md](SETTINGS.md) and
  [guides/run-limits.md](guides/run-limits.md).

## 1.6.2

### Bot language servers by role (BOT-LSP-DEFAULTS)

- Bots whose role writes code (by default the castes `engineer`, `qa`,
  `devops`, `reviewer`, `release`) run language servers in a **limited** mode:
  one TypeScript server per worktree (`tsserver.useSyntaxServer: "never"`),
  no automatic typings download, a 1024 MB heap cap (`maxTsServerMemory`) and
  a 120 s idle timeout instead of 600 s. Every other bot runs **none**
  (`lsp.enabled: false`). Monorepo typecheck still goes through the build
  server.
- The policy is an instance setting (Instance settings → General → "Bot
  language servers", `GET`/`PATCH /api/myrmidon/bot-lsp`): which roles write
  code, the mode of coding and other roles (`off` / `limited` / `full`), the
  idle timeout, the memory cap and excluded workspace roots. An agent card can
  pin its own mode ("Language servers" section).
- Changes apply without a server restart: the profile compiler re-reads the
  policy on every reconcile tick, and a changed `lsp` block is applied while
  the bot is paused, like a model change. On the first deploy every container
  bot gets the new block once (one restart per bot, under its pause).

## 1.6.1

### Role queues as instance settings (SWARM-SETTINGS-UI)

- The pilot of the per-role task queues is set in the interface, without a
  restart: the "Role queues (SWARM-CLAIM)" section of Instance → General
  (`GET`/`PATCH /api/myrmidon/swarm-claim`, board reads, instance-admin
  writes) holds the master switch, the pilot role set (the pilot on the dev
  team: comma-separated roles, e.g. `engineer`), the pilot company set, the
  lease TTL, the per-agent task ceiling, the sweep interval and the P0
  preemption. The server re-resolves the row on every claim, checkout, sweep
  tick and supervisor read: turning a role on takes effect within a minute,
  and turning the pilot off releases the live leases at once — the PATCH does
  it synchronously (the response reports the count) and the sweep repeats it
  on its next pass with the release reason `pilot_disabled`. The `MYRMIDON_SWARM_*`
  environment variables are now documented forced overrides: a set variable
  beats the stored value for its key only, and every key of the GET answer
  carries its source (`settings`, `env` or `default`) — both the settings
  screen and the Swarm supervisor screen render where each value came from.
  Every change appends a journal entry (who, what, when — newest first, kept
  under `general.swarmClaimJournal`) plus the `instance.swarm_claim.updated`
  activity row. The P0 preemption became a setting: off demotes the priority
  rank to a tie-break, the queue is strictly oldest-first. Under the hood the
  stored settings never survived the vendor general-settings write cycle (the
  key was dropped on every write, so the pilot could in practice only be
  enabled from the environment) — fixed together with the journal key.
  See [SETTINGS.md](SETTINGS.md).

### SWARM-IDLE-WAKE: Free agents wake when their role queue is not empty

- Third pass of the swarm supervisor (`sweep.ts`, after the release and free passes): on each tick, for each pair of "role + ready queue + free agents", wakes the missing number of agents, in batches ≤5 (`MYRMIDON_SWARM_IDLE_WAKE_BATCH`, default 5, clamp 1–25), each wake bound to the top task of the queue (P0 first — `orderSwarmQueueCandidates`). Pure modules: `idle-wake.ts` (policy: no live lease, under task ceiling, not paused/error, no live run, idempotency key) and `idle-queue.ts` (DB reads: role-queue pairs, live claim counts, coverage check). Assigned tasks go to the role of their executor; tasks without an executor are offered to every role with agents. The active task limit is respected, castes remain a gate on the claim side (`caste_excluded`, CUSTOM-CASTES B) — the point of control; the caste ceiling is respected. Supervisor metric: new total `freeAgentsWithQueue` — "free agents when queue is not empty" — which the pass should keep at 0 (unassigned tasks are now visible to roles with agents). Wakes go only through the existing `enqueueWakeup` (pause, maintenance, limits, budget — all gates preserved); the capture happens on checkout of the awakened run. The "one TTL + sweep interval" criterion is covered by a test (interval ≤ TTL/3). Docs: `MYRMIDON_SWARM_IDLE_WAKE_BATCH` in SETTINGS.md/SETTINGS.ru.md; skill `skills/paperclip/SKILL.md` supplemented with self-capture fallback (`POST /api/myrmidon/companies/{companyId}/swarm-claim/claim`).
### Grant-based actor permission checks (ADMIN-AGENT part B)

- Board-only actor-type checks on the company environments and
  tool-connections routes now follow the company permission grant: an agent
  actor passes when the company grants it the matching permission key —
  `environments:manage` for the environments routes (including reading the
  shared instance environment catalog), `tools:admin` for stdio command
  templates and tool gateway management, `tools:manage_connections` (or
  `tools:use` on the connection test routes) for connection testing,
  `tools:manage_runtime` for runtime slot control, and `tools:view_audit` for
  the raw gateway audit read. Board actors keep the exact previous semantics
  (instance admins and the local implicit board pass; signed-in members pass
  with the grant; viewers stay read-only), and an agent without a grant gets
  the same 403 as before the change, so enabling nothing changes nothing.
  Tool mutation activity-log rows now record the real acting principal — an
  agent-actor mutation writes `actorType: "agent"` with the agent and run ids
  instead of the old hardcoded board-user placeholder. Operator guide:
  [guides/actor-grant-routes.md](guides/actor-grant-routes.md).

### Custom castes, consumers (CUSTOM-CASTES B)

- The server-side consumers of the company caste directory (part A ships the
  directory itself): the agent role validator accepts any well-formed caste
  key (latin letters, digits, hyphens, 1–60) and the agent create/update
  service refuses a key that is not a caste of the company with a 400 that
  names the key; the swarm claim gate reads the claiming agent's caste —
  `swarmEligible=false` returns the new `caste_excluded` claim reason (a
  supervision caste never enters the claim pool), and a caste-set
  `maxActiveTasks` overrides the global swarm ceiling for that caste's
  agents. A role with no directory entry, and a build with no directory wired,
  behave exactly as before. The autonomy matrix and the authorization logic
  are unchanged — the caste key is the role string, the CEO checks stay
  byte-identical, and custom roles keep working through explicit grants.
  Regression tests pin all of the above, including "moving an agent to a
  caste changes no autonomy verdict". The behavior contract is documented
  in [SETTINGS.md](SETTINGS.md) (section "CUSTOM-CASTES B").

### Stale-block watchdog (STALE-BLOCK part B)

- Periodic module `myrmidon/stale-block`: every
  `MYRMIDON_STALE_BLOCK_INTERVAL_SEC` (default 300 s) it inspects blocked
  tasks and lifts a block whose every reason is dead — a blocker task that
  is done or cancelled (cancelled blockers never fire the
  blockers-resolved path), a passed `reasonRef.dueAt` date, or a cleared
  gate/event. Dead blocked-by edges are removed through the ordinary issue
  update path, the task returns to `in_progress`, and one system comment
  names the cause. A task with a live reason is untouched. Opt-in via
  `MYRMIDON_STALE_BLOCK_ENABLED` (default 0). Guide:
  [guides/stale-block.md](guides/stale-block.md).
- One new attention source kind `stale_block`: a lifted block raises one
  card for the lead and the operator, computed on the fly from a
  process-level signal registry (no new store); cards fade after
  `MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS` (default 24 h).

### Gateway-priced hermes runs (HERMES-USAGE-COST)

- hermes_gateway runs no longer land in the cost ledger as unpriced $0
  rows: after every LLM-gateway spend collection sweep, a reconcile pass
  fills each run's `cost_events` row with the gateway's own spend for that
  run (cost_status=reported) and refreshes the agent/company monthly
  counters. Only unpriced hermes_gateway rows are touched — adapter-priced
  rows and other providers are never overwritten, and a run with no
  collected spend stays unpriced instead of getting an invented price. The
  first sweep can look back up to 90 days
  (`MYRMIDON_LITELLM_FIRST_LOOKBACK_DAYS`), and
  `POST /api/myrmidon/companies/:id/litellm/sweep` accepts a `from` body
  for one-off month backfills. The UI-2.0 forecast chip shows
  "spent" only when no monthly budget is configured, ending the
  "$0 of $0" placeholder.

### Bot runtime tuning from the profile compiler (BOT-RUNTIME-TUNING part B)

- The bot profile compiler writes three settings into each bot's
  `hermes/config.yaml` that it never wrote before:
  `compression.threshold_tokens` (an absolute token cap — Hermes compresses
  at the lower of its ratio threshold and this count, so a long session on a
  large-window model no longer grows to half the window before compacting),
  `model.context_length` (the context window of the card's model, from the
  card's own `models.contextLength` or the instance's
  `MYRMIDON_BOT_MODEL_CONTEXT_LENGTH` alias map), and the auxiliary models
  `auxiliary.title_generation.model` / `auxiliary.compression.model` (the
  title generator and the compression summarizer stop riding the main,
  expensive model). Instance settings:
  `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS`,
  `MYRMIDON_BOT_MODEL_CONTEXT_LENGTH`,
  `MYRMIDON_BOT_AUX_TITLE_MODEL`, `MYRMIDON_BOT_AUX_COMPRESSION_MODEL`.
  The card's entry always wins over the instance setting; unset stays unset
  (no compiler-invented defaults). Values are validated in ranges at compile
  time (10 000–2 000 000 for the token cap, 8 000–10 000 000 for the context
  window): an out-of-range or non-integer value is dropped with a profile
  warning in the container activity log — never a compile failure. Settings
  are read on every profile build, and a change restarts the affected bot
  containers on the next pass. Settings documentation:
  [SETTINGS.md](SETTINGS.md) § Bot containers.

### Board administrators from agents (ADMIN-AGENT part C)

- The UI half of making an agent a board administrator. The agent card's
  **Permissions / Trust** tab gains a fourth flag, **Board administrator**:
  flipping it goes through the same permissions PATCH as the three sibling
  flags, the state comes from the agent detail API
  (`access.boardAdmin`, falling back to `permissions.boardAdmin`), and both
  readers are fail-closed — anything but an explicit `true` reads as "not an
  administrator". Operators see the toggle only with permission-management
  authority (owner or admin membership, instance admin, local implicit
  board); a 403 from the API becomes a plain-language note under the toggle.
  The Company Settings **Members** page names every agent administrator: one
  table row per non-terminated flagged agent, with a **Board administrator**
  badge and a link to the agent's Permissions tab. Operator guide:
  [guides/agent-board-admin.md](guides/agent-board-admin.md).

### Board administrator grant semantics (ADMIN-AGENT part A)

- The server half of the board-administrator switch. `PATCH
  /agents/:id/permissions` accepts an optional `boardAdmin` boolean: enabling
  grants the fixed operator set — the 17 keys of
  `BOARD_ADMIN_PERMISSION_KEYS` (`agents:create` … `joins:approve`), an
  explicit list that never silently widens when the global permission
  registry grows — and snapshots the set keys the agent already held into
  `permissions.boardAdminSavedGrantKeys`; disabling revokes only the keys the
  switch added, so personal grants (a separately issued `tasks:assign`)
  survive, and re-enabling keeps the original snapshot. `GET /agents/:id`
  resolves `access.boardAdmin` for the CEO, the stored flag, or a
  pre-existing full set (read-time migration — nothing is rewritten until
  the first toggle). Flipping the switch needs the company
  `users:manage_permissions` right (board actors) or the same grant (agent
  actors; an agent cannot grant board admin to itself — 403), and every flip
  logs `agent.permissions_updated` with the `boardAdmin` value and the acting
  principal. Same guide:
  [guides/agent-board-admin.md](guides/agent-board-admin.md).

### Parallel helpers without a hard cap (HELPERS-NO-CAP)

- The number of parallel helpers is a setting with **no built-in upper
  limit**; the default stays 2 (owner's decision, repeated 03.10). The hard
  cap of 50 that clamped even the owner's own settings value is gone: the
  company ceiling (`maxPerAgent`) and the per-agent limit are taken exactly
  as saved, from the interface, and the profile compiler resolves a card
  against the owner's number as written. Protection against a typo is a
  warning, not a clamp: the settings page shows a host-load note for a saved
  ceiling above 50 ("values this high put a real load on the host — make
  sure this is intended, not a typo"), and saving is never blocked. The
  agent card's limit field likewise accepts any whole number ≥ 1 and only
  rejects non-numbers. Settings documentation:
  [SETTINGS.md](SETTINGS.md) § PARALLEL-HELPERS.

## 1.6.0

### Telegram notifications (TG-NOTIFY-SETTINGS, part A: the settings core)

- The company-level settings that say what the board sends to the owner in
  Telegram: the daily digest, error notifications, inbound rules, escalations
  and head-bot proactivity, as ONE runtime-changeable contract
  (`packages/shared/src/myrmidon-telegram-notify.ts` — types and zod
  validators shared by the server and the UI). Storage without migration:
  the `myrmidonTelegramNotifySettings` key of `instance_settings.general`,
  company-keyed. API: `GET /api/myrmidon/telegram-notify` answers the full
  document (every field of every section always present), `PATCH
  /api/myrmidon/telegram-notify` applies a partial update; each changed
  field is recorded in a bounded changelog (200 entries) with the actor, the
  field path and the from/to values. Reads need company access; PATCH is
  board only. Every section defaults to OFF — with the defaults the owner
  keeps receiving only the replies to their own messages and the U2 decision
  cards; the parts that actually send (digest, errors, inbound, escalations,
  proactivity) consume this contract. No environment variables are added.

### CTO chat planner (CTO-CHAT B)

- The board chat planner: one owner message in free text
  (`POST /api/myrmidon/cto-chat/plan`, or the same planning step entered from
  the owner's Telegram DM bridge) becomes a proposed epic with child tasks and
  per-task acceptance criteria. The proposal is shown as the board's existing
  `suggest_tasks` approval card on the standing conversation task, and
  accepting the card is what creates the issues — nothing exists before
  acceptance, no assignee is inferred, and a rejected or expired card creates
  nothing. The planner is off unless `MYRMIDON_CTO_CHAT_BASE_URL` and
  `MYRMIDON_CTO_CHAT_KEY_SECRET` are set; the gateway key is a company secret
  read per call and never logged. The default model is the free
  `dashscope-qwen-flash`; one proposal is capped at 8 child tasks (hard
  ceiling 20) and one planning call is never retried. Operator guide:
  [guides/cto-chat-planner.md](guides/cto-chat-planner.md). The portal chat
  screen (part A) is below.

### CTO chat (CTO-CHAT)

- The Commander chat screen of the 2.0 shell (route `commander-chat`, reached
  from the rail, the phone bottom bar and the `Ctrl K` "Tell the Commander"
  palette with the typed draft carried over): the owner writes one free-text
  request, the screen calls the board chat planner
  (`POST /api/myrmidon/companies/:companyId/cto-chat/plan`) and renders the
  proposed epic read-only — the epic, every child task, acceptance criteria
  line by line. The pending `suggest_tasks` approval card from the standing
  Agent Chat issue renders through the existing card component; accepting
  the card creates the issues, rejecting creates nothing. The same flow is
  reachable from the owner's Telegram DM. Operator guide:
  [guides/commander-chat.md](guides/commander-chat.md).

### Reference-task evals (EVALS-A part A)

- The evals path: a seeded corpus of neutral reference tasks for the pilot
  role `engineer`, an LLM judge behind the company's LLM gateway (a free
  DashScope model by default, one chat-completions call per task, strict JSON
  parsing — an unparseable response scores zero with a `parseError` flag, not
  invented points), per-task rubric scoring with the CI pass rate folded in
  for `code` tasks, and a promote/confirm/regress verdict where a drop beyond
  the threshold is only actionable after a confirmation run repeats it. The
  judge never executes code. Scores live in `myrmidon_eval_runs`; the optional
  Langfuse export is off by default and never blocks local scoring. Reads are
  company-scoped, run mutations need a board actor, and an unconfigured
  contour answers `503` with the names of the missing settings. The verdict
  seam for the skill lifecycle (`candidate → verified → deprecated`, with
  rollback) is exposed as `POST …/evals/verdict`; the merged lifecycle module
  does not wire it to the board yet. Guide: [guides/reference-task-evals.md](guides/reference-task-evals.md).

### Stack update screen (STACK-UPDATES part C)

- The «Stack» screen in the panel (Company → Stack, route `/stack`): every
  component of the stack registry with our version/commit/digest (or an honest
  `unknown` with the reason), where it runs, the latest upstream release, the
  release lag, the notable security/breaking lines of the release notes as a
  collapsible excerpt and the patch-closed verdict per carried delta; lagging
  components sort first, with a name filter. *Refresh data* and *Check
  releases* run the instance-admin `POST /api/myrmidon/stack/refresh` /
  `POST /api/myrmidon/stack/check` from the screen — a failure, including the
  503 of a broken probe, is shown in place without losing the table. The
  *Schedule update* button on a lagging row opens a dialog with a default plan
  (versions, our patches, notable lines, canary then production, rollback) and
  creates an unassigned backlog draft task through the existing issue-creation
  route — nothing is deployed from the screen. The release check itself
  (part B: the schedule, the excerpt rules and the patch-closed verdict) and
  the registry API are documented in the same guide. Guide:
  [guides/stack-registry.md](guides/stack-registry.md).

### alibaba-image connector (1.6 deployment)

- Free image generation and editing for agents through the company's DashScope
  key: the `alibaba-image` connector container from the private deployment
  repository (tools `generate_image` and `edit_image`, registry-checked
  qwen-image/wan/z-image models, async submit-then-poll, results into the
  calling agent's workspace with a JSON sidecar, audit of argument
  sizes only). Operator guide — bringing the container up in the deploy window
  (port 8083, read-only key mount, shared workspace root), registering it as
  an external MCP server and granting it to the work designer, the bbq SMM and
  the designer agents, plus the per-family live smoke:
  [guides/alibaba-image-connector.md](guides/alibaba-image-connector.md).

### Stack update cycle documentation (STACK-UPDATES part D)

- The stack-updates overview document (EN + RU) for the whole release-watch
  cycle: where «ours» comes from per probe (health-commit, docker-image,
  container-labels, env, manual, none) and where «latest» comes from (the
  anonymous GitHub releases/tags read), how the lag is counted and why an
  unmatched local version reads `unknown`, the notable-lines excerpt rules,
  the patch-closed verdict (closed/open/unknown per carried delta through the
  compare API, with the aggregate), the daily sweep behind
  `MYRMIDON_STACK_CHECK_INTERVAL_SEC` and the manual check, the
  `stack_update` attention card with its dedup key, the unassigned backlog
  draft the planner creates, both settings and the network-down behavior
  (transport failure → 503 with the previous cache intact; a per-source HTTP
  error → a per-component unknown). The screen-by-column screen guide is
  referenced, not duplicated. Document: [stack-updates.md](stack-updates.md).

### Company regulations in the wiki (WIKI-CORTEX)

- Regulation pages with a draft → approved lifecycle, revisions and rollback:
  an edit of a draft or of an approved regulation appends a new DRAFT revision
  and the resolver keeps serving the newest APPROVED one, so writing text
  never changes what the fleet reads without an explicit board approval; a
  rollback is one more revision that copies an earlier one (append-only
  history, the restore is itself restorable). Draft writes are open to any
  actor with access to the company — the wiki maintainer agent writes drafts —
  while approve and rollback are board-only. The approved regulations that
  apply to a role reach the agents through the compiled bot profile: one
  deterministic workspace `REGULATIONS.md` beside the agent's own instruction
  files, where the profile hash decides whether a bot restarts (same approved
  revisions — same bytes — no restart; the file never shadows a
  `REGULATIONS.md` the agent's own bundle ships). Roles are plain role keys
  with `*` meaning every role. Operator guide — the API, the delivery
  mechanics and the wiki-maintainer runbook:
  [guides/wiki-regulations.md](guides/wiki-regulations.md).

### Autonomy matrix

- Role-by-action-class verdicts that say what an agent of a role may do on its
  own and what needs the board: the matrix is stored as company regulations
  with revisions and is served through a REST API. The «Autonomy matrix»
  settings screen shows and edits the matrix; every change is a new revision,
  so the previous verdicts stay readable and restorable.

### Swarm claims (SWARM-CLAIM)

- Part A, per-role task queues with leased claims: an agent takes the top task
  of its own role's queue behind a lease (TTL plus heartbeat) recorded in the
  new `issue_claims` table. The run's checkout writes the claim and a finishing
  run releases it; a sweep returns expired leases, and leases of tasks that
  left the queue, to the queue and wakes the next agent of the role. A
  per-agent active-task limit keeps one agent from taking the whole queue, and
  a P0 (critical) task preempts the normal queue order. The claim path is off
  until `MYRMIDON_SWARM_CLAIM_ENABLED` is turned on; the lease TTL, the active
  task ceiling and the sweep interval are `MYRMIDON_SWARM_LEASE_TTL_SEC`,
  `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` and
  `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC`.
- Part B, the supervisor view and the pilot report over claims and leases: the
  queue and lease state per role, and a window comparison against the frozen
  baseline snapshot. The release fallback now also writes the release reason.
  The supervisor settings (`MYRMIDON_SWARM_SUPERVISOR_TASK_MAX`,
  `MYRMIDON_SWARM_PILOT_BASELINE_DOC`) are documented in
  [SETTINGS.md](SETTINGS.md).

### Skill lifecycle (SKILL-LIFECYCLE)

- The company skill lifecycle `candidate → verified → deprecated`, with
  approval-gated promotion and rollback. A `candidate` skill reaches only the
  agents listed in `MYRMIDON_SKILL_PILOT_AGENTS`; a `verified` skill reaches
  everyone. With the variable unset the pilot set is empty, so a candidate
  reaches nobody.

### Foraging (FORAGING)

- A source registry per company, snapshot comparison of the sources, skill
  candidates drafted from what changed, a per-pass cost budget and a screen.
  Foraging ships DISABLED: no timer is armed and no source is read unless
  `MYRMIDON_FORAGING_ENABLED=1` is set; any other value keeps it off, so a
  typo cannot turn it on.

### Baseline metrics (BASELINE part A)

- Six board metrics computed from the task history over any window, by
  project and by executor role: cycle time (todo → done, mean, median, p90),
  time in review, return rate (in review → in progress), time blocked with the
  top reasons, runs per task and LLM cost per task. They are served by
  `GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to`. A periodic
  job, off unless `MYRMIDON_BASELINE_INTERVAL_SEC` is set, recomputes the last
  14 days per company and freezes one snapshot per pass in the additive
  `baseline_metric_snapshots` table, so a pilot can be compared with the
  measured «before». A failure of one company does not stop the others.

### Parallel helpers (PARALLEL-HELPERS)

- Agents can run parallel helper subagents. The agent card gets a «Parallel
  helpers» block: on/off, the maximum number of concurrent helpers within a
  company ceiling, and the helper model from the allow-list; a company default
  and a capacity hint sit beside it. The profile compiler writes the matching
  delegation section for bot containers. When neither the card nor the stored
  settings name a model, helpers run on `MYRMIDON_BOT_HELPER_MODEL`, or on the
  parent agent's model if that is unset.

### Quality and stack

- The Quality page: window metrics by project and by role, built on the
  baseline metrics above.
- The Stack screen's release lag, patch status and update planner (described
  in «Stack update screen» above) are documented in the stack guide, together
  with the LLM tracing card and the operator signal guide.

### Myrmidon 2.0 UI (behind `enableMyrmidonUi2`, off by default)

- The 2.0 shell and six re-skinned data screens, shown only when the
  `enableMyrmidonUi2` experimental flag is on; the denied lock fails closed
  and there is no client-side undo timer. A per-user board UI language (RU/EN)
  with catalogs and guards, an operator guide for the shell, and a fix of the
  i18n guard so that it accepts the flat re-skin catalog.

### Bot containers

- The run-bound GitHub broker capability is delivered to container runs of the
  gateway adapter; the token reaches only the agents listed in
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST`. Bot-side media scripts ship
  under `tools/media-mcp/bot-scripts`, with a hygiene pass over them.
- The `dwg_convert` media tool for container bots: DWG/DXF input converted to
  DXF, SVG or PDF through the media service, restoring the dwg2dxf/dwg2SVG
  capability the bots had on the host (the bot image stays free of CAD
  utilities; a separate bot image is forbidden by CONVENTIONS §8). The worker
  image builds LibreDWG from the pinned GNU release and adds an ezdxf venv for
  DXF round-trips (version bump R12…R2018 on DXF input) and SVG rendering;
  PDF output needs LibreOffice in the worker image and the base image refuses
  it honestly (render SVG instead). The tool is synchronous (300 s timeout)
  with the same per-bot gating, quotas and output accounting as the other
  media jobs; the config sample lists it in `tools`. Docs:
  [media-tools.md](media-tools.md) (#381).

### Deploy and release

- `rollback.sh --local` rolls back to a local image without pulling.
- The GitHub Release is now published by CI from the `myr-v*` tag, using this
  file's section for the tag's version.

### Fixes

- The Telegram DM status is one edited message with live progress steps
  instead of repeated «working…» messages.
- Maintenance: leaving windows always retire, the tick isolates windows from
  each other, and the owner chat never waits on it.
- Closing a channel-bound task by its assigned agent notifies the bound chat.
- No run is dispatched for a task whose delivering PRs all merged (the wake
  guard); its settings are `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_*`, and the
  settle sweep and the guard have an operator guide.
- The gateway adapter joins the idempotency-keyed adapters for infra-interrupt
  relief.
- Secrets are masked in comment edits, issue descriptions and documents.
- CI: five flaky tests were made deterministic, two real races behind them
  were fixed, and three tests that blocked unrelated PRs were deflaked.

### Upgrade notes

- Additive migrations 0289–0295 (among them 0294, the baseline metric
  snapshots, and 0295, the issue claims); no vendor table is modified.
- Every new setting is off or closed by default; see [SETTINGS.md](SETTINGS.md)
  before enabling any of them.

## 1.5.0

### Tracing health (TRACING-HEALTH)

- The "LLM tracing" status card in Company settings and the operator attention
  signal: the board reads the health report of the LiteLLM → Langfuse v4
  tracing pipeline (`GET /api/myrmidon/tracing/health`, part C) and surfaces
  it two ways. The card (below the Server console section) shows the dot and
  state (`ok` / `ok (idle)` / `red` / `unknown` / `not enabled`), the reason
  line, one null-aware line per evidence probe and the window span, refreshing
  once a minute. A periodic sweep (`MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC`,
  default 300 s, off with the check itself) evaluates the same report for
  every company and raises ONE attention card on the operator desk —
  `degraded` is high, `unknown` is medium, `ok`/`idle` raise nothing; the
  signal goes to the operator role, never the task owner. Dedup is by state:
  recovery clears the card without dismissal bookkeeping, and the journal gets
  one activity row per state transition only. Guide:
  [guides/tracing-health.md](guides/tracing-health.md).

### Client connectors (the browser bridge)

- The client connector gateway (EXTCASE-B): the board accepts an outbound
  WebSocket connection (`/bridge/v1`, JSON-RPC 2.0) from a browser extension on
  a client PC — the transport for platforms that exist only in the client's
  browser behind a local signing key. Pairing is a one-shot 15-minute code
  exchanged for a device-bound bridge token (only HMAC digests are stored,
  peppered by `MYRMIDON_BROWSER_BRIDGE_PEPPER`); revocation is fail-closed and
  drops the live socket. Every action is gated by the declared capability set
  and the company domain allowlist (checked at the gateway and again in the
  extension) and journaled — one row per action in the company activity log,
  page content never journaled. Signing follows the operator policy
  (`general.browserBridge.signing`: `enabled` / `auto` / `manual` / `types`)
  with a one-call emergency off; the signed bytes and the PIN never leave the
  client PC — the journal holds the document hash. Guide:
  [guides/browser-bridge-gateway.md](guides/browser-bridge-gateway.md).
- The connector panel (EXTCASE-PANEL), Company settings → Connectors: the
  device list with online status and capabilities, one-shot pairing codes shown
  once, revocation with confirmation, the domain allowlist, the signing policy
  with a daily signature limit per UTC day (the gateway refuses before the
  device is asked, `dailyLimitReached`) and the emergency stop, plus the bridge
  journal with filters (device, method, outcome, signatures only) and the
  document hash per signature. Guide:
  [guides/connector-panel.md](guides/connector-panel.md).
- The browser action primitives in the shipped extension (EXTCASE-D):
  `browser.fill` types a value into one field (input, textarea, select or a
  contenteditable node) and dispatches `input`/`change` so the page sees the
  change; `browser.download` fetches the file in the page's own session —
  the content script runs in the page's origin, so the request carries the
  browser's cookies — and returns its name, type, size and base64 bytes under
  a 25 MiB ceiling (`BROWSER_DOWNLOAD_MAX_BYTES`; a larger file is refused
  with `downloadTooLarge` before it crosses the bridge). An action the board
  marks `confirmation: "human"` runs only after a person on the client PC
  presses Confirm in the extension's confirm page: a refusal, the 180-second
  budget expiring — the gateway then sends the `browser.cancel` notification
  and the extension drops the pending step — or a build without the
  confirmation port is an `internalError` refusal (the step never reaches the
  confirmation flow), never a silent execution. The extension declares the `fill` and `download` capabilities and
  never `sign`. Site-specific selectors and recorded scenarios are built on
  top of these primitives and live outside the fork. Guide:
  [guides/bridge-extension.md](guides/bridge-extension.md).
- The signing host contract: a generic, client-free native-messaging contract
  for local signing helpers (`extension/src/native-host-contract.ts`) — a
  closed `actionType` enum (`sign` / `sign_and_submit` / `sign_attachment`), a
  document payload of bytes or a SHA-256 digest, a closed error-code set, and
  validators both sides compile against. A concrete helper (token middleware
  binding, PIN storage) is deployment-specific and lives outside the public
  fork. Guide:
  [guides/signing-host-contract.md](guides/signing-host-contract.md).

### OCR path

- `ocr.pdf` for every bot (EXT-CASE-OCR): a PDF received as a mail attachment
  or downloaded through the bridge is recognized into text in the bot
  workspace, with a structural excerpt for tender documentation (requirements,
  deadlines, positions). Backends: RAGFlow (MCP) or an OpenAI-compatible
  gateway (LiteLLM), selected by `MYRMIDON_OCR_BACKEND`; refusals carry stable
  codes and happen before the backend is contacted (size and page ceilings).
  The journal holds metadata only — never the text or the bytes. Guide:
  [guides/ocr.md](guides/ocr.md).

### External MCP connectors

- Any standards-compliant HTTP MCP server now plugs in without fork code
  through the vendor's generic connection surface (Apps → Connect an app →
  Connect your own MCP server, or Apps → Advanced → Paste a config):
  credentials become company secrets, per-agent grants default to deny, and
  tools arrive namespaced `mcp.<connection>:<tool>`. The operator runbook —
  entry points, grants, health checks, rotation:
  [guides/external-mcp-connectors.md](guides/external-mcp-connectors.md).

### UI 2.0 shell (flagged, UI-0a)

- The Myrmidon 2.0 shell behind the instance flag `enableMyrmidonUi2`
  (default off, Instance settings → Experimental → "Myrmidon UI 2.0 Shell"):
  a clean-room tree `ui/src/ui2/` — the 232px left rail, the top bar with the
  nest switcher, status chips and the "Tell the Commander" entry, and the
  390px phone frame (56px header + five-tab bottom bar). The 2.0 design-system
  tokens (`--myr-*`, light and dark) and the self-hosted Saira / Exo 2 / Inter /
  JetBrains Mono subsets land with it. Pages and routes stay shared with the
  1.x shell; turning the flag off restores it. The rail badge and status chips
  read the existing dashboard and sidebar-badges aggregates until the
  STATUS-STRIP endpoint exists. i18n keys `ui2.*` ship in en/ru (translated)
  and the other locales (English values until the translation pass). Operator
  guide: [guides/ui2-shell.md](guides/ui2-shell.md).
- The six re-skinned screens behind the same flag (Decisions, Costs, Agent
  overview, Runs and queue, System, Language) now render real data through
  the existing APIs — no new server endpoints. Each screen ships the full
  state set (skeleton, error with/without cache, empty, denied): a `403`
  answer renders the lock alone, never partial data. Decisions decide with
  option, inputs and an idempotency key; there is no client-side undo timer
  (the server-side hold is a later wave). Screen-by-screen details:
  [guides/ui2-shell.md](guides/ui2-shell.md).

### Task PR sync

- A task delivered by a pull request settles itself once its PRs merge
  (#315): a periodic sweep (`server/src/myrmidon/task-pr-sync/`, ships
  enabled) reads the task's own `pull_request` work products, refreshes each
  PR's state through the existing GitHub resolver, and closes the task with
  one neutral comment (PR refs, merge sha, time) when every PR is terminal
  with at least one merged and no post-deploy gate (a pending card, a pending
  approval or a future-scheduled monitor) is still open. Closed-without-merge
  PRs send the task back to its assignee; superseded PR rows are ignored. And
  the wake guard half (#339, post-1.5.0): an event-free wake to such a
  settle-pending task is skipped (reason `wake_skipped_pr_settle_pending`)
  instead of dispatching a run that would only race the settle. Operator
  guide: [guides/task-pr-sync.md](guides/task-pr-sync.md).

### Container GitHub access (CONTAINER-GITHUB-WRITE)

- An agent in a bot container can push to GitHub through the board's managed
  credentials (#363): when a run's GitHub identity is board-managed (the
  default, see `MYRMIDON_HOST_GITHUB_CREDENTIALS` in
  [SETTINGS.md](SETTINGS.md)), the heartbeat mints a run-bound
  `github_credentials` capability, and the `hermes_gateway` adapter now
  carries it to the container — the pair rides the `/v1/runs` request body
  (`github_broker`), is bound to that run alone (contextvars, never the
  process env shared by the gateway's concurrent runs) and reaches every
  terminal and `execute_code` subprocess of the run as
  `PAPERCLIP_GITHUB_BROKER_URL`/`PAPERCLIP_GITHUB_BROKER_TOKEN`. Inside the
  container, the dev image's `git` credential helper (URL-scoped to
  `github.com` over https, `ssh://git@github.com/…` remotes rewritten to
  https) and its `gh` wrapper resolve the credential on each invocation
  through the board's `POST /runtime-tools/github/credentials` broker and
  exec the real `git`/`gh`; the wrappers walk up to 6 broker address
  candidates (`PAPERCLIP_GITHUB_BROKER_URL` → `PAPERCLIP_API_URL` →
  `PAPERCLIP_RUNTIME_API_URL` → `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON`
  items) and never print the token. A run without a capability — or a card
  whose GitHub identity is not board-managed — gets both names stripped and
  the wrappers fail open, exactly as before this change. A static
  `GH_TOKEN`/`GITHUB_TOKEN` inherited from the image profile no longer
  shadows the credential: while a capability is bound, those names are
  blanked in the run's subprocesses. This closes the gap that motivated
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` (see SETTINGS.md): the
  allowlist remains a fallback for dev bots on machines where the board's
  broker address is genuinely unreachable.

## 1.4.0

Everything merged between the 1.3.2 and 1.4.0 tags. Deploy this release's board,
dockergate and fleetd images together (see [deploy.md](deploy.md#deploy-the-board-and-the-release-components-together)).

### Memory and isolation

- "Memory" tab on the agent card (MEMORY-UI, plan 1.4 item 1): view, export (JSON)
  and removal of the entries of the agent's memory bank — resolved by the same bank
  rule the memory plugin fork applies. Removing one entry is reversible (invalidation
  with a reason); clearing the whole bank sits behind a typed confirmation; every
  action writes an activity log row. The section is enabled by the
  `MYRMIDON_HINDSIGHT_API_URL` + `MYRMIDON_HINDSIGHT_KEY_SECRET` pair.
  Guide: [guides/agent-memory-card.md](guides/agent-memory-card.md) (#258, #265).

### Cloud storage

- CLOUD-CONNECTOR part B: the owner connects a cloud from the panel — the connector
  builds the provider's authorization URL with a single-use state and PKCE, exchanges
  the code, and keeps the resulting token bundle in a company secret of the instance
  secret store. Only the secret id stays in the connector's own state, so no bot ever
  holds a cloud token and the token value never travels through the panel API (#252).

### Owner questions and instructions

- U2: question and confirmation cards (`ask_user_questions`, `request_confirmation`)
  reach the owner's Telegram DM when the company runs the Telegram DM bridge
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) — the card is also answered from Telegram,
  including a callback that arrives for a task the authoring agent no longer owns.
  A task with its own live chat binding keeps its card in that conversation only.
  Guide: [guides/owner-telegram-cards.md](guides/owner-telegram-cards.md) (#277, #284, #287).
- H2: every change to an agent's instructions bundle (file put, file delete, patch)
  is snapshotted into the append-only `agent_instructions_revisions` history, and any
  earlier revision can be restored through the API — the restore itself becomes a new
  revision. Guide: [guides/agent-instructions-revisions.md](guides/agent-instructions-revisions.md) (#273, #299).

### Deploy and reliability

- Automatic rollback by health for the board and the bot fleet (R5-C). A failed
  health check after a deploy no longer leaves the board or the touched bots on the
  broken image. Board: the job moves to `rolling_back` and the host executor runs
  `rollback.sh` to the image the deploy remembered before the switch; the job ends
  `auto_rolled_back` (maintenance window closed) or `failed_rollback` (window kept
  for the operator). Bots: a failed canary or wave bot moves the rollout to
  `rolling_back`; every bot that received the new image gets its own card image
  re-applied, one at a time, and the rollout ends `rolled_back` with the original
  failure reason kept. Switches (both on by default): `MYRMIDON_DEPLOY_AUTO_ROLLBACK`
  for the board, `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` for the fleet; the host side
  of the board switch is `AUTO_ROLLBACK` in `deploy.env`, both sides must agree.
  Unattended auto-update stays off (`MYRMIDON_DEPLOY_AUTO_UPDATE=0`); see
  [SETTINGS.md](SETTINGS.md) (#261).
- Heartbeat: a queued-run start that re-enters the agent start lock no longer waits
  for itself. The lock body now runs in an async-context frame per agent, so a
  nested start from the same chain skips the wait and no longer stalls for
  `AGENT_START_LOCK_STALE_MS` (30 s) on every cancellation that promotes a queued
  run (#174).
- RELEASE-GATE: the board and the release's component images deploy together,
  enforced by the deploy script itself. `deploy.sh` resolves the dockergate and
  fleetd digests of the SAME release (the `myr-vX.Y.Z` tag from the board image
  version label, else the `sha-<short>` tag of its commit) and refuses a release
  whose components are missing from the registry before anything changes — the
  01.10 incident deployed the board alone while production dockergate still
  rejected the new `maxConcurrentRuns` marker key and every bot apply was denied
  for ~40 minutes. Each component now rolls out in the same run with its own
  health probe (`MYR_<COMPONENT>_HEALTH_URL`), and a post-deploy smoke
  (`bot-apply-smoke.sh`) waits for at least one bot container to re-apply, else
  the deploy reports DEGRADED with the rollback commands
  (`rollback-component.sh` per component). CI gained the applied-marker contract:
  the markers `serializeAppliedMarker()` writes are emitted from the server code
  of every commit and fed through the dockergate validator, so a marker the
  validator would deny turns CI red before any image exists (#276).
- AUTO-RESUME: the board itself resumes an agent left in `error` by a failed
  run — a sweep on the scheduler tick with a backoff of 1, 5 and 15 minutes,
  reusing the pause/resume wake chain so the resumed agent also wakes the work
  it was stranded on. After `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` (default 3)
  failed resumes the board stops and escalates the agent's `agent_error_alert`
  card on the attention desk to severity `critical`; the operator's resume
  re-arms the counter. State lives in `agents.metadata.myrmidon_auto_resume`
  (no migration), every action writes an activity log row
  (`agent.auto_resume_issued` / `agent.auto_resume_exhausted`). Settings:
  `MYRMIDON_AUTO_RESUME_*` in [SETTINGS.md](SETTINGS.md); guide:
  [guides/auto-resume.md](guides/auto-resume.md) (#272).

### Telegram

- Telegram DM run status and inline split (U1). In a bridged Telegram DM
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) a run can now show its "working on
  it" status as one editable message instead of milestone silence: the status
  is posted once when the run is queued, the same provider message is edited
  in place as the phase changes, and the run's final answer replaces it —
  the failure, admin-attention and completion milestones still publish, and
  the `/stop` terminal milestone stays suppressed. Separately, a long
  structured Markdown answer that the vendor sends as one `.md` attachment
  can split inline into ordered parts at paragraph/line/word boundaries.
  Both behaviors are opt-in and off by default:
  `MYRMIDON_TELEGRAM_DM_STATUS` and `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` (a
  document needing more parts than the cap stays an attachment); see
  [SETTINGS.md](SETTINGS.md) and the guide
  [guides/telegram-dm-status.md](guides/telegram-dm-status.md) (#267, #313).

## 1.3.2

Everything merged between the 1.3.1 and 1.3.2 tags. Deploy this release's dockergate image
together with the board.

### Bot containers

- The reconciler no longer recreates bot containers whose template never changed. dockergate
  trimmed `HostConfig.Binds` out of the container inspect (A2) while the driver's template-drift
  check compared it, so every bot counted as drifted on every pass: production recreated all 51
  bots every 17–20 minutes, interrupting every run in flight. The A2 answer carries the bind list
  again, and a gate contract test checks that every field the drift check compares survives the
  trim (the field list is emitted from the driver's code, not hand-copied) (#253).
- Every drift writes an activity line naming the field and both values
  (`bot container template drift detected`, `details.fields`), so it is diagnosable from the log
  alone instead of costing another incident (#253).
- The state-DB descriptor probe on the gateway write path is bounded: the WAL/SHM generation
  check now has a budget, so a slow or stuck filesystem no longer stalls every bot write (#240).
- Bot image development variant: a third build target with a repository-cycle toolchain is
  available for development work (#238).

### Interface

- Live browser screen console core: the owner watches and drives the live browser that bots
  authorize in. Registry, screen sessions with safe timers, a two-contour bot pause, the
  session journal and site-data cleanup. See [guides/browsers.md](guides/browsers.md) (#210).
- Access hub server core: the server module for the Access section (secrets, grants, rotation,
  SSH keys) is merged. See [guides/access-hub.md](guides/access-hub.md) (#235).
- Stack registry guide: the seeded component list, `GET /api/myrmidon/stack` and
  `POST /api/myrmidon/stack/refresh`, the cache and the Docker socket setting. See
  [guides/stack-registry.md](guides/stack-registry.md) (#243).
- Access-hub guide aligned with the merged server module (#249).

### Cloud storage

- Owner-authorized cloud storage with per-agent folder grants: the owner connects one account
  per provider, keeps a list of reachable folders and grants them to an agent, a caste or
  everyone with a read-only or read-write mode. OneDrive provider and API under
  `/api/myrmidon/cloud-connector`. See [guides/cloud-files-connector.md](guides/cloud-files-connector.md)
  (#245).

## 1.3.1

Everything merged between the 1.3.0 and 1.3.1 tags. The release replaces 1.3.0 and ships
the two fixes 1.3.0 lacks.

### Bot containers

- dockergate accepts the applied-profile marker with the optional `maxConcurrentRuns` key
  (integer 1–50) that the board writes since CONCURRENCY-SYNC. The 1.3.0 dockergate
  demanded exactly three keys and refused every bot-container profile apply with
  `tar_content` (`applied_json`), which stops the whole fleet on a fresh install. Deploy
  this release's dockergate image together with the board; a hand-swapped dockergate image
  is no longer needed. See [dockergate.md](dockergate.md#the-applied-profile-marker) (#228).
- Canary rollout for the bot image: a new bot image is applied to a single canary bot
  first, its health (Docker HEALTHCHECK plus a settle window) and a smoke run against the
  canary gateway are verified, and only then do waves of `MYRMIDON_BOT_CANARY_WAVE_SIZE`
  (default 4) bots follow, one bot at a time. A failed canary stops the rollout without
  touching the rest of the fleet; a rollout can be aborted. Routes:
  `GET/POST /api/myrmidon/bot-canary[/preview|/:id/abort]` (reads: board; writes: instance
  admin). Everything is off by default (`MYRMIDON_BOT_CANARY`). Design:
  [design/bot-canary.md](design/bot-canary.md) (in Russian) (#222).
- Bot settings resolve per fleet host: a `MYRMIDON_FLEET_HOSTS` record can override the
  hindsight URL, the LLM gateway base URL, the board's extra host name, the volume root,
  the bot network and the image allowlist for the bots placed on that host; a field absent
  from the record takes the instance value. See [SETTINGS.md](SETTINGS.md) (#225).
- New guide: [guides/bot-container-card.md](guides/bot-container-card.md) — the agent
  card's Container section, the concurrent runs limit and the applied-profile marker
  (#219).
- The card read is reconciled at pass time, not at the sweep's snapshot (#237).

### Database

- The chat and recovery hot sweeps compare uuid columns as uuid-typed, guarded values
  instead of text. A text-cast column cannot use its primary-key index, so every sweep
  scanned the whole table; on production that drove the board database to 300–400 % CPU.
  No new indexes are needed — the comparisons are served by the primary-key indexes (#227).
- Migration `0286` drops the ad-hoc operator expression indexes
  `myr_hotfix_issue_comments_id_text`, `myr_hotfix_wakeup_id_text` and
  `myr_hotfix_heartbeat_runs_id_text`, created outside the migration history to stop the
  bleeding. They are no longer needed once the predicates are typed (#227).

### Interface

- "About Myrmidon" section in Instance → General (release version, commit, build date,
  image digest when set, the Paperclip base version, license and links) and a release
  version line in the sidebar footer. The data comes from the new route
  `GET /api/myrmidon/about` (board/agent; anonymous gets 403) (#216).
- Fleet server console: a company owner opens a terminal to a registered fleet server in
  the browser (Guacamole with a signed auth JSON). New routes
  `GET/PUT /api/myrmidon/fleet/servers`, `POST /api/myrmidon/fleet/console-token`,
  `POST /api/myrmidon/fleet/console-sessions/close`; the servers live in the new table
  `myrmidon_fleet_servers` (migration `0287`). The section is on the company settings
  page. Design: [design/server-console.md](design/server-console.md) (in Russian) (#232).
- Per-agent LLM gateway keys (`POST /api/myrmidon/companies/<companyId>/litellm/keys/<agentId>`,
  `…/rotate`; `GET` returns only the secret name and the value's sha256; issue/rotate is
  board-only) and a cycle check of the fallback model chains when an agent card is saved
  (#233).

### Reliability

- An undelivered agent-to-agent card no longer dies from the task status flip: the card is
  delivered once before the terminal transition finalizes it (#234).
- Stack registry core: `GET /api/myrmidon/stack` serves the seeded component list with its
  local state (version/commit/digest or an honest "unknown"), and
  `POST /api/myrmidon/stack/refresh` (instance admin only) rebuilds the cache from what
  the board process can see; a failed infrastructure probe keeps the previous cache and
  answers 503. See [guides/stack-registry.md](guides/stack-registry.md) (#212).
- Guides: the access-hub guide gained the availability notice (#214).

## 1.3.0

The 1.3 feature release: bot containers on fleet hosts, the deploy of the board from the
interface, maintenance windows, the operator guides set and the groundwork listed in
[ROADMAP.md](ROADMAP.md). The full entry list is in the git history between the 1.2.1 and
1.3.0 tags. Two defects shipped in this release are fixed by 1.3.1: the dockergate marker
refusal (#228) and the database hot-path scans (#227).

## 1.2.1

Everything merged between the 1.2.0 and 1.2.1 tags.

### Memory and isolation

- Local fork of the hindsight memory plugin (`packages/plugins/hindsight-paperclip`, same plugin
  id `paperclip-plugin-hindsight`, version `0.3.0-myrmidon.1`): each agent's memory resolves to
  its own bank from the card's `adapterConfig.hindsight.bankId` or the configuration's
  `bankByAgentId` map. An agent without a bank is closed: retain is skipped with a warning and
  recall returns nothing — there is no fallback bank. Retain metadata now carries the agent
  name. Install and upgrade from the repository path; CI gained the fork's test lane and
  host-side install checks (#150).

### Bot containers

- Bot Node.js image: `/scratch/npm-global/bin` is off `PATH` — a writable volume on `PATH` let
  a bot plant a binary, and the dockergate image contract rejects it. The preinstalled packages
  in `/opt/node-tools` are unaffected; the Dockerfile test now checks every stage's `PATH`
  against the dockergate policy (#167).

### Interface

- Myrmidon favicon everywhere: worktree-preview instances draw the Myrmidon ant instead of the
  vendor paperclip, and tab icons and the web manifest are served with no-cache so browsers
  revalidate them (#166).

### Internal

- The agent-assigned MCP tool set moved from `heartbeat.ts` into its own module
  (`agent-assigned-tools.ts`) with no behaviour change, so heartbeat and the bot-container
  profile compiler resolve the same assignment from one place (#120).

## 1.2.0

Everything merged after the 1.1.0 tag, including fixes that were never tagged on their own.

### Bot containers

- Per-bot board tool gateway: container bots reach the board through their own scoped gateway.
- Shared media tools MCP service for container bots, with fixes for filter-escape injection,
  job-directory quota counting, streamed conversions and spool ownership.
- `dockergate`: an allowlisting Docker proxy for bot containers.
- Bot image: Node.js variant (`runtime-node`), an ssh client, and a venv interpreter present
  for the bot user.
- Bot board API keys are issued with a responsible user.
- Configurable run-create timeout for the hermes gateway (default 60 s).
- Container startup feedback in the server tests no longer needs a real container.

### Memory and isolation

- Hindsight bank allowlist and observation scopes in bot profiles, plus a tool to split
  banks when transferring memory.
- Plugin `apiRoute` calls are bound to an invocation scope.

### Wakes and heartbeat

- Emergency stop for the runs a draining pause left finishing: the agent detail page shows a
  banner with a confirm-and-stop button while the agent is paused and live runs remain, and
  `POST /api/myrmidon/agents/:id/emergency-stop` cancels them immediately with the same
  `agent_paused` code a pause-cancel uses — the agent's own status is untouched (#173). Operator
  guide: [guides/emergency-stop.md](guides/emergency-stop.md).
- Continuation wakes: age-threshold sweep and direct-delivery settlement fixed.
- Tasks stranded by an operator pause are woken in batches when the pause is lifted.
- Configurable cap on cross-issue influence.
- Heartbeat logs an unreadable cgroup memory limit; the cap is documented.
- Kill-switch flag semantics are covered by a test matrix and a docs guard; documented that the
  L2 budget carry is L1-only and that the vendor retry budget restarts at the successor.

### Deploy

- Deploy lifts maintenance mode when the drain times out.
- Documented that database migrations must be additive-only.

### Process

- Plan intake procedure and text scanner for plan entries.
- Publish scan wrapper for PR and issue text.