import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});

function verify(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const mode of ['eager', 'all']) {
    for (const input of [report, report, reversed]) {
      const result = run(input, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${JSON.stringify(expected[mode])}\n`);
      assert.deepEqual(JSON.parse(result.stdout), expected[mode]);
    }
  }
  assert.equal(JSON.stringify(report), original);
}

const cases = [
  {
    name: 'eager bridge adds the intermediate bytes and preserves an isolated component',
    before: { entry: 'a', modules: [m('a', 2, true), m('b', 3, true), m('z', 7, false)], edges: [e('a', 'old', 'eager', 'b')] },
    after: { entry: 'a', modules: [m('a', 2, true), m('b', 3, true), m('x', 4, true), m('z', 7, false)], edges: [e('a', 'first', 'eager', 'x'), e('x', 'second', 'eager', 'b')] },
    beforeExpected: {
      eager: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b'], bytes: 5 }, { id: 'z', paths: ['z'], bytes: 7 }] },
      all: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b'], bytes: 5 }, { id: 'z', paths: ['z'], bytes: 7 }] },
    },
    afterExpected: {
      eager: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b', 'x'], bytes: 9 }, { id: 'z', paths: ['z'], bytes: 7 }] },
      all: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b', 'x'], bytes: 9 }, { id: 'z', paths: ['z'], bytes: 7 }] },
    },
  },
  {
    name: 'lazy first segment changes eager partitions but not all connectivity',
    before: { entry: 'a', modules: [m('a', 1, true), m('b', 2, false), m('c', 3, false), m('z', 8, false)], edges: [e('a', 'old', 'lazy', 'b'), e('b', 'next', 'eager', 'c')] },
    after: { entry: 'a', modules: [m('a', 1, true), m('b', 2, false), m('c', 3, false), m('x', 5, false), m('z', 8, false)], edges: [e('a', 'first', 'lazy', 'x'), e('x', 'second', 'eager', 'b'), e('b', 'next', 'eager', 'c')] },
    beforeExpected: {
      eager: { entry: 'a', components: [{ id: 'a', paths: ['a'], bytes: 1 }, { id: 'b', paths: ['b', 'c'], bytes: 5 }, { id: 'z', paths: ['z'], bytes: 8 }] },
      all: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b', 'c'], bytes: 6 }, { id: 'z', paths: ['z'], bytes: 8 }] },
    },
    afterExpected: {
      eager: { entry: 'a', components: [{ id: 'a', paths: ['a'], bytes: 1 }, { id: 'b', paths: ['b', 'c', 'x'], bytes: 10 }, { id: 'z', paths: ['z'], bytes: 8 }] },
      all: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b', 'c', 'x'], bytes: 11 }, { id: 'z', paths: ['z'], bytes: 8 }] },
    },
  },
  {
    name: 'zero-byte intermediate with the smallest path becomes the component id',
    before: { entry: 'b', modules: [m('b', 6, true), m('c', 4, true), m('z', 1, false)], edges: [e('c', 'old', 'eager', 'b')] },
    after: { entry: 'b', modules: [m('b', 6, true), m('c', 4, true), m('a', 0, true), m('z', 1, false)], edges: [e('c', 'first', 'eager', 'a'), e('a', 'second', 'eager', 'b')] },
    beforeExpected: {
      eager: { entry: 'b', components: [{ id: 'b', paths: ['b', 'c'], bytes: 10 }, { id: 'z', paths: ['z'], bytes: 1 }] },
      all: { entry: 'b', components: [{ id: 'b', paths: ['b', 'c'], bytes: 10 }, { id: 'z', paths: ['z'], bytes: 1 }] },
    },
    afterExpected: {
      eager: { entry: 'b', components: [{ id: 'a', paths: ['a', 'b', 'c'], bytes: 10 }, { id: 'z', paths: ['z'], bytes: 1 }] },
      all: { entry: 'b', components: [{ id: 'a', paths: ['a', 'b', 'c'], bytes: 10 }, { id: 'z', paths: ['z'], bytes: 1 }] },
    },
  },
];

for (const fixture of cases) {
  test(fixture.name, () => {
    verify(fixture.before, fixture.beforeExpected);
    verify(fixture.after, fixture.afterExpected);
  });
}

test('rejects a subdivided edge when the new endpoint is missing', () => {
  const invalid = { entry: 'a', modules: [m('a', 1, true), m('b', 2, true)], edges: [e('a', 'first', 'eager', 'missing'), e('missing', 'second', 'eager', 'b')] };
  for (const mode of ['eager', 'all']) {
    const result = run(invalid, mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
