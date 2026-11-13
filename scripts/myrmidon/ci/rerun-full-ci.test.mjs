// CI-LABEL-NOOP-KEEPS-RESULT: the `full-ci` label re-runs the main workflow
// through the API instead of being one of its triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRun, planActions, rerunFullCi } from './rerun-full-ci.mjs';

const run = (id, over = {}) => ({
  id,
  head_sha: 'aaa',
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
  );
  assert.equal(picked.id, 3);
  assert.equal(pickRun([run(1, { head_sha: 'bbb' })], 'aaa'), null);
  assert.equal(pickRun([], 'aaa'), null);
});

test('planActions cancels only a run that is not completed and always re-runs', () => {
  assert.deepEqual(planActions(run(1)), { cancel: false, rerun: true });
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.deepEqual(planActions(run(1, { status })), { cancel: true, rerun: true });
  }
  assert.deepEqual(planActions(null), { cancel: false, rerun: false });
});

function fakeApi(runs, { completesAfterPolls = 0 } = {}) {
  const calls = [];
  let polls = 0;
  const api = async (args) => {
    calls.push(args.join(' '));
    const path = args[args.length - 1];
    if (args[0] === '-X') return null;
    if (/\/pulls\/\d+$/.test(path)) return { head: { sha: 'aaa' } };
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
