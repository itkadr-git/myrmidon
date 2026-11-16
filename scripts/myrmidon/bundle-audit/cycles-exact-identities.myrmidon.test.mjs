import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const names = ['__proto__', 'constructor', 'toString', 'a|b', 'a\\b', './a', 'a', '\u00e9', '\u03bb', 'prefix', 'prefix-long', 'isolated', 'loop', 'dag1', 'dag2', 'dag3'];
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const edges = [
  edge('__proto__', 'constructor'), edge('constructor', '__proto__'),
  edge('a|b', 'a\\b'), edge('a\\b', 'a|b'),
  edge('./a', 'a'), edge('a', './a', 'lazy'),
  edge('\u00e9', '\u03bb'), edge('\u03bb', '\u00e9'),
  edge('prefix', 'prefix-long'), edge('prefix-long', 'prefix'),
  edge('loop', 'loop'), edge('dag1', 'dag2', 'eager', 'alias-one'),
  edge('dag1', 'dag2', 'eager', 'alias-two'), edge('dag2', 'dag3'),
  edge('toString', 'dag1'),
];
const expected = {
  entry: '__proto__',
  eagerCycles: [['__proto__', 'constructor'], ['a\\b', 'a|b'], ['loop'], ['prefix', 'prefix-long'], ['\u00e9', '\u03bb']],
  allCycles: [['./a', 'a'], ['__proto__', 'constructor'], ['a\\b', 'a|b'], ['loop'], ['prefix', 'prefix-long'], ['\u00e9', '\u03bb']],
};

// Deterministic Fisher-Yates permutations; the expected graph is specified above.
function shuffled(values, seed) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('exact identities and cycle projections are invariant under graph permutations', t => {
  const dir = mkdtempSync(join(root, 'cycles-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  for (let seed = 1; seed <= 16; seed++) {
    const report = {
      entry: '__proto__',
      modules: shuffled(names, seed).map(path => ({ path, bytes: 0, eager: false })),
      edges: shuffled(edges, seed + 100),
    };
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, `seed ${seed}: ${result.error}`);
    assert.equal(result.status, 0, `seed ${seed}: ${result.stderr}`);
    assert.equal(result.stderr, '', `seed ${seed}`);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, `seed ${seed}`);
  }
});
