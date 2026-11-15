import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type PrepareInput = { signal?: AbortSignal };
type SyncInput = { localDir: string; signal?: AbortSignal };

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async (_input: PrepareInput) => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
  syncDirectoryToSsh: vi.fn(async (_input: SyncInput) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { SshOperationAbortedError, isSshOperationAbortedError } from "./ssh-abort.js";

// myrmidon(OPE-12801)
describe("remote managed runtime: run cancellation", () => {
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

  async function makeWorkspace() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "myrmidon-remote-run-cancel-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const assetDir = path.join(rootDir, "skills");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
    return { workspaceDir, assetDir };
  }

  // A transfer that ends only when the run is cancelled, like the real one.
  function untilAborted(signal: AbortSignal | undefined): Promise<never> {
    return new Promise<never>((_, reject) => {
      const fail = () => reject(new SshOperationAbortedError("Workspace upload"));
      if (!signal) return;
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }

  it("stops the workspace preparation when the run is cancelled and uploads nothing after it", async () => {
    const { workspaceDir, assetDir } = await makeWorkspace();
    const controller = new AbortController();
    prepareWorkspaceForSshExecution.mockImplementationOnce(async (input: PrepareInput) => untilAborted(input.signal));

    const preparing = prepareRemoteManagedRuntime({
      spec,
      runId: "run-cancel-prepare",
      adapterKey: "omp",
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "skills", localDir: assetDir }],
      signal: controller.signal,
    });
    const outcome = preparing.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("Cancelled by control plane"));

    const error = await outcome;
    expect(isSshOperationAbortedError(error)).toBe(true);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("does not start a workspace restore when the run is cancelled during the asset upload", async () => {
    const { workspaceDir, assetDir } = await makeWorkspace();
    const controller = new AbortController();
    syncDirectoryToSsh.mockImplementationOnce(async (input: SyncInput) => untilAborted(input.signal));

    const preparing = prepareRemoteManagedRuntime({
      spec,
      runId: "run-cancel-assets",
      adapterKey: "omp",
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "skills", localDir: assetDir }],
      signal: controller.signal,
    });
    const outcome = preparing.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Cancelled by control plane"));

    expect(isSshOperationAbortedError(await outcome)).toBe(true);
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("does not prepare anything for a run that was cancelled before the preparation finished its first step", async () => {
    const { workspaceDir, assetDir } = await makeWorkspace();
    const controller = new AbortController();
    // The preparation itself completes, the cancellation arrives right after it.
    prepareWorkspaceForSshExecution.mockImplementationOnce(async () => {
      controller.abort(new Error("Cancelled by control plane"));
      return { gitBacked: false };
    });

    await expect(
      prepareRemoteManagedRuntime({
        spec,
        runId: "run-cancel-after-prepare",
        adapterKey: "omp",
        workspaceLocalDir: workspaceDir,
        assets: [{ key: "skills", localDir: assetDir }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ssh_operation_aborted" });
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("still restores the workspace when an asset upload fails without a cancellation", async () => {
    const { workspaceDir, assetDir } = await makeWorkspace();
    syncDirectoryToSsh.mockImplementationOnce(async () => {
      throw new Error("ssh transfer failed");
    });

    await expect(
      prepareRemoteManagedRuntime({
        spec,
        runId: "run-asset-fails",
        adapterKey: "omp",
        workspaceLocalDir: workspaceDir,
        assets: [{ key: "skills", localDir: assetDir }],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("ssh transfer failed");
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });
});
