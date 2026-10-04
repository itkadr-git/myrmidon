// myrmidon(1.6.2-BOT-DISK-C): clone hygiene — the git part of the bot
// draft-directory lifecycle (draft-lifecycle.ts, BOT-DISK-A).
//
// The lifecycle used to reap any top-level entry of a bot's `workspace` or
// `scratch` volume whose directory mtime was older than the idle TTL. For a
// git clone that is wrong both ways: editing a tracked file, committing or
// fetching does not change the clone directory's own mtime, so a busy clone
// looks idle, and nothing told merged work from unpushed work. Now an entry
// that is, or holds, a git repository is never reaped by mtime. Each
// repository is judged on its own:
//
// - removed when the bot's own report says it is clean (no modified, staged or
//   untracked file, no merge/rebase in progress, no stash) and fully pushed
//   (every commit of HEAD and of every local branch is on some remote-tracking
//   ref — which covers "merged into origin/main" and "pushed with no local
//   changes"), it is not the base of a linked worktree or the alternate of
//   another clone, and nothing in it changed for longer than the idle TTL;
// - kept with an attention signal (source `bot_disk_lifecycle`) when it holds
//   unpushed work — a dirty tree, an operation in progress, a stash, or
//   commits on no remote — and has been idle longer than the TTL;
// - kept silently otherwise (active, no report yet, or a failed inspection).
//
// Why a report from the bot, and not git run by the board: a clone is the
// bot's directory, and git executes programs its repository config names
// (core.fsmonitor, filter drivers) during `git status`. Run by the board on
// the host, that would hand a bot code execution outside its container. The
// container paths (alternates under /cache/git, linked worktrees under
// /workspace) do not resolve on the host either. So the image's
// `bot-clone-hygiene` (docker/bot-runtime/clone-hygiene.py) inspects the
// clones INSIDE the container, as the bot user, and writes
// `$HERMES_HOME/.myrmidon/clone-hygiene.json`; the board only reads that file
// and the file tree's timestamps. A report can at worst make the board delete
// that same bot's clean-looking directory: the path must name a directory
// inside the bot's own workspace or scratch volume (no "..", no symbolic link
// on the way), and before anything is removed the board walks the tree and
// requires that no file or directory changed (mtime or ctime) since the report
// was written and within the idle TTL — a later edit makes the report stale.

import { lstat, readdir, readFile, realpath, rm } from "fs/promises";
import { basename, join, relative, sep } from "path";

/** Where the image writes the report, relative to the bot's hermes volume. */
export const CLONE_HYGIENE_REPORT_PATH = ".myrmidon/clone-hygiene.json";
/** A report larger than this is ignored (no verdicts, nothing removed). */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** A report older than this is ignored. */
export const CLONE_HYGIENE_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A repository is judged at most this often (the maintenance tick is seconds). */
export const CLONE_HYGIENE_JUDGE_INTERVAL_MS = 10 * 60 * 1000;
/** Depth below a volume entry searched for nested repositories. */
const MAX_REPO_DEPTH = 3;
/** Entries a "nothing changed" walk may visit before it gives up (and keeps the clone). */
const MAX_WALK_ENTRIES = 3_000_000;
/** Never descended into while looking for repositories. */
const SKIP_DIRS = new Set(["node_modules", ".pnpm-store", ".git"]);

/** One repository in the bot's report (docker/bot-runtime/clone-hygiene.py). */
export interface CloneReportEntry {
  /** Container path, under /workspace/ or /scratch/. */
  path: string;
  dirty: boolean;
  inProgress: boolean;
  stashCount: number;
  unpushedCommits: number;
  hasRemote: boolean;
  linkedWorktrees: number;
  referencedBy: number;
  branch: string | null;
  mergedIntoDefault: boolean | null;
  error: string | null;
}

export interface CloneReport {
  inspectedAtMs: number;
  repos: Map<string, CloneReportEntry>;
}

