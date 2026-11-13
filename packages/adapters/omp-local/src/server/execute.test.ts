import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunGuard, type RunGuardStopReason } from "@myrmidon/adapter-utils";
import { buildRunGuardHintMessage } from "@myrmidon/adapter-utils/run-guard-hint";
import { runningProcesses } from "@myrmidon/adapter-utils/server-utils";
import { resetOmpModelsCacheForTests } from "./models.js";
import { OMP_STEER_EXTENSION_FILE, OMP_STEER_EXTENSION_SOURCE, OMP_STEER_FILE_ENV } from "./run-guard.js";

type ProcessResultShape = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
};

type PrepareRuntimeCallShape = {
  runId: string;
  target: unknown;
  adapterKey: string;
  assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean }>;
  [key: string]: unknown;
};

const {
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(
    async (
      _runId?: string,
      _target?: unknown,
      _command?: string,
      _args?: string[],
      _options?: { env?: Record<string, string>; [key: string]: unknown },
    ): Promise<ProcessResultShape> => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "done",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cost: { total: 0.01 },
          },
        },
        toolResults: [],
      }),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    }),
  ),
  runAdapterExecutionTargetShellCommand: vi.fn(
    async (
      _runId?: string,
      _target?: unknown,
      _command?: string,
      _options?: unknown,
    ): Promise<{
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }> => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
  ),
  prepareAdapterExecutionTargetRuntime: vi.fn(
    async (_input?: PrepareRuntimeCallShape) => ({
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/runtime",
      assetDirs: {
        skills: "/remote/runtime/skills",
        agentConfig: "/remote/runtime/agentConfig",
      },
      restoreWorkspace: vi.fn(async () => undefined),
    }),
  ),
}));

vi.mock("./models.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("./models.js");
  return {
    ...actual,
    ensureOmpModelConfiguredAndAvailable: vi.fn(async () => undefined),
  };
});

vi.mock("@myrmidon/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@myrmidon/adapter-utils/execution-target");
  return {
    ...actual,
    // The callback bridge is not under test here (asset staging and env are).
    startAdapterExecutionTargetPaperclipBridge: async () => null,
    ensureAdapterExecutionTargetCommandResolvable: async (...args: Parameters<typeof actual.ensureAdapterExecutionTargetCommandResolvable>) => {
      if (args[0] === "omp") return;
      return actual.ensureAdapterExecutionTargetCommandResolvable(...args);
    },
    resolveAdapterExecutionTargetCommandForLogs: async (...args: Parameters<typeof actual.resolveAdapterExecutionTargetCommandForLogs>) => {
      if (args[0] === "omp") return "omp";
      return actual.resolveAdapterExecutionTargetCommandForLogs(...args);
    },
    runAdapterExecutionTargetProcess: (...args: Parameters<typeof actual.runAdapterExecutionTargetProcess>) => {
      if (args[2] === "omp") {
        return runAdapterExecutionTargetProcess(
          ...(args as unknown as Parameters<typeof runAdapterExecutionTargetProcess>),
        );
      }
      return actual.runAdapterExecutionTargetProcess(...args);
    },
    runAdapterExecutionTargetShellCommand: (...args: Parameters<typeof actual.runAdapterExecutionTargetShellCommand>) => {
      const runId = args[0] ?? "";
      const shellCmd = args[2] ?? "";
      if (runId.startsWith("run-") || shellCmd.includes(".jsonl") || shellCmd.includes("head -n 1")) {
        return runAdapterExecutionTargetShellCommand(...args);
      }
      return actual.runAdapterExecutionTargetShellCommand(...args);
    },
    // myrmidon(OPE-12801): the cancellation tests use an SSH target; creating
    // the session directory on it is not under test and must not open ssh.
    ensureAdapterExecutionTargetDirectory: (...args: Parameters<typeof actual.ensureAdapterExecutionTargetDirectory>) => {
      const target = args[1];
      if (target?.kind === "remote" && target.transport === "ssh") return Promise.resolve();
      return actual.ensureAdapterExecutionTargetDirectory(...args);
    },
    prepareAdapterExecutionTargetRuntime: (...args: Parameters<typeof actual.prepareAdapterExecutionTargetRuntime>) => {
      if (args[0]?.adapterKey === "omp") {
        return prepareAdapterExecutionTargetRuntime(...args);
      }
      return actual.prepareAdapterExecutionTargetRuntime(...args);
    },
  };
});

import { buildSkillDescriptionsLinkCommand, execute } from "./execute.js";

