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
//   1. the main branch CI is green (`mainCiConclusion` is `success`). If main is
//      red or pending, batch merge / auto-merge is halted and backoff is applied;
//   2. the newest verdict line about that PR is an approval (a later RETURN,
//      DEFERRED, or an unclear line cancels it);
//   3. the PR is open and not a draft;
//   4. the head did not move after the verdict: a verdict that names a head sha
//      must match the current head; a verdict without one must be newer than the
//      head commit;
//   5. the check run `CI result` of the head commit is `success`.
// A PR whose head moved after an approval is reported as `needs-rereview` (the
// reviewer must look at the new commits only); the script never labels it.
//
// When main is red, candidate merges are held ("main-red"), backoff increments,
// and state is preserved. Once main turns green, merge resumes and backoff is reset.
// Repeated runs are safe and idempotent.
//
// Usage (run it every few minutes from the operator host or devflow cron):
//   node scripts/myrmidon/review-approve-label.mjs --repo owner/name \
//        --verdicts <file.json> | --psql-cmd '<command that runs psql -At and reads SQL on stdin>' \
//        [--since-hours 48] [--reviewer-pattern '^adm-dev-review'] [--dry-run] [--json] \
//        [--check-main] [--base-branch main] [--auto-merge] [--state-file <path>]
//   node scripts/myrmidon/review-approve-label.mjs --print-sql [--since-hours 48]
//
// The verdict file is a JSON array of {id, issueId, createdAt, authorName, body}.
// GitHub is reached with `gh api` and `gh pr merge` (GH_TOKEN must be allowed to edit labels and merge); the
// token is never printed. Exit code: 0 ok, 1 a GitHub/board call failed, 2 usage.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const APPROVED_LABEL = "review-approved";
export const CI_CHECK_NAME = "CI result";
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
 * The decision for one PR. `pr` is {state, draft, merged, headSha, labels, autoMerge},
 * `headCommittedAt` a Date or null, `ci` is the conclusion of the `CI result`
 * check run of the head ("success", "failure", "in_progress", "missing", ...),
 * `mainCi` is the conclusion of the `CI result` check run of main ("success", ...),
 * `isMainRed` indicates whether main auto-merge is currently held.
 */
export function decideApproveLabel({
  verdict,
  pr,
  headCommittedAt,
  ci,
  mainCi = "success",
  isMainRed = false,
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

  const alreadyLabeled = pr.labels.includes(APPROVED_LABEL);
  const redMain = isMainRed || isRedMain(mainCi);

  // When main is red, auto-merge must not be enabled.
  // If native auto-merge was already turned on for the PR, disable it safely.
  const shouldDisableAutoMerge = redMain && Boolean(pr.autoMerge);
  const shouldEnableAutoMerge = !redMain && autoMerge && !pr.autoMerge;

  if (alreadyLabeled) {
    if (shouldDisableAutoMerge) {
      return { action: "hold", disableAutoMerge: true, reason: "main-red" };
    }
    if (shouldEnableAutoMerge) {
      return { action: "label", autoMerge: true, reason: "approved-head-green" };
    }
    if (redMain && autoMerge) {
      return { action: "hold", reason: "main-red" };
    }
    return { action: "noop", reason: "already-labeled" };
  }

  // The review-approved label is applied as soon as the PR head is approved and green,
  // triggering CI pipelines. Auto-merge is held if main is red.
  const decision = {
    action: "label",
    autoMerge: shouldEnableAutoMerge,
    reason: "approved-head-green",
  };
  if (redMain) decision.holdMerge = true;
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
        labels: (data.labels ?? []).map((label) => label.name),
        autoMerge: Boolean(data.auto_merge || data.autoMergeRequest),
      };
    },
    async headCommittedAt(sha) {
      const data = await run([`repos/${repo}/commits/${sha}`]);
      const value = data.commit?.committer?.date ?? data.commit?.author?.date;
      return value ? new Date(value) : null;
    },
    async ciConclusion(sha) {
      const data = await run([`repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
      const runs = (data.check_runs ?? []).filter((item) => item.name === CI_CHECK_NAME);
      if (runs.length === 0) return "missing";
      const newest = runs.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))[0];
      return newest.status === "completed" ? (newest.conclusion ?? "unknown") : newest.status;
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
    async addLabel(number) {
      await run(["-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${APPROVED_LABEL}`]);
    },
    async enableAutoMerge(number) {
      await runPr(["merge", String(number), "-R", repo, "--auto", "--squash"]);
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
    mainCiRaw === "pending";

  let resolvedConclusion = mainCiRaw;
  if (isRunning) {
    // When main CI is running, take the last completed CI result conclusion
    const prev =
      lastCompletedMain ||
      (state.lastCompletedStatus && state.lastCompletedStatus !== "unknown" ? state.lastCompletedStatus : null) ||
      (state.mainStatus && state.mainStatus !== "unknown" && !["in_progress", "queued", "pending"].includes(state.mainStatus) ? state.mainStatus : null) ||
      "success";
    resolvedConclusion = prev;
    log(`Main branch CI is currently ${mainCiRaw}; using last completed conclusion: ${resolvedConclusion}.`);
  }

  const isMainRed = isRedMain(resolvedConclusion);

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
  const holdAutoMerge = isMainRed || currentlyBackingOff;

  await stateStore?.save({
    consecutiveFailures,
    backoffUntil,
    mainStatus: mainCiRaw,
    lastCompletedStatus,
    lastCheckAt: now.toISOString(),
  });

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
      const decision = decideApproveLabel({
        verdict,
        pr,
        headCommittedAt,
        ci,
        mainCi: resolvedConclusion,
        isMainRed: holdAutoMerge,
        autoMerge: autoMerge && !holdAutoMerge,
      });

      if (decision.action === "label" && !dryRun) {
        if (!pr.labels.includes(APPROVED_LABEL)) {
          await github.addLabel(prNumber);
        }
        if (decision.autoMerge) {
          await github.enableAutoMerge(prNumber);
        }
      }
      if (decision.disableAutoMerge && !dryRun) {
        await github.disableAutoMerge(prNumber);
      }
      results.push({
        prNumber,
        ...decision,
        dryRun: dryRun && (decision.action === "label" || decision.disableAutoMerge) ? true : undefined,
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
    if (Boolean(args.verdicts) === Boolean(args.psqlCmd)) throw new Error("give exactly one of --verdicts <file> or --psql-cmd <command>");
    new RegExp(args.reviewerPattern);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  let comments;
  try {
    comments = args.verdicts
      ? JSON.parse(fs.readFileSync(args.verdicts, "utf8"))
      : await (io.readFromPsql ?? readVerdictsFromPsql)(args.psqlCmd, boardVerdictSql(args.sinceHours));
    if (!Array.isArray(comments)) throw new Error("the verdict source is not a JSON array");
  } catch (e) {
    err(`cannot read the verdicts: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
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
