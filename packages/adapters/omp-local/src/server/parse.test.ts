import { describe, expect, it } from "vitest";
import {
  parseOmpJsonl,
  isOmpUnknownSessionError,
  summarizeOmpToolRejections,
  OMP_TOOL_CALLS_REJECTED_ERROR_CODE,
} from "./parse.js";

describe("parseOmpJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from OMP" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.messages).toContain("Hello from OMP");
    expect(parsed.finalMessage).toBe("Hello from OMP");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "OMP" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello OMP",
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.messages).toContain("Hello OMP");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Rate limit exceeded (429)",
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual(["Rate limit exceeded (429)"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to provider lost",
      }),
    ].join("\n");

    const parsed = parseOmpJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to provider lost"]);
  });
});

// myrmidon(OPE-12806)
describe("summarizeOmpToolRejections", () => {
  const SERVICE_MODE = "Service mode does not accept async or timeout; use ready.timeout for readiness.";

  function toolEvents(id: string, toolName: string, isError: boolean, text: string) {
    return [
      { type: "tool_execution_start", toolCallId: id, toolName, args: {} },
      { type: "tool_execution_end", toolCallId: id, toolName, isError, result: { content: [{ type: "text", text }], details: {} } },
    ];
  }

  function parse(events: unknown[]) {
    return parseOmpJsonl(events.map((event) => JSON.stringify(event)).join("\n"));
  }

  it("uses a dedicated error code", () => {
    expect(OMP_TOOL_CALLS_REJECTED_ERROR_CODE).toBe("omp_tool_calls_rejected");
  });

  it("reports a run in which every tool call was rejected", () => {
    const parsed = parse([
      ...toolEvents("c1", "bash", true, SERVICE_MODE),
      ...toolEvents("c2", "bash", true, SERVICE_MODE),
    ]);
    const summary = summarizeOmpToolRejections(parsed.toolCalls);
    expect(summary).toMatchObject({ finishedCalls: 2, rejectedCalls: 2, allRejected: true });
    expect(summary?.message).toBe(`OMP finished, but all 2 tool call(s) were rejected: ${SERVICE_MODE}`);
  });

  it("reports a run in which the shell was rejected on every call although reads succeeded", () => {
    // The shape of the production runs: read works, every bash call is refused.
    const parsed = parse([
      ...toolEvents("r1", "read", false, "file contents"),
      ...toolEvents("b1", "bash", true, SERVICE_MODE),
      ...toolEvents("b2", "bash", true, SERVICE_MODE),
      ...toolEvents("b3", "bash", true, SERVICE_MODE),
    ]);
    const summary = summarizeOmpToolRejections(parsed.toolCalls);
    expect(summary?.allRejected).toBe(false);
    expect(summary?.rejectedTools).toEqual([{ toolName: "bash", calls: 3, sampleError: SERVICE_MODE }]);
    expect(summary?.message).toBe(`OMP finished, but all 3 "bash" call(s) were rejected: ${SERVICE_MODE}`);
  });

  it("does not report ordinary runs", () => {
    expect(summarizeOmpToolRejections(parse([]).toolCalls)).toBeNull();
    // a tool that failed at first and then worked
    expect(summarizeOmpToolRejections(parse([
      ...toolEvents("b1", "bash", true, "exit code 1"),
      ...toolEvents("b2", "bash", true, "exit code 1"),
      ...toolEvents("b3", "bash", true, "exit code 1"),
      ...toolEvents("b4", "bash", false, "ok"),
    ]).toolCalls)).toBeNull();
    // one or two failed calls of a tool next to successful work
    expect(summarizeOmpToolRejections(parse([
      ...toolEvents("e1", "edit", true, "no match"),
      ...toolEvents("e2", "edit", true, "no match"),
      ...toolEvents("w1", "write", false, "written"),
    ]).toolCalls)).toBeNull();
    // a call that never finished is not counted as rejected
    expect(summarizeOmpToolRejections(parse([
      { type: "tool_execution_start", toolCallId: "x1", toolName: "bash", args: {} },
    ]).toolCalls)).toBeNull();
  });
});

describe("isOmpUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isOmpUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isOmpUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOmpUnknownSessionError("", "no session available")).toBe(true);
    expect(isOmpUnknownSessionError("all good", "")).toBe(false);
    expect(isOmpUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});

describe("terminal provider failures", () => {
  it("surfaces and deduplicates errors from OMP assistant messages", () => {
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Context limit exceeded" };
    const parsed = parseOmpJsonl([
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_end", messages: [message] },
    ].map((event) => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["400 Context limit exceeded"]);
  });

  it("reports an error even when the provider omitted its message", () => {
    expect(parseOmpJsonl(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } })).errors)
      .toEqual(["OMP provider request failed."]);
  });
});
