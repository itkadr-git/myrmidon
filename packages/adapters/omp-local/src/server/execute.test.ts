import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetOmpModelsCacheForTests } from "./models.js";

const {
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  prepareAdapterExecutionTargetRuntime,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
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
  })),
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  })),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: "/remote/runtime",
    assetDirs: {
      skills: "/remote/runtime/skills",
      agentConfig: "/remote/runtime/agentConfig",
    },
    restoreWorkspace: vi.fn(async () => undefined),
  })),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "omp"),
}));

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      models: [
        { provider: "openai", id: "gpt-4o", selector: "openai/gpt-4o" },
      ],
    }),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "omp"),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
    runAdapterExecutionTargetShellCommand,
    prepareAdapterExecutionTargetRuntime,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

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
    const firstCallArgs = (runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]])[3];
    const secondCallArgs = (runAdapterExecutionTargetProcess.mock.calls[1] as unknown as [string, unknown, string, string[]])[3];
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
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test",
        spec: {},
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
    const prepareCall = prepareAdapterExecutionTargetRuntime.mock.calls[0][0] as {
      assets: Array<{ key: string; localDir: string; followSymlinks?: boolean }>;
    };
    const skillsAsset = prepareCall.assets.find((a) => a.key === "skills");
    const agentConfigAsset = prepareCall.assets.find((a) => a.key === "agentConfig");
    expect(skillsAsset).toBeDefined();
    expect(skillsAsset?.followSymlinks).toBe(true);
    expect(agentConfigAsset).toBeDefined();
    expect(agentConfigAsset?.followSymlinks).toBe(true);

    const targetProcCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(targetProcCall[4].env.PI_CODING_AGENT_DIR).toBe("/remote/runtime/agentConfig");
    expect(targetProcCall[4].env.OMP_CODING_AGENT_DIR).toBe("/remote/runtime/agentConfig");
  });
});
