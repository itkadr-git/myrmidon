#!/usr/bin/env node
// Review approval -> GitHub label and auto-merge controller, with green main protection.
//
// The reviewer role records its verdict on the board (a comment with a line such
// as `VERDICT #123: APPROVE` or `VERDICT: APPROVE - PR #123, head <sha>`). The
// `review-approved` label on the pull request is what the `hot-files-review`
// gate and the auto-merge read. This script turns the first into the second:
// it reads the recent verdict comments of the reviewer agents, and puts the label
// (and optionally enables native `gh pr merge --auto --squash`) on a pull request
// only when ALL of this holds:
//   1. the main branch CI is green right now: the newest `CI result` check run on
//      the main head that is a verdict (not `skipped`) is `completed success`. If
//      main is red, pending, running, or has no registered run, merge / auto-merge
//      is held and backoff is applied;
//   2. the newest verdict line about that PR is an approval (a later RETURN,
//      DEFERRED, or an unclear line cancels it);
//   3. the PR is open and not a draft;
//   4. the head did not move after the verdict: a verdict that names a head sha
//      must match the current head; a verdict without one must be newer than the
//      head commit;
//   5. the check run `CI result` of the head commit is `success`: the newest run
//      that is a verdict; a `skipped` run (the label-event runs of the workflow
//      skip `CI result`) is passed over and never hides an earlier result;
//   6. the PR base is not behind main: the PR's `base.sha` equals the current
//      main head. A stale base never merges — the script asks GitHub to
//      update-branch and waits for a fresh green CI on the new head;
//   7. migration guard: a PR that rewrites an existing
//      `packages/db/src/migrations/NNNN_*.sql` or `meta/NNNN_snapshot.json` file,
//      or adds a snapshot numbered below the newest one already on main, is
//      refused (no label, no auto-merge; an armed auto-merge is disabled).
//   8. exact-head arm (OPE-12186): the arm command is
//      `gh pr merge --auto --squash --match-head-commit <headSha>` — GitHub may
//      only merge the head the verdict approved, never a commit that lands
//      between the arm and the merge. Without a head sha auto-merge is not
//      armed (the label is still applied).
// A PR whose head moved after an approval is reported as `needs-rereview` (the
// reviewer must look at the new commits only); the script never labels it.
//
// When main is red, candidate merges are held ("main-red"), backoff increments,
// and state is preserved. Once main turns green, merge resumes and backoff is reset.
// Repeated runs are safe and idempotent.
//
// Usage (run it from CI or a Myrmidon worker; no host-installed scripts are needed):
//   node scripts/myrmidon/review-approve-label.mjs --repo owner/name \
//        [--since-hours 48] [--reviewer-pattern '^adm-dev-review'] [--dry-run] [--json] \
//        [--check-main] [--base-branch main] [--auto-merge] [--state-file <path>]
//   node scripts/myrmidon/review-approve-label.mjs --print-sql [--since-hours 48]
//
// Verdicts are fetched from the Myrmidon REST API using PAPERCLIP_API_URL,
// PAPERCLIP_COMPANY_ID, and PAPERCLIP_API_KEY. PAPERCLIP_RUN_ID is forwarded
// as X-Paperclip-Run-Id for board requests. Exit code: 0 ok, 1 a board/GitHub
// call failed, 2 usage.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const APPROVED_LABEL = "review-approved";
export const CI_CHECK_NAME = "CI result";
/** Check runs are read in pages of 100; one head never has anywhere near this many `CI result` runs. */
const CHECK_RUNS_MAX_PAGES = 10;
/**
 * Conclusions of a completed `CI result` run that say nothing about the head.
 * The workflow skips `CI result` on label events (all but `full-ci`), so a
 * `skipped` run is always newer than the real one after a label is put on the
 * pull request; it is not a verdict and must never hide the real result.
 * `cancelled` / `timed_out` / `neutral` are NOT listed: they are real outcomes
 * and are never read as `success`.
 */
export const NOT_A_VERDICT_CONCLUSIONS = new Set(["skipped"]);

/**
 * The state of the `CI result` check from ITS check runs of one commit.
 * Runs are walked newest first (`started_at`, then the run id): a completed
 * `skipped` run is passed over; the first other run decides, a run still
 * queued / in progress answers its status (pending for the caller). A commit
 * with no `CI result` run is "missing"; one whose runs are all skipped has no
 * verdict yet and is "pending".
 */
