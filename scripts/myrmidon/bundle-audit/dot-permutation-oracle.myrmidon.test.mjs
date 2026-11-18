import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const mod = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

// IDs and edge lines below are hand-derived from JS UTF-16 lexical ordering.
const report = {
  entry: '__proto__',
  modules: [mod('\u00e9', false), mod('constructor'), mod('__proto__'), mod('a|b', false)],
  edges: [
    edge('__proto__', 'alias-b', 'eager', 'constructor'),
    edge('__proto__', 'alias-a', 'eager', 'constructor'),
    edge('constructor', 'back', 'eager', '__proto__'),
    edge('__proto__', 'self', 'eager', '__proto__'),
    edge('__proto__', 'cross|:', 'lazy', 'a|b'),
    edge('__proto__', 'same', 'lazy', '\u00e9'),
    edge('__proto__', 'same', 'eager', 'constructor'),
    edge('__proto__', 'missing-eager', 'eager', null),
    edge('constructor', 'missing-lazy', 'lazy', null),
  ],
};
const expected = [
  'digraph imports {',
  '  n0 [label="__proto__", style=solid];',
  '  n1 [label="a|b", style=dashed];',
  '  n2 [label="constructor", style=solid];',
  '  n3 [label="\u00e9", style=dashed];',
  '  n0 -> n2 [label="alias-a", style=solid];',
  '  n0 -> n2 [label="alias-b", style=solid];',
  '  n0 -> n1 [label="cross|:", style=dashed];',
  '  n0 -> n2 [label="same", style=solid];',
  '  n0 -> n3 [label="same", style=dashed];',
  '  n0 -> n0 [label="self", style=solid];',
  '  n2 -> n0 [label="back", style=solid];',
  '  // unresolved: 2',
  '}',
  '',
].join('\n');

function shuffle(items, seed) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('DOT matches the independent lexical oracle across seeded permutations', () => {
  for (const seed of [1, 2, 17, 42, 12345, 0xdeadbeef]) {
    const input = { ...report, modules: shuffle(report.modules, seed), edges: shuffle(report.edges, seed ^ 0x9e3779b9) };
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, `seed ${seed}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected, `seed ${seed}`);
  }
});
