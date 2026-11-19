import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, to, kind, specifier) => ({ from, to, kind, specifier });
const c = (id, paths, bytes) => ({ id, paths, bytes });
const d = (from, to) => ({ from, to });

const report = {
  entry: 'a',
  modules: [m('a', 2, true), m('b', 3, true), m('c', 5, true), m('d', 7, false), m('e', 11, false), m('z', 13, false)],
  edges: [
    e('a', 'b', 'eager', 'ab'), e('b', 'a', 'eager', 'ba'),
    e('c', 'd', 'eager', 'cd'), e('d', 'c', 'eager', 'dc'),
    e('a', 'c', 'eager', 'ac1'), e('b', 'd', 'eager', 'ac2'),
    e('a', 'e', 'eager', 'ae'), e('d', 'e', 'lazy', 'de'),
    e('b', null, 'lazy', 'external'),
  ],
};

// Both directions are specified independently of the CLI result.
const components = [c('a', ['a', 'b'], 5), c('c', ['c', 'd'], 12), c('e', ['e'], 11), c('z', ['z'], 13)];
const expected = {
  eager: [
    { entry: 'a', components, edges: [d('a', 'c'), d('a', 'e')] },
    { entry: 'a', components, edges: [d('c', 'a'), d('e', 'a')] },
  ],
  all: [
    { entry: 'a', components, edges: [d('a', 'c'), d('a', 'e'), d('c', 'e')] },
    { entry: 'a', components, edges: [d('c', 'a'), d('e', 'a'), d('e', 'c')] },
  ],
};

function assertOutput(stdout, oracle) {
  // Do not expose input or output payloads in assertion diagnostics.
  assert.ok(stdout === `${JSON.stringify(oracle)}\n`, 'condensation differs from the hand-written oracle');
}

function run(input, mode, oracle) {
  const result = spawnSync(process.execPath, [cli, mode], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  assert.ok(result.status === 0 && result.stderr === '', 'condensation CLI failed');
  assertOutput(result.stdout, oracle);
}

test('transposing internal import edges reverses the condensation in eager and all modes', () => {
  const transpose = {
    ...report,
    edges: report.edges.map(edge => edge.to === null ? { ...edge } : { ...edge, from: edge.to, to: edge.from }),
  };
  for (const mode of ['eager', 'all']) {
    for (const [index, input] of [report, transpose].entries()) {
      run(input, mode, expected[mode][index]);
      run({ ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }, mode, expected[mode][index]);
    }
  }
});

test('oracle rejects a missing component', () => {
  for (const mode of ['eager', 'all']) {
    for (const oracle of expected[mode]) {
      const incomplete = { ...oracle, components: oracle.components.filter(component => component.id !== 'z') };
      assert.throws(() => assertOutput(`${JSON.stringify(incomplete)}\n`, oracle), assert.AssertionError);
    }
  }
});