export function selectCiResultConclusion(checkRuns, name = CI_CHECK_NAME) {
  const named = (Array.isArray(checkRuns) ? checkRuns : []).filter((item) => item && item.name === name);
  if (named.length === 0) return "missing";
  const newestFirst = [...named].sort(
    (a, b) =>
      String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")) || Number(b.id ?? 0) - Number(a.id ?? 0),
  );
  for (const run of newestFirst) {
    if (run.status !== "completed") return run.status ?? "pending";
    const conclusion = run.conclusion ?? "unknown";
    if (NOT_A_VERDICT_CONCLUSIONS.has(conclusion)) continue;
    return conclusion;
  }
  return "pending";
}
export const MIGRATION_SQL_RE = /^packages\/db\/src\/migrations\/(\d{4})_[^/]*\.sql$/;
export const MIGRATION_SNAPSHOT_RE = /^packages\/db\/src\/migrations\/meta\/(\d{4})_snapshot\.json$/;

/**
 * Migration guard (OPE-10520): returns the reason a PR must not merge because of
 * migration files, or null when the PR is clean.
 * - `migration-overwrite`: the PR modifies a migration .sql or meta snapshot file
 *   that already exists on main (SQL of an applied migration must never change);
 * - `migration-stale-number`: the PR adds a migration/snapshot numbered below the
 *   newest one already on main (breaks the snapshot chain, e.g. 0434 prevId != 0433 id).
 */
export function detectMigrationViolation(prFiles, mainFiles) {
  const mainSet = new Set(mainFiles ?? []);
  let newestMain = -1;
  for (const path of mainSet) {
    const m = MIGRATION_SQL_RE.exec(path) ?? MIGRATION_SNAPSHOT_RE.exec(path);
    if (m) newestMain = Math.max(newestMain, Number(m[1]));
  }
  for (const path of prFiles ?? []) {
    const m = MIGRATION_SQL_RE.exec(path) ?? MIGRATION_SNAPSHOT_RE.exec(path);
    if (!m) continue;
    const number = Number(m[1]);
    if (mainSet.has(path)) return { reason: "migration-overwrite", path };
    if (number < newestMain) return { reason: "migration-stale-number", path };
  }
  return null;
}
export const DEFAULT_REVIEWER_PATTERN = "^adm-dev-review";
export const DEFAULT_SINCE_HOURS = 48;
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_BASE_DELAY_MS = 30_000;
export const DEFAULT_MAX_DELAY_MS = 1_800_000;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const RED_MAIN_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

export function isRedMain(conclusion) {
  return typeof conclusion === "string" && RED_MAIN_CONCLUSIONS.has(conclusion.toLowerCase());
}

const APPROVE_WORDS = /\b(?:APPROVE|APPROVED|LGTM)\b/i;
const NON_APPROVE_WORDS =
  /\b(?:RETURN|RETURNED|REWORK|DEFERRED|REJECT|REJECTED|BLOCK|BLOCKED|CHANGES[ \t]+REQUESTED|REQUEST[ \t]+CHANGES|SUPERSEDED)\b/i;
const VERDICT_WORD = /(?:\bVERDICT\b|ВЕРДИКТ)/i;
const PR_REFERENCE = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g;
const HEAD_REFERENCE = /\bhead\b[^0-9a-fA-F\n]{0,8}([0-9a-fA-F]{7,40})\b/i;

/**
 * Calculates exponential backoff delay based on consecutive failure count.
 */
export function calculateBackoff({
  consecutiveFailures = 0,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  factor = DEFAULT_BACKOFF_FACTOR,
} = {}) {
  if (consecutiveFailures <= 0) return 0;
  const delay = baseDelayMs * Math.pow(factor, consecutiveFailures - 1);
  return Math.min(maxDelayMs, delay);
}

/**
 * State store helper for file-backed controller state.
 */
export function createFileStateStore(filePath) {
  return {
    async load() {
      try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        const text = fs.readFileSync(filePath, "utf8");
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async save(state) {
      if (!filePath) return;
      try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
      } catch {
        // fail-safe: ignore disk write failure
      }
    },
  };
}

/**
 * In-memory state store for tests and short-lived runs.
 */
export function createMemoryStateStore(initial = null) {
  let state = initial ? { ...initial } : null;
  return {
    async load() {
      return state ? { ...state } : null;
    },
    async save(newState) {
      state = { ...newState };
    },
  };
}

/**
 * Verdict markers of one comment: one entry per line that names a verdict.
 * A line with both approving and non-approving words, or with several different
 * PR numbers, is `unclear`: it can never approve, and as the newest line it
 * cancels an older approval (fail closed).
 */
export function parseVerdictLines(body, repo) {
  const markers = [];
  const lines = String(body ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!VERDICT_WORD.test(line)) continue;
    const numbers = new Set();
    for (const match of line.matchAll(PR_REFERENCE)) {
      if (match[1] && repo && match[1].toLowerCase() !== repo.toLowerCase()) continue;
      numbers.add(Number(match[2]));
    }
    if (numbers.size === 0) continue;
    const approves = APPROVE_WORDS.test(line);
    const refuses = NON_APPROVE_WORDS.test(line);
    const headMatch = HEAD_REFERENCE.exec(line);
    const head = headMatch ? headMatch[1].toLowerCase() : null;
    let outcome = "unclear";
    if (numbers.size === 1) {
      if (approves && !refuses) outcome = "approve";
      else if (refuses && !approves) outcome = "refuse";
    }
    for (const prNumber of numbers) markers.push({ prNumber, outcome, head, line: index });
  }
  return markers;
}

