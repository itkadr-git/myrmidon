// myrmidon(1.6.2-BOT-DISK-C): the board's bare git mirrors for bot clones.
//
// Development bots clone the same repositories again and again, and every
// clone used to carry the whole object database (about 1.7 GB for this
// repository). The board keeps ONE bare mirror per repository named in
// `general.botDisk.gitMirrorRepos`, under the shared package cache:
//
//   <sharedPackageCachePath>/git/<owner>/<repo>.git
//
// Bots mount `<cache>/git` read-only at `/cache/git` (template.ts
// GIT_MIRROR_MOUNT) and the image's git wrapper clones with
// `--reference-if-able /cache/git/<owner>/<repo>.git`: the clone's
// `objects/info/alternates` points at the mirror, and the clone stores only
// the objects the mirror does not have (the bot's own commits and whatever
// arrived upstream since the last refresh).
//
// Only the board writes here, so the mirror is as trustworthy as the board's
// own fetch (a writable mirror would let one bot rewrite objects another bot's
// clone reads through its alternates, and git does not re-hash those). Because
// clones borrow objects, the mirror must never lose one: the mirror's own
// config turns automatic gc off, and the refresher's gc keeps every
// unreachable object (`gc.pruneExpire=never` — unreachable objects go to a
// cruft pack that never expires). A ref deleted upstream (`fetch --prune`)
// therefore only removes the ref, never the objects a clone may still need.
//
// The refresh runs from the maintenance tick (bot-disk-service.ts
// runBotDiskSweep): each mirror at most once per `gitMirrorRefreshMs`, one
// refresh at a time in this process, and a lock directory next to the mirror
// keeps a second board process (or a manual run) out. A new mirror is fetched
// into a temporary directory and renamed into place, so a bot never sees a
// half-made one (and `--reference-if-able` skips a mirror that is absent).
//
// Credentials: a public repository needs none. For a private one the board
// uses the server-environment token (GITHUB_TOKEN, then GH_TOKEN) through the
// same URL-scoped credential helper as the board's own checkouts
// (services/git-credentials.ts buildGitAuthInvocation): the token travels in
// the environment, never in argv or in the mirror's config.

import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "../../middleware/logger.js";
import { buildGitAuthInvocation } from "../../services/git-credentials.js";

/** Subdirectory of the shared package cache that holds the mirrors. */
export const GIT_MIRROR_SUBDIR = "git";
/** File inside a mirror whose mtime is the last successful refresh. */
export const GIT_MIRROR_STAMP = "myrmidon-fetched-at";
/** A lock directory older than this belongs to a dead refresh and is taken over. */
export const GIT_MIRROR_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
/** One git command of a refresh may run this long. */
export const GIT_MIRROR_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

/** What the refresher needs from the outside world; tests replace it. */
export interface GitMirrorDeps {
  runGit(args: string[], env: Record<string, string>): Promise<void>;
  now(): number;
  env: Record<string, string | undefined>;
  log: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void };
}

export interface GitMirrorLayout {
  sharedPackageCachePath?: string;
  gitMirrorRepos: readonly string[];
  gitMirrorRefreshMs: number;
}

export type GitMirrorOutcome = "created" | "fetched" | "not_due" | "locked" | "failed";

export interface GitMirrorResult {
  repo: string;
  outcome: GitMirrorOutcome;
  error?: string;
}

/** The mirror directory of `owner/repo` (lower case, see resolveBotDiskLayout). */
export function gitMirrorPath(cacheRoot: string, repo: string): string {
  const [owner, name] = repo.toLowerCase().split("/");
  return path.join(cacheRoot, GIT_MIRROR_SUBDIR, owner!, `${name}.git`);
}

export function gitMirrorUrl(repo: string): string {
  return `https://github.com/${repo.toLowerCase()}.git`;
}

/** The environment a refresh's git commands run with: no prompt, the token (if any) only in env. */
export function gitMirrorEnv(env: Record<string, string | undefined>): { args: string[]; env: Record<string, string> } {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
  if (!token) return { args: [], env: { GIT_TERMINAL_PROMPT: "0" } };
  const auth = buildGitAuthInvocation({ token, source: "server_env", secretName: null });
  return { args: auth.configArgs, env: { ...auth.env, GIT_TERMINAL_PROMPT: "0" } };
}

/** Config of a new mirror. Automatic gc is off: only the refresher runs gc, with pruning off. */
const MIRROR_CONFIG: ReadonlyArray<[string, string]> = [
  ["core.logAllRefUpdates", "false"],
  ["gc.auto", "0"],
  ["gc.pruneExpire", "never"],
  ["fetch.prune", "true"],
];

const GIT_SUBCOMMANDS = new Set(["init", "config", "remote", "fetch", "gc"]);

