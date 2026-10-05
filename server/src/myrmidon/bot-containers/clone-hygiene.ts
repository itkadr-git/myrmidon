// myrmidon(1.6.2-BOT-DISK-C): clone hygiene — the git part of the bot
// draft-directory lifecycle (draft-lifecycle.ts, BOT-DISK-A).
//
// WHERE THE FILES ARE. The board server has no mount of the bot volumes (host
// mounts were removed from it in 1.3.0), so it can neither inspect nor delete a
// clone. The work is done INSIDE each bot container by the image's
// `bot-clone-hygiene` (docker/bot-runtime/git-reference/bot-clone-hygiene),
// started by the entrypoint and run on a timer as the bot user:
//
// - the board sets the POLICY: the profile compiler writes
//   `MYRMIDON_CLONE_IDLE_TTL_SEC` (the lifecycle's idle TTL; 0 when the
//   lifecycle is off) into the bot's `.env`, so a change applies on the next
//   reconcile pass without a restart;
// - the reporter applies it: a clone that is clean, fully pushed (every commit
//   of HEAD and of every local branch is on a remote-tracking ref, which covers
//   "merged into origin/main" and "pushed with no local changes"), not the base
//   of a linked worktree, not the alternate of another clone, and unchanged for
//   longer than the TTL is removed; a clone with unpushed work (dirty tree,
//   operation in progress, stash, commits on no remote) is never touched;
// - the board only READS the report (the driver fetches
//   `/data/hermes/.myrmidon/clone-hygiene.json` from the running container) and
//   raises an attention signal (source `bot_disk_lifecycle`) for each clone with
//   unpushed work idle longer than the TTL. Git is never run by the board on a
//   bot's directory: repository config can name programs to execute.
//
// If the board DOES see the volume root (a development host), its own sweep
// still reaps plain directories by mtime but leaves every git repository to the
// reporter (draft-lifecycle.ts).

import { lstat, readdir } from "fs/promises";
import { join } from "path";

/** Where the image writes the report, relative to the bot's hermes volume. */
export const CLONE_HYGIENE_REPORT_PATH = ".myrmidon/clone-hygiene.json";
/** A report larger than this is ignored (no signals). */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** A report older than this is ignored. */
export const CLONE_HYGIENE_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Depth below a volume entry searched for nested repositories. */
const MAX_REPO_DEPTH = 3;
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
  /** Seconds since anything in the clone changed; null: unknown. */
  idleSeconds: number | null;
  error: string | null;
}

/** myrmidon(BOT-DISK-D): one clone root of the container-start hard-link self-check. */
export interface HardlinkRootResult {
  /** Container path of the root: /data/hermes, /workspace or /scratch. */
  root: string;
  ok: boolean;
  error: string | null;
}

/** The self-check the entrypoint runs at every start (docker/bot-runtime/entrypoint.sh)
 *  and the reporter passes on: a hard link from the pnpm store into each clone root. */
export interface HardlinkCheck {
  store: string;
  importMethod: string;
  ok: boolean;
  roots: HardlinkRootResult[];
}

export interface CloneReport {
  inspectedAtMs: number;
  repos: Map<string, CloneReportEntry>;
  hardlinkCheck: HardlinkCheck | null;
}

/** The report's `hardlinkCheck`, or null when absent or malformed. */
export function parseHardlinkCheck(value: unknown): HardlinkCheck | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.store !== "string" || typeof v.ok !== "boolean" || !Array.isArray(v.roots)) return null;
  const roots: HardlinkRootResult[] = [];
  for (const item of v.roots.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.root !== "string" || typeof r.ok !== "boolean") continue;
    roots.push({ root: r.root.slice(0, 200), ok: r.ok, error: typeof r.error === "string" ? r.error.slice(0, 500) : null });
  }
  return {
    store: v.store.slice(0, 500),
    importMethod: typeof v.importMethod === "string" ? v.importMethod.slice(0, 40) : "unknown",
    ok: v.ok,
    roots,
  };
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
      idleSeconds: int(r.idleSeconds),
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
  return { inspectedAtMs, repos, hardlinkCheck: parseHardlinkCheck(obj.hardlinkCheck) };
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
  /** `clone`: unpushed work in an idle clone. `hardlink` (BOT-DISK-D): pnpm cannot
   *  hard-link from its store into `path` (a clone root), so installs there copy. */
  kind?: "clone" | "hardlink";
  botKey: string;
  /** Container path of the clone. */
  path: string;
  branch: string | null;
  reason: string;
  observedAtMs: number;
}

