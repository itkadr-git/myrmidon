// scripts/myrmidon/ci/label-noop-ci-result.test.mjs
// OPE-12841: a `labeled` run for any label other than `full-ci` must not
// publish a check named `CI result` on the PR head. Before the fix, job
// `ci-result` kept its name and skipped cleanly on the label gate: GitHub
// still created a check run named `CI result` with conclusion `skipped`, and
// the branch ruleset reads a skipped required check as satisfied — PR #2965
// auto-merged on head c2a00a6e whose only real run was cancelled, with no
// tests executed.
//
// Review round 1 (adm-dev-review-8): a test must prove the BEHAVIOUR, not
// the workflow strings. label-noop-ci-result-sim.py is an execution engine
// for the job graph of myrmidon-ci.yml: it parses the workflow YAML,
// evaluates each job's real `if:`/`name:` expressions against concrete
// event contexts (a `labeled` run with `review-approved` on a head whose
// real run is cancelled / still running, a red plan, a green merge-queue
// candidate), applies GitHub's needs/skip/check-run semantics, and reads
// the result the way the branch ruleset does — the latest completed
// `CI result` on the head, where BOTH `success` and `skipped` satisfy the
// required check (the defect's mechanism). The fixed workflow must keep
// every review-approved scenario blocked/pending, and the teeth check must
// reproduce the original defect (`satisfied`) when ci-result is mutated
// back to the static required name — proving the engine actually executes
// the workflow rather than echoing expected verdicts.
//
// The `!cancelled()` gate deliberately stays: re-gating on
// `needs.plan.result == 'success'` would make the job skip on a real run
// with a red plan and publish a *satisfying* skipped required check — the
// same defect class; the red-plan scenario proves it stays blocked.
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

test('labeled review-approved on a head without a green real run never satisfies the required CI result gate (OPE-12841)', () => {
  const output = runSimulator();
  assert.match(output, /scenario 0: pull_request\/labeled\/review-approved.*ruleset=blocked/);
  assert.match(output, /scenario 1: pull_request\/labeled\/review-approved.*ruleset=pending/);
  assert.match(output, /scenario 2: pull_request\/labeled\/review-approved.*ruleset=blocked/);
  assert.match(output, /all scenarios pass/);
});

test('teeth: the simulator reproduces the defect on the pre-fix workflow shape', () => {
  const output = runSimulator();
  assert.match(
    output,
    /teeth: pre-fix shape.*ruleset satisfied; the defect must reproduce as 'satisfied'/,
  );
});

test('the executed graph publishes no check named CI result on a label-noop run', () => {
  const output = runSimulator();
  // Only the numbered scenario lines, not the teeth line (which deliberately
  // reintroduces the required name to prove the engine has teeth).
  const lines = output
    .split('\n')
    .filter((line) => line.startsWith('[ok] scenario') && line.includes('review-approved'));
  assert.ok(lines.length >= 3, 'three review-approved scenarios ran');
  for (const line of lines) {
    assert.doesNotMatch(line, /\('CI result',/, 'no required-name check published');
    assert.match(line, /CI result \(label noop\)/, 'the noop run publishes the renamed check');
  }
});

test('the red-plan real run publishes a failing CI result, never a satisfying skipped check', () => {
  const output = runSimulator();
  assert.match(
    output,
    /scenario 3: push\/-\/- tier=full plan=failure.*published=.*\('CI result', 'failure'\).*ruleset=blocked/,
  );
});

// ---- workflow-source tripwires kept from round 1 (cheap regression guards) ----

// The label-noop condition used by the concurrency group, the plan gate and
// the ci-result gate: true when the run is a REAL run (push, merge_group,
// dispatch, or a `labeled` event carrying exactly the `full-ci` label).
const REAL_RUN = "(github.event_name != 'pull_request' || github.event.action != 'labeled' || github.event.label.name == 'full-ci')";

async function ciResultJobBlock() {
  const content = await readFile(WORKFLOW, 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex((line) => /^  ci-result:\s*$/.test(line));
  assert.ok(start >= 0, 'ci-result job found in myrmidon-ci.yml');
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  [a-z][a-z0-9-]*:\s*$/.test(line)) break;
    block.push(line);
  }
  return block;
}

test('ci-result keeps the !cancelled() gate over the label condition', async () => {
  const block = await ciResultJobBlock();
  const ifLine = block.find((line) => /^    if: /.test(line));
  assert.ok(ifLine, 'ci-result has an if condition');
  const expr = ifLine.replace(/^    if: \$\{\{ /, '').replace(/ \}\}\s*$/, '');
  assert.ok(expr.startsWith('!cancelled() && '), 'a red plan must still fail the summary (no needs.plan.result re-gate)');
  assert.doesNotMatch(expr, /needs\.plan\.result == 'success'/, 're-gating on plan would publish a satisfying skipped check on a red plan');
  assert.ok(expr.includes(REAL_RUN), 'the label condition stays in the gate');
});

test('labeled full-ci run still publishes the required name (regression guard)', async () => {
  const block = await ciResultJobBlock();
  const nameLine = block.find((line) => /^    name: /.test(line));
  assert.match(nameLine, /&& 'CI result' \|\|/, 'real runs keep the required check name');
});

test('plan keeps the label-noop gate so non-full-ci labeled runs skip the lanes', async () => {
  const content = await readFile(WORKFLOW, 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex((line) => /^  plan:\s*$/.test(line));
  assert.ok(start >= 0, 'plan job found');
  const ifLine = lines.slice(start, start + 5).find((line) => /^    if: /.test(line));
  assert.ok(ifLine, 'plan has an if condition');
  assert.ok(ifLine.includes(REAL_RUN), 'plan skips on non-full-ci labeled events');
});

test('workflow concurrency group keeps non-full-ci labeled runs out of the real run group', async () => {
  const content = await readFile(WORKFLOW, 'utf8');
  assert.match(
    content,
    /github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'full-ci'.*&& '' \|\| '-label-noop'/,
    'non-full-ci labeled events get the -label-noop concurrency group',
  );
  assert.match(
    content,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && github\.run_attempt == 1 && \(github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'full-ci'\) \}\}/,
    'label-noop runs do not cancel the real head run',
  );
});
