import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const simulator = fileURLToPath(new URL('./draft-cost-gate-sim.py', import.meta.url));

test('workflow event, dependency graph, required result and dispatch behavior', () => {
  const output = execFileSync('python3', [simulator], { encoding: 'utf8' });
  assert.match(output, /workflow behavior scenarios and mutation controls passed/);
});
