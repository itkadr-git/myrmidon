// server/src/myrmidon/knowledge/git-export-git.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-8): the git side of the nightly export.
//
// One repository, one branch. The job clones (or fetches) that branch into
// a scratch checkout, replaces the work tree with the deterministic file
// list, and commits only when `git status` is dirty. An unchanged tree
// produces no commit — that is the determinism the task asks for.
//
// Credentials never go into the remote URL and never into a log line. The
// caller passes an optional `insteadOf` rewrite (the same shape git uses)
// so a token stays in the environment the caller already owns.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  KNOWLEDGE_EXPORT_AUTHOR_EMAIL,
  KNOWLEDGE_EXPORT_AUTHOR_NAME,
  knowledgeExportCommitMessage,
  type KnowledgeGitTree,
} from "./git-export.js";

const execFileAsync = promisify(execFile);

export interface GitExportRunner {
  /**
   * Runs git with `args` in `cwd`. Implementations must not echo env values
   * that look like tokens.
   */
  git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
}

/** The real git. Timeouts stay short: this is a metadata repo, not a code clone. */
export function createSystemGitRunner(timeoutMs = 60_000): GitExportRunner {
  return {
    async git(cwd, args, env) {
      const result = await execFileAsync("git", args, {
        cwd,
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    },
  };
}

export interface PublishKnowledgeExportInput {
  /** Absolute scratch directory. Created if missing, removed by the caller. */
  workDir: string;
  repoUrl: string;
  branch: string;
  tree: KnowledgeGitTree;
  runner?: GitExportRunner;
  /** Extra env for the git process (author, askpass). Never logged here. */
  env?: NodeJS.ProcessEnv;
}

export interface PublishKnowledgeExportResult {
  committed: boolean;
  /** Null when nothing changed. */
  commit: string | null;
  contentHash: string;
  pageCount: number;
}

async function git(runner: GitExportRunner, cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return runner.git(cwd, args, env);
}

/**
 * Writes the tree into `workDir` (which must already be a git checkout on
 * `branch`) and commits when the work tree differs. Returns whether a
 * commit was created.
 */
export async function commitKnowledgeTreeIfChanged(
  runner: GitExportRunner,
  workDir: string,
  branch: string,
  tree: KnowledgeGitTree,
  env?: NodeJS.ProcessEnv,
): Promise<{ committed: boolean; commit: string | null }> {
  const keep = new Set(tree.files.map((file) => file.path));
  for (const file of tree.files) {
    if (file.path.includes("..") || path.isAbsolute(file.path)) {
      throw new Error(`refusing to write a path outside the export repo: ${file.path}`);
    }
    const abs = path.join(workDir, file.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }

  // Drop files the new tree no longer has. Tracked files only: a scratch
  // clone has nothing else we should be touching.
  const listed = await git(runner, workDir, ["ls-files", "-z"], env);
  const tracked = listed.stdout.split("\0").filter((name) => name.length > 0);
  for (const name of tracked) {
    if (!keep.has(name)) {
      // Unlink first so a runner that only records argv still leaves a
      // dirty work tree; `git add -A` below stages the deletion.
      await unlink(path.join(workDir, name)).catch(() => undefined);
    }
  }

  await git(runner, workDir, ["add", "-A"], env);
  const status = await git(runner, workDir, ["status", "--porcelain"], env);
  if (status.stdout.trim().length === 0) {
    return { committed: false, commit: null };
  }

  const authorEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: KNOWLEDGE_EXPORT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: KNOWLEDGE_EXPORT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: KNOWLEDGE_EXPORT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: KNOWLEDGE_EXPORT_AUTHOR_EMAIL,
  };
  await git(
    runner,
    workDir,
    [
      "commit",
      "--allow-empty-message",
      "-m",
      knowledgeExportCommitMessage(tree),
    ],
    authorEnv,
  );
  const head = await git(runner, workDir, ["rev-parse", "HEAD"], authorEnv);
  return { committed: true, commit: head.stdout.trim() || null };
}

/**
 * Clone-or-fetch the branch, write the tree, commit if it changed, push.
 * The push is skipped when nothing changed, so a quiet night is a no-op
 * on the remote too.
 */
export async function publishKnowledgeExport(input: PublishKnowledgeExportInput): Promise<PublishKnowledgeExportResult> {
  const runner = input.runner ?? createSystemGitRunner();
  const env = input.env;
  await mkdir(input.workDir, { recursive: true });

  const gitDir = path.join(input.workDir, ".git");
  let hasGit = false;
  try {
    await readFile(gitDir);
    hasGit = true;
  } catch {
    try {
      await readFile(path.join(gitDir, "HEAD"));
      hasGit = true;
    } catch {
      hasGit = false;
    }
  }

  if (!hasGit) {
    // Clone the branch if it exists; otherwise init an empty repo and set
    // the remote so the first push creates the branch.
    const probe = await git(runner, input.workDir, ["ls-remote", "--heads", input.repoUrl, input.branch], env).catch(
      (err: unknown) => {
        throw new Error(`knowledge export: cannot reach ${redactUrl(input.repoUrl)}: ${errorMessage(err)}`);
      },
    );
    if (probe.stdout.trim().length > 0) {
      await rm(input.workDir, { recursive: true, force: true });
      await mkdir(path.dirname(input.workDir), { recursive: true });
      await git(runner, path.dirname(input.workDir), [
        "clone",
        "--branch",
        input.branch,
        "--single-branch",
        "--",
        input.repoUrl,
        input.workDir,
      ], env);
    } else {
      await git(runner, input.workDir, ["init", "-b", input.branch], env);
      await git(runner, input.workDir, ["remote", "add", "origin", input.repoUrl], env);
    }
  } else {
    await git(runner, input.workDir, ["fetch", "origin", input.branch], env).catch(() => {
      // The branch may not exist yet. A failed fetch must not hide a later
      // push error: we only swallow "no such branch" by continuing to commit.
    });
  }

  const { committed, commit } = await commitKnowledgeTreeIfChanged(runner, input.workDir, input.branch, input.tree, env);
  if (committed) {
    await git(runner, input.workDir, ["push", "origin", `HEAD:${input.branch}`], env);
  }
  return {
    committed,
    commit,
    contentHash: input.tree.contentHash,
    pageCount: input.tree.pageCount,
  };
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//<redacted>@");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\/\/[^@/]+@/g, "//<redacted>@");
  return "unknown error";
}
