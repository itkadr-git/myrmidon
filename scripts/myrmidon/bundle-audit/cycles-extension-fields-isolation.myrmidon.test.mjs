import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const sentinel = 'extension-private-sentinel';
const annotations = {
  x_meta: { path: sentinel, from: 'fake', to: 'fake', bytes: -1, eager: false, nested: [null, true, { x_note: sentinel }] },
  x_note: [null, false, 'note'],
  x_weight: 'private',
};
const moduleFor = (path, eager) => ({ path, bytes: 1, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const fixtures = [
  {
    report: { entry: 'a', modules: [moduleFor('a', true), moduleFor('b', true), moduleFor('c', false), moduleFor('d', false), moduleFor('e', false)], edges: [edge('a', 'a'), edge('a', 'b'), edge('b', 'c', 'lazy'), edge('c', 'a'), edge('d', 'e'), edge('e', 'd')] },
    expected: { entry: 'a', eagerCycles: [['a'], ['d', 'e']], allCycles: [['a', 'b', 'c'], ['d', 'e']] },
  },
  {
    report: { entry: 'root', modules: [moduleFor('root', true), moduleFor('left', true), moduleFor('right', false), moduleFor('end', true)], edges: [edge('root', 'left'), edge('root', 'right', 'lazy'), edge('left', 'end'), edge('right', 'end')] },
    expected: { entry: 'root', eagerCycles: [], allCycles: [] },
  },
];

function decorate(report, level) {
  const copy = structuredClone(report);
  if (level === 'report' || level === 'all') Object.assign(copy, annotations);
  if (level === 'module' || level === 'all') copy.modules.forEach(m => Object.assign(m, annotations));
  if (level === 'edge' || level === 'all') copy.edges.forEach(e => Object.assign(e, annotations));
  return copy;
}

function invoke(report) {
  return spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}

test('unknown producer fields do not affect cycles or output', () => {
  for (const { report, expected } of fixtures) {
    for (const level of ['base', 'report', 'module', 'edge', 'all']) {
      for (const reversed of [false, true]) {
        const input = decorate(report, level);
        if (reversed) { input.modules.reverse(); input.edges.reverse(); }
        const before = JSON.stringify(input);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = invoke(input);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, JSON.stringify(expected) + '\n');
          assert.ok(!result.stdout.includes(sentinel));
          assert.equal(JSON.stringify(input), before);
        }
      }
    }
  }
});

test('decorations do not hide invalid known fields or leak payload', () => {
  for (const [mutate, category] of [
    [report => { report.modules[0].bytes = -1; }, 'shape'],
    [report => { report.edges[0].to = 'missing'; }, 'reference'],
  ]) {
    const input = decorate(fixtures[0].report, 'all');
    mutate(input);
    const before = JSON.stringify(input);
    const result = invoke(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `FAIL: ${category}\n`);
    assert.ok(!result.stderr.includes(sentinel));
    assert.equal(JSON.stringify(input), before);
  }
});
