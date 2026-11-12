import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import { withSilenceHeartbeat, type RuntimeProgressSink } from "./runtime-progress.js";
import { raceSshAbort, throwIfSshAborted } from "./ssh-abort.js"; // myrmidon(OPE-12801)

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  /**
   * Restores the workspace and the runtime assets, then removes this run's
   * directory on the remote (`.paperclip-runtime/runs/<runId>`) whether or not
   * the restore succeeded. The removal is best-effort and is skipped for an
   * in-place (unsynced) workspace. A restore error is rethrown after it.
   */
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

// myrmidon(OPE-12633 SSH-RUN-CLEANUP, OPE-12664): an SSH environment is a
// long-lived host, unlike a sandbox lease that is destroyed after the run. Each
// synced run gets its own copy of the workspace under
// <remoteWorkspacePath>/.paperclip-runtime/runs/<runId>/workspace (on the
// Myrmidon monorepo about 0.8 GB, up to 3 GB with a build), and nothing removed
// it, so the remote disk filled up run after run.
//
// The whole run directory is removed at every end of the run, whatever the
// outcome. `restoreWorkspace` restores first (when the workspace is synced) and
// removes the run directory in its `finally`, so a failed restore, a failed
// asset restore or an aborted restore still removes the copy and the original
// error still reaches the caller. The adapters call `restoreWorkspace` from
// their own `finally`, so a failed, timed-out or cancelled run reaches it too.
// A failed prepare removes the copy it had just started. The removal is
// best-effort (see `runBestEffortSshCleanup`: errors are logged, never thrown)
// and touches only this run's directory. An in-place (unsynced) workspace has
// no run directory, so nothing is removed.
//
// The API bridge stops in parallel with the restore and reads its pid file from
// the run directory, so the removal command first stops a bridge server that is
// still recorded there, then removes the directory (otherwise the server would
// be left running on the runner).
//
// Safety net: a run that never reaches its `finally` (the board process dies, a
// failed removal) leaves its copy, so whole run directories older than four
// hours are pruned when the next run starts: the longest run timeout is three
// hours, so a concurrent run on a shared environment is never touched. 11.11: a
// two-day window let one omp runner pile up 24 copies of 1.5 GB in an evening;
// 11.11 and 12.11: the bots disk filled to 100% twice (OPE-12664).
export const REMOTE_RUN_DIR_RETENTION_MINUTES = 240;

// Where the file bridge keeps its pid file below a run's runtime root. It
// mirrors `startAdapterExecutionTargetPaperclipBridge` in execution-target.ts
// (`<runtimeRootDir>/paperclip-bridge/queue`) and
// `sandboxCallbackBridgeDirectories` (`server.pid`); this module cannot import
// them without a cycle.
const REMOTE_BRIDGE_PID_FILE_RELATIVE_PATH = path.posix.join("paperclip-bridge", "queue", "server.pid");

function remoteRunsDir(baseWorkspaceRemoteDir: string): string {
  return path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs");
}

// A run id is exactly one path segment under `runs/`. An empty, dotted or
// separator-bearing id would make the removal reach the runs directory itself
// or another run's directory, so such an id is never removed.
function isSingleRunDirSegment(runId: string): boolean {
  return (
    runId !== "" &&
    runId !== "." &&
    runId !== ".." &&
    !runId.includes("/") &&
    !runId.includes("\\") &&
    !runId.includes("\0")
  );
}

function remoteRunDir(baseWorkspaceRemoteDir: string, runId: string): string {
  return path.posix.join(remoteRunsDir(baseWorkspaceRemoteDir), runId);
}

/**
 * The command that removes ONE run's directory
 * (`<base>/.paperclip-runtime/runs/<runId>`) entirely: the workspace copy and
 * the runtime directory together. When `bridgePidFile` is given it first stops
 * the bridge server recorded there, if the file is still present. Throws when
 * `runId` is not a single path segment.
 */
export function buildRemoteRunDirectoryRemoveCommand(
  baseWorkspaceRemoteDir: string,
  runId: string,
  bridgePidFile?: string,
): string {
  if (!isSingleRunDirSegment(runId)) {
    throw new Error("the run id is not a single path segment");
  }
  const runDir = shellQuote(remoteRunDir(baseWorkspaceRemoteDir, runId));
  const stopBridge = bridgePidFile
    ? `p=$(cat ${shellQuote(bridgePidFile)} 2>/dev/null); [ "$p" -gt 1 ] 2>/dev/null && kill "$p" 2>/dev/null; `
    : "";
  return `if [ -d ${runDir} ]; then ${stopBridge}rm -rf -- ${runDir}; fi`;
}