describe("omp local execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    resetOmpModelsCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("first run does not pass --session and specifies --session-dir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-test-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    const args = call![3];
    expect(args).not.toContain("--session");
    expect(args).toContain("--session-dir");
    expect(args).not.toContain("--skill");
    expect(args).toContain("--provider");
    expect(args).toContain("openai");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4o");
  });

  it("resumes with --session when session header matches cwd", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const sessionDir = path.join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const sessionFilePath = path.join(sessionDir, "session-123.jsonl");
    await writeFile(
      sessionFilePath,
      `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`,
      "utf8",
    );

    await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionFilePath,
        sessionParams: {
          sessionId: sessionFilePath,
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    const args = call![3];
    expect(args).toContain("--session");
    expect(args).toContain(sessionFilePath);
  });

  it("resumes with --session when omp 18.9.2 writes title line before the session header", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-resume-title-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const sessionDir = path.join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const sessionFilePath = path.join(sessionDir, "session-title-first.jsonl");
    // omp 18.9.2 writes {"type":"title",…} as the first line and the
    // {"type":"session",…,"cwd":…} header on the second line.
    await writeFile(
      sessionFilePath,
      [
        JSON.stringify({ type: "title", title: "omp session" }),
        JSON.stringify({ type: "session", cwd: workspaceDir }),
      ].join("\n") + "\n",
      "utf8",
    );

    await execute({
      runId: "run-title-first",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionFilePath,
        sessionParams: {
          sessionId: sessionFilePath,
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-title-first",
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    const args = call![3];
    expect(args).toContain("--session");
    expect(args).toContain(sessionFilePath);
  });

  it("starts a fresh session without --session when session header cwd differs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-stale-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const otherDir = path.join(rootDir, "other");
    const sessionDir = path.join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const sessionFilePath = path.join(sessionDir, "session-123.jsonl");
    await writeFile(
      sessionFilePath,
      `${JSON.stringify({ type: "session", cwd: otherDir })}\n`,
      "utf8",
    );

    await execute({
      runId: "run-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionFilePath,
        sessionParams: {
          sessionId: sessionFilePath,
          cwd: otherDir,
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    const args = call![3];
    expect(args).not.toContain("--session");
    expect(args).toContain("--session-dir");
  });

  it("starts a fresh session without --session when session belongs to another agent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-foreign-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const foreignSessionDir = path.join(os.homedir(), ".omp", "paperclips", "company-1", "agent-other");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(foreignSessionDir, { recursive: true });
    cleanupDirs.push(path.join(os.homedir(), ".omp", "paperclips", "company-1"));

    const sessionFilePath = path.join(foreignSessionDir, "session-foreign.jsonl");
    await writeFile(
      sessionFilePath,
      `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`,
      "utf8",
    );

    await execute({
      runId: "run-foreign",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionFilePath,
        sessionParams: {
          sessionId: sessionFilePath,
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-foreign",
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    const args = call![3];
    expect(args).not.toContain("--session");
    expect(args).toContain("--session-dir");
  });

  it("retries with a fresh session when resumed session produces unknown session error and sets clearSession: true", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-unknown-session-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const sessionDir = path.join(rootDir, "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const sessionFilePath = path.join(sessionDir, "session-missing.jsonl");
    await writeFile(
      sessionFilePath,
      `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`,
      "utf8",
    );

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: `Error: Session not found: ${sessionFilePath}`,
      pid: 124,
      startedAt: new Date().toISOString(),
    }));

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "recovered",
          usage: { input: 5, output: 5, cacheRead: 0, cost: { total: 0 } },
        },
        toolResults: [],
      }),
      stderr: "",
      pid: 125,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-retry",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: sessionFilePath,
        sessionParams: {
          sessionId: sessionFilePath,
          cwd: workspaceDir,
        },
        sessionDisplayId: "session-missing",
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const firstCallArgs = runAdapterExecutionTargetProcess.mock.calls[0]?.[3];
    const secondCallArgs = runAdapterExecutionTargetProcess.mock.calls[1]?.[3];
    expect(firstCallArgs).toContain("--session");
    expect(secondCallArgs).not.toContain("--session");
    expect(secondCallArgs).toContain("--session-dir");
    expect(result.clearSession).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("returns timedOut: true and appropriate errorMessage when process times out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-timeout-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "Process timed out",
      pid: 126,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
        timeoutSec: 30,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toBe("Timed out after 30s");
  });

  // myrmidon(OPE-12806): omp exits 0 after the model gives up on rejected tool
  // calls. Such a run is failed with its own error code, not succeeded.
  it("fails the run with omp_tool_calls_rejected when omp exits 0 but every shell call was rejected", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-rejected-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const refusal = "Service mode does not accept async or timeout; use ready.timeout for readiness.";
    const events: unknown[] = [];
    for (const id of ["b1", "b2", "b3"]) {
      events.push({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "git status", name: "inspect", timeout: 30 } });
      events.push({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: true, result: { content: [{ type: "text", text: refusal }], details: {} } });
    }
    events.push({ type: "turn_end", message: { role: "assistant", content: "I could not run any command." }, toolResults: [] });

    const makeExecuteInput = (runId: string, logs: string[]) => ({
      runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async (_stream: string, text: string) => {
        logs.push(text);
      },
    });

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: events.map((event) => JSON.stringify(event)).join("\n"),
      stderr: "",
      pid: 127,
      startedAt: new Date().toISOString(),
    }));

    const logs: string[] = [];
    const result = await execute(makeExecuteInput("run-rejected", logs));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("omp_tool_calls_rejected");
    expect(result.errorMessage).toBe(`OMP finished, but all 3 tool call(s) were rejected: ${refusal}`);
    expect(logs.join("")).toContain("Marking the run as failed (omp_tool_calls_rejected)");

    // A run whose tool calls worked stays successful.
    const okEvents = [
      { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "git status" } },
      { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "clean" }], details: {} } },
      { type: "turn_end", message: { role: "assistant", content: "done" }, toolResults: [] },
    ];
    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: okEvents.map((event) => JSON.stringify(event)).join("\n"),
      stderr: "",
      pid: 128,
      startedAt: new Date().toISOString(),
    }));
    const okResult = await execute(makeExecuteInput("run-not-rejected", []));
    expect(okResult.exitCode).toBe(0);
    expect(okResult.errorMessage).toBeNull();
    expect(okResult.errorCode ?? null).toBeNull();
  });

  it("discovers newly created session file via set diff and ignores preexisting files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-diff-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const companySessionDir = path.join(os.homedir(), ".omp", "paperclips", "company-diff", "agent-diff");
    await mkdir(companySessionDir, { recursive: true });
    cleanupDirs.push(path.join(os.homedir(), ".omp", "paperclips", "company-diff"));

    const oldSessionFile = path.join(companySessionDir, "session-old.jsonl");
    await writeFile(oldSessionFile, `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`, "utf8");

    const newSessionFile = path.join(companySessionDir, "session-new.jsonl");

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => {
      await writeFile(newSessionFile, `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          type: "turn_end",
          message: {
            role: "assistant",
            content: "first run done",
            usage: { input: 10, output: 10, cacheRead: 0, cost: { total: 0 } },
          },
          toolResults: [],
        }),
        stderr: "",
        pid: 127,
        startedAt: new Date().toISOString(),
      };
    });

    const result = await execute({
      runId: "run-diff",
      agent: {
        id: "agent-diff",
        companyId: "company-diff",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionId).toBe(newSessionFile);
    expect(result.sessionId).not.toBe(oldSessionFile);
  });

  it("does not pick up preexisting session file when execution fails before creating one", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-preexisting-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const companySessionDir = path.join(os.homedir(), ".omp", "paperclips", "company-pre", "agent-pre");
    await mkdir(companySessionDir, { recursive: true });
    cleanupDirs.push(path.join(os.homedir(), ".omp", "paperclips", "company-pre"));

    const oldSessionFile = path.join(companySessionDir, "session-old.jsonl");
    await writeFile(oldSessionFile, `${JSON.stringify({ type: "session", cwd: workspaceDir })}\n`, "utf8");

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Process crashed before session initialization",
      pid: 128,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute({
      runId: "run-failed",
      agent: {
        id: "agent-pre",
        companyId: "company-pre",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionId).toBeNull();
  });

  it("stages agentConfig containing skills and sets PI_CODING_AGENT_DIR in remote execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-remote",
      authToken: "test-host-api-token",
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test",
        remoteCwd: "/remote/workspace",
        // Sandbox targets execute through the provider runtime runner; session listing
        // (ls on the target) goes through it, so the test supplies a minimal one.
        runner: {
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: 1,
            startedAt: new Date().toISOString(),
          }),
        } as never,
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalled();
    const prepareCall = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
    const skillsAsset = prepareCall?.assets?.find((a) => a.key === "skills");
    const agentConfigAsset = prepareCall?.assets?.find((a) => a.key === "agentConfig");
    expect(skillsAsset).toBeDefined();
    expect(skillsAsset?.followSymlinks).toBe(true);
    expect(agentConfigAsset).toBeDefined();
    expect(agentConfigAsset?.followSymlinks).toBe(true);

    const targetProcCall = runAdapterExecutionTargetProcess.mock.calls[0];
    expect(targetProcCall).toBeDefined();
    const targetProcOptions = targetProcCall?.[4];
    expect(targetProcOptions?.env?.PI_CODING_AGENT_DIR).toBe("/remote/runtime/agentConfig");
    expect(targetProcOptions?.env?.OMP_CODING_AGENT_DIR).toBe("/remote/runtime/agentConfig");
  });

  // myrmidon(OPE-12805): the agent config dir staged to a remote runner carries
  // the managed omp settings, so omp offers `bash` without `name`/`ready`.
  it("stages a config.yml that switches off bash service launch for remote execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-remote-settings-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    // The staged dir is removed when the run ends, so read it while it is staged.
    let stagedSettings: string | null = null;
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async (input?: PrepareRuntimeCallShape) => {
      const agentConfigAsset = input?.assets?.find((asset) => asset.key === "agentConfig");
      stagedSettings = agentConfigAsset
        ? await readFile(path.join(agentConfigAsset.localDir, "config.yml"), "utf8").catch(() => null)
        : null;
      return {
        workspaceRemoteDir: "/remote/workspace",
        runtimeRootDir: "/remote/runtime",
        assetDirs: {
          skills: "/remote/runtime/skills",
          agentConfig: "/remote/runtime/agentConfig",
        },
        restoreWorkspace: vi.fn(async () => undefined),
      };
    });

    await execute({
      runId: "run-remote-settings",
      authToken: "test-host-api-token",
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test",
        remoteCwd: "/remote/workspace",
        runner: {
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: 1,
            startedAt: new Date().toISOString(),
          }),
        } as never,
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(stagedSettings).toBe("launch:\n  enabled: false\n");
  });

  it("prepends existing skill bin/ dirs to PATH and ignores skills without bin/ dir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-skill-path-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const skillWithBinDir = path.join(rootDir, "skills", "skill-with-bin");
    const skillWithBinBinDir = path.join(skillWithBinDir, "bin");
    const skillWithoutBinDir = path.join(rootDir, "skills", "skill-without-bin");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(skillWithBinBinDir, { recursive: true });
    await mkdir(skillWithoutBinDir, { recursive: true });

    runAdapterExecutionTargetProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: workspaceDir })}\n${JSON.stringify({ type: "turn_start" })}\n${JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, toolResults: [] })}\n${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    }));

    await execute({
      runId: "run-skill-path-unit",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Unit Agent",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        cwd: workspaceDir,
        model: "openai/gpt-4o",
      },
      context: {
        paperclipSkills: [
          { name: "skill-with-bin", path: skillWithBinDir },
          { name: "skill-without-bin", path: skillWithoutBinDir },
        ],
      },
      authToken: "run-jwt-token",
      onLog: async () => {},
    });

    const targetProcCall = runAdapterExecutionTargetProcess.mock.calls[0];
    expect(targetProcCall).toBeDefined();
    const targetProcOptions = targetProcCall?.[4];
    const pathValue = targetProcOptions?.env?.PATH || targetProcOptions?.env?.Path || "";
    const entries = pathValue.split(path.delimiter);
    expect(entries[0]).toBe(skillWithBinBinDir);
    expect(entries).not.toContain(path.join(skillWithoutBinDir, "bin"));
  });

  // myrmidon(1.6.7 OPE-12266): the default tool list must match omp 18.9.2
  // built-ins — `ls` is a hard error and `find` requires the fd binary.
  it("passes the omp 18.9.2 verified default tool list and honors config.tools", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-tools-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const runExecute = async (config: Record<string, unknown>) => {
      await execute({
        runId: "run-tools",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Builder",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: { command: "omp", model: "openai/gpt-4o", ...config },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      });
    };

    await runExecute({});
    let call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    expect(call![3]).toEqual(expect.arrayContaining(["--tools", "read,bash,edit,write,grep"]));

    runAdapterExecutionTargetProcess.mockClear();
    await runExecute({ tools: "read,bash,grep" });
    call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[]]
      | undefined;
    expect(call).toBeDefined();
    expect(call![3]).toEqual(expect.arrayContaining(["--tools", "read,bash,grep"]));
  });

  // myrmidon(1.6.7 OPE-12266): local process confinement mirrors codex_local —
  // filesystemScope=workspace builds sandbox options with the omp session dir
  // as a read/write managed path and logs the "Confining OMP" line.
  it("builds local process sandbox options and logs the confining line for filesystemScope=workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-sandbox-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const logs: Array<{ stream: string; text: string }> = [];
    await execute({
      runId: "run-sandbox",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
        filesystemScope: "workspace",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async (stream: string, text: string) => {
        logs.push({ stream, text });
      },
    });

    const allText = logs.map((entry) => entry.text).join("");
    expect(allText).toContain("Confining OMP with workspace filesystem scope.");

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { localProcessSandbox?: { workspaceDir: string; filesystemScope: string; command: string; managedPaths: Array<{ path: string; access: string }> } }]
      | undefined;
    expect(call).toBeDefined();
    const sandbox = call![4]?.localProcessSandbox;
    expect(sandbox).toBeDefined();
    expect(sandbox!.workspaceDir).toBe(workspaceDir);
    expect(sandbox!.filesystemScope).toBe("workspace");
    expect(sandbox!.command).toBe("bwrap");
    expect(sandbox!.managedPaths.some((managed) => managed.access === "rw")).toBe(true);
  });

  // myrmidon(1.6.7 OPE-12266): without sandbox config there is no confinement
  // and no confining log — behavior of existing agents is preserved.
  it("does not confine and does not log the confining line without sandbox config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-nosandbox-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const logs: Array<{ stream: string; text: string }> = [];
    await execute({
      runId: "run-no-sandbox",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OMP Builder",
        adapterType: "omp_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "omp",
        model: "openai/gpt-4o",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async (stream: string, text: string) => {
        logs.push({ stream, text });
      },
    });

    const allText = logs.map((entry) => entry.text).join("");
    expect(allText).not.toContain("Confining OMP");

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { localProcessSandbox?: unknown }]
      | undefined;
    expect(call).toBeDefined();
    expect(call![4]?.localProcessSandbox).toBeFalsy();
  });

  // myrmidon(OPE-12801)
  describe("cancellation of an SSH run", () => {
    type RuntimeEvent = { eventType: string; level?: string; message?: string; payload?: Record<string, unknown> };

    async function makeSshRun(runId: string) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-ssh-cancel-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      const controller = new AbortController();
      const events: RuntimeEvent[] = [];
      const onCancellationReady = vi.fn(async () => undefined);
      const restoreWorkspace = vi.fn(async () => undefined);
      const input = {
        runId,
        authToken: "test-host-api-token",
        executionTarget: {
          kind: "remote" as const,
          transport: "ssh" as const,
          remoteCwd: "/remote/workspace",
          spec: {
            host: "ssh.example.test",
            port: 22,
            username: "ssh-user",
            remoteCwd: "/remote/workspace",
            remoteWorkspacePath: "/remote/workspace",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Builder",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "omp", model: "openai/gpt-4o" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
        signal: controller.signal,
        onCancellationReady,
        onEvent: async (event: RuntimeEvent) => {
          events.push(event);
        },
      };
      const preparedRuntime = {
        workspaceRemoteDir: "/remote/workspace",
        runtimeRootDir: "/remote/runtime",
        assetDirs: { skills: "/remote/runtime/skills", agentConfig: "/remote/runtime/agentConfig" },
        restoreWorkspace,
      };
      return { input, controller, events, onCancellationReady, restoreWorkspace, preparedRuntime };
    }

    function abortedTransfer(): Error {
      return Object.assign(new Error("Workspace upload was cancelled"), { code: "ssh_operation_aborted" });
    }

    it("does not start OMP and does not restore the workspace when the run is cancelled during the exchange", async () => {
      const run = await makeSshRun("run-cancel-during-prepare");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async (prepareInput) => {
        // The exchange gets the run's signal and ends with the cancellation.
        expect(prepareInput?.signal).toBe(run.controller.signal);
        run.controller.abort(new Error("Cancelled by control plane"));
        throw abortedTransfer();
      });

      const result = await execute(run.input);

      expect(run.onCancellationReady).toHaveBeenCalledTimes(1);
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
      expect(run.restoreWorkspace).not.toHaveBeenCalled();
      expect(result.errorCode).toBe("cancelled");
      expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
      expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    });

    it("does not start the exchange for a run that is already cancelled", async () => {
      const run = await makeSshRun("run-cancel-before-prepare");
      run.onCancellationReady.mockImplementationOnce(async () => {
        run.controller.abort(new Error("Cancelled by control plane"));
      });

      const result = await execute(run.input);

      expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
      expect(result.errorCode).toBe("cancelled");
    });

    it("does not restore the workspace after a cancellation during OMP and records why", async () => {
      const run = await makeSshRun("run-cancel-during-omp");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        expect(options?.signal).toBe(run.controller.signal);
        run.controller.abort(new Error("Cancelled by control plane"));
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        };
      });

      await execute(run.input);

      expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
      expect(run.restoreWorkspace).not.toHaveBeenCalled();
      expect(run.events).toEqual([
        expect.objectContaining({
          eventType: "lifecycle",
          level: "warn",
          payload: { reason: "run_cancelled", runtimeRootDir: "/remote/runtime" },
        }),
      ]);
    });

    it("records an error event when the run's processes could not be stopped on the runner", async () => {
      const run = await makeSshRun("run-cancel-survivor");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        run.controller.abort(new Error("Cancelled by control plane"));
        const onRemoteRunStop = options?.onRemoteRunStop as (report: Record<string, unknown>) => Promise<void>;
        await onRemoteRunStop({ ok: true, found: 2, survivors: 0, forced: false, survivorPids: [], error: null });
        await onRemoteRunStop({ ok: false, found: 2, survivors: 1, forced: true, survivorPids: [4242], error: null });
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        };
      });

      await execute(run.input);

      const errors = run.events.filter((event) => event.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("4242");
      expect(errors[0].payload).toMatchObject({ reason: "remote_run_stop_failed", survivors: 1, survivorPids: [4242] });
    });

    // myrmidon(OMP-RUN-GUARD-2): the adapter stops the local ssh client itself.
    function registerClient(runId: string) {
      const kill = vi.fn(() => true);
      runningProcesses.set(runId, {
        child: { pid: 4242, exitCode: null, signalCode: null, kill } as never,
        graceSec: 20,
        processGroupId: null,
      });
      return kill;
    }
    const signalledResult = () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });

    it("signals the local ssh client when the run is cancelled while OMP is running", async () => {
      const run = await makeSshRun("run-cancel-signals-client");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);
      let kill = vi.fn(() => true);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (runId) => {
        kill = registerClient(runId!);
        try {
          expect(kill).not.toHaveBeenCalled();
          run.controller.abort(new Error("Cancelled before issue reassignment"));
          // The board did not get to the process: the adapter signals it.
          expect(kill).toHaveBeenCalledTimes(1);
          expect(kill).toHaveBeenCalledWith("SIGTERM");
        } finally {
          runningProcesses.delete(runId!);
        }
        return signalledResult();
      });

      await execute(run.input);

      expect(kill).toHaveBeenCalledTimes(1);
    });

    it("signals the local ssh client at its start when the run was cancelled before it was registered", async () => {
      const run = await makeSshRun("run-cancel-before-client");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);
      const spawned = vi.fn(async () => undefined);
      let kill = vi.fn(() => true);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (runId, _target, _command, _args, options) => {
        // The abort found no process to stop: the client is not registered yet.
        run.controller.abort(new Error("Cancelled before issue reassignment"));
        kill = registerClient(runId!);
        try {
          await (options?.onSpawn as (meta: Record<string, unknown>) => Promise<void>)({ pid: 4242, startedAt: "now" });
          expect(kill).toHaveBeenCalledWith("SIGTERM");
        } finally {
          runningProcesses.delete(runId!);
        }
        return signalledResult();
      });

      await execute({ ...run.input, onSpawn: spawned });

      expect(spawned).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it("leaves the client of a run that is not cancelled alone", async () => {
      const run = await makeSshRun("run-not-cancelled-client");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);
      let kill = vi.fn(() => true);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (runId, _target, _command, _args, options) => {
        kill = registerClient(runId!);
        try {
          await (options?.onSpawn as (meta: Record<string, unknown>) => Promise<void>)({ pid: 4242, startedAt: "now" });
        } finally {
          runningProcesses.delete(runId!);
        }
        return { ...signalledResult(), exitCode: 0, signal: null };
      });

      await execute(run.input);
      // Aborting after the run ended does not signal anything either.
      run.controller.abort(new Error("late"));

      expect(kill).not.toHaveBeenCalled();
    });

    it("restores the workspace of an SSH run that was not cancelled", async () => {
      const run = await makeSshRun("run-ssh-not-cancelled");
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => run.preparedRuntime);

      const result = await execute(run.input);

      expect(run.onCancellationReady).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(0);
      expect(run.restoreWorkspace).toHaveBeenCalledTimes(1);
      expect(run.events).toEqual([]);
    });

    it("does not opt a sandbox run into signal-based cancellation", async () => {
      const run = await makeSshRun("run-sandbox-no-opt-in");

      await execute({
        ...run.input,
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "test",
          remoteCwd: "/remote/workspace",
          runner: {
            execute: async () => ({
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: 1,
              startedAt: new Date().toISOString(),
            }),
          } as never,
        },
      });

      expect(run.onCancellationReady).not.toHaveBeenCalled();
      const prepareCall = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
      expect(prepareCall?.signal).toBeUndefined();
    });

    // myrmidon(OMP-RUN-GUARD-2): both stops of the local ssh client go through one function.
  });

  // myrmidon(OMP-RUN-GUARD): the board's run guard is fed from omp's event
  // stream. Before this an omp run had no model call limit at all.
  describe("run guard", () => {
    type StreamLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    type RuntimeEvent = { eventType: string; level?: string; message?: string; payload?: Record<string, unknown> };

    const TURN_START = `${JSON.stringify({ type: "turn_start" })}\n`;
    const WRITE_CALL = `${JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-edit",
      toolName: "edit",
      args: { path: "src/a.ts" },
    })}\n`;
    const WRAP_UP_TEXT = buildRunGuardHintMessage({ reason: "model_call_limit", modelCalls: 135, remaining: 15 });
    const steerDir = path.join(os.homedir(), ".omp", "paperclips", "company-1", "agent-1", ".myrmidon");
    const stoppedProcess = (): ProcessResultShape => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    });

    async function makeLocalRun(runId: string) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-run-guard-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      const logs: string[] = [];
      const input = {
        runId,
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Builder",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "omp", model: "openai/gpt-4o" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
      };
      const steerFile = path.join(steerDir, `steer-${runId}.txt`);
      return { input, logs, steerFile };
    }

    afterEach(async () => {
      await rm(steerDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it("loads the steer extension and names the steer file when the run has a guard", async () => {
      const run = await makeLocalRun("run-guard-args");

      await execute({ ...run.input, runGuard: new RunGuard() });

      const call = runAdapterExecutionTargetProcess.mock.calls[0];
      const args = call?.[3] ?? [];
      const extensionPath = path.join(steerDir, OMP_STEER_EXTENSION_FILE);
      expect(args[args.indexOf("--extension") + 1]).toBe(extensionPath);
      expect(call?.[4]?.env?.[OMP_STEER_FILE_ENV]).toBe(run.steerFile);
      expect(await readFile(extensionPath, "utf8")).toBe(OMP_STEER_EXTENSION_SOURCE);
    });

    it("does not change the command of a run without a guard", async () => {
      const run = await makeLocalRun("run-guard-absent");

      await execute(run.input);

      const call = runAdapterExecutionTargetProcess.mock.calls[0];
      expect(call?.[3]).not.toContain("--extension");
      expect(call?.[4]?.env?.[OMP_STEER_FILE_ENV]).toBeUndefined();
    });

    it("leaves the wrap-up hint in the steer file 15 model calls before the limit and lets the run go on", async () => {
      const run = await makeLocalRun("run-guard-wrap-up");
      const guard = new RunGuard();
      const onRunGuardStop = vi.fn(async (_reason: RunGuardStopReason) => undefined);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        const onLog = options?.onLog as StreamLog;
        // 134 calls: nothing is said yet.
        await onLog("stdout", TURN_START.repeat(134));
        await expect(readFile(run.steerFile, "utf8")).rejects.toThrow();
        // The 135th call arrives split across two chunks of the stream.
        await onLog("stdout", TURN_START.slice(0, 9));
        await onLog("stdout", TURN_START.slice(9));
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 4242, startedAt: new Date().toISOString() };
      });

      const result = await execute({ ...run.input, runGuard: guard, onRunGuardStop });

      expect(guard.stats().modelCalls).toBe(135);
      expect(await readFile(run.steerFile, "utf8")).toBe(WRAP_UP_TEXT);
      expect(run.logs.join("")).toContain("Run guard hint left for OMP (wrap-up, 15 model calls left)");
      expect(onRunGuardStop).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();
    });

    it("stops the OMP process on the first model call past the limit and reports the guard's reason", async () => {
      const run = await makeLocalRun("run-guard-stop");
      const guard = new RunGuard();
      const onRunGuardStop = vi.fn(async (_reason: RunGuardStopReason) => undefined);
      const kill = vi.fn(() => true);
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (runId, _target, _command, _args, options) => {
        const onLog = options?.onLog as StreamLog;
        // What runChildProcess registers for the run: the adapter signals this child.
        runningProcesses.set(runId!, {
          child: { pid: 4242, exitCode: null, signalCode: null, kill } as never,
          graceSec: 20,
          processGroupId: null,
        });
        try {
          await onLog("stdout", WRITE_CALL + TURN_START.repeat(150));
          expect(kill).not.toHaveBeenCalled();
          expect(onRunGuardStop).not.toHaveBeenCalled();
          // The 151st model call.
          await onLog("stdout", TURN_START);
          expect(onRunGuardStop).toHaveBeenCalledTimes(1);
          expect(kill).toHaveBeenCalledTimes(1);
          // omp may still print before it dies; the stop is not repeated.
          await onLog("stdout", TURN_START + WRITE_CALL);
        } finally {
          runningProcesses.delete(runId!);
        }
        return stoppedProcess();
      });

      const result = await execute({ ...run.input, runGuard: guard, onRunGuardStop });

      expect(onRunGuardStop).toHaveBeenCalledTimes(1);
      expect(onRunGuardStop).toHaveBeenCalledWith("model_call_limit");
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(result.errorCode).toBe("model_call_limit");
      expect(result.errorMessage).toBe("OMP was stopped by the run guard: model_call_limit.");
      expect(result.signal).toBe("SIGTERM");
      // The board reads these to decide whether the run is continued.
      expect(guard.stats()).toMatchObject({ modelCalls: 150, writeCalls: 1 });
      expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
      expect(run.logs.join("")).toContain("Run guard stopped OMP: model_call_limit (150 model calls)");
    });

    it("on an SSH run delivers the hint over ssh and restores the workspace after a guard stop", async () => {
      const run = await makeLocalRun("run-guard-ssh");
      const guard = new RunGuard();
      const controller = new AbortController();
      const events: RuntimeEvent[] = [];
      const restoreWorkspace = vi.fn(async () => undefined);
      let stagedAgentConfigFiles: string[] = [];
      // The board aborts the run's signal when the guard stops the run.
      const onRunGuardStop = vi.fn(async (reason: RunGuardStopReason) => {
        controller.abort(new Error(reason));
      });
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async (prepareInput) => {
        const agentConfig = prepareInput?.assets?.find((asset) => asset.key === "agentConfig");
        stagedAgentConfigFiles = agentConfig ? await readdir(agentConfig.localDir) : [];
        return {
          workspaceRemoteDir: "/remote/workspace",
          runtimeRootDir: "/remote/runtime",
          assetDirs: { skills: "/remote/runtime/skills", agentConfig: "/remote/runtime/agentConfig" },
          restoreWorkspace,
        };
      });
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        const onLog = options?.onLog as StreamLog;
        await onLog("stdout", WRITE_CALL + TURN_START.repeat(151));
        return stoppedProcess();
      });

      const result = await execute({
        ...run.input,
        authToken: "test-host-api-token",
        executionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/remote/workspace",
          spec: {
            host: "ssh.example.test",
            port: 22,
            username: "ssh-user",
            remoteCwd: "/remote/workspace",
            remoteWorkspacePath: "/remote/workspace",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
        signal: controller.signal,
        onCancellationReady: async () => undefined,
        onEvent: async (event: RuntimeEvent) => {
          events.push(event);
        },
        runGuard: guard,
        onRunGuardStop,
      });

      // The extension travels with the agent config; the steer file is on the runner.
      expect(stagedAgentConfigFiles).toContain(OMP_STEER_EXTENSION_FILE);
      const call = runAdapterExecutionTargetProcess.mock.calls[0];
      const args = call?.[3] ?? [];
      expect(args[args.indexOf("--extension") + 1]).toBe(`/remote/runtime/agentConfig/${OMP_STEER_EXTENSION_FILE}`);
      const remoteSteerFile = "/remote/runtime/sessions/company-1/agent-1/.myrmidon/steer-run-guard-ssh.txt";
      expect(call?.[4]?.env?.[OMP_STEER_FILE_ENV]).toBe(remoteSteerFile);

      const steerWrites = runAdapterExecutionTargetShellCommand.mock.calls
        .map((shellCall) => String(shellCall[2] ?? ""))
        .filter((command) => command.includes("steer-run-guard-ssh.txt"));
      expect(steerWrites).toHaveLength(1);
      expect(steerWrites[0]).toContain(`printf '%s' '${WRAP_UP_TEXT}' > '${remoteSteerFile}.tmp'`);
      expect(steerWrites[0]).toContain(`mv '${remoteSteerFile}.tmp' '${remoteSteerFile}'`);

      expect(onRunGuardStop).toHaveBeenCalledWith("model_call_limit");
      expect(controller.signal.aborted).toBe(true);
      expect(result.errorCode).toBe("model_call_limit");
      // A guard stop is not a cancellation: the work comes back from the runner.
      expect(restoreWorkspace).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.payload?.reason === "run_cancelled")).toEqual([]);
    });
  });

  // myrmidon(OMP-RUN-GUARD-3): a retry continues the session of the run it replaces.
  describe("session continuity of an SSH run", () => {
    const BASE = "/remote/workspace";
    const SESSION_ROOT = `${BASE}/.paperclip-runtime/omp-sessions/company-1/agent-1/task-1`;
    const OLD_CWD = `${BASE}/.paperclip-runtime/runs/run-old/workspace`;
    const NEW_CWD = `${BASE}/.paperclip-runtime/runs/run-session/workspace`;
    const SESSION_FILE = `${SESSION_ROOT}/2026-11-13_abc.jsonl`;
    const sshTarget = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: BASE,
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: BASE,
        remoteWorkspacePath: BASE,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };
    const shellOk = (stdout = "") => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });
    const defaultShell = async () => shellOk();

    async function makeRun(runId: string, sessionParams: Record<string, unknown> | null) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-ssh-session-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => ({
        workspaceRemoteDir: NEW_CWD,
        runtimeRootDir: `${NEW_CWD}/.paperclip-runtime/omp`,
        assetDirs: {
          skills: `${NEW_CWD}/.paperclip-runtime/omp/skills`,
          agentConfig: `${NEW_CWD}/.paperclip-runtime/omp/agentConfig`,
        },
        restoreWorkspace: vi.fn(async () => undefined),
      }));
      return {
        runId,
        authToken: "test-host-api-token",
        executionTarget: sshTarget,
        agent: { id: "agent-1", companyId: "company-1", name: "OMP Builder", adapterType: "omp_local", adapterConfig: {} },
        runtime: {
          sessionId: sessionParams ? String(sessionParams.sessionId) : null,
          sessionParams,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: { command: "omp", model: "openai/gpt-4o" },
        context: { taskId: "task-1", paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        onLog: async () => {},
      };
    }

    const savedParams = {
      sessionId: SESSION_FILE,
      cwd: OLD_CWD,
      remoteExecution: { transport: "ssh", host: "ssh.example.test", port: 22, username: "ssh-user", remoteCwd: BASE },
    };

    it("keeps the sessions of an SSH run outside the run's directory", async () => {
      const input = await makeRun("run-session", null);

      await execute(input);

      const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? [];
      expect(args[args.indexOf("--session-dir") + 1]).toBe(SESSION_ROOT);
      expect(args).not.toContain("--session");
      // Sessions of earlier runs are pruned by age, only below the sessions root.
      const prune = runAdapterExecutionTargetShellCommand.mock.calls
        .map((call) => String(call[2] ?? ""))
        .find((command) => command.startsWith("find "));
      expect(prune).toContain(`'${BASE}/.paperclip-runtime/omp-sessions'`);
      expect(prune).toContain("-mtime +14 -delete");
    });

    it("resumes the session of an earlier run after pointing its header at this run's workspace copy", async () => {
      const input = await makeRun("run-session", savedParams);
      let headerCwd = OLD_CWD;
      const commands: string[] = [];
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        const text = String(command ?? "");
        commands.push(text);
        if (text.includes("sed -i")) {
          headerCwd = NEW_CWD;
          return shellOk();
        }
        if (text.includes("head -n")) return shellOk(`${JSON.stringify({ type: "session", id: "abc", cwd: headerCwd })}\n`);
        return shellOk();
      });
      try {
        await execute(input);
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? [];
      expect(args[args.indexOf("--session") + 1]).toBe(SESSION_FILE);
      const rewrite = commands.find((command) => command.includes("sed -i"));
      expect(rewrite).toContain(`"cwd":"${OLD_CWD}"#"cwd":"${NEW_CWD}"`);
      expect(rewrite).toContain(`'${SESSION_FILE}'`);
    });

    it("starts a fresh session when the header cannot be moved to this run's workspace copy", async () => {
      const input = await makeRun("run-session", savedParams);
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        const text = String(command ?? "");
        if (text.includes("sed -i")) return { ...shellOk(), exitCode: 1 };
        if (text.includes("head -n")) return shellOk(`${JSON.stringify({ type: "session", id: "abc", cwd: OLD_CWD })}\n`);
        return shellOk();
      });
      try {
        await execute(input);
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? [];
      expect(args).not.toContain("--session");
      expect(args[args.indexOf("--session-dir") + 1]).toBe(SESSION_ROOT);
    });

    it("does not resume a session of another task of the same agent", async () => {
      const otherTaskFile = `${BASE}/.paperclip-runtime/omp-sessions/company-1/agent-1/task-2/2026-11-13_def.jsonl`;
      const input = await makeRun("run-session", { ...savedParams, sessionId: otherTaskFile });
      const commands: string[] = [];
      // The header of the file is fine: the file itself is the wrong one.
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        const text = String(command ?? "");
        commands.push(text);
        if (text.includes("head -n")) return shellOk(`${JSON.stringify({ type: "session", id: "def", cwd: OLD_CWD })}\n`);
        return shellOk();
      });
      try {
        await execute(input);
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? [];
      expect(args).not.toContain("--session");
      expect(args[args.indexOf("--session-dir") + 1]).toBe(SESSION_ROOT);
      // The foreign file is not touched.
      expect(commands.some((command) => command.includes(otherTaskFile) && command.includes("sed -i"))).toBe(false);
    });

    it("does not resume a session of another agent", async () => {
      const otherAgentFile = `${BASE}/.paperclip-runtime/omp-sessions/company-1/agent-9/task-1/x.jsonl`;
      const input = await makeRun("run-session", { ...savedParams, sessionId: otherAgentFile });
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) =>
        String(command ?? "").includes("head -n")
          ? shellOk(`${JSON.stringify({ type: "session", id: "x", cwd: OLD_CWD })}\n`)
          : shellOk(),
      );
      try {
        await execute(input);
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      expect(runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? []).not.toContain("--session");
    });

    it("links the agent's persistent skill description cache into the agent dir of the run", async () => {
      const input = await makeRun("run-session", null);

      await execute(input);

      const AGENT_CONFIG = `${NEW_CWD}/.paperclip-runtime/omp/agentConfig`;
      const CACHE = `${BASE}/.paperclip-runtime/omp-skill-cache/company-1/agent-1`;
      const link = runAdapterExecutionTargetShellCommand.mock.calls
        .map((call) => String(call[2] ?? ""))
        .find((command) => command.includes("ln -sfn"));
      expect(link).toBe(
        `mkdir -p '${CACHE}' && ln -sfn '${CACHE}/skill-descriptions.db' '${AGENT_CONFIG}/skill-descriptions.db'`,
      );
      expect(buildSkillDescriptionsLinkCommand(AGENT_CONFIG, CACHE)).toBe(link);
    });

    it("runs on when the skill description cache cannot be linked", async () => {
      const input = await makeRun("run-session", null);
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        if (String(command ?? "").includes("ln -sfn")) throw new Error("ssh lost");
        return shellOk();
      });
      try {
        await execute(input);
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    });

    it("drops the task's session after the run guard stopped the run, so the next run starts a new one", async () => {
      const input = await makeRun("run-session", null);
      const guard = new RunGuard();
      let listed = 0;
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        if (String(command ?? "").includes("ls -1t")) {
          listed += 1;
          return shellOk(listed >= 2 ? `${SESSION_FILE}\n` : "");
        }
        return shellOk();
      });
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        const onLog = options?.onLog as (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        await onLog("stdout", `${JSON.stringify({ type: "turn_start" })}\n`.repeat(151));
        return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: new Date().toISOString() };
      });
      let result;
      try {
        result = await execute({ ...input, runGuard: guard, onRunGuardStop: async () => undefined });
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      expect(result.errorCode).toBe("model_call_limit");
      expect(result.clearSession).toBe(true);
      expect(result.sessionId ?? null).toBeNull();
      expect(result.sessionParams ?? null).toBeNull();
    });

    it("does not resume a session that is missing on the runner", async () => {
      const input = await makeRun("run-session", savedParams);
      // The default shell mock prints no header: the file is not there.

      await execute(input);

      const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] ?? [];
      expect(args).not.toContain("--session");
    });

    it("reports the session to the board when omp has written it, before the run ends", async () => {
      const input = await makeRun("run-session", null);
      const onSessionCreated = vi.fn(async () => undefined);
      let listed = 0;
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, command) => {
        const text = String(command ?? "");
        if (text.includes("ls -1t")) {
          listed += 1;
          // Empty before the run starts and after the first turn the file is there.
          return shellOk(listed >= 2 ? `${SESSION_FILE}\n` : "");
        }
        return shellOk();
      });
      runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        const onLog = options?.onLog as (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        await onLog("stdout", `${JSON.stringify({ type: "turn_start" })}\n`);
        expect(onSessionCreated).not.toHaveBeenCalled();
        await onLog("stdout", `${JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] })}\n`);
        // The board has the session while omp is still running.
        expect(onSessionCreated).toHaveBeenCalledTimes(1);
        return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: new Date().toISOString() };
      });
      try {
        await execute({ ...input, onSessionCreated });
      } finally {
        runAdapterExecutionTargetShellCommand.mockImplementation(defaultShell);
      }

      expect(onSessionCreated).toHaveBeenCalledWith({
        sessionParams: expect.objectContaining({ sessionId: SESSION_FILE, cwd: NEW_CWD }),
        sessionDisplayId: SESSION_FILE,
      });
    });
  });

  it("passes workspaceSyncMode: \"full\" by default and \"git_checkout\" when configured", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-omp-workspace-sync-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const runExecute = (workspaceSync?: string) =>
      execute({
        runId: "run-workspace-sync",
        authToken: "test-host-api-token",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "test",
          remoteCwd: "/remote/workspace",
          // Sandbox targets execute through the provider runtime runner; session listing
          // (ls on the target) goes through it, so the test supplies a minimal one.
          runner: {
            execute: async () => ({
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: 1,
              startedAt: new Date().toISOString(),
            }),
          } as never,
        },
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Builder",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "omp",
          model: "openai/gpt-4o",
          // myrmidon(OPE-12795): the adapter reads workspaceSync from the resolved config.
          ...(workspaceSync ? { workspaceSync } : {}),
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      });

    await runExecute(undefined);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceSyncMode: "full" }),
    );

    await runExecute("git_checkout");
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceSyncMode: "git_checkout" }),
    );
  });
});
