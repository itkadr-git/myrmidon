import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});

// A long valid eager prefix precedes the disconnected module and its edge.
const fixture = () => ({
  entry: 'n0',
  modules: [
    ...Array.from({ length: 12 }, (_, i) => ({ path: `n${i}`, bytes: i + 1, eager: true })),
    { path: 'z', bytes: 1, eager: false },
  ],
  edges: [
    ...Array.from({ length: 11 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'eager', specifier: `s${i}` })),
    { from: 'z', to: 'z', kind: 'lazy', specifier: 'last' },
  ],
});

const cases = [
  ...[null, [], 1].map(value => [`root ${JSON.stringify(value)}`, () => value, 'shape']),
  ...['modules', 'edges'].flatMap(key => [null, {}, 1].map(value => [
    `${key} ${JSON.stringify(value)}`, r => { r[key] = value; return r; }, 'shape',
  ])),
  ...['modules', 'edges'].flatMap(key => [null, [], 1].map(value => [
    `${key} last item ${JSON.stringify(value)}`, r => { r[key][r[key].length - 1] = value; return r; }, 'shape',
  ])),
  ...[-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1].map(value => [
    `last bytes ${value}`, r => { r.modules.at(-1).bytes = value; return r; }, 'shape',
  ]),
  ['last eager non-boolean', r => { r.modules.at(-1).eager = 'false'; return r; }, 'shape'],
  ['last path empty', r => { r.modules.at(-1).path = ''; return r; }, 'shape'],
  ['last edge from empty', r => { r.edges.at(-1).from = ''; return r; }, 'shape'],
  ['last edge to empty', r => { r.edges.at(-1).to = ''; return r; }, 'shape'],
  ['last edge specifier non-string', r => { r.edges.at(-1).specifier = null; return r; }, 'shape'],
  ['last edge kind invalid', r => { r.edges.at(-1).kind = 'other'; return r; }, 'shape'],
  ['duplicate path', r => { r.modules.at(-1).path = 'n0'; return r; }, 'graph'],
  ['duplicate exact edge', r => { r.edges[r.edges.length - 1] = { ...r.edges[0] }; return r; }, 'graph'],
  ['missing entry', r => { r.entry = 'missing'; return r; }, 'graph'],
  ['missing edge source', r => { r.edges.at(-1).from = 'missing'; return r; }, 'graph'],
  ['missing edge target', r => { r.edges.at(-1).to = 'missing'; return r; }, 'graph'],
  ['reachable flag false', r => { r.modules[11].eager = false; return r; }, 'graph'],
  ['unreachable flag true', r => { r.modules.at(-1).eager = true; return r; }, 'graph'],
];

test('late invalid input fails closed with its exact category', async t => {
  for (const [label, mutate, category] of cases) {
    await t.test(label, () => {
      const result = run(mutate(fixture()));
      assert.equal(result.status, 1, label);
      assert.equal(result.stdout, '', label);
      assert.equal(result.stderr, `${category}\n`, label);
    });
  }
});

test('same layer overflow fails closed', () => {
  const report = fixture();
  report.modules[1].bytes = Number.MAX_SAFE_INTEGER;
  report.modules.at(-1).eager = true;
  report.edges[report.edges.length - 1] = { from: 'n0', to: 'z', kind: 'eager', specifier: 'last' };
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});

test('different layer totals may exceed the safe integer limit', () => {
  const report = fixture();
  report.modules[0].bytes = Number.MAX_SAFE_INTEGER;
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    entry: 'n0',
    layers: Array.from({ length: 12 }, (_, i) => ({
      depth: i, paths: [`n${i}`], bytes: i === 0 ? Number.MAX_SAFE_INTEGER : i + 1,
    })),
    unreachable: ['z'],
  });
});
