import { expect, it, vi } from "vitest";
import { RunGuard, toolFailureSignature, type AdapterExecutionContext } from "@myrmidon/adapter-utils";
import { execute as executeHermesGateway } from "@myrmidon/hermes-paperclip-adapter/gateway/server";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";
import { MAINTENANCE_INTERRUPT_ERROR_CODE } from "../myrmidon/maintenance/domain.js";

const runGuardReasons = ["model_call_limit", "idle_timeout", "tool_retry_loop"] as const;

it.each(runGuardReasons)("turns %s into a no-auto-replay reconciliation", (reason) => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status,
      errorCode: reason,
      scheduledRetryAttempt: 0,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(true);
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status,
      errorCode: "cancelled",
      scheduledRetryAttempt: 0,
      resultJson: { runGuardStopReason: reason },
    })).toBe(true);
  }
});

it("allows N model calls and rejects N+1 before it can dispatch", () => {
  const guard = new RunGuard({ modelCallLimit: 3 });
  expect(guard.modelCall().stop).toBe(false); // N-2
  expect(guard.modelCall().stop).toBe(false); // N-1
  expect(guard.modelCall().stop).toBe(false); // N
  expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" }); // N+1
  expect(guard.modelCall()).toEqual({ stop: true, reason: "model_call_limit" });
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

it("counts gateway model rounds once per assistant response and stops before the limit is exceeded", async () => {
  const guard = new RunGuard({ modelCallLimit: 2 });
  const onRunGuardStop = vi.fn(async () => undefined);
  const frames = [
    ["message.delta", { delta: "first" }],
    ["tool.started", { tool: "noop" }],
    ["tool.completed", { tool: "noop" }],
    ["message.delta", { delta: "second" }],
    ["tool.started", { tool: "noop" }],
    ["tool.completed", { tool: "noop" }],
    ["message.delta", { delta: "third" }],
    ["run.completed", { status: "completed", output: "done" }],
  ] as const;
  const newline = String.fromCharCode(10);
  const sse = frames.map(([event, data]) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join(newline)).join("");
  const ctx: AdapterExecutionContext = {
    runId: "guard-model-test-run",
    agent: { id: "agent-test", companyId: "company-test", name: "test", adapterType: "hermes_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-test" },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test-only", timeoutSec: 10, sessionKeyStrategy: "run" },
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
