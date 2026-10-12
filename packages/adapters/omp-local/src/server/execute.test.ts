import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetOmpModelsCacheForTests } from "./models.js";

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

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@paperclipai/adapter-utils/execution-target");
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
    prepareAdapterExecutionTargetRuntime: (...args: Parameters<typeof actual.prepareAdapterExecutionTargetRuntime>) => {
      if (args[0]?.adapterKey === "omp") {
        return prepareAdapterExecutionTargetRuntime(...args);
      }
      return actual.prepareAdapterExecutionTargetRuntime(...args);
    },
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
});
