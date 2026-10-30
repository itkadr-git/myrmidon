import { describe, expect, it } from \"vitest\";
import {
  TrajectoryTracker,
  validateTrajectoryEvent,
  TRAJECTORY_EVENT_JSON_SCHEMA,
} from \"./trajectory-events.js\";

describe(\"TrajectoryTracker and Trajectory Events\", () => {
  const options = {
    runId: \"run-test-123\",
    agentId: \"agent-dev-1\",
    companyId: \"comp-test-01\",
    consecutiveErrorThreshold: 3,
    repeatWindowSize: 5,
  };

  it(\"tracks single tool error and resets on subsequent success\", () => {
    const tracker = new TrajectoryTracker(options);

    // Step 1: Tool call and error
    const call1 = tracker.recordToolCall({
      toolName: \"terminal\",
      args: { command: \"npm test\" },
    });
    expect(call1.isRepeat).toBe(false);

    const res1 = tracker.recordToolResult({
      toolName: \"terminal\",
      callId: call1.event.payload.callId,
      status: \"error\",
      error: \"Process exited with code 1\",
    });

    expect(res1.event.payload.status).toBe(\"error\");
    expect(res1.event.payload.consecutiveErrors).toBe(1);
    expect(res1.isStopConditionTriggered).toBe(false);

    // Step 2: Tool call and success
    const call2 = tracker.recordToolCall({
      toolName: \"terminal\",
      args: { command: \"npm --version\" },
    });
    const res2 = tracker.recordToolResult({
      toolName: \"terminal\",
      callId: call2.event.payload.callId,
      status: \"success\",
    });

    expect(res2.event.payload.status).toBe(\"success\");
    expect(res2.event.payload.consecutiveErrors).toBe(0);
    expect(res2.isStopConditionTriggered).toBe(false);
  });

  it(\"triggers repeated_tool_error stop condition when tool fails consecutively up to threshold\", () => {
    const tracker = new TrajectoryTracker(options);

    // Failure 1
    const c1 = tracker.recordToolCall({ toolName: \"patch\", args: { path: \"a.ts\", old: \"foo\" } });
    const r1 = tracker.recordToolResult({
      toolName: \"patch\",
      callId: c1.event.payload.callId,
      status: \"error\",
      error: \"Found 0 matches\",
    });
    expect(r1.event.payload.consecutiveErrors).toBe(1);
    expect(r1.isStopConditionTriggered).toBe(false);

    // Failure 2
    const c2 = tracker.recordToolCall({ toolName: \"patch\", args: { path: \"a.ts\", old: \"bar\" } });
    const r2 = tracker.recordToolResult({
      toolName: \"patch\",
      callId: c2.event.payload.callId,
      status: \"error\",
      error: \"Found 2 matches\",
    });
    expect(r2.event.payload.consecutiveErrors).toBe(2);
    expect(r2.isStopConditionTriggered).toBe(false);

    // Failure 3 (Threshold reached!)
    const c3 = tracker.recordToolCall({ toolName: \"patch\", args: { path: \"a.ts\", old: \"baz\" } });
    const r3 = tracker.recordToolResult({
      toolName: \"patch\",
      callId: c3.event.payload.callId,
      status: \"error\",
      error: \"File not found\",
    });
    expect(r3.event.payload.consecutiveErrors).toBe(3);
    expect(r3.isStopConditionTriggered).toBe(true);
    expect(r3.stopConditionEvent).toBeDefined();
    expect(r3.stopConditionEvent?.payload.condition).toBe(\"repeated_tool_error\");
    expect(r3.stopConditionEvent?.payload.action).toBe(\"abort_run\");
    expect(r3.stopReason).toContain(\"failed 3 times consecutively\");
  });

  it(\"detects repeated identical tool calls and flags repeat failure\", () => {
    const tracker = new TrajectoryTracker(options);

    const callArgs = { command: \"git status\" };

    // Initial call
    const c1 = tracker.recordToolCall({ toolName: \"terminal\", args: callArgs });
    expect(c1.isRepeat).toBe(false);
    const r1 = tracker.recordToolResult({
      toolName: \"terminal\",
      callId: c1.event.payload.callId,
      status: \"error\",
      error: \"git not found\",
    });
    expect(r1.event.payload.isRepeatFailure).toBe(false);

    // Repeat identical call
    const c2 = tracker.recordToolCall({ toolName: \"terminal\", args: callArgs });
    expect(c2.isRepeat).toBe(true);

    const r2 = tracker.recordToolResult({
      toolName: \"terminal\",
      callId: c2.event.payload.callId,
      status: \"error\",
      error: \"git not found\",
    });
    expect(r2.event.payload.isRepeatFailure).toBe(true);
  });

  it(\"validates trajectory event schema invariants\", () => {
    const tracker = new TrajectoryTracker(options);

    const startEvent = tracker.recordRunStart({
      model: \"glm-5.3\",
      modelFamily: \"glm\",
      provider: \"dashscope\",
    });
    const stepEvent = tracker.advanceStep();
    const callResult = tracker.recordToolCall({ toolName: \"read_file\", args: { path: \"/etc/hosts\" } });
    const toolResult = tracker.recordToolResult({
      toolName: \"read_file\",
      callId: callResult.event.payload.callId,
      status: \"success\",
    });
    const completeEvent = tracker.recordRunComplete({
      status: \"completed\",
      artifacts: [\"commit:abc1234\"],
    });

    const events = [startEvent, stepEvent, callResult.event, toolResult.event, completeEvent];
    for (const ev of events) {
      const val = validateTrajectoryEvent(ev);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
      expect(TRAJECTORY_EVENT_JSON_SCHEMA.properties.eventType.enum).toContain(ev.eventType);
    }

    // Invalid event checks
    expect(validateTrajectoryEvent(null).valid).toBe(false);
    expect(validateTrajectoryEvent({}).valid).toBe(false);
    expect(validateTrajectoryEvent({ ...startEvent, eventType: \"invalid.event\" }).valid).toBe(false);
    expect(validateTrajectoryEvent({ ...startEvent, stepIndex: -1 }).valid).toBe(false);
  });
});
