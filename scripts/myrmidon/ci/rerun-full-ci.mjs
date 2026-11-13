#!/usr/bin/env node
// scripts/myrmidon/ci/rerun-full-ci.mjs
// CI-LABEL-NOOP-KEEPS-RESULT: the `full-ci` label starts a full run of
// "Myrmidon CI" WITHOUT being a trigger of that workflow (a `labeled` run of
// the main workflow became its newest run on the head and left the required
// `CI result` check "expected"). This script, called from
// myrmidon-ci-full-label.yml, does the equivalent through the API:
//   1. find the newest "Myrmidon CI" pull_request run on the CURRENT PR head;
//   2. if it is still queued/running: cancel it and wait until it is completed
//      (the label cancels the ordinary run, as `cancel-in-progress` did);
//   3. re-run it (new attempt of the same run: the check runs, including
//      `CI result`, are replaced by the attempt's, no second workflow run).
// The `plan` step of the main workflow reads the PR labels live, so the
// re-run (old payload) goes to the full tier.
//
// Usage (env): REPO, PR_NUMBER. Optional: WAIT_RUN_MS, CANCEL_WAIT_MS.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const WORKFLOW_FILE = 'myrmidon-ci.yml';

/** Newest pull_request run of the main workflow on `headSha`, or null. */
export function pickRun(runs, headSha) {
  const own = (runs || []).filter(
    (run) => run && run.head_sha === headSha && run.event === 'pull_request',
  );
  if (own.length === 0) return null;
  return own.reduce((best, run) =>
    Date.parse(run.created_at) > Date.parse(best.created_at) ||
    (run.created_at === best.created_at && run.id > best.id)
      ? run
      : best,
  );
}

export function isCompleted(run) {
  return run.status === 'completed';
}

/**
 * The steps to take for the picked run: nothing to cancel when completed.
 * Returns {cancel: boolean, rerun: boolean}.
 */
export function planActions(run) {
  if (!run) return { cancel: false, rerun: false };
  return { cancel: !isCompleted(run), rerun: true };
}

async function ghApi(args) {
  const { stdout } = await execFileAsync('gh', ['api', ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout ? JSON.parse(stdout) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `api(args)` is injectable for tests. */
export async function rerunFullCi({
  repo,
  prNumber,
  api = ghApi,
  sleepFn = sleep,
  waitRunMs = 120_000,
  cancelWaitMs = 300_000,
  stepMs = 5_000,
  log = console.log,
}) {
  const pr = await api([`repos/${repo}/pulls/${prNumber}`]);
  const headSha = pr.head.sha;
  const runsPath =
    `repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs` +
    `?event=pull_request&head_sha=${headSha}&per_page=50`;

  let run = null;
  for (let waited = 0; ; waited += stepMs) {
    run = pickRun((await api([runsPath])).workflow_runs, headSha);
    if (run || waited >= waitRunMs) break;
    await sleepFn(stepMs);
  }
  if (!run) {
    throw new Error(`no "Myrmidon CI" pull_request run on head ${headSha} of PR #${prNumber}`);
  }
  log(`PR #${prNumber} head ${headSha}: run ${run.id} status=${run.status} conclusion=${run.conclusion}`);

  const actions = planActions(run);
  if (actions.cancel) {
    await api(['-X', 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`]);
    log(`cancelled run ${run.id}`);
    for (let waited = 0; ; waited += stepMs) {
      const now = await api([`repos/${repo}/actions/runs/${run.id}`]);
      if (isCompleted(now)) break;
      if (waited >= cancelWaitMs) {
        throw new Error(`run ${run.id} did not complete within ${cancelWaitMs} ms after cancel`);
      }
      await sleepFn(stepMs);
    }
  }
  await api(['-X', 'POST', `repos/${repo}/actions/runs/${run.id}/rerun`]);
  log(`re-run of ${run.id} requested (full tier by the live label)`);
  return { runId: run.id, headSha, cancelled: actions.cancel };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { REPO, PR_NUMBER } = process.env;
  if (!REPO || !PR_NUMBER) {
    console.error('REPO and PR_NUMBER are required');
    process.exit(2);
  }
  rerunFullCi({ repo: REPO, prNumber: PR_NUMBER }).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
