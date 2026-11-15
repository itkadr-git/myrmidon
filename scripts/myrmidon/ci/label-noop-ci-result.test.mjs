// scripts/myrmidon/ci/label-noop-ci-result.test.mjs
// OPE-12841 + CI-LABEL-NOOP-KEEPS-RESULT.
// OPE-12841: a run for a label other than `full-ci` must never leave a
// passing (skipped) required `CI result` on a head without a green real run
// (PR #2965 auto-merged on a cancelled head). First fix: a renamed job in the
// noop run. That run became the newest run of the workflow on the head, so the
// required `CI result` of the real green run was read as "expected" and green
// PRs (#3147, #3088, #3095) could not be merged.
// Now: myrmidon-ci.yml has no `labeled` trigger (no noop run exists, the last
// real verdict stays), `full-ci` is handled by myrmidon-ci-full-label.yml,
// which cancels the running run and re-runs it, and `plan` reads PR labels
// live. label-noop-ci-result-sim.py executes the trigger match and the
// ruleset reading; the tests below add source tripwires on the pieces the
// simulator cannot execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, 'label-noop-ci-result-sim.py');
const WORKFLOW = path.join(HERE, '../../../.github/workflows/myrmidon-ci.yml');

function runSimulator(extraArgs = []) {
  // The simulator fails closed: any unparseable expression, unknown job
  // shape or scenario mismatch exits non-zero with the offending line on
  // stderr, which node --test surfaces as the failure message.
  return execFileSync('python3', [SIM, '--workflow', WORKFLOW, ...extraArgs], {
    encoding: 'utf8',
    cwd: path.join(HERE, '../../..'),
  });
}

test('a label other than full-ci creates no run of the main workflow and keeps the last real verdict (CI-LABEL-NOOP-KEEPS-RESULT, OPE-12841)', () => {
  const output = runSimulator();
  assert.match(output, /scenario 0: pull_request\/labeled\/review-approved real_run=success ruleset=satisfied/);
  assert.match(output, /scenario 3: pull_request\/labeled\/review-approved real_run=cancelled ruleset=blocked/);
  assert.match(output, /scenario 4: pull_request\/labeled\/review-approved real_run=in-progress ruleset=pending/);
  assert.match(output, /scenario 5: pull_request\/labeled\/review-approved real_run=failure ruleset=blocked/);
  assert.match(output, /all scenarios pass/);
});

test('full-ci is handled by the full-label workflow only', () => {
  const output = runSimulator();
  assert.match(output, /scenario 6: full-ci handled only by the full-label workflow/);
  assert.match(output, /scenario 7: full-label workflow has another name/);
});

test('teeth: with `labeled` back in the trigger the simulator reproduces the defect', () => {
  const output = runSimulator();
  assert.match(output, /teeth: .*the defect must reproduce as 'expected'/);
});

// ---- workflow-source tripwires ----

const FULL_WORKFLOW = path.join(HERE, '../../../.github/workflows/myrmidon-ci-full-label.yml');

async function jobBlock(name) {
  const content = await readFile(WORKFLOW, 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `${name} job found in myrmidon-ci.yml`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  [a-z][a-z0-9-]*:\s*$/.test(line)) break;
    block.push(line);
  }
  return block;
}

test('main workflow does not list `labeled` among its pull_request types and has no label-noop machinery', async () => {
  const content = await readFile(WORKFLOW, 'utf8');
  assert.match(content, /^    types: \[opened, synchronize, reopened\]$/m);
  assert.doesNotMatch(content, /'-label-noop'|github\.event\.label\.name/);
});

test('ci-result keeps the static required name and the !cancelled() gate (no needs.plan.result re-gate)', async () => {
  const block = await jobBlock('ci-result');
  assert.ok(block.some((line) => line === '    name: CI result'), 'static required name');
  const ifLine = block.find((line) => /^    if: /.test(line));
  assert.equal(ifLine, '    if: ${{ !cancelled() }}');
  assert.doesNotMatch(ifLine, /needs\.plan\.result/, 'a red plan must still fail the summary, not skip');
});

test('plan reads the PR labels live so a re-run (old payload) goes to the full tier', async () => {
  const content = await readFile(WORKFLOW, 'utf8');
  assert.match(content, /issues\/\$PR_NUMBER\/labels/);
  assert.match(content, /grep -qx 'full-ci'/);
  // attempt > 1 with an API failure must fail the step, not fall back to the stale payload
  assert.match(content, /GITHUB_RUN_ATTEMPT:-1\}" -gt 1 \]; then[\s\S]{0,400}exit 1/);
});

test('full-label workflow: labeled only, job gated on full-ci, can re-run runs, never cancelled itself', async () => {
  const content = await readFile(FULL_WORKFLOW, 'utf8');
  assert.match(content, /types: \[labeled\]/);
  assert.match(content, /if: \$\{\{ github\.event\.label\.name == 'full-ci' \}\}/);
  assert.match(content, /actions: write/);
  assert.match(content, /cancel-in-progress: false/);
  assert.match(content, /rerun-full-ci\.mjs/);
  // the script runs with actions: write: it comes from the base commit, not the PR merge ref
  assert.match(content, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(content, /pull-requests: read/);
});
