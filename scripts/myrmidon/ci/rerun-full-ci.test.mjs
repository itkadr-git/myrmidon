// CI-LABEL-NOOP-KEEPS-RESULT: the `full-ci` label re-runs the main workflow
// through the API instead of being one of its triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRun, planActions, rerunFullCi, runBelongsToPr } from './rerun-full-ci.mjs';

const PR = { prNumber: 7, headRef: 'feat' };
const run = (id, over = {}) => ({
  id,
  head_sha: 'aaa',
  head_branch: 'feat',
  pull_requests: [{ number: 7 }],
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: `2026-11-13T10:0${id % 10}:00Z`,
  ...over,
});

test('pickRun takes the newest pull_request run on the head and ignores other heads and events', () => {
  const picked = pickRun(
    [run(1), run(3), run(2), run(9, { head_sha: 'bbb' }), run(8, { event: 'push' })],
    'aaa',
    PR,
  );
  assert.equal(picked.id, 3);
  assert.equal(pickRun([run(1, { head_sha: 'bbb' })], 'aaa', PR), null);
  assert.equal(pickRun([], 'aaa', PR), null);
});

test('pickRun does not take a run of another PR or branch that shares the head sha', () => {
  const other = run(9, { pull_requests: [{ number: 8 }], head_branch: 'rel/1.6.7' });
  const mainRun = run(8, { pull_requests: [], head_branch: 'main' });
  assert.equal(pickRun([other, mainRun], 'aaa', PR), null);
  assert.equal(pickRun([other, run(1)], 'aaa', PR).id, 1, 'older own run beats a newer foreign one');
  assert.equal(runBelongsToPr(run(1, { pull_requests: [] }), PR), true, 'empty list: head branch decides');
  assert.equal(runBelongsToPr(run(1, { pull_requests: [], head_branch: 'x' }), PR), false);
  assert.equal(runBelongsToPr(run(1, { pull_requests: [] }), { prNumber: 7 }), false, 'no ref known: no match');
});

test('planActions cancels only a run that is not completed and always re-runs', () => {
  assert.deepEqual(planActions(run(1)), { cancel: false, rerun: true });
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.deepEqual(planActions(run(1, { status })), { cancel: true, rerun: true });
  }
  assert.deepEqual(planActions(null), { cancel: false, rerun: false });
});

function fakeApi(runs, { completesAfterPolls = 0, rerunFailures = 0, headAfter = 'aaa' } = {}) {
  const calls = [];
  let polls = 0;
  let prReads = 0;
  let rerunFails = rerunFailures;
  const api = async (args) => {
    calls.push(args.join(' '));
    const path = args[args.length - 1];
    if (args[0] === '-X') {
      if (path.endsWith('/rerun') && rerunFails > 0) {
        rerunFails -= 1;
        throw new Error('HTTP 403: Workflow run is still running');
      }
      return null;
    }
    if (/\/pulls\/\d+$/.test(path)) {
      prReads += 1;
      return { head: { sha: prReads === 1 ? 'aaa' : headAfter, ref: 'feat' } };
    }
    if (path.includes('/workflows/myrmidon-ci.yml/runs')) return { workflow_runs: runs };
    if (/\/actions\/runs\/\d+$/.test(path)) {
      polls += 1;
      return { status: polls > completesAfterPolls ? 'completed' : 'in_progress' };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const opts = { log: () => {}, sleepFn: async () => {}, stepMs: 1, waitRunMs: 3, cancelWaitMs: 5 };

test('a completed run is re-run without cancel', async () => {
  const { api, calls } = fakeApi([run(1)]);
  const res = await rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts });
  assert.equal(res.cancelled, false);
  assert.ok(calls.some((c) => c.endsWith('/actions/runs/1/rerun')));
  assert.ok(!calls.some((c) => c.endsWith('/cancel')));
});

test('a running run is cancelled, awaited until completed, then re-run (in that order)', async () => {
  const { api, calls } = fakeApi([run(2, { status: 'in_progress', conclusion: null })], {
    completesAfterPolls: 2,
  });
  const res = await rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts });
  assert.equal(res.cancelled, true);
  const cancel = calls.findIndex((c) => c.endsWith('/runs/2/cancel'));
  const rerun = calls.findIndex((c) => c.endsWith('/runs/2/rerun'));
  assert.ok(cancel >= 0 && rerun > cancel);
  assert.ok(calls.slice(cancel, rerun).filter((c) => c.endsWith('/actions/runs/2')).length >= 3);
});

test('no run on the head fails loudly instead of leaving the label without effect', async () => {
  const { api } = fakeApi([]);
  await assert.rejects(rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts }), /no "Myrmidon CI"/);
});

test('a run that never completes after cancel fails, no re-run is requested', async () => {
  const { api, calls } = fakeApi([run(2, { status: 'in_progress' })], { completesAfterPolls: 999 });
  await assert.rejects(rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts }), /did not complete/);
  assert.ok(!calls.some((c) => c.endsWith('/rerun')));
});

test('rerun 403 "still running" right after cancel is retried and then succeeds', async () => {
  const { api, calls } = fakeApi([run(2, { status: 'in_progress' })], { rerunFailures: 3 });
  await rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts, rerunAttempts: 5, rerunPauseMs: 1 });
  assert.equal(calls.filter((c) => c.endsWith('/runs/2/rerun')).length, 4);
});

test('rerun that never succeeds fails with the cancelled-run recovery text', async () => {
  const { api } = fakeApi([run(2, { status: 'in_progress' })], { rerunFailures: 99 });
  await assert.rejects(
    rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts, rerunAttempts: 3, rerunPauseMs: 1 }),
    /CANCELLED.*Re-run all jobs.*push/s,
  );
});

test('a head that moved before the re-run: no re-run (the push starts its own CI)', async () => {
  const { api, calls } = fakeApi([run(2, { status: 'in_progress' })], { headAfter: 'bbb' });
  const res = await rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts });
  assert.equal(res.skipped, 'head-moved');
  assert.ok(!calls.some((c) => c.endsWith('/rerun')));
});

test('a foreign run on the same head is never re-run', async () => {
  const { api } = fakeApi([run(9, { pull_requests: [{ number: 8 }], head_branch: 'other' })]);
  await assert.rejects(rerunFullCi({ repo: 'o/r', prNumber: 7, api, ...opts }), /no "Myrmidon CI"/);
});
