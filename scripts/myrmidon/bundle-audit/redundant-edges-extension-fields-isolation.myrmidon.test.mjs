import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const annotation = { x_meta: { path: sentinel, from: 'wrong', to: 'wrong', bytes: -1, eager: false, nested: [null, true, { x_note: sentinel }] }, x_note: 'note', x_weight: [null, false, 'weight'] };
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const graphs = [
  {
    report: { entry: 'e', modules: ['e', 'a', 'b', 'z', 'lazy'].map(path => ({ path, bytes: 1, eager: path !== 'lazy' })), edges: [edge('e', 'z', 'shortcut'), edge('e', 'b', 'b'), edge('b', 'z', 'z'), edge('e', 'a', 'a'), edge('a', 'z', 'z'), edge('e', 'lazy', 'lazy', 'lazy')] },
    expected: '{"entry":"e","redundant":[{"from":"e","specifier":"shortcut","to":"z","alternativePath":["e","a","z"]}]}\n',
  },
  {
    report: { entry: 'root', modules: [{ path: 'root', bytes: 2, eager: true }, { path: 'leaf', bytes: 3, eager: true }], edges: [edge('root', 'leaf', 'one'), edge('root', 'leaf', 'two')] },
    expected: '{"entry":"root","redundant":[{"from":"root","specifier":"one","to":"leaf","alternativePath":["root","leaf"]},{"from":"root","specifier":"two","to":"leaf","alternativePath":["root","leaf"]}]}\n',
  },
];

function decorate(report, level, extras = annotation) {
  return {
    ...report,
    ...(level === 'report' || level === 'all' ? extras : {}),
    modules: report.modules.map(mod => ({ ...mod, ...(level === 'module' || level === 'all' ? extras : {}) })),
    edges: report.edges.map(item => ({ ...item, ...(level === 'edge' || level === 'all' ? extras : {}) })),
  };
}
function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
}

test('unknown annotations do not affect the complete redundant-edge report', () => {
  for (const { report, expected } of graphs) {
    for (const level of ['base', 'report', 'module', 'edge', 'all']) {
      for (const extras of [annotation, { ...annotation, x_meta: null, x_note: true }]) {
        const fixture = decorate(report, level, extras);
        for (const reverse of [false, true]) {
          const input = reverse ? { ...fixture, modules: [...fixture.modules].reverse(), edges: [...fixture.edges].reverse() } : fixture;
          const before = JSON.stringify(input);
          for (let repeat = 0; repeat < 2; repeat++) {
            const result = run(input);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, '');
            assert.equal(result.stdout, expected);
            assert.ok(!result.stdout.includes(sentinel));
            assert.equal(JSON.stringify(input), before);
          }
        }
      }
    }
  }
});

test('annotations do not hide invalid known fields or leak their contents', () => {
  const fixture = decorate(graphs[0].report, 'all');
  const badBytes = structuredClone(fixture);
  badBytes.modules[0].bytes = -1;
  const badTarget = structuredClone(fixture);
  badTarget.edges[0].to = 'missing';
  for (const [input, category] of [[badBytes, 'shape\n'], [badTarget, 'graph\n']]) {
    const before = JSON.stringify(input);
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, category);
    assert.ok(!result.stderr.includes(sentinel));
    assert.equal(JSON.stringify(input), before);
  }
});
