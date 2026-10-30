/**
 * Trajectory Events and Stop Condition Tracking (1.6.6 DEVEFF / OPE-10097).
 *
 * Implements standardized trajectory event schemas and an in-memory
 * TrajectoryTracker for recording agent execution, detecting repeated tool
 * calls, tracking consecutive tool errors, and triggering stop conditions.
 * Compatible with Harbor ATIF (Agent Trajectory Interchange Format) and Myrmidon run-log events.
 */

import crypto from \"node:crypto\";

export type TrajectoryEventType =
  | \"trajectory.run_start\"
  | \"trajectory.step\"
  | \"trajectory.tool_call\"
  | \"trajectory.tool_result\"
  | \"trajectory.stop_condition\"
  | \"trajectory.run_complete\";

export interface TrajectoryRunStartPayload {
  version: 1;
  model: string;
  modelFamily: string;
  provider: string;
  promptSha256?: string;
  metadata?: Record<string, unknown>;
}

export interface TrajectoryStepPayload {
  version: 1;
  stepIndex: number;
  reasoningPreview?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface TrajectoryToolCallPayload {
  version: 1;
  callId: string;
  toolName: string;
  inputSummary: string;
  argsHash: string;
  isRepeat: boolean;
}

export interface TrajectoryToolResultPayload {
  version: 1;
  callId: string;
  toolName: string;
  status: \"success\" | \"error\" | \"timeout\";
  durationMs: number;
  error?: string;
  consecutiveErrors: number;
  isRepeatFailure: boolean;
}

export interface TrajectoryStopConditionPayload {
  version: 1;
  condition: \"repeated_tool_error\" | \"repeated_tool_call\" | \"consecutive_no_op\" | \"budget_exceeded\";
  toolName?: string;
  consecutiveFailures?: number;
  message: string;
  action: \"abort_run\" | \"escalate_blocked\" | \"request_human_input\";
}

export interface TrajectoryRunCompletePayload {
  version: 1;
  status: \"completed\" | \"failed\" | \"aborted\";
  totalSteps: number;
  totalToolCalls: number;
  totalErrors: number;
  repeatedErrorCount: number;
  artifacts?: string[];
}

export interface TrajectoryEvent<T = Record<string, unknown>> {
  eventId: string;
  eventType: TrajectoryEventType;
  timestamp: string;
  runId: string;
  agentId: string;
  companyId: string;
  stepIndex: number;
  payload: T;
}

/**
 * Standard JSON Schema Draft-07 for Trajectory Events.
 */
export const TRAJECTORY_EVENT_JSON_SCHEMA = {
  $schema: \"http://json-schema.org/draft-07/schema#\",
  title: \"TrajectoryEvent\",
  type: \"object\",
  required: [
    \"eventId\",
    \"eventType\",
    \"timestamp\",
    \"runId\",
    \"agentId\",
    \"companyId\",
    \"stepIndex\",
    \"payload\",
  ],
  properties: {
    eventId: { type: \"string\" },
    eventType: {
      type: \"string\",
      enum: [
        \"trajectory.run_start\",
        \"trajectory.step\",
        \"trajectory.tool_call\",
        \"trajectory.tool_result\",
        \"trajectory.stop_condition\",
        \"trajectory.run_complete\",
      ],
    },
    timestamp: { type: \"string\" },
    runId: { type: \"string\" },
    agentId: { type: \"string\" },
    companyId: { type: \"string\" },
    stepIndex: { type: \"integer\", minimum: 0 },
    payload: {
      type: \"object\",
      required: [\"version\"],
      properties: {
        version: { type: \"integer\", enum: [1] },
      },
    },
  },
} as const;

/**
 * Validates a trajectory event against structural invariants.
 */
export function validateTrajectoryEvent(event: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof event !== \"object\" || event === null || Array.isArray(event)) {
    return { valid: false, errors: [\"Event must be a non-null object\"] };
  }

  const rec = event as Record<string, unknown>;
  const required = [\"eventId\", \"eventType\", \"timestamp\", \"runId\", \"agentId\", \"companyId\", \"stepIndex\", \"payload\"];
  for (const field of required) {
    if (rec[field] === undefined || rec[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const validTypes = [
    \"trajectory.run_start\",
    \"trajectory.step\",
    \"trajectory.tool_call\",
    \"trajectory.tool_result\",
    \"trajectory.stop_condition\",
    \"trajectory.run_complete\",
  ];
  if (typeof rec.eventType !== \"string\" || !validTypes.includes(rec.eventType)) {
    errors.push(`Invalid eventType: ${String(rec.eventType)}`);
  }

  if (typeof rec.stepIndex !== \"number\" || !Number.isInteger(rec.stepIndex) || rec.stepIndex < 0) {
    errors.push(`stepIndex must be a non-negative integer`);
  }

  if (typeof rec.payload !== \"object\" || rec.payload === null || Array.isArray(rec.payload)) {
    errors.push(`payload must be an object`);
  } else {
    const payload = rec.payload as Record<string, unknown>;
    if (payload.version !== 1) {
      errors.push(`payload.version must be 1`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Hash input arguments for deterministic repeat comparison.
 */
function hashToolArgs(args: unknown): string {
  if (args === undefined || args === null) return \"null\";
  try {
    const str = typeof args === \"string\" ? args : JSON.stringify(args);
    return crypto.createHash(\"sha256\").update(str).digest(\"hex\").slice(0, 16);
  } catch {
    return \"unhashable\";
  }
}

export interface TrajectoryTrackerOptions {
  runId: string;
  agentId: string;
  companyId: string;
  consecutiveErrorThreshold?: number; // default 3
  repeatWindowSize?: number; // default 5
}

interface RecentToolInvocation {
  toolName: string;
  argsHash: string;
  stepIndex: number;
  callId: string;
  hadError?: boolean;
}

/**
 * TrajectoryTracker maintains trajectory history during an agent run,
 * classifies errors, detects duplicate calls, and signals stop conditions.
 */
export class TrajectoryTracker {
  public readonly runId: string;
  public readonly agentId: string;
  public readonly companyId: string;
  public readonly consecutiveErrorThreshold: number;
  public readonly repeatWindowSize: number;

  private currentStepIndex: number = 0;
  private totalToolCalls: number = 0;
  private totalErrors: number = 0;
  private repeatedErrorCount: number = 0;

  // Active consecutive tool error state
  private consecutiveErrors: {
    toolName: string;
    count: number;
    lastError: string;
  } | null = null;

  // Sliding window of recent invocations to detect loops
  private recentCalls: RecentToolInvocation[] = [];

  // Map of active tool calls by callId
  private activeCalls: Map<string, { toolName: string; argsHash: string; startTime: number }> = new Map();

  constructor(options: TrajectoryTrackerOptions) {
    this.runId = options.runId;
    this.agentId = options.agentId;
    this.companyId = options.companyId;
    this.consecutiveErrorThreshold = options.consecutiveErrorThreshold ?? 3;
    this.repeatWindowSize = options.repeatWindowSize ?? 5;
  }

  public getStepIndex(): number {
    return this.currentStepIndex;
  }

  public advanceStep(): TrajectoryEvent<TrajectoryStepPayload> {
    this.currentStepIndex++;
    return {
      eventId: crypto.randomUUID(),
      eventType: \"trajectory.step\",
      timestamp: new Date().toISOString(),
      runId: this.runId,
      agentId: this.agentId,
      companyId: this.companyId,
      stepIndex: this.currentStepIndex,
      payload: {
        version: 1,
        stepIndex: this.currentStepIndex,
      },
    };
  }

  public recordRunStart(input: {
    model: string;
    modelFamily: string;
    provider: string;
    promptSha256?: string;
  }): TrajectoryEvent<TrajectoryRunStartPayload> {
    return {
      eventId: crypto.randomUUID(),
      eventType: \"trajectory.run_start\",
      timestamp: new Date().toISOString(),
      runId: this.runId,
      agentId: this.agentId,
      companyId: this.companyId,
      stepIndex: this.currentStepIndex,
      payload: {
        version: 1,
        model: input.model,
        modelFamily: input.modelFamily,
        provider: input.provider,
        promptSha256: input.promptSha256,
      },
    };
  }

  /**
   * Record a tool call attempt. Detects identical repeated invocations.
   */
  public recordToolCall(input: {
    toolName: string;
    args?: unknown;
    inputSummary?: string;
    callId?: string;
  }): { event: TrajectoryEvent<TrajectoryToolCallPayload>; isRepeat: boolean } {
    const callId = input.callId ?? crypto.randomUUID();
    const argsHash = hashToolArgs(input.args);
    this.totalToolCalls++;

    // Check sliding window for identical call
    const isRepeat = this.recentCalls.some(
      (c) => c.toolName === input.toolName && c.argsHash === argsHash,
    );

    this.activeCalls.set(callId, {
      toolName: input.toolName,
      argsHash,
      startTime: Date.now(),
    });

    const event: TrajectoryEvent<TrajectoryToolCallPayload> = {
      eventId: crypto.randomUUID(),
      eventType: \"trajectory.tool_call\",
      timestamp: new Date().toISOString(),
      runId: this.runId,
      agentId: this.agentId,
      companyId: this.companyId,
      stepIndex: this.currentStepIndex,
      payload: {
        version: 1,
        callId,
        toolName: input.toolName,
        inputSummary: input.inputSummary ?? (typeof input.args === \"string\" ? input.args.slice(0, 100) : \"\"),
        argsHash,
        isRepeat,
      },
    };

    return { event, isRepeat };
  }

  /**
   * Record a tool execution result. Tracks consecutive tool failures,
   * detects repeat errors, and checks whether stop condition is reached.
   */
  public recordToolResult(input: {
    toolName: string;
    callId?: string;
    status: \"success\" | \"error\" | \"timeout\";
    error?: string;
    durationMs?: number;
  }): {
    event: TrajectoryEvent<TrajectoryToolResultPayload>;
    stopConditionEvent?: TrajectoryEvent<TrajectoryStopConditionPayload>;
    isStopConditionTriggered: boolean;
    stopReason?: string;
  } {
    const callId = input.callId ?? \"\";
    const active = callId ? this.activeCalls.get(callId) : null;
    if (callId) this.activeCalls.delete(callId);

    const durationMs = input.durationMs ?? (active ? Date.now() - active.startTime : 0);
    const isError = input.status === \"error\" || input.status === \"timeout\";
    const argsHash = active?.argsHash ?? \"\";

    let consecutiveCount = 0;
    let isRepeatFailure = false;
    let stopConditionEvent: TrajectoryEvent<TrajectoryStopConditionPayload> | undefined;

    if (isError) {
      this.totalErrors++;
      const errStr = (input.error ?? \"\").slice(0, 200);

      // Check if previous invocation was an identical failed call
      const recentMatch = this.recentCalls.find(
        (c) => c.toolName === input.toolName && c.argsHash === argsHash && c.hadError === true,
      );
      if (recentMatch) {
        isRepeatFailure = true;
        this.repeatedErrorCount++;
      }

      // Track consecutive errors on the same tool
      if (this.consecutiveErrors && this.consecutiveErrors.toolName === input.toolName) {
        this.consecutiveErrors.count++;
        this.consecutiveErrors.lastError = errStr;
      } else {
        this.consecutiveErrors = {
          toolName: input.toolName,
          count: 1,
          lastError: errStr,
        };
      }
      consecutiveCount = this.consecutiveErrors.count;

      // Update sliding call window
      this.recentCalls.push({
        toolName: input.toolName,
        argsHash,
        stepIndex: this.currentStepIndex,
        callId,
        hadError: true,
      });
      if (this.recentCalls.length > this.repeatWindowSize) {
        this.recentCalls.shift();
      }

      // Check threshold trigger
      if (consecutiveCount >= this.consecutiveErrorThreshold) {
        const message = `Tool '${input.toolName}' failed ${consecutiveCount} times consecutively. Stopping run.`;
        stopConditionEvent = {
          eventId: crypto.randomUUID(),
          eventType: \"trajectory.stop_condition\",
          timestamp: new Date().toISOString(),
          runId: this.runId,
          agentId: this.agentId,
          companyId: this.companyId,
          stepIndex: this.currentStepIndex,
          payload: {
            version: 1,
            condition: \"repeated_tool_error\",
            toolName: input.toolName,
            consecutiveFailures: consecutiveCount,
            message,
            action: \"abort_run\",
          },
        };
      }
    } else {
      // Success resets consecutive tool error tracker
      this.consecutiveErrors = null;
      this.recentCalls.push({
        toolName: input.toolName,
        argsHash,
        stepIndex: this.currentStepIndex,
        callId,
        hadError: false,
      });
      if (this.recentCalls.length > this.repeatWindowSize) {
        this.recentCalls.shift();
      }
    }

    const event: TrajectoryEvent<TrajectoryToolResultPayload> = {
      eventId: crypto.randomUUID(),
      eventType: \"trajectory.tool_result\",
      timestamp: new Date().toISOString(),
      runId: this.runId,
      agentId: this.agentId,
      companyId: this.companyId,
      stepIndex: this.currentStepIndex,
      payload: {
        version: 1,
        callId,
        toolName: input.toolName,
        status: input.status,
        durationMs,
        error: input.error,
        consecutiveErrors: consecutiveCount,
        isRepeatFailure,
      },
    };

    return {
      event,
      stopConditionEvent,
      isStopConditionTriggered: Boolean(stopConditionEvent),
      stopReason: stopConditionEvent?.payload.message,
    };
  }

  public recordRunComplete(input: {
    status: \"completed\" | \"failed\" | \"aborted\";
    artifacts?: string[];
  }): TrajectoryEvent<TrajectoryRunCompletePayload> {
    return {
      eventId: crypto.randomUUID(),
      eventType: \"trajectory.run_complete\",
      timestamp: new Date().toISOString(),
      runId: this.runId,
      agentId: this.agentId,
      companyId: this.companyId,
      stepIndex: this.currentStepIndex,
      payload: {
        version: 1,
        status: input.status,
        totalSteps: this.currentStepIndex,
        totalToolCalls: this.totalToolCalls,
        totalErrors: this.totalErrors,
        repeatedErrorCount: this.repeatedErrorCount,
        artifacts: input.artifacts,
      },
    };
  }
}