function defaultDeps(): GitMirrorDeps {
  return {
    runGit: (args, env) =>
      new Promise((resolve, reject) => {
        execFile(
          "git",
          args,
          { env: { ...process.env, ...env }, timeout: GIT_MIRROR_COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            const command = args.find((arg) => GIT_SUBCOMMANDS.has(arg)) ?? "";
            if (err) reject(new Error(`git ${command} failed: ${String(stderr || err.message).trim().slice(0, 500)}`));
            else resolve();
          },
        );
      }),
    now: () => Date.now(),
    env: process.env,
    log: logger,
  };
}

async function mtimeMs(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Take the lock directory next to the mirror; false when a live refresh holds it. */
async function takeLock(lockDir: string, now: number): Promise<boolean> {
  try {
    await mkdir(lockDir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const since = await mtimeMs(lockDir);
  if (since !== null && now - since < GIT_MIRROR_LOCK_STALE_MS) return false;
  await rm(lockDir, { recursive: true, force: true });
  try {
    await mkdir(lockDir);
    return true;
  } catch {
    return false;
  }
}

/** Directories the bots read through a read-only mount: world-readable whatever the board's umask. */
async function mkdirReadable(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
}

async function refreshOne(layout: GitMirrorLayout & { sharedPackageCachePath: string }, repo: string, deps: GitMirrorDeps): Promise<GitMirrorResult> {
  const dir = gitMirrorPath(layout.sharedPackageCachePath, repo);
  const stamp = path.join(dir, GIT_MIRROR_STAMP);
  const now = deps.now();
  const last = await mtimeMs(stamp);
  if (last !== null && now - last < layout.gitMirrorRefreshMs) return { repo, outcome: "not_due" };
  const attempt = lastAttempt.get(dir);
  if (attempt !== undefined && now - attempt < layout.gitMirrorRefreshMs) return { repo, outcome: "not_due" };

  await mkdirReadable(path.dirname(dir));
  const lockDir = `${dir}.lock`;
  if (!(await takeLock(lockDir, now))) return { repo, outcome: "locked" };
  lastAttempt.set(dir, now);
  const auth = gitMirrorEnv(deps.env);
  try {
    const exists = (await mtimeMs(dir)) !== null;
    let target = dir;
    if (!exists) {
      target = `${dir}.tmp-${process.pid}-${now}`;
      await rm(target, { recursive: true, force: true });
      // --shared=0644: files 0644, directories 0755, whatever the board's umask —
      // the bots (another uid) read the mirror through a read-only mount.
      await deps.runGit(["init", "--quiet", "--bare", "--shared=0644", target], auth.env);
      for (const [key, value] of MIRROR_CONFIG) {
        await deps.runGit(["-C", target, "config", key, value], auth.env);
      }
      await deps.runGit(["-C", target, "remote", "add", "origin", gitMirrorUrl(repo)], auth.env);
      await deps.runGit(["-C", target, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], auth.env);
      await deps.runGit(["-C", target, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"], auth.env);
    }
    await deps.runGit([...auth.args, "-C", target, "fetch", "--quiet", "--prune", "origin"], auth.env);
    // Pack the fetched objects without ever dropping one a clone may borrow.
    await deps.runGit(["-C", target, "-c", "gc.auto=6700", "-c", "gc.pruneExpire=never", "gc", "--auto", "--quiet"], auth.env);
    await writeFile(path.join(target, GIT_MIRROR_STAMP), new Date(now).toISOString() + "\n", { mode: 0o644 });
    await chmod(path.join(target, GIT_MIRROR_STAMP), 0o644);
    if (!exists) await rename(target, dir);
    deps.log.info({ repo, mirror: dir }, exists ? "git mirror refreshed" : "git mirror created");
    return { repo, outcome: exists ? "fetched" : "created" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn({ repo, mirror: dir, error: message }, "git mirror refresh failed; bots clone without it until the next attempt");
    // A half-made new mirror never stays behind.
    await rm(`${dir}.tmp-${process.pid}-${now}`, { recursive: true, force: true }).catch(() => undefined);
    return { repo, outcome: "failed", error: message };
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Last attempt per mirror in this process: a failing fetch waits a full interval too. */
const lastAttempt = new Map<string, number>();
let inFlight: Promise<GitMirrorResult[]> | null = null;

/**
 * Refresh every due mirror of `layout`. Returns [] when there is nothing to do
 * or a previous call is still running (one refresh at a time per process).
 */
export function refreshGitMirrors(layout: GitMirrorLayout, deps: GitMirrorDeps = defaultDeps()): Promise<GitMirrorResult[]> {
  const cacheRoot = layout.sharedPackageCachePath;
  if (!cacheRoot || layout.gitMirrorRepos.length === 0) return Promise.resolve([]);
  if (inFlight) return Promise.resolve([]);
  const run = (async () => {
    const results: GitMirrorResult[] = [];
    for (const repo of layout.gitMirrorRepos) {
      results.push(await refreshOne({ ...layout, sharedPackageCachePath: cacheRoot }, repo, deps));
    }
    return results;
  })();
  inFlight = run;
  return run.finally(() => {
    inFlight = null;
  });
}

/** Test hook: forget the per-process attempt times. */
export function resetGitMirrorStateForTests(): void {
  lastAttempt.clear();
}
