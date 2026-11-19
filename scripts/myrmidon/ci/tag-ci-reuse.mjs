#!/usr/bin/env node
// CI-TAG-REUSE-BRANCH-RUN (16.11): decides whether the release tag CI
// (myrmidon-ci-tag.yml) must run its own full pipeline or can take the result of
// the full "Myrmidon CI" (myrmidon-ci.yml) run that already ran on the SAME
// commit (the head of the rel branch the tag is cut on).
//
// Why: the tag used to start a second full pipeline of a commit whose branch run
// is the one the rollout waits for; both took the same runners and the release CI
// went twice as slow.
//
// CI-TAG-REUSE-CANCELLED (16.11, rc.12/rc.13 of 1.6.9): the branch run is often
// CANCELLED right at the tag cut (a superseded attempt, a hand cancel) and
// re-run minutes later — on rc.13 the re-run attempt went green 47 min after the
// tag push, BEFORE the tag's duplicate full pipeline finished. A cancelled run
// carries no verdict about the code, so it must be waited for like a running
// one; the first version read it as a final "failed" and burned a second full
// pipeline on the same commit.
//
// Decision (mode is written to $GITHUB_OUTPUT):
//   reuse - a completed successful run of myrmidon-ci.yml (event push or
//           workflow_dispatch, any branch; a pull_request run is the fast tier and
//           never counts) exists for the commit. The lanes of the tag workflow are
//           skipped, `CI result` is success.
//   full  - no such run (after a short grace for a run that is just starting), or
//           the run(s) failed, or the wait timed out (a running or cancelled run
//           never turned green within the budget), or the API kept failing. The
//           tag workflow runs the whole pipeline as before.
// A run that is still queued/in progress is waited for (polling with a timeout),
// and so is a cancelled run: its canonical next state is a re-run that can turn
// green. Only a genuinely red run is a terminal "full".
//
// Usage: node tag-ci-reuse.mjs --repo OWNER/REPO --tag TAG [--sha SHA]
//          [--timeout-min 70] [--interval-sec 30] [--grace-sec 90]
// Env: GH_TOKEN (or GITHUB_TOKEN), GITHUB_OUTPUT.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW_FILE = "myrmidon-ci.yml";
const FULL_EVENTS = new Set(["push", "workflow_dispatch"]);
const PENDING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

// Classifies the runs of myrmidon-ci.yml of one commit:
// success | pending | cancelled | none | failed.
export function classifyRuns(runs, sha) {
  const mine = (runs ?? []).filter(
    (r) => r && r.head_sha === sha && FULL_EVENTS.has(r.event) && (r.path ?? `.github/workflows/${CI_WORKFLOW_FILE}`).endsWith(CI_WORKFLOW_FILE),
  );
  if (mine.some((r) => r.status === "completed" && r.conclusion === "success")) return "success";
  if (mine.some((r) => PENDING.has(r.status))) return "pending";
  if (mine.length === 0) return "none";
  // A cancelled run is not a red verdict about the code: the canonical answer to
  // a cancelled CI is a re-run (a new attempt of the same run id, or a fresh
  // dispatch of the same branch), and that re-run can turn green. Wait for it
  // like for a pending run; only a genuinely red conclusion is terminal.
  if (mine.every((r) => r.status === "completed" && r.conclusion === "cancelled")) return "cancelled";
  return "failed";
}

// fetchRuns(): Promise<run[]> (throws on an API failure). sleep(ms) and now() are injectable.
export async function decide({
  fetchRuns,
  sha,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 70 * 60_000,
  intervalMs = 30_000,
  graceMs = 90_000,
  log = () => {},
}) {
  const started = now();
  for (;;) {
    let state;
    try {
      state = classifyRuns(await fetchRuns(), sha);
    } catch (err) {
      log(`runs read failed: ${err.message}`);
      state = "error";
    }
    const elapsed = now() - started;
    log(`state=${state} elapsed=${Math.round(elapsed / 1000)}s`);
    if (state === "success") return { mode: "reuse", reason: "the branch run of the same commit is green" };
    if (state === "failed") return { mode: "full", reason: "the branch run of the same commit did not succeed" };
    if (state === "pending" || state === "cancelled") {
      if (elapsed >= timeoutMs) {
        return { mode: "full", reason: state === "cancelled"
          ? "timed out waiting for the re-run of the cancelled branch run"
          : "timed out waiting for the branch run" };
      }
    } else if (elapsed >= graceMs) {
      // none / error: a run that is just starting shows up within the grace
      return { mode: "full", reason: state === "none" ? "no branch run of this commit" : "the runs API kept failing" };
    }
    await sleep(intervalMs);
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

async function ghGet(repo, token, pathAndQuery) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GET ${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}

export async function resolveTagSha(get, tag) {
  const ref = await get(`git/ref/tags/${tag}`);
  let { type, sha } = ref.object;
  while (type === "tag") ({ type, sha } = (await get(`git/tags/${sha}`)).object);
  return sha;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let mode = "full";
  let reason = "decision failed";
  try {
    if (!repo || !token) throw new Error("repo or token missing");
    const get = (p) => ghGet(repo, token, p);
    const sha = args.sha || (await resolveTagSha(get, args.tag));
    const result = await decide({
      sha,
      fetchRuns: async () => (await get(`actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${sha}&per_page=100`)).workflow_runs ?? [],
      timeoutMs: Number(args["timeout-min"] ?? 70) * 60_000,
      intervalMs: Number(args["interval-sec"] ?? 30) * 1000,
      graceMs: Number(args["grace-sec"] ?? 90) * 1000,
      log: (m) => console.log(m),
    });
    ({ mode, reason } = result);
    console.log(`tag ${args.tag} commit ${sha}`);
  } catch (err) {
    // Fail safe: any error means the full pipeline runs, never a free pass.
    reason = `error: ${err.message}`;
  }
  console.log(`mode=${mode} (${reason})`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
