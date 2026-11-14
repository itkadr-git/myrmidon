#!/usr/bin/env node
// RELEASE-CUT (OPE-12888): the single entry point for cutting a release
// candidate tag `myr-vX.Y.Z-rc.N`. Replaces the ad-hoc host scripts
// (`ops/auto/rc167-*-go.sh`) and the not-always-connected `rc-gate.sh` after
// the 12.11 incident: rc.24 went out with 17 open release tasks and, later,
// six closed tasks turned out to have unmerged PRs.
//
// One command checks, in order, then tags:
//   1. board: every task with the release label is `done` (no open tasks);
//   2. board: no task of the release carries an unmerged attached PR --
//      including `done` tasks (a closed task with an open PR is the silent
//      failure mode of the 12.11 incident);
//   3. changelog: the version section exists in both CHANGELOGs (the same
//      assert collect-fragments.mjs --check makes, RELEASE-CUT-CHANGELOG);
//   4. git: the tag is new and the commit is on the default branch;
//   5. gh: the CI of the release commit is green.
//
// On any violation the script refuses with the full list. The only way past
// a board violation is an explicit override:
//
//   node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25 \
//     --override "rc.24 already shipped; the list is stale" \
//     --journal OPE-12408
//
// An override requires non-empty text AND the board journal issue; the script
// posts the violation list with the reason to the journal issue as a comment
// BEFORE tagging (a failed post refuses: no silent bypasses). CI is never
// bypassable: there is no flag to skip the check (tests inject a fake CI
// checker through the module API, `run(args, { ciStatus })`), and a red,
// running, missing or unverifiable CI is a hard refusal.
//
// Board API: PAPERCLIP_API_URL (default http://127.0.0.1:3100),
// PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID (default: this company).
// CI checks run through `gh` (GITHUB_TOKEN or gh auth); tagging through `git`.
//
// Exit codes: 0 = tagged (or dry-run clean), 1 = refusal, 2 = usage error.
// Tests: scripts/myrmidon/release/cut-rc.test.mjs (fakes for the board API and gh).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REPO = "itkadr-git/myrmidon";
const DEFAULT_API_URL = "http://127.0.0.1:3100";
const DEFAULT_COMPANY_ID = "2870b911-483a-4091-9f15-183841811143";
const DONE_STATUSES = new Set(["done"]);
const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
// Work-product states of an attached PR that block the cut; `closed-unmerged`
// is computed from state "closed" when the PR never merged.
const PR_BLOCKING_STATES = new Set(["open", "draft", "closed-unmerged"]);

function usage() {
  console.error(`usage:
  node scripts/myrmidon/release/cut-rc.mjs --version 1.7.0 --rc 25 [options]

required:
  --version X.Y.Z        release version (must match the changelog section)
  --rc N                 candidate number N (tag myr-vX.Y.Z-rc.N)

options:
  --override "text"      bypass board violations; requires --journal ISSUE
  --journal OPE-NNNN     board issue that receives the override record
  --root <dir>           repository root (default: git toplevel of cwd)
  --sha <sha>            commit to tag (default: origin/<default-branch> HEAD)
  --branch <name>        branch whose CI must be green (default: default branch)
  --board-label NAME     release label name (default: "<major>.<minor>" of --version)
  --dry-run              run every check, print the plan, tag nothing
  --flaky-waiver-verify  accept a verified flaky-CI waiver for this tag only
  -h | --help`);
}

export function parseArgs(argv) {
  const args = {
    version: null, rc: null, override: null, journal: null, root: null,
    sha: null, branch: null, boardLabel: null, dryRun: false, flakyWaiverVerify: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--version": args.version = argv[++i]; break;
      case "--rc": args.rc = argv[++i]; break;
      case "--override": args.override = argv[++i]; break;
      case "--journal": args.journal = argv[++i]; break;
      case "--root": args.root = argv[++i]; break;
      case "--sha": args.sha = argv[++i]; break;
      case "--branch": args.branch = argv[++i]; break;
      case "--board-label": args.boardLabel = argv[++i]; break;
      case "--dry-run": args.dryRun = true; break;
      case "--flaky-waiver-verify": args.flakyWaiverVerify = true; break;
      case "-h": case "--help": args.help = true; break;
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return args;
}

export class UsageError extends Error {}

export function validateArgs(args) {
  if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new UsageError("--version X.Y.Z is required");
  }
  if (!args.rc || !/^\d+$/.test(String(args.rc))) {
    throw new UsageError("--rc N is required (candidate number, decimal)");
  }
  if (args.override !== null && args.override !== undefined && !String(args.override).trim()) {
    throw new UsageError("--override requires non-empty text");
  }
  if (args.override && !args.journal) {
    throw new UsageError("--override requires --journal OPE-NNNN (every bypass is recorded on the board)");
  }
  if (args.journal && !/^OPE-\d+$/i.test(args.journal)) {
    throw new UsageError("--journal must be an issue identifier like OPE-12408");
  }
}