export function buildStaleRemoteRunsPruneCommand(baseWorkspaceRemoteDir: string): string {
  const runsDir = remoteRunsDir(baseWorkspaceRemoteDir);
  return `if [ -d ${shellQuote(runsDir)} ]; then find ${shellQuote(runsDir)} -mindepth 1 -maxdepth 1 -type d -mmin +${REMOTE_RUN_DIR_RETENTION_MINUTES} -exec rm -rf {} +; fi`;
}

async function runBestEffortSshCleanup(spec: SshRemoteExecutionSpec, command: string, what: string): Promise<void> {
  try {
    await runSshCommand(spec, command, { timeoutMs: 120_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    console.warn(`[myrmidon] Could not ${what} on the SSH environment; continuing. ${String(error)}`);
  }
}

// Best-effort removal of ONE run's directory (see the OPE-12664 note above).
// Never throws: a run id that is not a single path segment is refused with a
// warning, and an ssh failure is logged by `runBestEffortSshCleanup`.
async function removeRemoteRunDirectory(
  spec: SshRemoteExecutionSpec,
  baseWorkspaceRemoteDir: string,
  runId: string,
  bridgePidFile: string,
): Promise<void> {
  let command: string;
  try {
    command = buildRemoteRunDirectoryRemoveCommand(baseWorkspaceRemoteDir, runId, bridgePidFile);
  } catch (error) {
    console.warn(`[myrmidon] Could not remove the run directory on the SSH environment; continuing. ${String(error)}`);
    return;
  }
  await runBestEffortSshCleanup(spec, command, "remove the run directory");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

// myrmidon(OPE-12809): the baseline snapshot carries the exclude list of the
// whole exchange. restoreWorkspaceFromSshExecution reads it back from the
// snapshot for the download and the merge, so a directory that was not
// uploaded is not downloaded either, and the board's own copy of it is neither
// overwritten nor deleted. `workspaceExclude` holds the reproducible
// directories resolved by prepareWorkspaceForSshExecution
// (ssh-workspace-excludes.ts).
function sshWorkspaceBaselineExcludes(prepared: { gitBacked: boolean; workspaceExclude?: string[] }): string[] {
  const base = prepared.gitBacked
    ? [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"]
    : [".paperclip-runtime"];
  return mergeExcludes(base, prepared.workspaceExclude);
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  /** Extra workspace exclude patterns, added to the reproducible directories. */
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
  /** myrmidon(OPE-12801): the run's cancellation signal; rejects with SshOperationAbortedError. */
  signal?: AbortSignal;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const workspaceRemoteDir = syncWorkspace
    ? path.posix.join(
        baseWorkspaceRemoteDir,
        ".paperclip-runtime",
        "runs",
        input.runId,
        "workspace",
      )
    : baseWorkspaceRemoteDir;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  // The run's copy of the workspace exists only for a synced workspace; an
  // in-place workspace has no run directory, so this is a no-op then. It only
  // ever targets this run's directory and never throws.
  const removeRunCopy = async (): Promise<void> => {
    if (!syncWorkspace) return;
    await removeRemoteRunDirectory(
      input.spec,
      baseWorkspaceRemoteDir,
      input.runId,
      path.posix.join(runtimeRootDir, REMOTE_BRIDGE_PID_FILE_RELATIVE_PATH),
    );
  };

  if (syncWorkspace) {
    await runBestEffortSshCleanup(input.spec, buildStaleRemoteRunsPruneCommand(baseWorkspaceRemoteDir), "prune stale run directories");
  }

  try {
    // myrmidon(OPE-12801): the upload ends with a silent unpack on the target and
    // the baseline snapshot hashes every workspace file without reporting bytes.
    // On a 3.8 GB workspace that was 30-40 minutes with no output line, and the
    // run-stall watchdog cancelled the run before omp started. The pulse keeps
    // the run's last-output time moving while this work is in progress.
    //
    // myrmidon(OPE-12801): a cancelled run stops here. The transfer processes
    // are killed (ssh.ts), the hashing of the local tree is abandoned, and the
    // SshOperationAbortedError reaches the adapter, which must not start the
    // agent CLI. The outer catch below removes the run directory on the target
    // (best-effort); the stale-run prune is the safety net.
    const { preparedWorkspace, baselineSnapshot } = await withSilenceHeartbeat(
      { sink: input.onProgress, label: "Preparing workspace for ssh" },
      async (onProgress) => {
        const prepared = syncWorkspace
          ? await prepareWorkspaceForSshExecution({
              spec: input.spec,
              localDir: input.workspaceLocalDir,
              remoteDir: workspaceRemoteDir,
              exclude: input.workspaceExclude,
              onProgress,
              signal: input.signal,
            })
          : null;
        throwIfSshAborted(input.signal, "Workspace preparation");
        const snapshot = prepared
          ? await raceSshAbort(
              captureDirectorySnapshot(input.workspaceLocalDir, {
                exclude: sshWorkspaceBaselineExcludes(prepared),
              }),
              input.signal,
              "Workspace preparation",
            )
          : null;
        return { preparedWorkspace: prepared, baselineSnapshot: snapshot };
      },
    );

    const assetDirs: Record<string, string> = {};
    try {
      for (const asset of input.assets ?? []) {
        throwIfSshAborted(input.signal, "Runtime asset upload");
        const remoteDir = path.posix.join(runtimeRootDir, asset.key);
        assetDirs[asset.key] = remoteDir;
        await syncDirectoryToSsh({
          spec: input.spec,
          localDir: asset.localDir,
          remoteDir,
          followSymlinks: asset.followSymlinks,
          exclude: asset.exclude,
          onProgress: input.onProgress,
          progressLabel: asset.key,
          signal: input.signal,
        });
      }
    } catch (error) {
      // myrmidon(OPE-12801): nothing ran on the target before a cancellation at
      // this point, so there is nothing to bring back; a restore here would keep
      // the cancelled run busy for minutes.
      if (preparedWorkspace && baselineSnapshot && !input.signal?.aborted) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          onProgress: input.onProgress,
        });
      }
      throw error;
    }

    // Stage each referenced (additional) project as a plain, read-only tree in its
    // OWN isolated remote directory (`project-<projectId>`). Additional sources
    // never get the anchor's git-history/overlay semantics. Per-project failure
    // isolation: one project's failure logs a warning and is skipped; the run and
    // the other projects continue (no workspace restore, unlike an asset failure).
    const additionalSourceDirs: Record<string, string> = {};
    for (const source of input.additionalSources ?? []) {
      throwIfSshAborted(input.signal, "Referenced project upload"); // myrmidon(OPE-12801)
      const { localPath, projectId, ignoreResolution } = source;
      try {
        if (!path.posix.isAbsolute(localPath)) {
          throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
        }
        if (
          projectId.length === 0 ||
          projectId.includes("/") ||
          projectId.includes("\\") ||
          projectId.includes("..")
        ) {
          throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
        }
        // Fail closed: a project whose ignore resolution failed is not staged at
        // all — the existing per-project skip-and-warn path below handles it.
        if (ignoreResolution.kind === "failed") {
          throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
        }
        const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
        const exclude = mergeExcludes(
          REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
          referencedSourceIgnoreExcludeEntries(ignoreResolution),
        );
        await syncDirectoryToSsh({
          spec: input.spec,
          localDir: localPath,
          remoteDir,
          exclude,
          onProgress: input.onProgress,
          progressLabel: `project-${projectId}`,
        });
        additionalSourceDirs[projectId] = remoteDir;
      } catch (error) {
        console.warn(
          `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
        );
      }
    }

    return {
      spec: input.spec,
      workspaceLocalDir: input.workspaceLocalDir,
      workspaceRemoteDir,
      runtimeRootDir,
      assetDirs,
      additionalSourceDirs,
      restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
        try {
          if (preparedWorkspace && baselineSnapshot) {
            // myrmidon(OPE-12801): after the download reaches 100% the restore
            // copies and merges the tree locally without output; a finished omp
            // run was cancelled as stalled in that phase and its work was lost.
            await withSilenceHeartbeat(
              { sink: onProgress, label: "Restoring workspace from ssh" },
              async (restoreProgress) => {
                await restoreWorkspaceFromSshExecution({
                  spec: input.spec,
                  localDir: input.workspaceLocalDir,
                  remoteDir: workspaceRemoteDir,
                  baselineSnapshot,
                  restoreGitHistory: preparedWorkspace.gitBacked,
                  onProgress: restoreProgress,
                });
              },
            );
          }
          for (const asset of input.assets ?? []) {
            if (!asset.restore) continue;
            await asset.restore({
              assetDir: path.posix.join(runtimeRootDir, asset.key),
              readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
            });
          }
        } finally {
          // The restore comes first. Whatever it did (it succeeded, failed or
          // was aborted), the run is over: remove its directory so the copy
          // does not pile up on the runner. The removal never throws, so the
          // restore's own error still reaches the caller (OPE-12664).
          await removeRunCopy();
        }
      },
    };
  } catch (error) {
    // The run never starts, so nothing will call `restoreWorkspace`: do not leave
    // the copy that was started behind.
    await removeRunCopy();
    throw error;
  }
}
