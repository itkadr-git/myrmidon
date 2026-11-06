# Run Guard Circuit Breakers & Adapter Coverage

RunGuard enforces five runtime safety circuit breakers on agent heartbeat executions:
1. **Model Call Limit (`model_call_limit`)**: Limits provider model requests to prevent runaway token expenditure.
2. **Idle Timeout (`idle_timeout`)**: Halts executions that produce no board/model activity within the timeout deadline.
3. **Repeated Tool Failure Loop (`tool_retry_loop`)**: Stops runs repeating identical failing tool invocations.
4. **Read-only Exploration (`no_progress_exploration`)**: Stops a run after N consecutive read-only tool calls with no write in between.
5. **Repeated Tool Call (`repeated_tool_call`)**: Stops a run the Nth time the same read-only call (same tool, same argument) is made without a write in between.

---

## 1. Configuration & Precedence

Default limits:
- Model call limit: **150** provider model requests (calls 1..N permitted; N+1 blocked before dispatch).
- Idle timeout: **20 minutes** (1,200,000 ms).
- Repeated tool retry limit: **3** consecutive identical tool failures.
- Read-only exploration limit: **40** consecutive read-only tool calls (`0` = off).
- Repeated tool call limit: **3** identical read-only calls since the last write (`0` = off).

### Hierarchy of Configuration

Limits are resolved via `resolveRunGuardOptions` in the following priority order:
1. **Agent Configuration (`agent.adapterConfig.runGuard` or flat fields)**:
   - `modelCallLimit` (number)
   - `idleTimeoutMs` or `idleTimeoutSec` (number)
   - `toolRetryLimit` (number)
   - `noProgressLimit` (number, `0` disables)
   - `repeatedToolCallLimit` (number, `0` disables)
2. **Team Liveness Settings (`teamLiveness.settings.runGuard` or flat fields)**:
   - `modelCallLimit` (number)
   - `idleTimeoutMs` or `idleTimeoutSec` (number)
   - `toolRetryLimit` (number)
   - `noProgressLimit` (number, `0` disables)
   - `repeatedToolCallLimit` (number, `0` disables)
3. **Environment Variables**:
   - `MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT`
   - `MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_MS` / `MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_SEC`
   - `MYRMIDON_RUN_GUARD_TOOL_RETRY_LIMIT`
   - `MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT`
   - `MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT`
4. **Defaults**: 150 calls / 20 min / 3 retries / 40 read-only calls / 3 repeats.

---

## 2. Adapter Coverage Matrix

