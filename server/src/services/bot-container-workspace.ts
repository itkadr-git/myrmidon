// myrmidon(1.6.9, OPE-13213): isolated workspace of a task for an adapter whose
// agent works in its own container.
//
// hermes_gateway and omp_local agents write code in `/workspace/<ISSUE>` inside
// the bot container (a volume on the bot disk). The board does not execute
// code, so it creates NO copy of its own for them: no git worktree under the
// project, no checkout of the shared project workspace. The isolated workspace
// of the task IS the task directory of the bot. One execution_workspaces row
// per task records it: mode `isolated_workspace`, strategy `bot_container`,
// cwd `/workspace/<ISSUE>`, nothing on the board's disk.

import type { ExecutionWorkspaceInput, RealizedExecutionWorkspace } from "./workspace-runtime.js";

export const BOT_CONTAINER_WORKSPACE_STRATEGY = "bot_container" as const;
export const BOT_CONTAINER_WORKSPACE_ROOT = "/workspace";

/** Adapters whose agent works in the task directory of its own container. */
const BOT_CONTAINER_WORKSPACE_ADAPTER_TYPES: ReadonlySet<string> = new Set(["hermes_gateway", "omp_local"]);

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

let adapterTypesForTests: ReadonlySet<string> | null = null;

/** Test seam: replaces the adapter set (null restores it). */
export function setBotContainerWorkspaceAdapterTypesForTests(types: Iterable<string> | null): void {
  adapterTypesForTests = types ? new Set(types) : null;
}

export function usesBotContainerWorkspace(adapterType: string | null | undefined): boolean {
  return (
    typeof adapterType === "string" &&
    (adapterTypesForTests ?? BOT_CONTAINER_WORKSPACE_ADAPTER_TYPES).has(adapterType)
  );
}

/** `/workspace/<ISSUE>` for a strict `<PREFIX>-<number>` identifier, else null. */
export function botContainerWorkspaceCwd(issueIdentifier: string | null | undefined): string | null {
  const key = typeof issueIdentifier === "string" ? issueIdentifier.trim() : "";
  return ISSUE_KEY_PATTERN.test(key) ? `${BOT_CONTAINER_WORKSPACE_ROOT}/${key}` : null;
}

/**
 * The bot-container workspace for this run, or null when the run keeps the
 * board-side path (other adapter, mode other than isolated, task without a
 * usable identifier).
 */
export function resolveBotContainerWorkspace(input: {
  adapterType: string | null | undefined;
  mode: string | null | undefined;
  issueIdentifier: string | null | undefined;
}): { cwd: string } | null {
  if (!usesBotContainerWorkspace(input.adapterType)) return null;
  if (input.mode !== "isolated_workspace") return null;
  const cwd = botContainerWorkspaceCwd(input.issueIdentifier);
  return cwd ? { cwd } : null;
}

/** The realized workspace of a bot-container run: no file is touched on the board. */
export function realizeBotContainerWorkspace(
  base: ExecutionWorkspaceInput,
  workspace: { cwd: string },
): RealizedExecutionWorkspace {
  return {
    ...base,
    strategy: BOT_CONTAINER_WORKSPACE_STRATEGY,
    cwd: workspace.cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
    branchCreatedByRuntime: false,
    baseRefSha: null,
  };
}
