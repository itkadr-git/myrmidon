import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const sentinel = 'input-sentinel-not-output';
const moduleRow = (path, bytes = 1) => ({ path, bytes, eager: false });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const fixture = () => ({
  entry: 'entry',
  modules: [moduleRow('entry'), moduleRow('target', 2), moduleRow('detached', 3)],
  edges: [edge('entry', 'target', 'eager', 'target'), edge('detached', 'external', 'lazy', null)],
  extra: sentinel,
});

function run(input) {
  const result = spawnSync(process.execPath, [cli], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function rejected(report, category, label) {
  const result = run(JSON.stringify(report));
  assert.equal(result.status, 1, label);
  assert.equal(result.stdout, '', label);
  assert.equal(result.stderr, `${category}\n`, label);
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel), label);
}

test('validates the last disconnected module and edge before producing output', async t => {
  const cases = [
    ['negative bytes', r => { r.modules[2].bytes = -1; }, 'shape'],
    ['fractional bytes', r => { r.modules[2].bytes = 1.5; }, 'shape'],
    ['unsafe bytes', r => { r.modules[2].bytes = Number.MAX_SAFE_INTEGER + 1; }, 'shape'],
    ['string bytes', r => { r.modules[2].bytes = '3'; }, 'shape'],
    ['eager type', r => { r.modules[2].eager = sentinel; }, 'shape'],
    ['empty module path', r => { r.modules[2].path = ''; }, 'shape'],
    ['duplicate module path', r => { r.modules[2].path = 'target'; }, 'graph'],
    ['edge kind', r => { r.edges[1].kind = sentinel; }, 'shape'],
    ['edge specifier', r => { r.edges[1].specifier = null; }, 'shape'],
    ['empty edge source', r => { r.edges[1].from = ''; }, 'shape'],
    ['empty edge target', r => { r.edges[1].to = ''; }, 'shape'],
    ['missing edge source', r => { r.edges[1].from = sentinel; }, 'graph'],
    ['missing edge target', r => { r.edges[1].to = sentinel; }, 'graph'],
    ['duplicate exact tuple', r => { r.edges.push({ ...r.edges[1] }); }, 'graph'],
  ];
  for (const [label, mutate, category] of cases) {
    await t.test(label, () => { const report = fixture(); mutate(report); rejected(report, category, label); });
  }
});

test('empty modules is a shape error', () => {
  rejected({ entry: 'entry', modules: [], edges: [], extra: sentinel }, 'shape', 'empty modules');
});

test('allows extra fields, aliases to the same target, and null targets', () => {
  const report = fixture();
  report.modules[2].extra = sentinel;
  report.edges[1].extra = sentinel;
  report.edges.push(edge('entry', 'alias', 'eager', 'target'));
  const result = run(JSON.stringify(report));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: 'entry', modules: [
    { path: 'entry', bytes: 1, targets: ['target'], fanOut: 1 },
    { path: 'detached', bytes: 3, targets: [], fanOut: 0 },
    { path: 'target', bytes: 2, targets: [], fanOut: 0 },
  ] }) + '\n');
  assert.ok(!result.stdout.includes(sentinel));
});

test('rejects trailing invalid input rather than accepting a valid JSON prefix', () => {
  const result = run(`${JSON.stringify(fixture())}\n${sentinel}`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'json\n');
  assert.ok(!result.stderr.includes(sentinel));
});
