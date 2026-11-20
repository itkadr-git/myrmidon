import { deepStrictEqual, equal, notEqual, ok, throws } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-fan-in.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function run(input) {
  const dir = mkdtempSync(join(resolve(scratch), 'fanin-multiplicity-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify(input));
    return spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 5000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reachability and expectations come from the original relation, not CLI output.
function fixture(paths, relation) {
  const reachable = new Set(['root']);
  let size;
  do {
    size = reachable.size;
    for (const [from, to, kind] of relation) {
      if (kind === 'eager' && to !== null && reachable.has(from)) reachable.add(to);
    }
  } while (reachable.size !== size);
  const modules = paths.map(([path, bytes]) => ({ path, bytes, eager: reachable.has(path) }));
  const expected = {
    entry: 'root',
    modules: modules.filter(item => reachable.has(item.path)).map(item => {
      const sources = new Set(relation.filter(([from, to, kind]) =>
        kind === 'eager' && to === item.path && from !== to && reachable.has(from)
      ).map(([from]) => from));
      const importers = [...sources].sort(compare);
      return { path: item.path, bytes: item.bytes, importerCount: importers.length, importers };
    }).sort((a, b) => b.importerCount - a.importerCount || b.bytes - a.bytes || compare(a.path, b.path)),
  };
  return { modules, relation, expected };
}

const fixtures = [
  fixture([['root', 1], ['a', 7], ['b', 4], ['c', 2]], [
    ['root', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'c', 'eager'],
  ]),
  fixture([['root', 1], ['A', 8], ['z', 8], ['shared', 3], ['suffix', 9]], [
    ['root', 'A', 'eager'], ['root', 'z', 'eager'], ['A', 'shared', 'eager'],
    ['z', 'shared', 'eager'], ['shared', 'suffix', 'eager'], ['shared', 'shared', 'eager'],
  ]),
  fixture([['root', 1], ['a', 4], ['b', 4], ['exit', 3]], [
    ['root', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'a', 'eager'],
    ['b', 'exit', 'eager'], ['exit', 'exit', 'eager'],
  ]),
  fixture([['root', 1], ['live', 5], ['lazy', 50], ['disconnected', 100], ['isolated', 7]], [
    ['root', 'live', 'eager'], ['root', 'lazy', 'lazy'], ['root', null, 'eager'],
    ['live', null, 'lazy'], ['lazy', 'live', 'eager'], ['disconnected', 'live', 'eager'],
    ['disconnected', 'isolated', 'eager'], ['live', 'live', 'eager'],
  ]),
];

function inputFor(f, aliases, reversed = false) {
  const edges = f.relation.flatMap(([from, to, kind], index) =>
    Array.from({ length: to === null ? 1 : aliases }, (_, alias) => ({
      from, to, kind, specifier: `specifier-${index}-${alias}`,
    }))
  );
  return { entry: 'root', modules: reversed ? [...f.modules].reverse() : f.modules,
    edges: reversed ? edges.reverse() : edges };
}

function assertReport(result, expected) {
  equal(result.status, 0, result.stderr);
  equal(result.stderr, '');
  deepStrictEqual(JSON.parse(result.stdout), expected);
}

test('resolved alias multiplicity preserves exact eager fan-in across graph shapes and permutations', () => {
  for (const f of fixtures) {
    ok(f.expected.modules.length > 1);
    for (const aliases of [1, 2, 4]) {
      for (const reversed of [false, true]) assertReport(run(inputFor(f, aliases, reversed)), f.expected);
    }
  }
});

test('the same assertion rejects a corrupted expected result', () => {
  const f = fixtures[1];
  const result = run(inputFor(f, 4));
  assertReport(result, f.expected);
  const corrupted = structuredClone(f.expected);
  corrupted.modules[0].bytes += 1;
  throws(() => assertReport(result, corrupted));
});

test('an exact duplicate import tuple is rejected without stdout', () => {
  const input = inputFor(fixtures[1], 2);
  input.edges.push({ ...input.edges[0] });
  const result = run(input);
  notEqual(result.status, 0);
  equal(result.stdout, '');
  ok(result.stderr.length > 0);
});
