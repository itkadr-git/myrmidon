import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetOmpModelsCacheForTests } from "./models.js";

const {
  runAdapterExecutionTargetProcess,
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
});
