// scripts/myrmidon/ci/label-noop-ci-result.test.mjs
// OPE-12841: a `labeled` run for any label other than `full-ci` must not
// publish a check named `CI result` on the PR head. Before the fix, job
// `ci-result` kept its name and skipped cleanly on the label gate: GitHub
// still created a check run named `CI result` with conclusion `skipped`, and
// the branch ruleset reads a skipped required check as satisfied — PR #2965
// auto-merged on head c2a00a6e whose only real run was cancelled, with no
// tests executed. The job now renames itself away from the required name on
// label-noop events (dynamic `name:`), so the noop run publishes no `CI
// result` check at all: the latest completed `CI result` on the head stays
// the cancelled real run and the PR stays blocked.
//
// The `!cancelled()` gate deliberately stays: re-gating on
// `needs.plan.result == 'success'` would make the job skip on a real run with
// a red plan and publish a *satisfying* skipped required check — the same
// defect class this issue is about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, '../../../.github/workflows/myrmidon-ci.yml');

// The label-noop condition used by the concurrency group, the plan gate and
// the ci-result gate: true when the run is a REAL run (push, merge_group,
// dispatch, or a `labeled` event carrying exactly the `full-ci` label).
const REAL_RUN = "(github.event_name != 'pull_request' || github.event.action != 'labeled' || github.event.label.name == 'full-ci')";

/** Regex-source of a string with the expression metacharacters escaped. */
const quoted = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function workflowLines() {
  const content = await readFile(WORKFLOW, 'utf8');
  return content.split('\n');
}

async function ciResultJobBlock() {
  const lines = await workflowLines();
  const start = lines.findIndex((line) => /^  ci-result:\s*$/.test(line));
  assert.ok(start >= 0, 'ci-result job found in myrmidon-ci.yml');
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  [a-z][a-z0-9-]*:\s*$/.test(line)) break;
    block.push(line);
  }
  return block;
}

test('ci-result publishes no required-name check on a label-noop run (OPE-12841)', async () => {
  const block = await ciResultJobBlock();
  const nameLine = block.find((line) => /^    name: /.test(line));
  assert.ok(nameLine, 'ci-result has a name');

  // The name is gated by the same label-noop condition as the plan job.
  assert.match(
    nameLine,
    new RegExp(`name: \\$\\{\\{ ${quoted(REAL_RUN)} && 'CI result' \\|\\| `),
    'the required check name only exists on real runs',
  );
  assert.match(nameLine, /'CI result \(label noop\)'/, 'the noop run gets a non-required name');
});

test('ci-result keeps the !cancelled() gate over the label condition', async () => {
  const block = await ciResultJobBlock();
  const ifLine = block.find((line) => /^    if: /.test(line));
  assert.ok(ifLine, 'ci-result has an if condition');
  const expr = ifLine.replace(/^    if: \$\{\{ /, '').replace(/ \}\}\s*$/, '');
  assert.ok(expr.startsWith('!cancelled() && '), 'a red plan must still fail the summary (no needs.plan.result re-gate)');
  assert.doesNotMatch(expr, /needs\.plan\.result == 'success'/, 're-gating on plan would publish a satisfying skipped check on a red plan');
  assert.ok(expr.includes(REAL_RUN), 'the label condition stays in the gate');
});

// ---- GitHub-side behaviour of the two context shapes (documented verdicts) ----

// GitHub semantics, restricted to what this defect exercises:
// - a job whose `if` evaluates false is skipped; GitHub still creates its
//   check run under the job's `name:` — a skipped required check satisfies
//   the ruleset (the defect);
// - a skipped job under a non-required name creates a check run the ruleset
//   ignores, so the latest real `CI result` verdict stays the verdict;
// - a job whose needs include a cancelled job and which has no
//   `!cancelled()` gate is cancelled, which also does not satisfy the ruleset.
const verdict = {
  realRun: { name: 'CI result', conclusion: 'failure-or-green-per-lanes' },
  labelNoop: { name: 'CI result (label noop)', conclusion: 'skipped' },
};

test('context matrix: the noop check is unrecognised and the real check keeps its name', async () => {
  const block = await ciResultJobBlock();
  const nameLine = block.find((line) => /^    name: /.test(line));
  const isNoop = nameLine.includes(REAL_RUN) && nameLine.includes("'CI result (label noop)'");
  assert.ok(isNoop, 'name is dynamic');

  // PR #2965 replay: push run cancelled, then `review-approved` labeled.
  const noopSuite = verdict.labelNoop; // what the fixed workflow publishes
  assert.notEqual(noopSuite.name, 'CI result', 'the noop suite does not use the required name');
  assert.notEqual(noopSuite.conclusion, 'success', 'the noop suite is not green');
  // The ruleset reads `CI result` on the head: the noop run is invisible, the
  // cancelled real run remains the latest completed verdict -> not satisfied.
  const rulesetView = [verdict.realRun, noopSuite].filter((check) => check.name === 'CI result');
  assert.equal(rulesetView.length, 1);
  assert.notEqual(rulesetView[0].conclusion, 'success');
});

test('labeled full-ci run publishes the required name (regression guard)', async () => {
  const block = await ciResultJobBlock();
  const nameLine = block.find((line) => /^    name: /.test(line));
  // The true-branch of the conditional is exactly 'CI result'.
  assert.match(nameLine, /&& 'CI result' \|\|/);
});

// ---- the plan job must keep its label gate (a noop run still skips the plan) ----

test('plan keeps the label-noop gate so non-full-ci labeled runs skip the lanes', async () => {
  const lines = await workflowLines();
  const start = lines.findIndex((line) => /^  plan:\s*$/.test(line));
  assert.ok(start >= 0, 'plan job found');
  const ifLine = lines.slice(start, start + 5).find((line) => /^    if: /.test(line));
  assert.ok(ifLine, 'plan has an if condition');
  assert.ok(ifLine.includes(REAL_RUN), 'plan skips on non-full-ci labeled events');
});

// ---- the concurrency side: a label-noop run must not cancel the real run ----

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
