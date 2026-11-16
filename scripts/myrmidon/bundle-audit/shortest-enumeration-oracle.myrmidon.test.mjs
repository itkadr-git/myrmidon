import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = String(to)) => ({ from, to, kind, specifier });

// Enumerate complete simple vertex sequences, then select the shortest for each target.
function enumerate(names, edges, entry) {
  const paths = [];
  function visit(sequence) {
    paths.push(sequence);
    for (const target of names) {
      if (!sequence.includes(target) && edges.some(e => e.from === sequence.at(-1) && e.to === target && e.kind === 'eager')) {
        visit([...sequence, target]);
      }
    }
  }
  visit([entry]);
  const modules = [], unreachable = [];
  for (const name of [...names].sort()) {
    const candidates = paths.filter(path => path.at(-1) === name);
    if (!candidates.length) { unreachable.push(name); continue; }
    const length = Math.min(...candidates.map(path => path.length));
    modules.push({ path: name, depth: length - 1, shortestPaths: String(candidates.filter(path => path.length === length).length) });
  }
  return { entry, modules, unreachable };
}

function fixture(names, edges, entry = 'a') {
  const expected = enumerate(names, edges, entry);
  const reachable = new Set(expected.modules.map(module => module.path));
  return { report: { entry, modules: names.map(path => ({ path, bytes: 0, eager: reachable.has(path) })), edges }, expected };
}

function run(report, executable = cli) {
  const result = spawnSync(process.execPath, [executable], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function verify(report, expected, executable = cli) {
  assert.equal(run(report, executable), `${JSON.stringify(expected)}\n`);
}

test('all 64 loop-free directed graphs match simple-sequence enumeration', () => {
  const names = ['a', 'b', 'c'];
  const possible = names.flatMap(from => names.filter(to => to !== from).map(to => edge(from, to)));
  for (let mask = 0; mask < 64; mask++) {
    const edges = possible.filter((_, index) => mask & (1 << index));
    const { report, expected } = fixture(names, edges);
    assert.deepEqual(expected.modules.find(module => module.path === 'a'), { path: 'a', depth: 0, shortestPaths: '1' });
    assert.equal(run(report), `${JSON.stringify(expected)}\n`, `graph mask ${mask}`);
  }
});

test('cyclic diamond deduplicates eager aliases and ignores lazy and null targets', () => {
  const edges = [edge('a', 'b'), edge('a', 'b', 'eager', 'alias'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'a'), edge('a', 'd', 'lazy'), edge('a', null), edge('x', 'x')];
  const { report, expected } = fixture(['a', 'b', 'c', 'd', 'x'], edges);
  assert.deepEqual(expected.modules.find(module => module.path === 'd'), { path: 'd', depth: 2, shortestPaths: '2' });
  assert.deepEqual(expected.unreachable, ['x']);
  verify(report, expected);
  const permuted = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  assert.equal(run(permuted), run(report));
});

test('negative control detects replacing count addition with assignment', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'shortest-oracle-'));
  try {
    const original = readFileSync(cli, 'utf8');
    const needle = 'counts.set(to, counts.get(to) + counts.get(from));';
    assert.equal(original.split(needle).length, 2, 'mutation must match exactly once');
    const mutant = join(dir, 'mutant.mjs');
    writeFileSync(mutant, original.replace(needle, 'counts.set(to, counts.get(from));'));
    const { report, expected } = fixture(['a', 'b', 'c', 'd'], [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
    assert.throws(() => verify(report, expected, mutant), error => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.match(error.message, /shortestPaths/);
      t.diagnostic(`Mutation rejected: ${error.message}`);
      return true;
    });
    verify(report, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
