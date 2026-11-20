import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const moduleOf = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const extensions = { x_meta: { path: sentinel, from: 'fake', to: 'fake', bytes: -1, eager: false, nested: [null, true, { x_note: sentinel }] }, x_note: 'annotation', x_weight: [null, false, 7] };
const graphs = [
  {
    report: { entry: 'e', modules: ['e', 'a', 'b', 'd'].map(x => moduleOf(x)).concat(moduleOf('z', false)), edges: [edge('e', 'a'), edge('e', 'a', 'eager', 'alias'), edge('e', 'b'), edge('a', 'd'), edge('b', 'd'), edge('e', 'd', 'lazy')] },
    expected: { entry: 'e', modules: [{ path: 'a', depth: 1, shortestPaths: '1' }, { path: 'b', depth: 1, shortestPaths: '1' }, { path: 'd', depth: 2, shortestPaths: '2' }, { path: 'e', depth: 0, shortestPaths: '1' }], unreachable: ['z'] },
  },
  {
    report: { entry: 'root', modules: [moduleOf('root'), moduleOf('leaf'), moduleOf('other', false)], edges: [edge('root', 'leaf'), edge('root', 'other', 'lazy')] },
    expected: { entry: 'root', modules: [{ path: 'leaf', depth: 1, shortestPaths: '1' }, { path: 'root', depth: 0, shortestPaths: '1' }], unreachable: ['other'] },
  },
];

function decorate(report, level) {
  const copy = structuredClone(report);
  if (level === 'report' || level === 'all') Object.assign(copy, structuredClone(extensions));
  if (level === 'module' || level === 'all') for (const module of copy.modules) Object.assign(module, structuredClone(extensions));
  if (level === 'edge' || level === 'all') for (const item of copy.edges) Object.assign(item, structuredClone(extensions));
  return copy;
}

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
}

test('unknown fields do not affect complete shortest-count results', () => {
  for (const { report, expected } of graphs) {
    for (const level of ['base', 'report', 'module', 'edge', 'all']) {
      const fixture = decorate(report, level);
      for (const reverse of [false, true]) {
        const input = structuredClone(fixture);
        if (reverse) { input.modules.reverse(); input.edges.reverse(); }
        const before = JSON.stringify(input);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = run(input);
          assert.equal(result.status, 0, `${level}: ${result.stderr}`);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
          assert.ok(!result.stdout.includes(sentinel));
          assert.equal(JSON.stringify(input), before);
        }
      }
    }
  }
});

test('decorations cannot make invalid known fields valid or leak payloads', () => {
  for (const { report } of graphs) {
    for (const category of ['shape', 'graph']) {
      const fixture = decorate(report, 'all');
      if (category === 'shape') fixture.modules[0].bytes = -1;
      else fixture.edges[0].to = 'missing';
      const before = JSON.stringify(fixture);
      const result = run(fixture);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${category}\n`);
      assert.ok(!result.stderr.includes(sentinel));
      assert.equal(JSON.stringify(fixture), before);
    }
  }
});