/** Parse the report file; null when it is not a usable report. */
export function parseCloneReport(raw: string, nowMs: number): CloneReport | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.inspectedAt !== "string" || !Array.isArray(obj.repos)) return null;
  const inspectedAtMs = Date.parse(obj.inspectedAt);
  if (!Number.isFinite(inspectedAtMs) || inspectedAtMs > nowMs + 60_000) return null;
  if (nowMs - inspectedAtMs > CLONE_HYGIENE_REPORT_MAX_AGE_MS) return null;
  const repos = new Map<string, CloneReportEntry>();
  for (const item of obj.repos.slice(0, 2000)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || containerPathProblem(r.path)) continue;
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
    const entry = {
      path: r.path,
      dirty: bool(r.dirty),
      inProgress: bool(r.inProgress),
      stashCount: int(r.stashCount),
      unpushedCommits: int(r.unpushedCommits),
      hasRemote: bool(r.hasRemote),
      linkedWorktrees: int(r.linkedWorktrees),
      referencedBy: int(r.referencedBy),
      branch: typeof r.branch === "string" ? r.branch.slice(0, 200) : null,
      mergedIntoDefault: typeof r.mergedIntoDefault === "boolean" ? r.mergedIntoDefault : null,
      error: typeof r.error === "string" ? r.error.slice(0, 500) : null,
    };
    // A field that does not parse makes the entry an inspection failure: keep.
    const malformed = [entry.dirty, entry.inProgress, entry.stashCount, entry.unpushedCommits, entry.hasRemote, entry.linkedWorktrees, entry.referencedBy].some((v) => v === null);
    repos.set(r.path, {
      ...(entry as CloneReportEntry),
      error: malformed ? entry.error ?? "malformed report entry" : entry.error,
    });
  }
  return { inspectedAtMs, repos };
}

/** Why a reported container path cannot name a clone, or null when it can. */
export function containerPathProblem(p: string): string | null {
  if (!p.startsWith("/workspace/") && !p.startsWith("/scratch/")) return "is not under /workspace or /scratch";
  if (p.includes("\0") || p.includes("\\")) return "contains a forbidden character";
  const segments = p.split("/").slice(2);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "has an empty, \".\" or \"..\" segment";
  return null;
}

export type CloneFate =
  | { action: "remove" }
  | { action: "keep"; reason: string }
  | { action: "signal"; reason: string };

/**
 * The verdict for one repository. `quiet` is true when nothing in the tree
 * changed since the report was written AND within the idle TTL (the caller's
 * walk); a repository that is not quiet is never removed or signalled.
 */
export function decideCloneFate(entry: CloneReportEntry | undefined, quiet: boolean): CloneFate {
  if (!entry) return { action: "keep", reason: "no hygiene report for this clone" };
  if (entry.error) return { action: "keep", reason: `inspection failed: ${entry.error}` };
  if (!quiet) return { action: "keep", reason: "changed within the idle TTL or since the report" };
  const work: string[] = [];
  if (entry.dirty) work.push("uncommitted changes");
  if (entry.inProgress) work.push("a merge, rebase or cherry-pick in progress");
  if (entry.stashCount > 0) work.push(`${entry.stashCount} stash entr${entry.stashCount === 1 ? "y" : "ies"}`);
  if (entry.unpushedCommits > 0) {
    work.push(`${entry.unpushedCommits} commit${entry.unpushedCommits === 1 ? "" : "s"} on no remote${entry.hasRemote ? "" : " (no remote configured)"}`);
  }
  if (work.length > 0) return { action: "signal", reason: `unpushed work: ${work.join(", ")}` };
  if (entry.linkedWorktrees > 0) return { action: "keep", reason: "base of linked worktrees" };
  if (entry.referencedBy > 0) return { action: "keep", reason: "another clone borrows its objects" };
  return { action: "remove" };
}

/** A clone kept with unpushed work, idle longer than the TTL. */
export interface CloneHygieneSignal {
  botKey: string;
  /** Container path of the clone. */
  path: string;
  branch: string | null;
  reason: string;
  observedAtMs: number;
}

const signals = new Map<string, CloneHygieneSignal>();
const lastJudged = new Map<string, number>();
const reportCache = new Map<string, { mtimeMs: number; size: number; report: CloneReport | null }>();

/** The current unpushed-work signals (attention source `bot_disk_lifecycle`). */
export function cloneHygieneSignals(): CloneHygieneSignal[] {
  return [...signals.values()];
}

/** Test hook. */
export function resetCloneHygieneStateForTests(): void {
  signals.clear();
  lastJudged.clear();
  reportCache.clear();
}

export interface CloneHygieneContext {
  botKey: string;
  botPath: string;
  report: CloneReport | null;
  nowMs: number;
  /** Host paths of the repositories seen in this sweep (signals of the rest are dropped). */
  seen: Set<string>;
  finish(): void;
}

async function readReport(botPath: string, nowMs: number): Promise<CloneReport | null> {
  const file = join(botPath, "hermes", CLONE_HYGIENE_REPORT_PATH);
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_REPORT_BYTES) return null;
    const cached = reportCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.report;
    const report = parseCloneReport(await readFile(file, "utf8"), nowMs);
    reportCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, report });
    return report;
  } catch {
    return null;
  }
}

