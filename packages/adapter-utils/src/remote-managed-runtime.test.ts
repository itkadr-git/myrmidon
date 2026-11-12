import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from('{"token":"remote"}\n').toString("base64"),
    stderr: "",
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

import {
  buildRemoteRunDirectoryRemoveCommand,
  buildStaleRemoteRunsPruneCommand,
  prepareRemoteManagedRuntime,
  type PreparedRemoteManagedRuntime,
  type RemoteManagedRuntimeAsset,
} from "./remote-managed-runtime.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { setExpensiveWorkspaceGitExecutor } from "./git-workspace-sync.js";

describe("remote managed runtime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("restores runtime assets without restoring an in-place SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-assets-only-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    let restoredAuth = "";
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: homeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.posix.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: homeDir,
      remoteDir: "/app/.paperclip-runtime/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/codex/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
  });

  it("stages each additional project into its own isolated SSH dir, isolating one failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-additional-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const firstDir = path.join(rootDir, "referenced-first");
    const secondDir = path.join(rootDir, "referenced-second");
    const brokenDir = path.join(rootDir, "referenced-broken");
    await mkdir(workspaceDir, { recursive: true });

    // The transfer rejects only for the broken project's directory.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string }) => {
      if (input.localDir === brokenDir) throw new Error("ssh transfer failed");
      return undefined;
    });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-additional",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: firstDir, projectId: "first", ignoreResolution: { kind: "other" } },
        { localPath: brokenDir, projectId: "broken", ignoreResolution: { kind: "other" } },
        { localPath: secondDir, projectId: "second", ignoreResolution: { kind: "other" } },
      ],
    });

    // Each healthy project staged into its OWN isolated dir under the runtime
    // root; the broken one is skipped, not fatal.
    expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["first", "second"]);
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/codex/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/codex/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-second",
    }));
  });

  it("skips an additional project whose localPath is not absolute", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-relative-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-relative",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: "relative/referenced", projectId: "relative", ignoreResolution: { kind: "other" } },
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
      ],
    });

    // The relative-path project never reaches the transfer and is skipped; the
    // absolute-path project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({
      localDir: "relative/referenced",
    }));
  });

  it("passes a project's resolved Git-ignored paths to the SSH exclude list, escaped", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-ignore-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const projectDir = path.join(rootDir, "referenced-project");
    await mkdir(workspaceDir, { recursive: true });

    await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ignore",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        {
          localPath: projectDir,
          projectId: "proj",
          ignoreResolution: { kind: "git", ignoredPaths: ["secret.env", "build", "weird[1].txt"] },
        },
      ],
    });

    const call = syncDirectoryToSsh.mock.calls.find((entry) => entry[0].localDir === projectDir);
    expect(call).toBeDefined();
    const exclude = (call![0] as { exclude?: string[] }).exclude ?? [];
    // The resolved ignored paths ride the exclude list, glob-escaped, on top of
    // the fixed heavy-directory excludes the SSH lane already applies.
    expect(exclude).toContain("secret.env");
    expect(exclude).toContain("build");
    expect(exclude).toContain("weird\\[1].txt");
    expect(exclude).toContain("node_modules");
  });

  it("skips a project whose ignore resolution failed without ever calling syncDirectoryToSsh for it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-failed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
        { localPath: failedDir, projectId: "failed", ignoreResolution: { kind: "failed", reason: "git status timed out" } },
      ],
    });

    // Fail closed: the failed project never reaches the transfer at all — no
    // bytes are sent for it — while the healthy project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: failedDir }));
  });

  it("never leaks a raw absolute path into the remote per-project staging warning", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-redact-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });

    // A raw toplevel string that makes `failedDir` a non-descendant, carrying
    // a sensitive absolute path — exactly the shape a caught Git diagnostic
    // could embed. `resolveReferencedSourceIgnore` is the single choke point
    // that must reduce it to the fixed category before anything downstream
    // (here, the remote lane's warning) ever sees it.
    const sensitivePath = "/srv/alice/project";
    let ignoreResolution;
    try {
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.toplevel") {
          return { stdout: `${sensitivePath}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      ignoreResolution = await resolveReferencedSourceIgnore(failedDir);
    } finally {
      setExpensiveWorkspaceGitExecutor(null);
    }
    expect(ignoreResolution.kind).toBe("failed");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await prepareRemoteManagedRuntime({
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "KNOWN HOSTS",
          strictHostKeyChecking: true,
        },
        runId: "run-redact",
        adapterKey: "codex",
        workspaceLocalDir: workspaceDir,
        workspaceRemoteDir: "/app",
        syncWorkspace: false,
        additionalSources: [{ localPath: failedDir, projectId: "failed", ignoreResolution }],
      });

      const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnedText).toContain("failed");
      expect(warnedText).not.toContain(sensitivePath);
      expect(warnedText).not.toContain(failedDir);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("remote managed runtime: run directory cleanup (OPE-12633, OPE-12664)", () => {
  const cleanupDirs: string[] = [];
  const spec = {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/workspace",
    remoteCwd: "/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "KNOWN HOSTS",
    strictHostKeyChecking: true,
  };

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function prepareSynced(runId: string, assets?: RemoteManagedRuntimeAsset[]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-cleanup-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
    return prepareRemoteManagedRuntime({
      spec,
      runId,
      adapterKey: "omp",
      workspaceLocalDir: workspaceDir,
      assets,
    });
  }

  const sshCommands = () => runSshCommand.mock.calls.map((call) => (call as unknown[])[1]);
  const isRemoveCommand = (command: unknown) => String(command).includes("rm -rf -- ");
  const removeCommands = () => sshCommands().filter(isRemoveCommand);
  // The pid file of the file bridge below a run's runtime root.
  const bridgePidFile = (runId: string) =>
    `/workspace/.paperclip-runtime/runs/${runId}/workspace/.paperclip-runtime/omp/paperclip-bridge/queue/server.pid`;
  const removeCommand = (runId: string) =>
    buildRemoteRunDirectoryRemoveCommand("/workspace", runId, bridgePidFile(runId));

  // The adapters call `restoreWorkspace` from the `finally` of their execute, so
  // a run that failed or was cancelled reaches it exactly like a successful one.
  async function runLikeAnAdapter(prepared: PreparedRemoteManagedRuntime, execute: () => Promise<void>) {
    try {
      await execute();
    } finally {
      await prepared.restoreWorkspace();
    }
  }

  function expectRemovalAfterRestore() {
    const removeIndex = sshCommands().findIndex(isRemoveCommand);
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(restoreWorkspaceFromSshExecution.mock.invocationCallOrder[0]).toBeLessThan(
      runSshCommand.mock.invocationCallOrder[removeIndex],
    );
  }

  it("prunes stale run directories before a synced run and removes the run's directory after the restore", async () => {
    const prepared = await prepareSynced("run-cleanup");
    expect(prepared.workspaceRemoteDir).toBe("/workspace/.paperclip-runtime/runs/run-cleanup/workspace");
    expect(sshCommands()).toEqual([buildStaleRemoteRunsPruneCommand("/workspace")]);

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(sshCommands()).toEqual([
      buildStaleRemoteRunsPruneCommand("/workspace"),
      removeCommand("run-cleanup"),
    ]);
    expectRemovalAfterRestore();
  });

  it("builds a removal command for one run directory, stopping the bridge first, and quotes the paths", () => {
    expect(buildRemoteRunDirectoryRemoveCommand("/workspace", "r1")).toBe(
      "if [ -d '/workspace/.paperclip-runtime/runs/r1' ]; then rm -rf -- '/workspace/.paperclip-runtime/runs/r1'; fi",
    );
    expect(
      buildRemoteRunDirectoryRemoveCommand(
        "/work space",
        "r1",
        "/work space/.paperclip-runtime/runs/r1/workspace/.paperclip-runtime/omp/paperclip-bridge/queue/server.pid",
      ),
    ).toBe(
      "if [ -d '/work space/.paperclip-runtime/runs/r1' ]; then " +
        "p=$(cat '/work space/.paperclip-runtime/runs/r1/workspace/.paperclip-runtime/omp/paperclip-bridge/queue/server.pid' 2>/dev/null); " +
        '[ "$p" -gt 1 ] 2>/dev/null && kill "$p" 2>/dev/null; ' +
        "rm -rf -- '/work space/.paperclip-runtime/runs/r1'; fi",
    );
    expect(buildStaleRemoteRunsPruneCommand("/work space")).toBe(
      "if [ -d '/work space/.paperclip-runtime/runs' ]; then find '/work space/.paperclip-runtime/runs' -mindepth 1 -maxdepth 1 -type d -mmin +240 -exec rm -rf {} +; fi",
    );
  });

  it("refuses a run id that is not a single path segment, so the command can never reach another run's directory", () => {
    for (const unsafe of ["", ".", "..", "a/b", "../other-run", "/abs", "a\\b", "a\0b"]) {
      expect(() => buildRemoteRunDirectoryRemoveCommand("/workspace", unsafe)).toThrow(/single path segment/);
    }
  });

  it("removes the run directory after a failed execute, not only after a successful run", async () => {
    const prepared = await prepareSynced("run-failed");

    await expect(
      runLikeAnAdapter(prepared, async () => {
        throw new Error("omp exited with code 1");
      }),
    ).rejects.toThrow("omp exited with code 1");

    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(removeCommands()).toEqual([removeCommand("run-failed")]);
    expectRemovalAfterRestore();
  });

  it("removes the run directory after an aborted (cancelled) run", async () => {
    const prepared = await prepareSynced("run-aborted");
    const controller = new AbortController();
    const run = runLikeAnAdapter(
      prepared,
      () =>
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
    );

    controller.abort(new Error("run cancelled"));

    await expect(run).rejects.toThrow("run cancelled");
    expect(removeCommands()).toEqual([removeCommand("run-aborted")]);
    expectRemovalAfterRestore();
  });

  it("removes the run directory when the restore fails, and the restore error still reaches the caller", async () => {
    const prepared = await prepareSynced("run-restore-fails");
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("ssh export failed"));

    await expect(prepared.restoreWorkspace()).rejects.toThrow("ssh export failed");

    expect(sshCommands()).toEqual([
      buildStaleRemoteRunsPruneCommand("/workspace"),
      removeCommand("run-restore-fails"),
    ]);
    expectRemovalAfterRestore();
  });

  it("removes the run directory when the restore itself is aborted", async () => {
    const prepared = await prepareSynced("run-restore-aborted");
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );

    await expect(prepared.restoreWorkspace()).rejects.toThrow("The operation was aborted");

    expect(removeCommands()).toEqual([removeCommand("run-restore-aborted")]);
    expectRemovalAfterRestore();
  });

  it("removes the run directory when an asset restore fails", async () => {
    const prepared = await prepareSynced("run-asset-restore-fails", [
      {
        key: "agentConfig",
        localDir: os.tmpdir(),
        restore: async () => {
          throw new Error("asset restore failed");
        },
      },
    ]);

    await expect(prepared.restoreWorkspace()).rejects.toThrow("asset restore failed");

    expect(removeCommands()).toEqual([removeCommand("run-asset-restore-fails")]);
    expectRemovalAfterRestore();
  });

  it("removes only this run's directory, never another run's", async () => {
    const first = await prepareSynced("run-one");
    await prepareSynced("run-two");
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("ssh export failed"));

    await expect(first.restoreWorkspace()).rejects.toThrow("ssh export failed");

    expect(removeCommands()).toEqual([removeCommand("run-one")]);
    expect(removeCommands().join("\n")).not.toContain("run-two");
    // The command names the run's own directory, not the shared `runs` directory.
    expect(String(removeCommands()[0])).toContain("rm -rf -- '/workspace/.paperclip-runtime/runs/run-one'");
  });

  it("does not remove anything for a run id that is not a single path segment", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const prepared = await prepareSynced("..");
      await prepared.restoreWorkspace();

      expect(removeCommands()).toEqual([]);
      expect(warnSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("remove the run directory");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("removes the copy of a run whose workspace upload fails, since no restore will follow", async () => {
    prepareWorkspaceForSshExecution.mockRejectedValueOnce(new Error("ssh upload failed"));

    await expect(prepareSynced("run-upload-fails")).rejects.toThrow("ssh upload failed");

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(sshCommands()).toEqual([
      buildStaleRemoteRunsPruneCommand("/workspace"),
      removeCommand("run-upload-fails"),
    ]);
  });

  it("removes the copy of a run whose asset staging fails, after restoring the workspace", async () => {
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("asset transfer failed"));

    await expect(
      prepareSynced("run-asset-fails", [{ key: "agentConfig", localDir: os.tmpdir() }]),
    ).rejects.toThrow("asset transfer failed");

    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(removeCommands()).toEqual([removeCommand("run-asset-fails")]);
    expectRemovalAfterRestore();
  });

  it("does not fail the run when a cleanup command fails", async () => {
    runSshCommand.mockRejectedValueOnce(new Error("prune refused"));
    const prepared = await prepareSynced("run-cleanup-fails");
    runSshCommand.mockRejectedValueOnce(new Error("rm refused"));

    await expect(prepared.restoreWorkspace()).resolves.toBeUndefined();
    expect(sshCommands()).toHaveLength(2);
  });

  // myrmidon(OPE-12801)
  it("keeps writing output lines while the workspace preparation and the restore are silent", async () => {
    vi.useFakeTimers();
    try {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-pulse-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

      const lines: string[] = [];
      const sink = (line: string) => {
        lines.push(line);
      };

      let finishPrepare: (value: { gitBacked: boolean }) => void = () => {};
      prepareWorkspaceForSshExecution.mockImplementationOnce(
        () => new Promise<{ gitBacked: boolean }>((resolve) => { finishPrepare = resolve; }),
      );
      const preparing = prepareRemoteManagedRuntime({
        spec,
        runId: "run-pulse",
        adapterKey: "omp",
        workspaceLocalDir: workspaceDir,
        onProgress: sink,
      });
      // 25 minutes of a silent preparation: longer than the 20-minute stall threshold.
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(lines.filter((line) => line.startsWith("[paperclip] Preparing workspace for ssh: still working"))).toHaveLength(25);
      finishPrepare({ gitBacked: false });
      vi.useRealTimers();
      const prepared = await preparing;

      vi.useFakeTimers();
      lines.length = 0;
      let finishRestore: () => void = () => {};
      restoreWorkspaceFromSshExecution.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => { finishRestore = () => resolve(undefined); }),
      );
      const restoring = prepared.restoreWorkspace(sink);
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(lines.filter((line) => line.startsWith("[paperclip] Restoring workspace from ssh: still working"))).toHaveLength(25);
      finishRestore();
      await restoring;

      const settled = lines.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(lines).toHaveLength(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a failed removal and still rethrows the restore error, not the removal error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const prepared = await prepareSynced("run-both-fail");
      restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("ssh export failed"));
      runSshCommand.mockRejectedValueOnce(new Error("rm refused"));

      await expect(prepared.restoreWorkspace()).rejects.toThrow("ssh export failed");

      expect(removeCommands()).toEqual([removeCommand("run-both-fail")]);
      expect(warnSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("rm refused");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("runs no cleanup for an in-place (unsynced) workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-in-place-"));
    cleanupDirs.push(rootDir);
    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-in-place",
      adapterKey: "omp",
      workspaceLocalDir: rootDir,
      syncWorkspace: false,
    });
    await prepared.restoreWorkspace();
    expect(sshCommands()).toEqual([]);
  });

  it("runs no cleanup for an in-place (unsynced) workspace, even when the restore fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-in-place-fails-"));
    cleanupDirs.push(rootDir);
    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-in-place-fails",
      adapterKey: "omp",
      workspaceLocalDir: rootDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: rootDir,
          restore: async () => {
            throw new Error("asset restore failed");
          },
        },
      ],
    });

    await expect(prepared.restoreWorkspace()).rejects.toThrow("asset restore failed");

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(sshCommands()).toEqual([]);
  });
});

describe("remote managed runtime: reproducible directories stay out of the exchange (OPE-12809)", () => {
  const cleanupDirs: string[] = [];
  const spec = {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/workspace",
    remoteCwd: "/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "KNOWN HOSTS",
    strictHostKeyChecking: true,
  };

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("passes the caller's excludes to the upload and restores against a baseline without the excluded directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-excludes-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await mkdir(path.join(workspaceDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(workspaceDir, "packages", "db", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(workspaceDir, "src", "edited.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(workspaceDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(path.join(workspaceDir, "packages", "db", "node_modules", "dep", "index.js"), "module.exports = 2;\n", "utf8");

    const resolvedExclude = ["node_modules", "node_modules/*", "*/node_modules", "*/node_modules/*", "custom-cache"];
    const prepareMock = prepareWorkspaceForSshExecution as unknown as {
      mockImplementationOnce: (impl: () => Promise<{ gitBacked: boolean; workspaceExclude: string[] }>) => void;
    };
    prepareMock.mockImplementationOnce(async () => ({ gitBacked: false, workspaceExclude: resolvedExclude }));

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-excludes",
      adapterKey: "omp",
      workspaceLocalDir: workspaceDir,
      workspaceExclude: ["custom-cache"],
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      exclude: ["custom-cache"],
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    const restoreCalls = restoreWorkspaceFromSshExecution.mock.calls as unknown as Array<[{
      baselineSnapshot: { exclude: string[]; entries: Map<string, unknown> };
    }]>;
    const baseline = restoreCalls[0][0].baselineSnapshot;
    // The restore takes its download and merge excludes from the baseline.
    expect(baseline.exclude).toEqual([".paperclip-runtime", ...resolvedExclude]);
    const paths = [...baseline.entries.keys()];
    expect(paths).toContain("src/edited.ts");
    expect(paths).toContain("packages/db");
    expect(paths.filter((entry) => entry.includes("node_modules"))).toEqual([]);
  });

  it("keeps the previous baseline when the workspace preparation reports no excludes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-excludes-none-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-excludes-none",
      adapterKey: "omp",
      workspaceLocalDir: workspaceDir,
    });
    await prepared.restoreWorkspace();

    const restoreCalls = restoreWorkspaceFromSshExecution.mock.calls as unknown as Array<[{
      baselineSnapshot: { exclude: string[] };
    }]>;
    expect(restoreCalls[0][0].baselineSnapshot.exclude).toEqual([".paperclip-runtime"]);
  });
});
