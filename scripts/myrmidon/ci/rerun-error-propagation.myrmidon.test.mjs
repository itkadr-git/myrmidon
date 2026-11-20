import test from 'node:test';
import assert from 'node:assert/strict';
import { rerunFullCi } from './rerun-full-ci.mjs';

const pr = ['repos/acme/project/pulls/7'];
const list = ['repos/acme/project/actions/workflows/myrmidon-ci.yml/runs?event=pull_request&head_sha=abc&per_page=50'];
const cancel = ['-X', 'POST', 'repos/acme/project/actions/runs/42/cancel'];
const poll = ['repos/acme/project/actions/runs/42'];
const rerun = ['-X', 'POST', 'repos/acme/project/actions/runs/42/rerun'];
const prResponse = { head: { sha: 'abc', ref: 'feature' } };
const run = (status) => ({ id: 42, head_sha: 'abc', head_branch: 'feature', pull_requests: [{ number: 7 }], event: 'pull_request', status, conclusion: null, created_at: '2026-01-01T00:00:00Z' });
const listing = (status) => ({ workflow_runs: [run(status)] });

function setup(responses) {
  const calls = [];
  const sleeps = [];
  const api = async (args) => {
    calls.push(args);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, 'unexpected API call');
    return response;
  };
  return {
    calls, sleeps,
    execute: () => rerunFullCi({ repo: 'acme/project', prNumber: 7, api, log: () => {}, sleepFn: async (ms) => { sleeps.push(ms); }, stepMs: 2, cancelWaitMs: 4 }),
  };
}

const cases = [
  { name: 'initial PR read', before: [], history: [pr] },
  { name: 'workflow list', before: [prResponse], history: [pr, list] },
  { name: 'cancel POST', before: [prResponse, listing('in_progress')], history: [pr, list, cancel] },
  { name: 'poll after cancel', before: [prResponse, listing('in_progress'), null], history: [pr, list, cancel, poll] },
  { name: 'final PR recheck after cancel', before: [prResponse, listing('in_progress'), null, { status: 'completed' }], history: [pr, list, cancel, poll, pr] },
  { name: 'final PR recheck for completed run', before: [prResponse, listing('completed')], history: [pr, list, pr] },
];

for (const scenario of cases) {
  test(`propagates the original error from ${scenario.name} without later API calls`, async () => {
    const error = new Error(`injected: ${scenario.name}`);
    const fixture = setup([...scenario.before, error]);
    await assert.rejects(fixture.execute(), (actual) => { assert.strictEqual(actual, error); return true; });
    assert.deepEqual(fixture.calls, scenario.history);
    assert.deepEqual(fixture.sleeps, []);
  });
}

test('cancel timeout polls at the boundary and stops before PR recheck or rerun', async () => {
  const fixture = setup([prResponse, listing('in_progress'), null, { status: 'in_progress' }, { status: 'in_progress' }, { status: 'in_progress' }]);
  await assert.rejects(fixture.execute(), { message: 'run 42 did not complete within 4 ms after cancel' });
  assert.deepEqual(fixture.calls, [pr, list, cancel, poll, poll, poll]);
  assert.deepEqual(fixture.sleeps, [2, 2]);
});

test('completed run reaches rerun without cancel or polling', async () => {
  const fixture = setup([prResponse, listing('completed'), prResponse, null]);
  assert.deepEqual(await fixture.execute(), { runId: 42, headSha: 'abc', cancelled: false });
  assert.deepEqual(fixture.calls, [pr, list, pr, rerun]);
  assert.deepEqual(fixture.sleeps, []);
});

test('running run reaches rerun after cancellation and completion', async () => {
  const fixture = setup([prResponse, listing('in_progress'), null, { status: 'in_progress' }, { status: 'completed' }, prResponse, null]);
  assert.deepEqual(await fixture.execute(), { runId: 42, headSha: 'abc', cancelled: true });
  assert.deepEqual(fixture.calls, [pr, list, cancel, poll, poll, pr, rerun]);
  assert.deepEqual(fixture.sleeps, [2]);
});