| Adapter | Model Call Limit | Idle Timeout (with Quiet Tool Pause) | Tool Retry Loop (Deduplicated) | Notes |
|---|:---:|:---:|:---:|---|
| **Hermes Gateway** (`hermes_gateway`) | **Full** | **Full** | **Full** | Discrete provider requests counted across tool boundaries (`message.delta`, `reasoning.available`, `model.request`). Idle paused while tools run (`tool.started` to `tool.completed`). Argument redaction in signature. Read-only exploration and repeated-call stops are fed by `tool.started` (tool name plus the event's `preview`, see section 5). |
| **ACPX Engines** (`claude`, `codex`, `kimi`, etc.) | **Full** | **Full** | **Full** | Counts model generation steps per tool cycle. Idle paused on in-progress tools. Deduplicates repeated failed tool events by `toolCallId`. Read-only exploration and repeated-call stops are **not** fed (tool titles only, no classifiable arguments). |
| **Kimi Local** (`kimi_local`) | Partial (Heartbeat) | Partial (Heartbeat) | **Full** | Hooks tool failure events into RunGuard. |
| **Legacy / Other Adapters** | Partial (Heartbeat) | **Full** (Heartbeat Watchdog) | N/A | Heartbeat watchdog monitors activity; terminal stop reasons (`model_call_limit`, `idle_timeout`, `tool_retry_loop`, `no_progress_exploration`, `repeated_tool_call`) complete the run with clean error code and no manual reconciliation hold. |

---

## 3. Tool Lifecycle & Quiet Execution Semantics

- **Quiet Tool Execution**: When an agent executes a long compilation, test suite, or shell tool without intermediate board events, the idle timer is paused via `guard.pauseIdle()`.
- **Resume on Completion**: Once all active tools finish, `guard.resumeIdle()` restarts the deadline from the tool completion timestamp. A 25-minute quiet tool run completes cleanly without being killed by the 20-minute idle limit.
- **Deduplicated Failures**: Streaming backends emitting multiple failed status updates for the same `toolCallId` are deduplicated, ensuring identical tool call retries only count once per invocation attempt.

---

## 4. Run Completion & Recovery Semantics

- RunGuard stops abort the active execution signal and terminate the run with `runErrorCode` set to the stop reason (`model_call_limit`, `idle_timeout`, `tool_retry_loop`, `no_progress_exploration`, or `repeated_tool_call`).
- `legacyExecutionNeedsReconciliation` returns `false` for RunGuard stop codes. The task is **not** placed in a manual reconciliation hold, and the same revision is **not** replayed automatically: the issue goes to `blocked` with a comment (section 6), and the next wake is the one a new comment or an explicit unblock causes.

---

## 5. Read-only Exploration and Repeated Calls

`RunGuard.toolStarted(name, args)` is called for every tool start the adapter sees. It classifies the call and keeps two counters, neither of which retains arguments (only a hash of tool name plus argument is kept, and only for read-only calls):

- **Consecutive read-only calls.** `search_files`, `read_file`, `skill_view`, `read_stale_tool_result`, and `terminal` commands in which every command is one of `sed` (without `-i`), `grep`/`egrep`/`fgrep`/`rg`, `cat`, `ls`, `find` (without `-exec`/`-delete`/...), `head`, `tail`, `wc`, `git log|show|diff|status`, optionally joined by `|`, `&&`, `||`, `;` and preceded by `cd`. The streak is reset by **any other call**: `patch`, `write_file`, `execute_code`, any other tool, any other terminal command (`git commit`, `git push`, `git apply`, `gh pr ...`, `curl -X POST|PATCH|PUT`, test runs, ...), and any command with an output redirection (other than to `/dev/null`) or command substitution. At the limit (default 40) the run stops with `no_progress_exploration`.
- **Repeats.** The same read-only call (same tool, same argument) seen the Nth time (default 3) since the last write stops the run with `repeated_tool_call`. A write clears the repeat counts, so re-reading a file after changing it is not a repeat. Terminal commands outside the read-only list are never counted as repeats.

The hermes gateway `tool.started` event carries only the tool name and a short `preview` string of the primary argument (for `terminal` the command line). That string is what is hashed and inspected, so two calls that differ only in arguments the preview does not show (for example the line range of a `read_file`) look identical. Raise `repeatedToolCallLimit` or set it to `0` for an agent that legitimately re-reads such calls.

## 6. After a Guard Stop: No Automatic Retry

A run stopped by any guard reason is never retried by the board:

- the five reasons are listed as permanent failures in the run retry taxonomy (`PERMANENT_RUN_FAILURE_ERROR_CODES`), so the stranded-issue sweep escalates instead of continuing;
- `scheduleBoundedRetryForRun` and the stranded-recovery enqueue refuse a guard-stopped predecessor, whoever asks;
- when the run ends, the assignee's `todo` / `in_progress` / `in_review` issue is moved to `blocked` through the stranded-recovery escalation with a system comment: why the run was stopped, the number of calls made without a write, that a new input (clarify or split the task) is needed, and that no automatic retry follows.

Maintenance interruptions (`myrmidon_maintenance_interrupted`) and transport failures (`hermes_gateway_connect_failed`, rate limits) are not guard stops and keep their own retry paths.

