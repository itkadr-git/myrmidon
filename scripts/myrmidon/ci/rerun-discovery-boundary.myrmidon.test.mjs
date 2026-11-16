import test from 'node:test';
import assert from 'node:assert/strict';
import { rerunFullCi } from './rerun-full-ci.mjs';

const repo = 'owner/repo';
const prPath = `repos/${repo}/pulls/7`;
const runsPath = `repos/${repo}/actions/workflows/myrmidon-ci.yml/runs?event=pull_request&head_sha=abc&per_page=50`;
const rerunPath = `repos/${repo}/actions/runs/10/rerun`;
const stepMs = 25;
const own = {
  id: 10, head_sha: 'abc', head_branch: 'feature', pull_requests: [{ number: 7 }],
  event: 'pull_request', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z',
};
const foreign = [
  { ...own, id: 11, pull_requests: [{ number: 8 }] },
  { ...own, id: 12, head_sha: 'other' },
  { ...own, id: 13, event: 'push' },
];

function harness(reads) {
  const calls = [];
  const sleeps = [];
  let index = 0;
  return {
    calls, sleeps,
    api: async (args) => {
      calls.push(args);
      if (args.length === 1 && args[0] === prPath) return { head: { sha: 'abc', ref: 'feature' } };
      if (args.length === 1 && args[0] === runsPath) {
        assert.ok(index < reads.length, 'unexpected discovery read');
        return { workflow_runs: reads[index++] };
      }
      if (args.length === 3 && args[0] === '-X' && args[1] === 'POST' && args[2] === rerunPath) return null;
      throw new Error(`unexpected API call: ${args.join(' ')}`);
    },
    sleepFn: async (ms) => { sleeps.push(ms); },
    log: () => {},
  };
}

for (const { name, reads, waitRunMs, pauses } of [
  { name: 'immediately', reads: [[own]], waitRunMs: 2 * stepMs, pauses: 0 },
  { name: 'after one pause', reads: [foreign, [...foreign, own]], waitRunMs: 2 * stepMs, pauses: 1 },
  { name: 'at the deadline', reads: [foreign, foreign, [...foreign, own]], waitRunMs: 2 * stepMs, pauses: 2 },
]) {
  test(`discovers the current completed run ${name}`, async () => {
    const h = harness(reads);
    const result = await rerunFullCi({ repo, prNumber: 7, waitRunMs, stepMs, ...h });
    assert.deepEqual(result, { runId: 10, headSha: 'abc', cancelled: false });
    assert.deepEqual(h.sleeps, Array(pauses).fill(stepMs));
    assert.deepEqual(h.calls, [
      [prPath], ...Array.from({ length: pauses + 1 }, () => [runsPath]), [prPath], ['-X', 'POST', rerunPath],
    ]);
  });
}

for (const { waitRunMs, pauses } of [{ waitRunMs: 0, pauses: 0 }, { waitRunMs: 2 * stepMs, pauses: 2 }]) {
  test(`times out without side effects at ${waitRunMs} ms`, async () => {
    const h = harness(Array.from({ length: pauses + 1 }, () => foreign));
    await assert.rejects(rerunFullCi({ repo, prNumber: 7, waitRunMs, stepMs, ...h }), /no "Myrmidon CI" pull_request run on head abc of PR #7/);
    assert.deepEqual(h.sleeps, Array(pauses).fill(stepMs));
    assert.deepEqual(h.calls, [[prPath], ...Array.from({ length: pauses + 1 }, () => [runsPath])]);
  });
}
