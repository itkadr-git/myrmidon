// myrmidon(1.7 KNOWLEDGE-2.0 L-13): the small git-backed record used by
// skill promotion and reconciliation. It deliberately uses git's executable
// rather than a shell, and never places credentials in arguments or logs.
//
// myrmidon(OPE-9408): every port method that touches the checkout — refresh,
// recordVerified, listEntries — is serialized per repository through a
// module-level registry shared by ALL port instances of this process
// (app.ts mounts the webhook routes while skill-lifecycle/index.ts creates
// its own port: separate instances, one physical checkout). Every git call
// is bounded by a timeout so a hung clone/push can never pin the mutex or a
// webhook request forever.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { GitSkillEntry, GitSkillFile } from "./domain.js";
import { assertSkillGitEntry, skillGitRelativePath, skillGitEnabled } from "./domain.js";
import type { SkillGitRecordPort } from "../skill-lifecycle/service.js";

const execFileAsync = promisify(execFile);

/** Upper bound for one git invocation. A checkout operation that exceeds it
 *  fails the caller instead of hanging the mutex or the webhook forever. */
export const GIT_SKILL_EXEC_TIMEOUT_MS = 60_000;

async function gitExec(repository: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return result.stdout;
}

/**
 * myrmidon(OPE-9408): per-repository promise chains, shared by every port
 * instance of the process. Like bot-containers' `botKeyLock`, a rejection is
 * delivered to its own caller and never poisons the tail: the next call
 * starts fresh, so the mutex is never left held by a failure.
 */
const repositoryLocks = new Map<string, Promise<void>>();

function withRepositoryLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
  const previous = repositoryLocks.get(repository) ?? Promise.resolve();
  // Run `fn` whether the previous tail settled or rejected: one caller's
  // failure must not wedge the queue for everyone else.
  const result = previous.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  repositoryLocks.set(repository, tail);
  void tail.then(() => {
    if (repositoryLocks.get(repository) === tail) repositoryLocks.delete(repository);
  });
  return result;
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
  }
  return files;
}

export function createGitSkillRecordPort(input: {
  repository: string;
  push?: boolean;
  env?: NodeJS.ProcessEnv;
  onRefresh?: () => Promise<void>;
  /** Test hook: per-invocation git timeout. Defaults to GIT_SKILL_EXEC_TIMEOUT_MS. */
  execTimeoutMs?: number;
}): SkillGitRecordPort {
  const root = path.resolve(input.repository);
  const push = input.push ?? input.env?.MYRMIDON_SKILL_GIT_PUSH === "1";
  const execTimeoutMs = input.execTimeoutMs ?? GIT_SKILL_EXEC_TIMEOUT_MS;
  const git = (args: string[]) => gitExec(root, args, execTimeoutMs);
  return {
    async refresh() {
      await withRepositoryLock(root, async () => {
        await git(["pull", "--ff-only"]);
        await input.onRefresh?.();
      });
    },
    async listEntries() {
      return withRepositoryLock(root, async () => {
        const skillsRoot = path.join(root, "skills");
        const files = await walk(skillsRoot).catch(() => []);
        const skillRoots = new Set(
          files
            .filter((file) => path.posix.basename(file).toLowerCase() === "skill.md")
            .map((file) => path.posix.dirname(file)),
        );
        const entries: GitSkillEntry[] = [];
        for (const key of skillRoots) {
          const skillRoot = path.join(skillsRoot, key);
          const entryFiles: GitSkillFile[] = [];
          for (const relative of await walk(skillRoot)) {
            entryFiles.push({ path: relative, content: await fs.readFile(path.join(skillRoot, relative), "utf8") });
          }
          if (entryFiles.length > 0) entries.push({ key, files: entryFiles });
        }
        return entries;
      });
    },
    async recordVerified({ key, files, revisionNumber }) {
      // myrmidon(OPE-9408): validate the key BEFORE any filesystem mutation.
      // skillGitRelativePath applies the same segment/regex rules the file
      // paths get, so an escaping key ("../x") is rejected before the
      // rm/mkdir below can touch anything outside skills/.
      if (!skillGitRelativePath(key, "SKILL.md")) throw new Error(`Invalid git skill key: ${key}`);
      const entry = assertSkillGitEntry({ key, files });
      await withRepositoryLock(root, async () => {
        await fs.mkdir(root, { recursive: true });
        await fs.rm(path.join(root, "skills", ...entry.key.split("/")), { recursive: true, force: true });
        try {
          for (const file of entry.files) {
            const relative = skillGitRelativePath(entry.key, file.path);
            if (!relative) throw new Error(`Invalid git skill path for ${entry.key}`);
            const destination = path.join(root, relative);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, file.content, "utf8");
          }
          await git(["add", "--", `skills/${entry.key}`]);
          const status = await git(["status", "--porcelain", "--", `skills/${entry.key}`]);
          if (!status.trim()) return;
          await git(["-c", "user.name=Myrmidon skill recorder", "-c", "user.email=skill-recorder@localhost", "commit", "-m", `Record verified skill ${entry.key} revision ${revisionNumber}`]);
          if (push) await git(["push"]);
        } catch (error) {
          // myrmidon(OPE-9408): a failed or timed-out git step must not leave a
          // half-recorded skill as the visible snapshot — listEntries reads the
          // working tree. Remove the key's slice with fs first (deterministic
          // even when git itself is what hung), then try to restore any prior
          // committed content best-effort. An absent key fails delivery closed
          // (drift), which is the safe direction.
          await fs.rm(path.join(root, "skills", ...entry.key.split("/")), { recursive: true, force: true }).catch(() => {});
          await git(["checkout", "--", `skills/${entry.key}`]).catch(() => {});
          throw error;
        }
      });
    },
  };
}

export function configuredGitSkillRecord(env: NodeJS.ProcessEnv = process.env): SkillGitRecordPort | null {
  const repository = env.MYRMIDON_SKILL_GIT_REPOSITORY?.trim();
  return skillGitEnabled(env) && repository ? createGitSkillRecordPort({ repository, env }) : null;
}