/** The newest marker per PR across the reviewer comments (time, then line order). */
export function latestVerdicts(comments, { repo, reviewerPattern = DEFAULT_REVIEWER_PATTERN } = {}) {
  const pattern = new RegExp(reviewerPattern);
  const newest = new Map();
  for (const comment of comments ?? []) {
    if (!comment || typeof comment !== "object") continue;
    if (!pattern.test(String(comment.authorName ?? ""))) continue;
    const at = comment.createdAt ? new Date(comment.createdAt) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    for (const marker of parseVerdictLines(comment.body, repo)) {
      const current = newest.get(marker.prNumber);
      const later =
        !current ||
        at.getTime() > current.at.getTime() ||
        (at.getTime() === current.at.getTime() && marker.line >= current.line);
      if (later) newest.set(marker.prNumber, { ...marker, at, commentId: comment.id ?? null, issueId: comment.issueId ?? null });
    }
  }
  return newest;
}

function headMatches(pinned, actual) {
  const a = String(actual ?? "").toLowerCase();
  return a.length > 0 && (a.startsWith(pinned) || pinned.startsWith(a));
}

/**
 * The decision for one PR. `pr` is {state, draft, merged, headSha, labels, autoMerge, baseSha},
 * `headCommittedAt` a Date or null, `ci` is the conclusion of the `CI result`
 * check run of the head ("success", "failure", "in_progress", "missing", ...),
 * `mainCi` is the resolved conclusion used for red-main backoff bookkeeping,
 * `mainGreen` is true only when the newest `CI result` run on main is completed
 * success right now (OPE-10520: merge only against a currently-green main),
 * `isMainRed` indicates whether main auto-merge is currently held,
 * `baseBehind` is true when the PR base no longer matches the main head,
 * `migrationViolation` is a {reason, path} from `detectMigrationViolation` or null.
 */
export function decideApproveLabel({
  verdict,
  pr,
  headCommittedAt,
  ci,
  mainCi = "success",
  mainGreen = true,
  isMainRed = false,
  baseBehind = false,
  basePr = null,
  cannotRetarget = false,
  migrationViolation = null,
  autoMerge = false,
}) {
  if (!verdict) return { action: "skip", reason: "no-verdict" };
  if (verdict.outcome !== "approve") return { action: "skip", reason: `latest-verdict-${verdict.outcome}` };
  if (pr.merged || pr.state !== "open") return { action: "skip", reason: "pr-not-open" };
  if (pr.draft) return { action: "skip", reason: "pr-draft" };
  if (verdict.head) {
    if (!headMatches(verdict.head, pr.headSha)) return { action: "needs-rereview", reason: "head-moved-after-verdict" };
  } else if (!headCommittedAt || headCommittedAt.getTime() > verdict.at.getTime()) {
    return { action: "needs-rereview", reason: "head-newer-than-verdict" };
  }
  if (ci !== "success") return { action: "skip", reason: `ci-${ci}` };

  // Migration guard (OPE-10520): refuse to merge PRs that rewrite applied
  // migrations or add a snapshot below the newest on main. If auto-merge was
  // armed before the violation appeared, disarm it and strip the label.
  if (migrationViolation) {
    return {
      action: "refuse",
      reason: migrationViolation.reason,
      path: migrationViolation.path,
      disableAutoMerge: Boolean(pr.autoMerge),
      removeLabel: Boolean(pr.labels.includes(APPROVED_LABEL)),
    };
  }

  // Stale base (OPE-10520): never merge a PR whose base is behind main — CI was
  // green on an old tree. The caller asks GitHub to update-branch; the new head
  // then needs a fresh verdict + green CI.
  if (baseBehind) {
    if (pr.autoMerge) {
      return { action: "hold", disableAutoMerge: true, reason: "base-behind" };
    }
    return { action: "hold", reason: "base-behind" };
  }

  // Stacked PR base check (OPE-10815): if the PR's base is neither defaultBranch nor rel/*,
  // check the PR of that base. If it's already merged or closed, the PR cannot be merged into
  // the dead base branch.
  const defaultBranch = pr.defaultBranch || "main";
  const isBaseDelivering = !pr.baseRef || pr.baseRef === defaultBranch || pr.baseRef.startsWith("rel/");
  if (!isBaseDelivering && basePr && (basePr.merged || basePr.state === "closed")) {
    if (cannotRetarget) {
      return {
        action: "refuse",
        reason: "cannot-retarget-base-to-main",
        disableAutoMerge: Boolean(pr.autoMerge),
        removeLabel: Boolean(pr.labels && pr.labels.includes(APPROVED_LABEL)),
      };
    }
    return {
      action: "hold",
      reason: "base-retargeted-waiting-ci",
      retargetBase: defaultBranch,
      disableAutoMerge: Boolean(pr.autoMerge),
    };
  }

  const alreadyLabeled = pr.labels.includes(APPROVED_LABEL);
  const redMain = isMainRed || isRedMain(mainCi);
  // OPE-10520: auto-merge is armed only while main is green right now. A running
  // or missing main CI is held even if the last completed run was green.
  const mergeAllowed = !redMain && mainGreen;

  // When main is red, auto-merge must not be enabled.
  // If native auto-merge was already turned on for the PR, disable it safely.
  const shouldDisableAutoMerge = (!mergeAllowed) && Boolean(pr.autoMerge);
  const shouldEnableAutoMerge = mergeAllowed && autoMerge && !pr.autoMerge;

  if (alreadyLabeled) {
    if (shouldDisableAutoMerge) {
      const reason = redMain && isRedMain(mainCi) ? "main-red" : "main-not-green";
      return { action: "hold", disableAutoMerge: true, reason };
    }
    if (shouldEnableAutoMerge) {
      return { action: "label", autoMerge: true, reason: "approved-head-green" };
    }
    if (!mergeAllowed && autoMerge) {
      const reason = redMain && isRedMain(mainCi) ? "main-red" : "main-not-green";
      return { action: "hold", reason };
    }
    return { action: "noop", reason: "already-labeled" };
  }

  // The review-approved label is applied as soon as the PR head is approved and green,
  // triggering CI pipelines. Auto-merge is held if main is not green right now.
  const decision = {
    action: "label",
    autoMerge: shouldEnableAutoMerge,
    reason: "approved-head-green",
  };
  if (!mergeAllowed) decision.holdMerge = true;
  if (shouldDisableAutoMerge) decision.disableAutoMerge = true;
  return decision;
}