const signals = new Map<string, CloneHygieneSignal>();

/** The current unpushed-work signals (attention source `bot_disk_lifecycle`). */
export function cloneHygieneSignals(): CloneHygieneSignal[] {
  return [...signals.values()];
}

/**
 * Replace the signals of one bot with those in its report. `idleTtlMs` is the
 * lifecycle TTL in force; a clone counts as idle when the report's
 * `idleSeconds` exceeds it. Returns false when the text is not a usable report.
 */
export function ingestCloneReport(botKey: string, raw: string, idleTtlMs: number, nowMs = Date.now()): boolean {
  if (raw.length > MAX_REPORT_BYTES) return false;
  const report = parseCloneReport(raw, nowMs);
  if (!report) return false;
  const seen = new Set<string>();
  for (const [containerPath, entry] of report.repos) {
    const key = `${botKey}:${containerPath}`;
    const idle = entry.idleSeconds !== null && entry.idleSeconds * 1000 > idleTtlMs;
    const fate = decideCloneFate(entry, idle);
    if (fate.action !== "signal") continue;
    seen.add(key);
    signals.set(key, {
      botKey,
      path: containerPath,
      branch: entry.branch,
      reason: fate.reason,
      observedAtMs: signals.get(key)?.observedAtMs ?? nowMs,
    });
  }
  // myrmidon(BOT-DISK-D): a clone root the start-time self-check could not hard-link into.
  for (const failed of report.hardlinkCheck?.roots.filter((root) => !root.ok) ?? []) {
    const key = `${botKey}:hardlink:${failed.root}`;
    seen.add(key);
    signals.set(key, {
      kind: "hardlink",
      botKey,
      path: failed.root,
      branch: null,
      reason: `cannot hard-link from the pnpm store ${report.hardlinkCheck?.store}: ${failed.error ?? "unknown error"}`,
      observedAtMs: signals.get(key)?.observedAtMs ?? nowMs,
    });
  }
  for (const [key, signal] of signals) {
    if (signal.botKey === botKey && !seen.has(key)) signals.delete(key);
  }
  return true;
}

/** Forget the signals of bots that are gone or whose report cannot be read any more. */
export function dropCloneSignalsExcept(botKeys: ReadonlySet<string>): void {
  for (const [key, signal] of signals) {
    if (!botKeys.has(signal.botKey)) signals.delete(key);
  }
}

/** Test hook. */
export function resetCloneHygieneStateForTests(): void {
  signals.clear();
  lifecycleState.rootMissingLogged = false;
  lifecycleState.reportsSeenAtMs = null;
  lifecycleState.rootPresent = null;
}

// "Lifecycle not effective": the board cannot see the volume root and no bot has
// delivered a report, so nothing is being reclaimed anywhere.
const lifecycleState: { rootMissingLogged: boolean; reportsSeenAtMs: number | null; rootPresent: boolean | null } = {
  rootMissingLogged: false,
  reportsSeenAtMs: null,
  rootPresent: null,
};
const REPORT_FRESH_MS = 24 * 60 * 60 * 1000;

/** The board-side sweep found (or lost) the volume root. Logs once per absence. */
export function noteVolumeRoot(present: boolean, log: (message: string) => void): void {
  lifecycleState.rootPresent = present;
  if (present) {
    lifecycleState.rootMissingLogged = false;
  } else if (!lifecycleState.rootMissingLogged) {
    lifecycleState.rootMissingLogged = true;
    log("bot volume root is not visible to the board; the board-side sweep is a no-op (clones are reaped inside the bot containers)");
  }
}

/** A bot's report was read: the in-container lifecycle is working. */
export function noteCloneReportSeen(nowMs = Date.now()): void {
  lifecycleState.reportsSeenAtMs = nowMs;
}

/**
 * True when the lifecycle reclaims nothing: the board cannot see the volume root
 * and no bot delivered a fresh clone report. Null before the first sweep.
 */
export function lifecycleNotEffective(nowMs = Date.now()): boolean | null {
  if (lifecycleState.rootPresent === null) return null;
  if (lifecycleState.rootPresent) return false;
  const seen = lifecycleState.reportsSeenAtMs;
  return seen === null || nowMs - seen > REPORT_FRESH_MS;
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
export async function findRepos(dir: string, depth = 0): Promise<string[]> {
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
