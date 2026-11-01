/**
 * Integration test for TrajectoryTracker in the hermes-local adapter executor.
 *
 * Verifies that:
 * 1. TrajectoryTracker is instantiated on execute start and logs trajectory.run_start.
 * 2. Tool completion lines ([done] ┊ ...) are parsed and fed into tracker.
 * 3. After 3 consecutive tool errors a trajectory.stop_condition event is logged.
 * 4. resultJson.trajectory.stopCondition is set to "repeated_tool_error".
 * 5. trajectory.run_complete is logged at the end of the run.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@myrmidon/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myrmidon/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@myrmidon/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onLog = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog,
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    } satisfies Record<string, unknown>,
    onLog,
  };
}

/** Build stdout simulating 3 consecutive failing shell tool calls. */
function failingToolStdout(): string {
  return [
    "[done] ┊ 💻 $   curl -s http://example.com  0.1s [exit 1]",
    "[done] ┊ 💻 $   curl -s http://example.com  0.2s [exit 1]",
    "[done] ┊ 💻 $   curl -s http://example.com  0.3s [exit 1]",
    "",
    "session_id: abc123",
  ].join("\n");
}

describe("hermes-local adapter TrajectoryTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs trajectory.run_start at execute start", async () => {
    const { ctx, onLog } = makeCtx();

    await execute(ctx as any);

    const logLines = onLog.mock.calls.map((call) => String(call[1]));
    const runStartLine = logLines.find((line) =>
      line.includes("trajectory.run_start"),
    );
    expect(runStartLine).toBeDefined();
    expect(runStartLine).toContain("test-run-1");
  });

  it("logs trajectory.stop_condition after 3 consecutive tool errors", async () => {
    const { ctx, onLog } = makeCtx();

    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(
      async (_runId, _cmd, _args, opts) => {
        // Simulate the child process emitting 3 failing tool lines
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.1s [exit 1]\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.2s [exit 1]\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.3s [exit 1]\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: null,
        };
      },
    );

    await execute(ctx as any);

    const logLines = onLog.mock.calls.map((call) => String(call[1]));
    const stopConditionLine = logLines.find((line) =>
      line.includes("trajectory.stop_condition"),
    );
    expect(stopConditionLine).toBeDefined();
    expect(stopConditionLine).toContain("repeated_tool_error");
    expect(stopConditionLine).toContain("shell");
    expect(stopConditionLine).toContain("abort_run");
  });

  it("sets resultJson.trajectory.stopCondition to repeated_tool_error", async () => {
    const { ctx } = makeCtx();

    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(
      async (_runId, _cmd, _args, opts) => {
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.1s [exit 1]\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.2s [exit 1]\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.3s [exit 1]\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: null,
        };
      },
    );

    const result = await execute(ctx as any);

    expect(result.resultJson).toBeDefined();
    const trajectory = (result.resultJson as Record<string, unknown>).trajectory as
      | Record<string, unknown>
      | null;
    expect(trajectory).not.toBeNull();
    expect(trajectory?.stopCondition).toBe("repeated_tool_error");
  });

  it("logs trajectory.run_complete at end of run", async () => {
    const { ctx, onLog } = makeCtx();

    await execute(ctx as any);

    const logLines = onLog.mock.calls.map((call) => String(call[1]));
    const runCompleteLine = logLines.find((line) =>
      line.includes("trajectory.run_complete"),
    );
    expect(runCompleteLine).toBeDefined();
  });

  it("does not emit trajectory events when trajectoryTracking is false", async () => {
    const { ctx, onLog } = makeCtx({ trajectoryTracking: false });

    await execute(ctx as any);

    const logLines = onLog.mock.calls.map((call) => String(call[1]));
    const trajectoryLines = logLines.filter((line) =>
      line.includes("trajectory."),
    );
    expect(trajectoryLines).toHaveLength(0);
  });

  it("resets consecutive error counter on successful tool call", async () => {
    const { ctx, onLog } = makeCtx();

    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(
      async (_runId, _cmd, _args, opts) => {
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.1s [exit 1]\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.2s [exit 1]\n");
        // Successful call resets the counter
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.3s\n");
        await opts.onLog("stdout", "[done] ┊ 💻 $   curl -s http://example.com  0.4s [exit 1]\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: null,
        };
      },
    );

    await execute(ctx as any);

    const logLines = onLog.mock.calls.map((call) => String(call[1]));
    const stopConditionLine = logLines.find((line) =>
      line.includes("trajectory.stop_condition"),
    );
    // Only 1 consecutive error after reset — stop condition NOT triggered
    expect(stopConditionLine).toBeUndefined();
  });
});
