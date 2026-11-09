import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const suite = fileURLToPath(new URL('./reviewer-isolation.test.py', import.meta.url));

test('reviewer subprocess cannot read executor checkout or session history', () => {
  const result = spawnSync('python3', [suite], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('reviewer subprocess quarantines hostile task and diff text', () => {
  const result = spawnSync('python3', [suite, '-k', 'prompt_injection'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