export function boardVerdictSql(sinceHours) {
  const hours = Number(sinceHours);
  if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 30) throw new Error("--since-hours must be an integer from 1 to 720");
  return (
    "select coalesce(json_agg(row_to_json(t)), '[]'::json) from (" +
    "select c.id as \"id\", c.issue_id as \"issueId\", c.created_at as \"createdAt\", a.name as \"authorName\", c.body as \"body\" " +
    "from issue_comments c join agents a on a.id = c.author_agent_id " +
    `where c.created_at > now() - interval '${hours} hours' ` +
    "and (c.body ilike '%verdict%' or c.body ilike '%вердикт%') order by c.created_at" +
    ") t;"
  );
}

/** Runs the SQL through an operator-supplied command (SQL on stdin, never in the command line). */
export function readVerdictsFromPsql(command, sql, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`the board command exited with ${code}`));
      try {
        const parsed = JSON.parse(stdout.trim() || "[]");
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        reject(new Error("the board command did not return JSON"));
      }
    });
    child.stdin.end(sql);
  });
}

async function ghJson(args) {
  const { stdout } = await execFileAsync("gh", ["api", ...args], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** The GitHub side, injectable for tests. */
export function createGitHubPort(repo, options = {}) {
  const run = typeof options === "function" ? options : (options.run ?? ghJson);
  const runPr = options.runPr ?? (async (args) => {
    const { stdout } = await execFileAsync("gh", ["pr", ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  });

  return {
    async pullRequest(number) {
      const data = await run([`repos/${repo}/pulls/${number}`]);
      return {
        state: data.state,
        draft: Boolean(data.draft),
        merged: Boolean(data.merged_at) || Boolean(data.merged),
        headSha: data.head?.sha ?? null,
        baseSha: data.base?.sha ?? null,
        baseRef: data.base?.ref ?? null,
        defaultBranch: data.base?.repo?.default_branch ?? "main",
        labels: (data.labels ?? []).map((label) => label.name),
        autoMerge: Boolean(data.auto_merge || data.autoMergeRequest),
      };
    },
    async updatePullRequestBase(number, base) {
      await run(["-X", "PATCH", `repos/${repo}/pulls/${number}`, "-f", `base=${base}`]);
    },
    async findPullRequestByHead(headBranch) {
      const owner = repo.split("/")[0];
      const data = await run([`repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=all`]);
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        return {
          number: item.number,
          state: item.state,
          merged: Boolean(item.merged_at || item.merged),
        };
      }
      return null;
    },
    async pullRequestFiles(number) {
      const data = await run([`repos/${repo}/pulls/${number}/files?per_page=100`]);
      return (Array.isArray(data) ? data : []).map((file) => file.filename).filter(Boolean);
    },
    async mainMigrationFiles(baseBranch = DEFAULT_BASE_BRANCH) {
      const trees = [];
      for (const dir of ["packages/db/src/migrations", "packages/db/src/migrations/meta"]) {
        try {
          const data = await run([`repos/${repo}/contents/${dir}?ref=${encodeURIComponent(baseBranch)}&per_page=100`]);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.type === "file" && typeof item.path === "string") trees.push(item.path);
            }
          }
        } catch {
          // A missing directory or a permissions hiccup must not crash the gate:
          // an empty list still catches overwrite-by-name below because the PR
          // file check falls back to comparing against an empty main set only
          // when no main files are listed; log is emitted by the caller.
        }
      }
      return trees;
    },
    async updateBranch(number) {
      await run(["-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`]);
    },
    async headCommittedAt(sha) {
      const data = await run([`repos/${repo}/commits/${sha}`]);
      const value = data.commit?.committer?.date ?? data.commit?.author?.date;
      return value ? new Date(value) : null;
    },
    async ciConclusion(sha) {
      // `filter=all`, as the board-side merge reader does: the default
      // `filter=latest` keeps only the newest run of every check suite, so a
      // rerun inside one suite would hide the attempt before it. The selection
      // of the verdict among the runs is selectCiResultConclusion's.
      const runs = [];
      for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
        const data = await run([
          `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CI_CHECK_NAME)}&filter=all&per_page=100&page=${page}`,
        ]);
        const batch = data.check_runs ?? [];
        runs.push(...batch);
        const total = typeof data.total_count === "number" ? data.total_count : batch.length;
        if (batch.length === 0 || runs.length >= total) break;
      }
      return selectCiResultConclusion(runs);
    },
    async mainHeadSha(baseBranch = DEFAULT_BASE_BRANCH) {
      const data = await run([`repos/${repo}/commits/${baseBranch}`]);
      return data.sha ?? null;
    },
    async mainCiConclusion(baseBranch = DEFAULT_BASE_BRANCH) {
      const sha = await this.mainHeadSha(baseBranch);
      if (!sha) return "missing";
      return await this.ciConclusion(sha);
    },
    async mainCiDetails(baseBranch = DEFAULT_BASE_BRANCH) {
      const sha = await this.mainHeadSha(baseBranch);
      if (!sha) return { status: "missing", conclusion: "missing", lastCompleted: null };
      const current = await this.ciConclusion(sha);
      if (current === "success" || RED_MAIN_CONCLUSIONS.has(current)) {
        return { status: "completed", conclusion: current, lastCompleted: current };
      }
      let lastCompleted = null;
      try {
        const commits = await run([`repos/${repo}/commits?sha=${encodeURIComponent(baseBranch)}&per_page=10`]);
        if (Array.isArray(commits)) {
          for (const c of commits) {
            const commitSha = c.sha;
            if (!commitSha || commitSha === sha) continue;
            const pastCi = await this.ciConclusion(commitSha);
            if (pastCi === "success" || RED_MAIN_CONCLUSIONS.has(pastCi)) {
              lastCompleted = pastCi;
              break;
            }
          }
        }
      } catch {
        // fallback if commits query fails
      }
      return { status: current, conclusion: current, lastCompleted };
    },
    async removeLabel(number) {
      await run(["-X", "DELETE", `repos/${repo}/issues/${number}/labels/${APPROVED_LABEL}`]);
    },
    async addLabel(number) {
      await run(["-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${APPROVED_LABEL}`]);
    },
    async enableAutoMerge(number, headSha) {
      if (!headSha) throw new Error(`enableAutoMerge(${number}): head sha is required — refusing to arm auto-merge without --match-head-commit`);
      await runPr(["merge", String(number), "-R", repo, "--auto", "--squash", "--match-head-commit", headSha]);
    },
    async disableAutoMerge(number) {
      await runPr(["merge", String(number), "-R", repo, "--disable-auto"]);
    },
  };
}

export async function runOnce({
  comments,
  repo,
  reviewerPattern,
  github,
  checkMain = true,
  baseBranch = DEFAULT_BASE_BRANCH,
  autoMerge = false,
  stateStore = null,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  factor = DEFAULT_BACKOFF_FACTOR,
  dryRun = false,
  now = new Date(),
  log = () => {},
}) {
  const verdicts = latestVerdicts(comments, { repo, reviewerPattern });
  const results = [];
  let failed = 0;

  const candidatePrs = [...verdicts.entries()].sort((a, b) => a[0] - b[0]);
  const hasApproveCandidate = candidatePrs.some(([, v]) => v.outcome === "approve");

  const state = (await stateStore?.load()) ?? {
    consecutiveFailures: 0,
    backoffUntil: null,
    mainStatus: "unknown",
    lastCompletedStatus: "unknown",
  };

  let mainCiRaw = "success";
  let lastCompletedMain = null;
  if (checkMain && hasApproveCandidate) {
    try {
      if (typeof github.mainCiDetails === "function") {
        const details = await github.mainCiDetails(baseBranch);
        mainCiRaw = details.status ?? details.conclusion ?? "unknown";
        lastCompletedMain = details.lastCompleted ?? null;
      } else {
        const res = await github.mainCiConclusion(baseBranch);
        if (typeof res === "object" && res !== null) {
          mainCiRaw = res.status ?? res.conclusion ?? "unknown";
          lastCompletedMain = res.lastCompleted ?? null;
        } else {
          mainCiRaw = String(res ?? "missing");
        }
      }
    } catch (err) {
      mainCiRaw = "error";
      log(`Failed to inspect main branch CI: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const isRunning =
    mainCiRaw === "in_progress" ||
    mainCiRaw === "queued" ||
    mainCiRaw === "pending" ||
    mainCiRaw === "missing";

  let resolvedConclusion = mainCiRaw;
  if (isRunning) {
    // When main CI is running or not yet registered, take the last completed CI result conclusion
    const prev =
      lastCompletedMain ||
      (state.lastCompletedStatus && state.lastCompletedStatus !== "unknown" ? state.lastCompletedStatus : null) ||
      (state.mainStatus && state.mainStatus !== "unknown" && !["in_progress", "queued", "pending", "missing"].includes(state.mainStatus) ? state.mainStatus : null) ||
      "success";
    resolvedConclusion = prev;
    log(`Main branch CI is currently ${mainCiRaw}; using last completed conclusion: ${resolvedConclusion}.`);
  }

  const isMainRed = isRedMain(resolvedConclusion);
  // OPE-10520: merge only when the newest main CI run is completed success right
  // now. in_progress/queued/missing holds the merge even if the last completed
  // run was green (the #1923 incident merged into a main whose fresh run was red).
  const mainGreen = mainCiRaw === "success";

  const isBackoffActive = Boolean(
    state.backoffUntil && new Date(state.backoffUntil).getTime() > now.getTime()
  );

  let consecutiveFailures = state.consecutiveFailures ?? 0;
  let backoffUntil = state.backoffUntil ?? null;
  let lastCompletedStatus = state.lastCompletedStatus ?? "unknown";

  if (isBackoffActive) {
    // While in an active backoff window, hold auto-merge and do not increment backoff again
    lastCompletedStatus = resolvedConclusion;
    log(`Auto-merge controller in backoff until ${backoffUntil}. Auto-merge paused.`);
  } else if (mainCiRaw === "failure") {
    // Pause / backoff grows only on actual failure of main
    consecutiveFailures += 1;
    const delayMs = calculateBackoff({ consecutiveFailures, baseDelayMs, maxDelayMs, factor });
    backoffUntil = new Date(now.getTime() + delayMs).toISOString();
    lastCompletedStatus = "failure";
    log(`Main CI failed. Consecutive failures: ${consecutiveFailures}, backoff until ${backoffUntil}.`);
  } else if (isRunning) {
    // Pause does not grow while CI is in_progress / queued
    lastCompletedStatus = resolvedConclusion;
    if (backoffUntil && new Date(backoffUntil).getTime() <= now.getTime()) {
      backoffUntil = null;
    }
  } else if (isRedMain(mainCiRaw)) {
    // cancelled or timed_out: main is red, but pause counter only increments on failure
    lastCompletedStatus = mainCiRaw;
    if (backoffUntil && new Date(backoffUntil).getTime() <= now.getTime()) {
      backoffUntil = null;
    }
  } else if (mainCiRaw === "success") {
    // Main is green: reset failures and backoff
    consecutiveFailures = 0;
    backoffUntil = null;
    lastCompletedStatus = "success";
  }

  const currentlyBackingOff = Boolean(
    backoffUntil && new Date(backoffUntil).getTime() > now.getTime()
  );
  const holdAutoMerge = isMainRed || currentlyBackingOff || !mainGreen;

  await stateStore?.save({
    consecutiveFailures,
    backoffUntil,
    mainStatus: mainCiRaw,
    lastCompletedStatus,
    lastCheckAt: now.toISOString(),
  });

  // One main-head lookup shared by all candidates: the stale-base gate compares
  // each PR's base.sha against it (OPE-10520, incident #2265).
  let mainHeadSha = null;
  if (checkMain && hasApproveCandidate && typeof github.mainHeadSha === "function") {
    try {
      mainHeadSha = await github.mainHeadSha(baseBranch);
    } catch (err) {
      log(`Failed to resolve ${baseBranch} head: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Migration guard listing from main, shared across candidates. An empty result
  // fails closed on the merge path: auto-merge is held until the listing works.
  let mainMigrationList = null;
  let mainMigrationListOk = false;
  if (hasApproveCandidate && typeof github.mainMigrationFiles === "function") {
    try {
      mainMigrationList = await github.mainMigrationFiles(baseBranch);
      mainMigrationListOk = Array.isArray(mainMigrationList) && mainMigrationList.length > 0;
      if (!mainMigrationListOk) {
        log("Migration guard: no migration files listed on main; holding auto-merge until the listing works.");
      }
    } catch (err) {
      log(`Migration guard: failed to list main migration files: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    mainMigrationListOk = true; // port does not support the listing: skip the guard
  }

  for (const [prNumber, verdict] of candidatePrs) {
    if (verdict.outcome !== "approve") {
      results.push({ prNumber, action: "skip", reason: `latest-verdict-${verdict.outcome}` });
      continue;
    }
    try {
      const pr = await github.pullRequest(prNumber);
      let headCommittedAt = null;
      let ci = "missing";
      if (pr.state === "open" && pr.headSha) {
        headCommittedAt = verdict.head ? null : await github.headCommittedAt(pr.headSha);
        ci = await github.ciConclusion(pr.headSha);
      }
      // Stale base (OPE-10520): PR whose base.sha lags the main head never merges.
      // If the main head could not be resolved, fail closed and treat the base as
      // behind — an unverifiable base must not merge.
      const baseBehind = Boolean(pr.baseSha) && (mainHeadSha ? pr.baseSha !== mainHeadSha : checkMain);
      // Migration guard (OPE-10520): refuse PRs that rewrite applied migrations
      // or add snapshots numbered below the newest on main.
      let migrationViolation = null;
      if (pr.state === "open" && !pr.draft && typeof github.pullRequestFiles === "function") {
        try {
          const prFiles = await github.pullRequestFiles(prNumber);
          if (Array.isArray(prFiles) && mainMigrationListOk) {
            migrationViolation = detectMigrationViolation(prFiles, mainMigrationList);
          }
        } catch (err) {
          failed += 1;
          results.push({
            prNumber,
            action: "error",
            reason: `migration-guard-read-failed: ${err instanceof Error ? err.message.split("\n")[0] : "error"}`,
          });
          continue;
        }
      }

      // Stacked PR base check (OPE-10815): if base is non-main, non-rel/*, inspect base PR
      let basePr = null;
      let cannotRetarget = false;
      const defaultBranch = pr.defaultBranch || "main";
      const isBaseDelivering = !pr.baseRef || pr.baseRef === defaultBranch || pr.baseRef.startsWith("rel/");
      if (pr.state === "open" && !pr.draft && !isBaseDelivering && typeof github.findPullRequestByHead === "function") {
        try {
          basePr = await github.findPullRequestByHead(pr.baseRef);
          if (basePr && (basePr.merged || basePr.state === "closed")) {
            if (!dryRun && typeof github.updatePullRequestBase === "function") {
              try {
                await github.updatePullRequestBase(prNumber, defaultBranch);
              } catch (err) {
                cannotRetarget = true;
                log(`PR #${prNumber}: failed to retarget base to ${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        } catch (err) {
          log(`PR #${prNumber}: failed to inspect base PR for ${pr.baseRef}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const decision = decideApproveLabel({
        verdict,
        pr,
        headCommittedAt,
        ci,
        mainCi: resolvedConclusion,
        mainGreen: mainGreen && mainMigrationListOk,
        isMainRed: holdAutoMerge,
        baseBehind,
        basePr,
        cannotRetarget,
        migrationViolation,
        autoMerge: autoMerge && !holdAutoMerge,
      });

      if (decision.action === "label" && !dryRun) {
        if (!pr.labels.includes(APPROVED_LABEL)) {
          await github.addLabel(prNumber);
        }
        if (decision.autoMerge) {
          if (pr.headSha) {
            await github.enableAutoMerge(prNumber, pr.headSha);
          } else {
            // Fail closed (OPE-12186): without a head sha the merge could land a
            // commit newer than the approved one — arm nothing, keep the label.
            log(`PR #${prNumber}: head sha unknown — auto-merge not armed (label kept).`);
          }
        }
      }
      if (decision.action === "refuse" && !dryRun) {
        if (decision.disableAutoMerge) await github.disableAutoMerge(prNumber);
        if (decision.removeLabel) await github.removeLabel(prNumber);
      }
      if (decision.disableAutoMerge && decision.action !== "refuse" && !dryRun) {
        await github.disableAutoMerge(prNumber);
      }
      if (decision.action === "hold" && decision.reason === "base-behind" && !dryRun) {
        // Ask GitHub to bring the base up to date; the new head will then need a
        // fresh verdict and a fresh green CI before any merge (OPE-10520).
        try {
          await github.updateBranch(prNumber);
          decision.updateBranch = true;
        } catch (err) {
          log(`PR #${prNumber}: update-branch failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
      results.push({
        prNumber,
        ...decision,
        dryRun: dryRun && (decision.action === "label" || decision.disableAutoMerge || decision.action === "refuse") ? true : undefined,
      });
    } catch (err) {
      failed += 1;
      results.push({ prNumber, action: "error", reason: err instanceof Error ? err.message.split("\n")[0] : "error" });
    }
  }

  for (const r of results) log(`PR #${r.prNumber}: ${r.action} (${r.reason})${r.dryRun ? " [dry run]" : ""}`);
  return {
    results,
    failed,
    paused: holdAutoMerge,
    mainCi: mainCiRaw,
    resolvedMainCi: resolvedConclusion,
    consecutiveFailures,
    backoffUntil,
  };
}

function parseArgs(argv) {
  const args = {
    repo: null,
    verdicts: null,
    psqlCmd: null,
    sinceHours: DEFAULT_SINCE_HOURS,
    reviewerPattern: DEFAULT_REVIEWER_PATTERN,
    dryRun: false,
    json: false,
    printSql: false,
    checkMain: true,
    baseBranch: DEFAULT_BASE_BRANCH,
    autoMerge: false,
    stateFile: null,
    baseDelaySec: DEFAULT_BASE_DELAY_MS / 1000,
    maxDelaySec: DEFAULT_MAX_DELAY_MS / 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      return value;
    };
    if (a === "--repo") args.repo = need();
    else if (a === "--verdicts") args.verdicts = need();
    else if (a === "--psql-cmd") args.psqlCmd = need();
    else if (a === "--since-hours") args.sinceHours = Number(need());
    else if (a === "--reviewer-pattern") args.reviewerPattern = need();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--print-sql") args.printSql = true;
    else if (a === "--check-main") args.checkMain = true;
    else if (a === "--no-check-main") args.checkMain = false;
    else if (a === "--base-branch") args.baseBranch = need();
    else if (a === "--auto-merge") args.autoMerge = true;
    else if (a === "--state-file") args.stateFile = need();
    else if (a === "--base-delay-sec") args.baseDelaySec = Number(need());
    else if (a === "--max-delay-sec") args.maxDelaySec = Number(need());
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

export async function main(argv, io = {}) {
  const out = io.log ?? console.log;
  const err = io.error ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
    if (args.printSql) {
      out(boardVerdictSql(args.sinceHours));
      return 0;
    }
    if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) throw new Error("--repo owner/name is required");
    if (!args.verdicts && !args.psqlCmd && !io.fetchImpl && (!process.env.PAPERCLIP_API_KEY || !process.env.PAPERCLIP_COMPANY_ID)) throw new Error("give exactly one of --verdicts <file> or --psql-cmd <command>");
    new RegExp(args.reviewerPattern);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  let comments;
  if (args.verdicts || args.psqlCmd) {
    try {
      comments = args.verdicts
        ? JSON.parse(fs.readFileSync(args.verdicts, "utf8"))
        : await (io.readFromPsql ?? readVerdictsFromPsql)(args.psqlCmd, boardVerdictSql(args.sinceHours));
      if (!Array.isArray(comments)) throw new Error("the verdict source is not a JSON array");
    } catch (e) {
      err(`cannot read the verdicts: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  } else {
    const apiUrl = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
    const apiKey = process.env.PAPERCLIP_API_KEY;
    const companyId = process.env.PAPERCLIP_COMPANY_ID;
    if (!apiKey || !companyId) {
      err("PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
      return 1;
    }
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    if (process.env.PAPERCLIP_RUN_ID) headers["X-Paperclip-Run-Id"] = process.env.PAPERCLIP_RUN_ID;
    const get = async (path) => {
      const response = await (io.fetchImpl ?? fetch)(`${apiUrl.replace(/\/$/, "")}${path}`, { headers });
      if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
      return response.json();
    };
    try {
      const issues = await get(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=200&view=compact`);
      const cutoff = Date.now() - args.sinceHours * 60 * 60 * 1000;
      comments = [];
      for (const issue of issues) {
        const issueComments = await get(`/api/issues/${encodeURIComponent(issue.id)}/comments`);
        for (const comment of issueComments) {
          if (new Date(comment.createdAt).getTime() < cutoff) continue;
          comments.push({ ...comment, authorName: comment.authorName ?? comment.author?.name ?? "" });
        }
      }
    } catch (e) {
      err(`cannot read verdicts from Myrmidon API: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const github = io.github ?? createGitHubPort(args.repo);
  const stateStore = io.stateStore ?? (args.stateFile ? createFileStateStore(args.stateFile) : null);
  const { results, failed } = await runOnce({
    comments,
    repo: args.repo,
    reviewerPattern: args.reviewerPattern,
    github,
    checkMain: args.checkMain,
    baseBranch: args.baseBranch,
    autoMerge: args.autoMerge,
    stateStore,
    baseDelayMs: args.baseDelaySec * 1000,
    maxDelayMs: args.maxDelaySec * 1000,
    dryRun: args.dryRun,
    log: args.json ? () => {} : out,
  });
  if (args.json) out(JSON.stringify(results));
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
