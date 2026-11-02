import { expect, it, vi } from "vitest";
import {
  RunGuard,
  resolveRunGuardOptions,
  toolFailureSignature,
  type AdapterExecutionContext,
} from "@myrmidon/adapter-utils";
import { emitRuntimeEventForTest } from "@myrmidon/adapter-utils/acpx-engine/execute.js";
import { execute as executeHermesGateway } from "@myrmidon/hermes-paperclip-adapter/gateway/server";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";
import {
  buildHeartbeatRunStopMetadata,
  inferHeartbeatRunStopReason,
  mergeHeartbeatRunStopMetadata,
} from "./heartbeat-stop-metadata.js";
import { decideReleaseRecovery, type ReleaseRecoveryFacts } from "../modules/wake-queue/domain/policy.js";
import { MAINTENANCE_INTERRUPT_ERROR_CODE } from "../myrmidon/maintenance/domain.js";

const runGuardReasons = ["model_call_limit", "idle_timeout", "tool_retry_loop"] as const;

it.each(runGuardReasons)("does not hold guard-stopped %s runs in reconciliation", (reason) => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status,
      errorCode: reason,
      scheduledRetryAttempt: 0,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status,
      errorCode: "cancelled",
      scheduledRetryAttempt: 0,
      resultJson: { runGuardStopReason: reason },
    })).toBe(false);
  }
});

