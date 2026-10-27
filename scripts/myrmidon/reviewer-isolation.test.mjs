import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('reviewer subprocess cannot read executor checkout or session history', () => {
  const suite = fileURLToPath(new URL('./reviewer-isolation.test.py', import.meta.url));
  const result = spawnSync('python3', [suite], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
