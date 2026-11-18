import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleFor = (path, bytes = 1) => ({ path, bytes, eager: true });
const edge = (from, to) => ({ from, to, specifier: to, kind: 'eager' });

function run(report) {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('12,000-node chain retains every path in order', { timeout: 35000 }, () => {
  const paths = Array.from({ length: 12000 }, (_, i) => `node-${i}`);
  const report = {
    entry: paths[0],
    modules: paths.map(path => moduleFor(path)),
    edges: paths.slice(1).map((path, i) => edge(paths[i], path)),
  };
  assert.deepEqual(run(report), { entry: paths[0], paths, bytes: 12000 });
});

test('1,000-branch diamond selects the unique heavy branch', { timeout: 35000 }, () => {
  const branches = Array.from({ length: 1000 }, (_, i) => `branch-${i}`);
  const winner = branches[731];
  const report = {
    entry: 'start',
    modules: [moduleFor('start'), ...branches.map(path => moduleFor(path, path === winner ? 100 : 1)), moduleFor('end')],
    edges: branches.flatMap(path => [edge('start', path), edge(path, 'end')]),
  };
  assert.deepEqual(run(report), { entry: 'start', paths: ['start', winner, 'end'], bytes: 102 });
});
