import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../../.github/workflows/myrmidon-ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing job ${name}`);
  return match[1];
};

test('draft pushes cannot run full lanes or publish a skipped required check', () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  for (const name of ['plan', 'checks', 'dockergate', 'deployed-migrations', 'plugin-readiness', 'ci-result']) {
    assert.match(job(name), /github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false/, name);
  }
  assert.match(job('ci-result'), /name: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.draft && 'draft CI omitted' \|\| 'CI result' \}\}/);
});

test('manual dispatch records a required reason and preserves other event paths', () => {
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      reason:[\s\S]*?required: true/);
  assert.match(job('plan'), /github\.event\.inputs\.reason/);
  assert.match(job('plan'), /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /merge_group:\n    types: \[checks_requested\]/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(job('plan'), /github\.event\.pull_request\.head\.sha/);
});
