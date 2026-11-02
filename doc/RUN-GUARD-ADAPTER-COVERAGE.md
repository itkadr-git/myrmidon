# Run Guard Circuit Breakers & Adapter Coverage

RunGuard enforces three runtime safety circuit breakers on agent heartbeat executions:
1. **Model Call Limit (`model_call_limit`)**: Limits provider model requests to prevent runaway token expenditure.
2. **Idle Timeout (`idle_timeout`)**: Halts executions that produce no board/model activity within the timeout deadline.
3. **Repeated Tool Failure Loop (`tool_retry_loop`)**: Stops runs repeating identical failing tool invocations.

---

## 1. Configuration & Precedence

Default limits:
- Model call limit: **150** provider model requests (calls 1..N permitted; N+1 blocked before dispatch).
- Idle timeout: **20 minutes** (1,200,000 ms).
- Repeated tool retry limit: **3** consecutive identical tool failures.

### Hierarchy of Configuration

Limits are resolved via `resolveRunGuardOptions` in the following priority order:
1. **Agent Configuration (`agent.adapterConfig.runGuard` or flat fields)**:
   - `modelCallLimit` (number)
   - `idleTimeoutMs` or `idleTimeoutSec` (number)
   - `toolRetryLimit` (number)
2. **Team Liveness Settings (`teamLiveness.settings.runGuard` or flat fields)**:
   - `modelCallLimit` (number)
   - `idleTimeoutMs` or `idleTimeoutSec` (number)
   - `toolRetryLimit` (number)
3. **Environment Variables**:
   - `MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT`
   - `MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_MS` / `MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_SEC`
   - `MYRMIDON_RUN_GUARD_TOOL_RETRY_LIMIT`
4. **Defaults**: 150 calls / 20 min / 3 retries.

---

## 2. Adapter Coverage Matrix

| Adapter | Model Call Limit | Idle Timeout (with Quiet Tool Pause) | Tool Retry Loop (Deduplicated) | Notes |
|---|:---:|:---:|:---:|---|
| **Hermes Gateway** (`hermes_gateway`) | **Full** | **Full** | **Full** | Discrete provider requests counted across tool boundaries (`message.delta`, `reasoning.available`, `model.request`). Idle paused while tools run (`tool.started` to `tool.completed`). Argument redaction in signature. |
| **ACPX Engines** (`claude`, `codex`, `kimi`, etc.) | **Full** | **Full** | **Full** | Counts model generation steps per tool cycle. Idle paused on in-progress tools. Deduplicates repeated failed tool events by `toolCallId`. |
| **Kimi Local** (`kimi_local`) | Partial (Heartbeat) | Partial (Heartbeat) | **Full** | Hooks tool failure events into RunGuard. |
| **Legacy / Other Adapters** | Partial (Heartbeat) | **Full** (Heartbeat Watchdog) | N/A | Heartbeat watchdog monitors activity; terminal stop reasons (`model_call_limit`, `idle_timeout`, `tool_retry_loop`) complete the run with clean error code and no manual reconciliation hold. |

---

## 3. Tool Lifecycle & Quiet Execution Semantics

- **Quiet Tool Execution**: When an agent executes a long compilation, test suite, or shell tool without intermediate board events, the idle timer is paused via `guard.pauseIdle()`.
- **Resume on Completion**: Once all active tools finish, `guard.resumeIdle()` restarts the deadline from the tool completion timestamp. A 25-minute quiet tool run completes cleanly without being killed by the 20-minute idle limit.
- **Deduplicated Failures**: Streaming backends emitting multiple failed status updates for the same `toolCallId` are deduplicated, ensuring identical tool call retries only count once per invocation attempt.

---

## 4. Run Completion & Recovery Semantics

- RunGuard stops abort the active execution signal and terminate the run with `runErrorCode` set to the stop reason (`model_call_limit`, `idle_timeout`, or `tool_retry_loop`).
- `legacyExecutionNeedsReconciliation` returns `false` for RunGuard stop codes. The task is **not** placed in a manual reconciliation hold; it remains assigned to the engineer, and the next wake is an ordinary heartbeat without auto-replaying the same revision.
