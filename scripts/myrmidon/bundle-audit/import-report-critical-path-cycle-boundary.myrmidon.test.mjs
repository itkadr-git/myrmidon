import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });

function run(t, report) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'critical-cycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: dir,
    env: { ...process.env, HOME: dir, TMPDIR: dir }, shell: false,
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function success(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"entry":"entry","paths":["entry","leaf"],"bytes":5}\n');
}
function graphFailure(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
}

const cycles = [
  ['self-loop', [edge('x', 'x')]],
  ['two-cycle', [edge('x', 'y'), edge('y', 'x')]],
  ['long cycle', [edge('x', 'y'), edge('y', 'z'), edge('z', 'w'), edge('w', 'x')]],
  ['cycle after diamond', [edge('x', 'y'), edge('x', 'z'), edge('y', 'w'), edge('z', 'w'), edge('w', 'x')]],
];

for (const [name, cycle] of cycles) {
  test(`${name}: only eager reachability makes the cycle fatal`, t => {
    const base = {
      entry: 'entry',
      modules: [moduleOf('entry', 2), moduleOf('leaf', 3), moduleOf('x', 9, false),
        moduleOf('y', 7, true), moduleOf('z', 6, true), moduleOf('w', 4, true)],
      edges: [edge('entry', 'leaf'), ...cycle],
    };
    success(run(t, base));
    success(run(t, { ...base, edges: [...base.edges, edge('entry', 'x', 'lazy')] }));
    graphFailure(run(t, { ...base, edges: [...base.edges, edge('entry', 'x')] }));
  });
}

test('module eager flags do not determine edge reachability', t => {
  const report = {
    entry: 'entry', modules: [moduleOf('entry', 2, false), moduleOf('leaf', 3, false), moduleOf('x', 9, true)],
    edges: [edge('entry', 'leaf'), edge('entry', 'x', 'lazy'), edge('x', 'x')],
  };
  success(run(t, report));
  graphFailure(run(t, { ...report, edges: [edge('entry', 'leaf'), edge('entry', 'x'), edge('x', 'x')] }));
});

test('multiple specifiers for one eager arc do not form a cycle', t => {
  success(run(t, {
    entry: 'entry', modules: [moduleOf('entry', 2), moduleOf('leaf', 3)],
    edges: [edge('entry', 'leaf', 'eager', './one'), edge('entry', 'leaf', 'eager', './two')],
  }));
});