it("pauses the idle deadline during an active quiet tool run for 25 minutes", async () => {
  vi.useFakeTimers();
  try {
    const guard = new RunGuard({ idleTimeoutMs: 20 * 60 * 1000 });
    const onIdle = vi.fn();
    guard.startIdleWatch(onIdle);

    // Active tool starts: idle timer is paused
    guard.pauseIdle();

    // 25 minutes elapsed during quiet tool execution (exceeding 20 minute limit)
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(guard.idle().stop).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();

    // Tool completes: idle timer resumes
    guard.resumeIdle();
    expect(onIdle).not.toHaveBeenCalled();

    // Another 19 minutes of silence: still not timed out
    await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
    expect(guard.idle().stop).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();

    // Reaching 20 minutes of silence after tool completion: triggers idle_timeout
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(guard.idle().stop).toBe(true);
    expect(onIdle).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("pauses gateway idle timeout during a 25-minute quiet tool execution without false idle trigger", async () => {
  vi.useFakeTimers();
  try {
    const guard = new RunGuard({ idleTimeoutMs: 20 * 60 * 1000 });
    const onRunGuardStop = vi.fn(async () => undefined);
    const ctx: AdapterExecutionContext = {
      runId: "quiet-tool-run",
      agent: { id: "agent-test", companyId: "company-test", name: "test", adapterType: "hermes_gateway", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-test" },
      config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test", timeoutSec: 10, sessionKeyStrategy: "run" },
      context: { issueId: "issue-test" },
      runGuard: guard,
      onRunGuardStop,
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
    };

    const newline = String.fromCharCode(10);
    const startSse = [
      `event: tool.started`,
      `data: ${JSON.stringify({ tool: "bash", preview: "make long-build" })}`,
      "", "",
      `event: run.completed`,
      `data: ${JSON.stringify({ status: "completed", output: "done" })}`,
      "", "",
    ].join(newline);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "quiet-tool-gateway-run", status: "started" }), { status: 200 });
      if (url.includes("/events")) return new Response(startSse, { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }));

    await executeHermesGateway(ctx);

    // Tool started -> idle is paused
    expect(guard.isIdlePaused()).toBe(true);

    // 25 minutes of quiet tool execution
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(guard.idle().stop).toBe(false);
    expect(onRunGuardStop).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("deduplicates repeated failed tool call updates by callId through production emitRuntimeEvent", async () => {
  const guard = new RunGuard({ toolRetryLimit: 3 });
  const onRunGuardStop = vi.fn(async () => undefined);
  const ctx = {
    runId: "dedupe-run",
    agent: { id: "agent-1", companyId: "comp-1", name: "test", adapterType: "acpx", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-1" },
    config: {},
    context: {},
    runGuard: guard,
    onRunGuardStop,
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  } as unknown as AdapterExecutionContext;

  const args = { file: "test.ts" };
  // First failed event for call-1: count 1
  await emitRuntimeEventForTest(ctx, {
    type: "tool_call",
    toolCallId: "call-1",
    status: "failed",
    title: "patch",
    input: args,
  } as any);
  expect(guard.stats().toolRetryCount).toBe(1);
  expect(onRunGuardStop).not.toHaveBeenCalled();

  // Duplicate failed events for SAME call-1: deduplicated by emitRuntimeEvent, count remains 1
  await emitRuntimeEventForTest(ctx, {
    type: "tool_call",
    toolCallId: "call-1",
    status: "failed",
    title: "patch",
    input: args,
  } as any);
  await emitRuntimeEventForTest(ctx, {
    type: "tool_call",
    toolCallId: "call-1",
    status: "failed",
    title: "patch",
    input: args,
  } as any);
  expect(guard.stats().toolRetryCount).toBe(1);
  expect(onRunGuardStop).not.toHaveBeenCalled();

  // Second failure for call-2: count becomes 2
  await emitRuntimeEventForTest(ctx, {
    type: "tool_call",
    toolCallId: "call-2",
    status: "failed",
    title: "patch",
    input: args,
  } as any);
  expect(guard.stats().toolRetryCount).toBe(2);
  expect(onRunGuardStop).not.toHaveBeenCalled();

  // Third failure for call-3: reaches limit 3 -> stops
  await emitRuntimeEventForTest(ctx, {
    type: "tool_call",
    toolCallId: "call-3",
    status: "failed",
    title: "patch",
    input: args,
  } as any);
  expect(guard.stats().toolRetryCount).toBe(3);
  expect(guard.stopped).toBe(true);
  expect(guard.stopReason).toBe("tool_retry_loop");
  expect(onRunGuardStop).toHaveBeenCalledWith("tool_retry_loop");
});

it("resolves guard limits with defaults (150 calls / 20 min / 3) and applies agent/team/env overrides", () => {
  // Defaults
  const def = resolveRunGuardOptions();
  expect(def.modelCallLimit).toBe(150);
  expect(def.idleTimeoutMs).toBe(20 * 60 * 1000);
  expect(def.toolRetryLimit).toBe(3);

  // Team overrides
  const team = resolveRunGuardOptions({
    teamLiveness: {
      runGuard: { modelCallLimit: 80, idleTimeoutSec: 600, toolRetryLimit: 5 },
    },
  });
  expect(team.modelCallLimit).toBe(80);
  expect(team.idleTimeoutMs).toBe(600 * 1000);
  expect(team.toolRetryLimit).toBe(5);

  // Agent overrides (takes precedence over team)
  const agent = resolveRunGuardOptions({
    teamLiveness: { modelCallLimit: 80 },
    agentConfig: {
      runGuard: { modelCallLimit: 50, idleTimeoutMs: 300000, toolRetryLimit: 2 },
    },
  });
  expect(agent.modelCallLimit).toBe(50);
  expect(agent.idleTimeoutMs).toBe(300000);
  expect(agent.toolRetryLimit).toBe(2);

  // Env overrides
  const env = resolveRunGuardOptions({
    env: {
      MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT: "200",
      MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_MS: "900000",
      MYRMIDON_RUN_GUARD_TOOL_RETRY_LIMIT: "4",
    },
  });
  expect(env.modelCallLimit).toBe(200);
  expect(env.idleTimeoutMs).toBe(900000);
  expect(env.toolRetryLimit).toBe(4);
});

it("persists stopReason in heartbeat metadata, bypasses reconciliation hold, and suppresses same-revision wake on run guard stop", () => {
  const baseReleaseRecoveryFacts: ReleaseRecoveryFacts = {
    suppressImmediateRecovery: false,
    reviewParticipant: {
      applies: false,
      isExecutionReviewParticipantRecoveryRun: false,
    },
    immediate: {
      applies: true,
      isDispositionRepairRetry: false,
      hasExplicitBlockerPath: false,
      isWorkspaceValidationFailedRun: false,
      isConfigurationIncompleteFailedRun: false,
      automaticRecoveryAlreadyFailed: false,
    },
    shared: {
      hasExistingExecutionPath: false,
      hasPersistedMonitor: false,
      suppressedByPauseHold: false,
      isStrandedRecoveryOrigin: false,
      recoveryAgentPresent: true,
      recoveryAgentInvokable: true,
    },
  };

  for (const reason of runGuardReasons) {
    // 1. inferHeartbeatRunStopReason correctly maps run guard errors to stopReason
    expect(inferHeartbeatRunStopReason({ outcome: "cancelled", errorCode: reason })).toBe(reason);
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: reason })).toBe(reason);

    // 2. buildHeartbeatRunStopMetadata constructs the full stop metadata
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "hermes_gateway",
      adapterConfig: {},
      outcome: "cancelled",
      errorCode: reason,
      errorMessage: `Run guard stopped: ${reason}`,
    });
    expect(metadata.stopReason).toBe(reason);
    expect(metadata.timeoutFired).toBe(false);

    // 3. mergeHeartbeatRunStopMetadata persists the stopReason in the run resultJson
    const initialResultJson = { previousPayload: "preserved" };
    const merged = mergeHeartbeatRunStopMetadata(initialResultJson, metadata);
    expect(merged.stopReason).toBe(reason);
    expect(merged.previousPayload).toBe("preserved");

    // 4. legacyExecutionNeedsReconciliation returns false (no manual hold in reconciliation)
    const isHeld = legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "cancelled",
      errorCode: reason,
      scheduledRetryAttempt: 0,
      resultJson: merged,
    });
    expect(isHeld).toBe(false);

    // 5. Wake queue release policy with suppressImmediateRecovery: true suppresses same-revision retry/wake
    const recoveryDecision = decideReleaseRecovery({
      ...baseReleaseRecoveryFacts,
      suppressImmediateRecovery: true,
    });
    expect(recoveryDecision).toEqual({ kind: "released" });
  }
});