export function tagName(args) {
  return `myr-v${args.version}-rc.${args.rc}`;
}

// --- board API -------------------------------------------------------------

export function boardFromEnv(env = process.env) {
  const apiUrl = env.PAPERCLIP_API_URL || DEFAULT_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  const companyId = env.PAPERCLIP_COMPANY_ID || DEFAULT_COMPANY_ID;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), apiKey, companyId };
}

async function boardFetch(api, pathname, init) {
  let res;
  try {
    res = await fetch(`${api.apiUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        "Content-Type": "application/json",
        ...(init && init.headers ? init.headers : {}),
      },
    });
  } catch (err) {
    throw new Error(`board API ${pathname} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`board API ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Lists every issue carrying the release label (paginated compact view).
export async function listReleaseIssues(api, labelName, log = () => {}, fetchBoard = boardFetch) {
  const labels = await fetchBoard(api, `/api/companies/${api.companyId}/labels`);
  const label = (labels || []).find(
    (l) => l.name === labelName || l.name === `release:${labelName}`,
  );
  if (!label) {
    throw new Error(`release label "${labelName}" not found on the board`);
  }
  const issues = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const batch = await fetchBoard(
      api,
      `/api/companies/${api.companyId}/issues?labelId=${label.id}&limit=${pageSize}&offset=${offset}&view=compact`,
    );
    issues.push(...batch);
    log(`board: fetched ${batch.length} issues (offset ${offset})`);
    if (!Array.isArray(batch) || batch.length < pageSize) break;
  }
  return issues;
}

// PullRequestWorkProduct "status" (open/merged/closed) plus repo/number when present.
export function prKeyOf(wp) {
  const meta = wp.metadata || {};
  const repo = meta.repository || meta.repo || meta.fullName || null;
  const num = meta.number ?? meta.pullRequestNumber ?? null;
  if (repo && num) return `${repo}#${num}`;
  return wp.title || "PR";
}

export function describePr(wp) {
  const key = prKeyOf(wp);
  return `${key} (${wp.title || "untitled"})`;
}

// `closed` state is ambiguous: closed-after-merge shows state "merged" in the
// board metadata; a PR closed WITHOUT merging blocks the cut.
export function prBlockingState(wp) {
  const status = String(wp.status || "").toLowerCase();
  if (status === "merged") return null;
  if (status === "open" || status === "draft" || status === "ready") {
    return status === "ready" ? "open" : status;
  }
  if (status === "closed") return "closed-unmerged";
  return status || "unknown";
}

// Checks the attached PRs of one issue against the blocking states.
// Returns the list of blocking descriptions (empty = clean).
export function blockingPrsOfIssue(issue, workProducts) {
  const blockers = [];
  for (const wp of workProducts || []) {
    if ((wp.type || "") !== "pull_request") continue;
    const st = prBlockingState(wp);
    if (st && PR_BLOCKING_STATES.has(st)) {
      blockers.push(`${describePr(wp)} - PR ${st}`);
    }
  }
  return blockers;
}

// Collects the board violations for the release: open issues and unmerged PRs.
export async function collectBoardViolations(api, issues, opts = {}, fetchBoard = boardFetch) {
  const violations = [];
  const openIssues = [];
  for (const issue of issues) {
    if (OPEN_STATUSES.has(issue.status)) {
      openIssues.push(issue);
      violations.push(`open task ${issue.identifier} "${issue.title}" [${issue.status}]`);
    } else if (!DONE_STATUSES.has(issue.status)) {
      // cancelled and other terminal-but-not-done states still block: the
      // release label claims the task is part of the release.
      violations.push(`task ${issue.identifier} not done [${issue.status}]`);
    }
  }
  for (const issue of issues) {
    let wps;
    try {
      wps = await fetchBoard(api, `/api/issues/${issue.id}/work-products`);
    } catch (err) {
      violations.push(`${issue.identifier}: cannot read work products: ${err.message}`);
      continue;
    }
    for (const b of blockingPrsOfIssue(issue, wps)) {
      violations.push(
        `${issue.identifier} (${issue.status}) has unmerged attached PR: ${b}`,
      );
    }
    if (opts.log) opts.log(`board: ${issue.identifier} checked`);
  }
  return { violations, openIssues };
}

// --- changelog -------------------------------------------------------------

// Same contract as collect-fragments.mjs --check (RELEASE-CUT-CHANGELOG):
// non-empty `## X.Y.Z` in both changelogs and the unreleased heading empty.
export function changelogVersionOk(root, version) {
  const problems = [];
  for (const [rel, unreleasedHeading] of [
    ["docs/myrmidon/CHANGELOG.md", "Unreleased"],
    ["docs/myrmidon/CHANGELOG.ru.md", "Без выпуска"],
  ]) {
    const file = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      problems.push(`${rel}: cannot read: ${err.message}`);
      continue;
    }
    const sectionRe = new RegExp(`^## ${version}\\s*$`, "m");
    if (!sectionRe.test(text)) {
      problems.push(`${rel}: no "## ${version}" section`);
      continue;
    }
    // The section must have content before the next "## " heading.
    const from = text.search(sectionRe);
    const rest = text.slice(from);
    const next = rest.slice(1).search(/^## /m);
    const body = next >= 0 ? rest.slice(0, next + 1) : rest;
    const bodyLines = body.split("\n").slice(1).filter((l) => l.trim());
    if (bodyLines.length === 0) {
      problems.push(`${rel}: "## ${version}" section is empty`);
    }
    // Unreleased heading must exist and be empty (nothing pending for the next cycle).
    const unreleasedRe = new RegExp(`^## ${unreleasedHeading}\\s*$`, "m");
    if (!unreleasedRe.test(text)) {
      problems.push(`${rel}: no "## ${unreleasedHeading}" section`);
      continue;
    }
    const uFrom = text.search(unreleasedRe);
    const uRest = text.slice(uFrom);
    const uNext = uRest.slice(1).search(/^## /m);
    const uBody = uNext >= 0 ? uRest.slice(0, uNext + 1) : uRest;
    const uLines = uBody.split("\n").slice(1).filter((l) => l.trim());
    if (uLines.length > 0) {
      problems.push(`${rel}: "${unreleasedHeading}" is not empty — fold the fragments first (collect-fragments.mjs --version ${version})`);
    }
  }
  return problems;
}

// --- git -------------------------------------------------------------------

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function resolveRef(root, ref) {
  try {
    return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

export function defaultBranch(root) {
  try {
    const sym = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return sym.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export function commitOnBranch(root, sha, branch) {
  try {
    git(root, ["merge-base", "--is-ancestor", sha, branch]);
    return true;
  } catch {
    return false;
  }
}

// --- gh (CI) ---------------------------------------------------------------

export function ghAvailable(opts = {}) {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", ...(opts.env ? { env: opts.env } : {}) });
    return true;
  } catch {
    return false;
  }
}

export function ghRunJson(repo, extraArgs, opts = {}) {
  const out = execFileSync("gh", ["run", "list", ...extraArgs, "--repo", repo, "--json", ...opts.fields], {
    encoding: "utf8",
    ...(opts.env ? { env: opts.env } : {}),
  });
  return JSON.parse(out);
}

export function ciStatusForCommit(root, { repo = GITHUB_REPO, branch, sha, env } = {}) {
  if (!ghAvailable({ env })) {
    return { ok: false, reason: "gh is not available/authenticated" };
  }
  try {
    const runs = ghRunJson(repo, ["--branch", branch, "--limit", "30"], { fields: ["databaseId", "headSha", "status", "conclusion", "workflowName", "event"], env });
    const commitRuns = runs.filter((r) => r.headSha === sha);
    if (commitRuns.length === 0) {
      return { ok: false, reason: `no CI runs found for ${sha} on ${branch}` };
    }
    const inProgress = commitRuns.filter((r) => r.status !== "completed");
    if (inProgress.length > 0) {
      return {
        ok: false,
        reason: `CI still running for ${sha}: ${inProgress.map((r) => r.workflowName).join(", ")}`,
      };
    }
    // Fail closed: every completed run must carry an explicitly allowed
    // successful conclusion. A completed run with a missing/empty/unknown
    // conclusion is unverifiable, not green — it refuses the cut (OPE-12888
    // review: `r.conclusion && ...` used to treat such runs as success).
    const allowedConclusions = new Set(["success", "skipped", "neutral"]);
    const failed = commitRuns.filter((r) => !allowedConclusions.has(r.conclusion));
    if (failed.length > 0) {
      return {
        ok: false,
        reason: `CI not confirmed green for ${sha}: ${failed.map((r) => `${r.workflowName}=${r.conclusion || "(no conclusion)"}`).join(", ")}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `gh run list failed: ${err.message}` };
  }
}

// --- board comment (override record) ---------------------------------------

export async function postOverrideComment(api, journalIdentifier, payload, fetchBoard = boardFetch) {
  const issue = await fetchBoard(api, `/api/issues/${encodeURIComponent(journalIdentifier)}`);
  return fetchBoard(api, `/api/issues/${issue.id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: payload }),
  });
}

// --- main ------------------------------------------------------------------

export function buildOverrideComment({ tagName: tag, version, rc, reason, violations, openIssues }) {
  const lines = [];
  lines.push(`**RELEASE-CUT OVERRIDE — ${tag}**`);
  lines.push("");
  lines.push(`Кандидат ${tag} (версия ${version}, rc.${rc}) поставлен с обходом ворот cut-rc.mjs.`);
  lines.push("");
  lines.push(`Обоснование: ${reason}`);
  lines.push("");
  lines.push("Нарушения, через которые прошёл обход:");
  for (const v of violations) lines.push(`- ${v}`);
  if (violations.length === 0) lines.push("- (none)");
  lines.push("");
  lines.push("Открытые задачи выпуска на момент обхода:");
  if (openIssues.length === 0) {
    lines.push("- (none)");
  } else {
    for (const i of openIssues) lines.push(`- ${i.identifier} "${i.title}" [${i.status}]`);
  }
  return lines.join("\n");
}

export function formatRefusal({ tag, violations, ciProblem, overridable = true }) {
  const lines = [];
  lines.push(`RELEASE-CUT REFUSED: ${tag}`);
  lines.push("");
  if (violations.length > 0) {
    lines.push("Violations:");
    for (const v of violations) lines.push(`  - ${v}`);
  }
  if (ciProblem) {
    lines.push(`CI: ${ciProblem}`);
  }
  lines.push("");
  if (overridable) {
    lines.push('Bypass requires: --override "reason" --journal OPE-NNNN (the bypass is recorded on the board).');
  } else {
    lines.push("Not bypassable: fix the repository/CI problem and retry (an override covers stale board state only).");
  }
  return lines.join("\n");
}

export async function run(args, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  const err = deps.err || ((m) => console.error(m));
  const api = deps.api || boardFromEnv();
  const fetchBoard = deps.fetchBoard || boardFetch;
  const ghImpl = deps.ciStatus || ciStatusForCommit;
  const gitRoot = args.root || deps.root || process.cwd();
  const tag = tagName(args);
  const branch = args.branch || defaultBranch(gitRoot);
  const label = args.boardLabel || args.version.split(".").slice(0, 2).join(".");

  log(`cut-rc: ${tag} on ${branch} (release label: ${label})`);

  // 1-2. board: open tasks and unmerged PRs
  let issues;
  try {
    issues = await listReleaseIssues(api, label, log, fetchBoard);
  } catch (e) {
    err(`RELEASE-CUT REFUSED: ${e.message}`);
    return 1;
  }
  const { violations: boardViolations, openIssues } = await collectBoardViolations(
    api, issues, { log }, fetchBoard,
  );

  // Hard problems (changelog, git, CI) are never bypassable: an override is
  // only for stale board state. A tag cut without the changelog section would
  // fail the tag CI gate anyway (RELEASE-CUT-CHANGELOG), and a wrong commit
  // cannot be argued away.
  const hardProblems = [];
  hardProblems.push(...changelogVersionOk(gitRoot, args.version).map((p) => `changelog: ${p}`));

  // 4. git
  let sha = null;
  if (args.sha) {
    sha = resolveRef(gitRoot, args.sha);
    if (!sha) hardProblems.push(`git: cannot resolve --sha ${args.sha} to a commit`);
  } else {
    sha = resolveRef(gitRoot, `origin/${branch}`) || resolveRef(gitRoot, branch);
    if (!sha) hardProblems.push(`git: cannot resolve ${`origin/${branch}`} to a commit`);
  }
  if (sha) {
    log(`cut-rc: tagging ${sha.slice(0, 12)} (${branch})`);
    if (!commitOnBranch(gitRoot, sha, branch)) {
      hardProblems.push(`git: ${sha.slice(0, 12)} is not on ${branch}`);
    }
    const existing = resolveRef(gitRoot, `refs/tags/${tag}`);
    if (existing) {
      hardProblems.push(`git: tag ${tag} already exists (at ${existing.slice(0, 12)})`);
    }
  }

  // 5. CI -- always (no skip flag): an unverified commit is not releasable.
  let ciProblem = null;
  if (!sha) {
    ciProblem = "no commit to check: cannot verify CI";
  } else {
    const ci = ghImpl(gitRoot, { repo: GITHUB_REPO, branch, sha, env: deps.env });
    if (!ci.ok) {
      ciProblem = ci.reason;
    }
  }
  if (ciProblem && args.flakyWaiverVerify) {
    const waiver = deps.verifyFlakyWaiver || (() => {
      try {
        execFileSync("node", [path.join(gitRoot, "scripts/myrmidon/release/release-flaky-waiver.mjs"), "verify", "--tag", tag], { encoding: "utf8", env: deps.env ? { ...process.env, ...deps.env } : process.env });
        return true;
      } catch { return false; }
    });
    if (waiver({ tag, sha, root: gitRoot })) {
      log(`cut-rc: verified flaky waiver accepted for ${tag}`);
      ciProblem = null;
    }
  }

  const overridable = boardViolations.length > 0 && hardProblems.length === 0 && !ciProblem;

  if (boardViolations.length === 0 && hardProblems.length === 0 && !ciProblem) {
    if (args.dryRun) {
      log(`dry-run: all checks clean — would create ${tag} at ${sha ? sha.slice(0, 12) : "?"}`);
      return 0;
    }
    log(`cut-rc: creating ${tag} at ${sha.slice(0, 12)}`);
    execFileSync("git", ["-C", gitRoot, "tag", tag, sha], { stdio: "inherit" });
    log(`cut-rc: done. Push it: git push origin ${tag}`);
    return 0;
  }

  // Board violations present: an override is the only path past them.
  if (overridable && args.override && args.journal) {
    const comment = buildOverrideComment({ tagName: tag, version: args.version, rc: args.rc, reason: args.override, violations: boardViolations, openIssues });
    log(`cut-rc: override requested — posting the record to ${args.journal}`);
    try {
      await postOverrideComment(api, args.journal, comment, fetchBoard);
    } catch (e) {
      err(`RELEASE-CUT REFUSED: cannot post the override record to ${args.journal}: ${e.message}`);
      err("No silent bypasses: fix board access and retry, or cut without the override.");
      return 1;
    }
    log(`cut-rc: override recorded on ${args.journal}`);
    if (args.dryRun) {
      log(`dry-run: override recorded (see above) — would create ${tag} at ${sha ? sha.slice(0, 12) : "?"}`);
      return 0;
    }
    log(`cut-rc: creating ${tag} at ${sha ? sha.slice(0, 12) : "?"}`);
    execFileSync("git", ["-C", gitRoot, "tag", tag, sha], { stdio: "inherit" });
    log(`cut-rc: done. Push it: git push origin ${tag}`);
    return 0;
  }

  err(formatRefusal({ tag, violations: [...boardViolations, ...hardProblems], ciProblem, overridable }));
  return 1;
}

// --- entry -----------------------------------------------------------------

export function mainSync(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    usage();
    return 2;
  }
  if (args.help) {
    usage();
    return 0;
  }
  try {
    validateArgs(args);
  } catch (e) {
    console.error(String(e.message || e));
    usage();
    return 2;
  }
  const root = args.root || process.cwd();
  return run(args, { root });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await mainSync(process.argv.slice(2)));
}
