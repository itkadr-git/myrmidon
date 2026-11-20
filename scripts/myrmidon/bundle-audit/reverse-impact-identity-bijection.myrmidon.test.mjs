import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const names = [
  ['entry', 'a', 'b', 'target', 'lazy', 'other'],
  ['../start!', 'z z', 'a?', '\u03a9 target', '\u00e9 lazy', 'other!'],
  ['start two', '../b', '\u03bb', 'target?', 'island space', '../other'],
];
const mod = (path, eager) => ({ path, bytes: 17, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: 'literal specifier!' });

// Each row is a hand-derived ordering of [module index, shortest distance].
const cases = [
  {
    name: 'chain',
    edges: [[0, 1], [1, 2], [2, 3], [0, 4, 'lazy'], [4, 5], [0, null]],
    eager: [true, true, true, true, false, false],
    expected: [[[2, 1], [1, 2], [0, 3]], [[2, 1], [1, 2], [0, 3]], [[2, 1], [1, 2], [0, 3]]],
  },
  {
    name: 'diamond with shortcut',
    edges: [[0, 1], [0, 2], [1, 3], [2, 3], [0, 3], [0, 4, 'lazy'], [4, 5]],
    eager: [true, true, true, true, false, false],
    expected: [[[1, 1], [2, 1], [0, 1]], [[0, 1], [2, 1], [1, 1]], [[1, 1], [0, 1], [2, 1]]],
  },
  {
    name: 'cycle',
    edges: [[0, 1], [1, 2], [2, 3], [3, 1], [3, 3], [0, 4, 'lazy'], [4, 5]],
    eager: [true, true, true, true, false, false],
    expected: [[[2, 1], [1, 2], [0, 3]], [[2, 1], [1, 2], [0, 3]], [[2, 1], [1, 2], [0, 3]]],
  },
  {
    name: 'lazy island imports target',
    edges: [[0, 1], [1, 3], [0, 2], [2, 3, 'lazy'], [0, 4, 'lazy'], [4, 3], [5, 4], [0, null]],
    eager: [true, true, true, true, false, false],
    expected: [[[1, 1], [4, 1], [0, 2], [5, 2]], [[1, 1], [4, 1], [0, 2], [5, 2]], [[1, 1], [4, 1], [5, 2], [0, 2]]],
  },
];

function reportFor(c, n) {
  return {
    entry: n[0],
    modules: n.map((path, i) => mod(path, c.eager[i])),
    edges: c.edges.map(([from, to, kind]) => edge(n[from], to === null ? null : n[to], kind)),
  };
}
function assertSuccess(result, expected) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

test('identity bijections preserve reverse impact and reorder ties', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'identity-bijection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  for (const c of cases) {
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      const expected = { entry: n[0], target: n[3], importers: c.expected[i].map(([index, distance]) => ({ path: n[index], distance })) };
      writeFileSync(file, JSON.stringify(reportFor(c, n)));
      const result = spawnSync(process.execPath, [cli, file, n[3]], { encoding: 'utf8', timeout: 5000 });
      assertSuccess(result, expected);
      assert.throws(() => assertSuccess({ ...result, stdout: `${JSON.stringify({ ...expected, importers: [] })}\n` }, expected), c.name);
    }
  }
  const sentinel = 'SENTINEL_MUST_NOT_LEAK';
  const invalid = reportFor(cases[0], names[0]);
  invalid.modules[1].path = invalid.modules[0].path;
  invalid.edges[0].specifier = sentinel;
  writeFileSync(file, JSON.stringify(invalid));
  const result = spawnSync(process.execPath, [cli, file, names[0][3]], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes(sentinel));
});