/** Per-bot state for one sweep; `finish()` drops signals of clones that are gone. */
export async function beginBotCloneHygiene(botPath: string, botKey: string, nowMs = Date.now()): Promise<CloneHygieneContext> {
  const report = await readReport(botPath, nowMs);
  const seen = new Set<string>();
  return {
    botKey,
    botPath,
    report,
    nowMs,
    seen,
    finish() {
      for (const [hostPath, signal] of signals) {
        if (signal.botKey === botKey && !seen.has(hostPath)) signals.delete(hostPath);
      }
    },
  };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function hasGitMarker(dir: string): Promise<boolean> {
  try {
    const st = await lstat(join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** Repositories at `dir` or below it (depth-limited, no symbolic links followed). */
async function findRepos(dir: string, depth = 0): Promise<string[]> {
  if (await hasGitMarker(dir)) return [dir];
  if (depth >= MAX_REPO_DEPTH) return [];
  let names: string[];
  try {
    names = (await readdir(dir)) as unknown as string[];
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const child = join(dir, name);
    if (!(await isDir(child))) continue;
    found.push(...(await findRepos(child, depth + 1)));
  }
  return found;
}

/**
 * True when no entry of the tree changed (mtime or ctime) after `sinceMs`.
 * Symbolic links are not followed, node_modules is not entered, and a tree too
 * large to walk counts as changed.
 */
export async function treeQuietSince(root: string, sinceMs: number): Promise<boolean> {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st;
    try {
      st = await lstat(current);
    } catch {
      continue; // vanished while walking
    }
    if (++visited > MAX_WALK_ENTRIES) return false;
    // A hard-linked file (every file of a pnpm node_modules is one, shared with
    // the store and the bot's other clones) gets a new ctime whenever ANOTHER
    // link to it is made or removed, so for those only the mtime says the
    // content changed.
    const changedAt = st.isFile() && st.nlink > 1 ? st.mtimeMs : Math.max(st.mtimeMs, st.ctimeMs);
    if (changedAt > sinceMs) return false;
    // node_modules holds ignored, regenerable files (and millions of entries):
    // the directory itself is checked, its contents are not walked.
    if (st.isDirectory() && basename(current) !== "node_modules") {
      let names: string[];
      try {
        names = (await readdir(current)) as unknown as string[];
      } catch {
        return false;
      }
      for (const name of names) stack.push(join(current, name));
    }
  }
  return true;
}

/** The host path is a real directory inside the bot's volume `sub`, reached without a symbolic link. */
async function insideVolume(botPath: string, sub: string, hostPath: string): Promise<boolean> {
  try {
    const [volume, real] = await Promise.all([realpath(join(botPath, sub)), realpath(hostPath)]);
    if (real !== join(volume, relative(join(botPath, sub), hostPath))) return false;
    return real.startsWith(volume + sep);
  } catch {
    return false;
  }
}

/**
 * Judge the git repositories at or under one volume entry. Returns false when
 * the entry holds no repository (the caller then applies the plain idle rule),
 * true when it does (the entry itself is never reaped as a whole then).
 */
export async function judgeGitClones(
  entryPath: string,
  config: { idleTtlMs: number },
  ctx: CloneHygieneContext & { sub: "scratch" | "workspace" },
): Promise<boolean> {
  if (!(await isDir(entryPath))) return false;
  const repos = await findRepos(entryPath);
  if (repos.length === 0) return false;
  const volumeHost = join(ctx.botPath, ctx.sub);
  for (const hostPath of repos) {
    ctx.seen.add(hostPath);
    const last = lastJudged.get(hostPath);
    if (last !== undefined && ctx.nowMs - last < CLONE_HYGIENE_JUDGE_INTERVAL_MS) continue;
    lastJudged.set(hostPath, ctx.nowMs);

    const containerPath = `/${ctx.sub}/${relative(volumeHost, hostPath).split(sep).join("/")}`;
    const entry = ctx.report?.repos.get(containerPath);
    let quiet = false;
    if (entry && !entry.error && ctx.report) {
      const since = Math.min(ctx.report.inspectedAtMs, ctx.nowMs - config.idleTtlMs);
      quiet = (await insideVolume(ctx.botPath, ctx.sub, hostPath)) && (await treeQuietSince(hostPath, since));
    }
    const fate = decideCloneFate(entry, quiet);
    if (fate.action === "remove") {
      signals.delete(hostPath);
      try {
        await rm(hostPath, { recursive: true, force: true });
        console.log(`Removed clean, fully pushed clone ${containerPath} of bot ${ctx.botKey}`);
      } catch (error) {
        console.error(`Failed to remove clone ${hostPath}:`, error);
      }
    } else if (fate.action === "signal") {
      signals.set(hostPath, {
        botKey: ctx.botKey,
        path: containerPath,
        branch: entry?.branch ?? null,
        reason: fate.reason,
        observedAtMs: signals.get(hostPath)?.observedAtMs ?? ctx.nowMs,
      });
    } else {
      signals.delete(hostPath);
    }
  }
  return true;
}
