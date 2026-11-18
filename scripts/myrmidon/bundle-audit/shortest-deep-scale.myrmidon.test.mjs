import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const size = 12000;
const name = index => `node-${String(index).padStart(5, '0')}`;
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });

test('deep chain retains every shortest count despite cycles and a lazy shortcut', () => {
  const modules = Array.from({ length: size }, (_, i) => ({ path: name(i), bytes: 0, eager: true }));
  const edges = Array.from({ length: size - 1 }, (_, i) => edge(name(i), name(i + 1)));
  edges.push(edge(name(size - 1), name(100)), edge(name(size - 1), name(size - 1)));
  edges.push(edge(name(0), name(size - 1), 'lazy'));
  modules.push({ path: 'unreachable-a', bytes: 0, eager: false }, { path: 'unreachable-b', bytes: 0, eager: false });
  edges.push(edge('unreachable-a', 'unreachable-b'), edge('unreachable-b', 'unreachable-a'));

  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify({ entry: name(0), modules, edges }),
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.modules.length, size, 'all reachable modules must be reported');
  const expected = {
    entry: name(0),
    modules: Array.from({ length: size }, (_, depth) => ({ path: name(depth), depth, shortestPaths: '1' })),
    unreachable: ['unreachable-a', 'unreachable-b'],
  };
  assert.deepEqual(output, expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
});
