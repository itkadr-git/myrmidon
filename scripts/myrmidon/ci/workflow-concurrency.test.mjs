import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-workflow-concurrency.py');

test('workflow concurrency verification script passes for all workflows on main', () => {
  const result = execFileSync('python3', [SCRIPT], { encoding: 'utf8' });
  assert.match(result, /All workflows on main have valid concurrency/);
});
