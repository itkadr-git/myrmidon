import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const sentinel = 'synthetic-extension-sentinel';
const mod = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const run = (report, target) => spawnSync(process.execPath, [cli, '-', target], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});
const metadata = { path: 'false-path', from: 'false-from', to: 'false-to', bytes: -1, eager: false, target: 'false-target', note: sentinel };

function decorate(report, scope) {
  const copy = structuredClone(report);
  if (scope.includes('report')) {
    copy.x_meta = [null, true, metadata];
    copy.x_note = sentinel;
    copy.x_weight = JSON.parse('{"__proto__":{"path":"false-path"},"nested":[false,null]}');
  }
  if (scope.includes('module')) {
    for (const item of copy.modules) {
      item.x_meta = metadata;
      item.x_note = [sentinel, null, false];
      item.x_weight = { target: 'false-target', bytes: -1 };
      item.target = 'false-target';
    }
  }
  if (scope.includes('edge')) {
    for (const item of copy.edges) {
      item.x_meta = metadata;
      item.x_note = sentinel;
      item.x_weight = [true, { from: 'false-from', to: 'false-to' }];
      item.target = 'false-target';
    }
  }
  return copy;
}

const cases = [
  {
    name: 'diamond',
    report: { entry: 'entry', modules: ['entry', 'a', 'b', 'target'].map(x => mod(x)), edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'target'), edge('b', 'target')] },
    expected: { entry: 'entry', target: 'target', importers: [{ path: 'a', distance: 1 }, { path: 'b', distance: 1 }, { path: 'entry', distance: 2 }] },
  },
  {
    name: 'cycle and disconnected importers',
    report: { entry: 'entry', modules: [mod('entry'), mod('a'), mod('target'), mod('z', false), mod('other', false)], edges: [edge('entry', 'a'), edge('a', 'target'), edge('target', 'a'), edge('z', 'target'), edge('other', 'z'), edge('entry', 'z', 'lazy')] },
    expected: { entry: 'entry', target: 'target', importers: [{ path: 'a', distance: 1 }, { path: 'z', distance: 1 }, { path: 'entry', distance: 2 }, { path: 'other', distance: 2 }] },
  },
];

for (const { name, report, expected } of cases) {
  test(`${name}: extension fields do not change reverse impact`, () => {
    const original = JSON.stringify(report);
    for (const scope of [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']]) {
      const decorated = decorate(report, scope);
      for (const permuted of [false, true]) {
        const input = structuredClone(decorated);
        if (permuted) { input.modules.reverse(); input.edges.reverse(); }
        const before = JSON.stringify(input);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = run(input, 'target');
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
          assert.equal(result.stdout.includes(sentinel), false);
          assert.equal(JSON.stringify(input), before);
        }
      }
    }
    assert.equal(JSON.stringify(report), original);
  });
}

test('extensions cannot hide invalid known fields or leak in errors', () => {
  const decorated = decorate(cases[0].report, ['report', 'module', 'edge']);
  const invalidBytes = structuredClone(decorated);
  invalidBytes.modules[1].bytes = -1;
  const invalidEndpoint = structuredClone(decorated);
  invalidEndpoint.edges[0].to = 'missing-endpoint';
  for (const [category, input] of [['shape', invalidBytes], ['graph', invalidEndpoint]]) {
    const before = JSON.stringify(input);
    const result = run(input, 'target');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
    assert.equal(result.stderr.includes(sentinel), false);
    assert.equal(result.stderr.includes('missing-endpoint'), false);
    assert.equal(result.stderr.includes('false-path'), false);
    assert.equal(JSON.stringify(input), before);
  }
});
