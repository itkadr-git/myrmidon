import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-fan-in.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir();
const names = [
  ['root', 'a', 'b', 'c', 'lazy'],
  ['../root space', 'z!', 'A', 'é', 'lazy island'],
  ['入口', '../a', 'b space', '!c', 'λ'],
];
const edge = (from, to, kind = 'eager', specifier = `${from}:${to}:${kind}`) => ({ from, to, kind, specifier });
const module = (path, bytes, eager = true) => ({ path, bytes, eager });
const row = (path, bytes, importers) => ({ path, bytes, importerCount: importers.length, importers });

// Expected importer sets and rank groups are written independently of the CLI.
const fixtures = [
  {
    name: 'diamond and aliases',
    modules: [module('root', 1), module('a', 5), module('b', 5), module('c', 3), module('lazy', 9, false)],
    edges: [edge('root', 'a'), edge('root', 'b'), edge('a', 'c'), edge('b', 'c'), edge('a', 'c', 'eager', 'alias'), edge('root', 'lazy', 'lazy'), edge('root', null)],
    expected: [row('c', 3, ['a', 'b']), row('a', 5, ['root']), row('b', 5, ['root']), row('root', 1, [])],
    orders: [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 2, 3]],
  },
  {
    name: 'cycle and self loop',
    modules: [module('root', 1), module('a', 4), module('b', 4), module('c', 2), module('lazy', 8, false)],
    edges: [edge('root', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'b'), edge('b', 'c'), edge('root', 'lazy', 'lazy'), edge('lazy', 'a')],
    expected: [row('a', 4, ['b', 'root']), row('b', 4, ['a']), row('c', 2, ['b']), row('root', 1, [])],
    orders: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]],
  },
  {
    name: 'lazy island and byte rank',
    modules: [module('root', 7), module('a', 2), module('b', 8), module('c', 12, false), module('lazy', 10, false)],
    edges: [edge('root', 'a'), edge('root', 'b'), edge('root', 'c', 'lazy'), edge('c', 'lazy'), edge('c', 'b'), edge('a', 'b', 'lazy'), edge('a', null, 'lazy')],
    expected: [row('b', 8, ['root']), row('a', 2, ['root']), row('root', 7, [])],
    orders: [[0, 1, 2], [0, 1, 2], [0, 1, 2]],
  },
  {
    name: 'equal ranks and importer ordering',
    modules: [module('root', 3), module('a', 6), module('b', 6), module('c', 6), module('lazy', 2, false)],
    edges: [edge('root', 'a'), edge('root', 'b'), edge('a', 'c'), edge('b', 'c'), edge('root', 'c', 'lazy'), edge('c', 'c'), edge('b', 'lazy', 'lazy')],
    expected: [row('c', 6, ['a', 'b']), row('a', 6, ['root']), row('b', 6, ['root']), row('root', 3, [])],
    orders: [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 2, 3]],
  },
];

function run(input) {
  const dir = mkdtempSync(join(scratch, 'fanin-bijection-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify(input));
    return spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 5000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function transform(fixture, variant) {
  const rename = value => value === null ? null : names[variant][names[0].indexOf(value)];
  return {
    entry: rename('root'),
    modules: fixture.modules.map(item => ({ ...item, path: rename(item.path) })),
    edges: fixture.edges.map(item => ({ ...item, from: rename(item.from), to: rename(item.to) })),
  };
}

function expectedFor(fixture, variant) {
  const rename = value => names[variant][names[0].indexOf(value)];
  return {
    entry: rename('root'),
    modules: fixture.orders[variant].map(index => {
      const item = fixture.expected[index];
      return { ...item, path: rename(item.path), importers: item.importers.map(rename).sort() };
    }),
  };
}

function assertReport(result, expected) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

for (const fixture of fixtures) {
  test(`${fixture.name}: identities preserve the complete ranked report`, () => {
    for (let variant = 0; variant < names.length; variant++) {
      assert.equal(new Set(names[variant]).size, names[variant].length);
      assertReport(run(transform(fixture, variant)), expectedFor(fixture, variant));
    }
  });
}

test('the report assertion rejects a corrupted result', () => {
  const expected = expectedFor(fixtures[0], 1);
  const result = run(transform(fixtures[0], 1));
  assertReport(result, expected);
  const corrupt = { ...result, stdout: result.stdout.replace('"importerCount":2', '"importerCount":0') };
  assert.notEqual(corrupt.stdout, result.stdout);
  assert.throws(() => assertReport(corrupt, expected));
});

test('rejects a non-injective module path merge without exposing input', () => {
  const input = transform(fixtures[0], 0);
  const sentinel = 'SENTINEL-private-merge';
  const merge = value => value === 'a' || value === 'b' ? sentinel : value;
  input.modules = input.modules.map(item => ({ ...item, path: merge(item.path) }));
  input.edges = input.edges.map(item => ({ ...item, from: merge(item.from), to: merge(item.to) }));
  const result = run(input);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'fan-in report: invalid input\n');
  assert.ok(!result.stderr.includes(sentinel));
});
