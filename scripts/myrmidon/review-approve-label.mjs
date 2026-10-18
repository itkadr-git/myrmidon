#!/usr/bin/env node
// Review approval -> GitHub label, without a delay.
//
// The reviewer role records its verdict on the board (a comment with a line such
// as `VERDICT #123: APPROVE` or `VERDICT: APPROVE - PR #123, head <sha>`). The
// `review-approved` label on the pull request is what the `hot-files-review`
// gate and the auto-merge read. This script turns the first into the second:
// it reads the recent verdict comments of the reviewer agents, and puts the label
// on a pull request only when ALL of this holds:
//   1. the newest verdict line about that PR is an approval (a later RETURN,
//      DEFERRED, or an unclear line cancels it);
//   2. the PR is open and not a draft;
//   3. the head did not move after the verdict: a verdict that names a head sha
//      must match the current head; a verdict without one must be newer than the
//      head commit;
//   4. the check run `CI result` of the head commit is `success`.
// A PR whose head moved after an approval is reported as `needs-rereview` (the
// reviewer must look at the new commits only); the script never labels it.
//
// Usage (run it every few minutes from the operator host):
//   node scripts/myrmidon/review-approve-label.mjs --repo owner/name \
//        --verdicts <file.json> | --psql-cmd '<command that runs psql -At and reads SQL on stdin>' \
//        [--since-hours 48] [--reviewer-pattern '^adm-dev-review'] [--dry-run] [--json]
//   node scripts/myrmidon/review-approve-label.mjs --print-sql [--since-hours 48]
//
// The verdict file is a JSON array of {id, issueId, createdAt, authorName, body}.
// GitHub is reached with `gh api` (GH_TOKEN must be allowed to edit labels); the
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

const APPROVE_WORDS = /\b(?:APPROVE|APPROVED|LGTM)\b/i;
const NON_APPROVE_WORDS =
  /\b(?:RETURN|RETURNED|REWORK|DEFERRED|REJECT|REJECTED|BLOCK|BLOCKED|CHANGES[ \t]+REQUESTED|REQUEST[ \t]+CHANGES|SUPERSEDED)\b/i;
const VERDICT_WORD = /(?:\bVERDICT\b|ВЕРДИКТ)/i;
const PR_REFERENCE = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g;
const HEAD_REFERENCE = /\bhead\b[^0-9a-fA-F\n]{0,8}([0-9a-fA-F]{7,40})\b/i;

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
  for (const comment of comments) {
    if (!pattern.test(String(comment.authorName ?? ""))) continue;
    const at = new Date(comment.createdAt);
    if (Number.isNaN(at.getTime())) continue;
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
 * The decision for one PR. `pr` is {state, draft, merged, headSha, labels},
 * `headCommittedAt` a Date or null, `ci` is the conclusion of the `CI result`
 * check run of the head ("success", "failure", "in_progress", "missing", ...).
 */
export function decideApproveLabel({ verdict, pr, headCommittedAt, ci }) {
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
  if (pr.labels.includes(APPROVED_LABEL)) return { action: "noop", reason: "already-labeled" };
  return { action: "label", reason: "approved-head-green" };
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
export function createGitHubPort(repo, run = ghJson) {
  return {
    async pullRequest(number) {
      const data = await run([`repos/${repo}/pulls/${number}`]);
      return {
        state: data.state,
        draft: Boolean(data.draft),
        merged: Boolean(data.merged_at) || Boolean(data.merged),
        headSha: data.head?.sha ?? null,
        labels: (data.labels ?? []).map((label) => label.name),
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
    async addLabel(number) {
      await run(["-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${APPROVED_LABEL}`]);
    },
  };
}

export async function runOnce({ comments, repo, reviewerPattern, github, dryRun = false, log = () => {} }) {
  const verdicts = latestVerdicts(comments, { repo, reviewerPattern });
  const results = [];
  let failed = 0;
  for (const [prNumber, verdict] of [...verdicts.entries()].sort((a, b) => a[0] - b[0])) {
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
      const decision = decideApproveLabel({ verdict, pr, headCommittedAt, ci });
      if (decision.action === "label" && !dryRun) await github.addLabel(prNumber);
      results.push({ prNumber, ...decision, dryRun: dryRun && decision.action === "label" ? true : undefined });
    } catch (err) {
      failed += 1;
      results.push({ prNumber, action: "error", reason: err instanceof Error ? err.message.split("\n")[0] : "error" });
    }
  }
  for (const r of results) log(`PR #${r.prNumber}: ${r.action} (${r.reason})${r.dryRun ? " [dry run]" : ""}`);
  return { results, failed };
}

function parseArgs(argv) {
  const args = { repo: null, verdicts: null, psqlCmd: null, sinceHours: DEFAULT_SINCE_HOURS, reviewerPattern: DEFAULT_REVIEWER_PATTERN, dryRun: false, json: false, printSql: false };
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
  const { results, failed } = await runOnce({
    comments,
    repo: args.repo,
    reviewerPattern: args.reviewerPattern,
    github,
    dryRun: args.dryRun,
    log: args.json ? () => {} : out,
  });
  if (args.json) out(JSON.stringify(results));
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