it("allows N model calls and rejects N+1 before it can dispatch", () => {
  const guard = new RunGuard({ modelCallLimit: 3 });
  expect(guard.modelCall().stop).toBe(false); // N-2
  expect(guard.modelCall().stop).toBe(false); // N-1
  expect(guard.modelCall().stop).toBe(false); // N
  expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" }); // N+1
  expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
  expect(guard.stats().modelCallCount).toBe(3);
});

it("refreshes the idle deadline on model and board events without cutting a long active run", async () => {
  vi.useFakeTimers();
  try {
    const guard = new RunGuard({ idleTimeoutMs: 20 });
    const onIdle = vi.fn();
    guard.startIdleWatch(onIdle);
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(19);
      if (index === 0) guard.modelCall();
      else guard.event();
      expect(onIdle).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(onIdle).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("counts identical failed tools across events, resets on success or different arguments, and never exposes arguments", () => {
  const args = { b: 2, token: "do-not-log", a: 1 };
  const guard = new RunGuard({ toolRetryLimit: 3 });
  expect(guard.toolFailure("patch", args).stop).toBe(false);
  guard.event();
  expect(guard.toolFailure("patch", { a: 1, b: 2, token: "do-not-log" }).stop).toBe(false);
  guard.event();
  expect(guard.toolFailure("patch", args)).toEqual({ stop: true, reason: "tool_retry_loop" });
  expect(toolFailureSignature("patch", args)).not.toContain("do-not-log");

  const resetOnSuccess = new RunGuard({ toolRetryLimit: 3 });
  expect(resetOnSuccess.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnSuccess.toolSuccess().stop).toBe(false);
  expect(resetOnSuccess.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnSuccess.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnSuccess.toolFailure("patch", args).reason).toBe("tool_retry_loop");

  const resetOnDifferentSignature = new RunGuard({ toolRetryLimit: 3 });
  expect(resetOnDifferentSignature.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnDifferentSignature.toolFailure("patch", { ...args, a: 2 }).stop).toBe(false);
  expect(resetOnDifferentSignature.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnDifferentSignature.toolFailure("patch", args).stop).toBe(false);
  expect(resetOnDifferentSignature.toolFailure("patch", args).reason).toBe("tool_retry_loop");
});


it("counts gateway assistant turns and repeated failed tool rounds without logging tool arguments", async () => {
  const guard = new RunGuard({ modelCallLimit: 10, toolRetryLimit: 3 });
  const onRunGuardStop = vi.fn(async () => undefined);
  const onLog = vi.fn(async () => undefined);
  const preview = JSON.stringify({ token: "do-not-log", path: "src/a.ts" });
  const frames = [
    ["message.delta", { delta: "first response" }],
    ["tool.started", { tool: "patch", preview }],
    ["tool.completed", { tool: "patch", error: "failed" }],
    ["message.delta", { delta: "second response" }],
    ["tool.started", { tool: "patch", preview }],
    ["tool.completed", { tool: "patch", error: "failed" }],
    ["message.delta", { delta: "third response" }],
    ["tool.started", { tool: "patch", preview }],
    ["tool.completed", { tool: "patch", error: "failed" }],
    ["run.completed", { status: "completed", output: "done" }],
  ] as const;
  const newline = String.fromCharCode(10);
  const sse = frames.map(([event, data]) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join(newline)).join("");
  const ctx: AdapterExecutionContext = {
    runId: "guard-test-run",
    agent: { id: "agent-test", companyId: "company-test", name: "test", adapterType: "hermes_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-test" },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test-only", timeoutSec: 10, sessionKeyStrategy: "run" },
    context: { issueId: "issue-test" },
    runGuard: guard,
    onRunGuardStop,
    onLog,
    onMeta: vi.fn(async () => undefined),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "guard-test-gateway-run", status: "started" }), { status: 200 });
    if (url.includes("/events")) return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ status: "running" }), { status: 200 });
  }));
  try {
    await executeHermesGateway(ctx);
    expect(onRunGuardStop).toHaveBeenCalledTimes(1);
    expect(onRunGuardStop).toHaveBeenCalledWith("tool_retry_loop");
    const logged = onLog.mock.calls.flat().join("\\n");
    expect(logged).not.toContain("do-not-log");
    expect(logged).toContain('"token":"[redacted len=10]"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("counts discrete provider requests across streaming token bursts and tool boundaries, stopping at the limit", async () => {
  const guard = new RunGuard({ modelCallLimit: 2 });
  const onRunGuardStop = vi.fn(async () => undefined);
  const frames = [
    // Round 1 (provider request 1: model.request followed by multiple streaming token chunks)
    ["model.request", { request_id: "req-1" }],
    ["message.delta", { delta: "first " }],
    ["message.delta", { delta: "chunk " }],
    ["message.delta", { delta: "tokens" }],
    ["tool.started", { tool: "noop" }],
    ["tool.completed", { tool: "noop" }],
    // Round 2 (provider request 2: model.request followed by multiple streaming token chunks)
    ["model.request", { request_id: "req-2" }],
    ["message.delta", { delta: "second " }],
    ["message.delta", { delta: "chunk " }],
    ["message.delta", { delta: "tokens" }],
    ["tool.started", { tool: "noop" }],
    ["tool.completed", { tool: "noop" }],
    // Round 3 (provider request 3: exceeds modelCallLimit 2 -> triggers model_call_limit stop)
    ["model.request", { request_id: "req-3" }],
    ["message.delta", { delta: "third" }],
    ["run.completed", { status: "completed", output: "done" }],
  ] as const;
  const newline = String.fromCharCode(10);
  const sse = frames.map(([event, data]) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join(newline)).join("");
  const ctx: AdapterExecutionContext = {
    runId: "guard-model-test-run",
    agent: { id: "agent-test", companyId: "company-test", name: "test", adapterType: "hermes_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-test" },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "mock-key", timeoutSec: 10, sessionKeyStrategy: "run" },
    context: { issueId: "issue-test" },
    runGuard: guard,
    onRunGuardStop,
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "guard-model-gateway-run", status: "started" }), { status: 200 });
    if (url.includes("/events")) return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ status: "running" }), { status: 200 });
  }));
  try {
    await executeHermesGateway(ctx);
    // Streaming chunks within each round did not artificially advance the model call count
    expect(guard.stats().modelCallCount).toBe(2);
    expect(guard.stopped).toBe(true);
    expect(guard.stopReason).toBe("model_call_limit");
    expect(onRunGuardStop).toHaveBeenCalledTimes(1);
    expect(onRunGuardStop).toHaveBeenCalledWith("model_call_limit");
  } finally {
    vi.unstubAllGlobals();
  }
});

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it("does not hold maintenance-interrupted runs scheduled for retry", () => {
  expect(legacyExecutionNeedsReconciliation({
    runtimeMode: "legacy", status: "cancelled", errorCode: MAINTENANCE_INTERRUPT_ERROR_CODE,
    scheduledRetryAttempt: 50, scheduledRetryReason: "myrmidon_maintenance",
    contextSnapshot: { issueId: "issue-1", retryReason: "myrmidon_maintenance" }, resultJson: {},
  })).toBe(false);
});

// myrmidon(CONTINUATION-WAIT-HOLD): a queued review/response wait is cancelled
// before provider startup and must not create an execution reconciliation hold.
it("does not hold queued continuations cancelled before provider startup", () => {
  for (const errorCode of [
    "issue_continuation_waiting_on_review",
    "issue_waiting_for_response",
  ]) {
    expect(
      legacyExecutionNeedsReconciliation({
        runtimeMode: "legacy",
        status: "cancelled",
        errorCode,
        resultJson: {},
      }),
    ).toBe(false);
    expect(
      legacyExecutionNeedsReconciliation({
        runtimeMode: "legacy",
        status: "failed",
        errorCode,
        resultJson: {},
      }),
    ).toBe(true);
  }
});

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });
