import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const specifiers = ['node:fs', '@scope/pkg/sub', 'pkg/sub', './x', '../x', '/x', 'C:\\x', 'c:x', '#alias', 'pkg'];
const paths = ['entry', 'Z', 'a', 'module/sub'];
const sort = values => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

function oracle(report) {
  const unresolved = report.edges.filter(edge => edge.to === null);
  const local = name => name.startsWith('.') || name.startsWith('/') || /^[A-Za-z]:/.test(name);
  const rows = wantLocal => sort([...new Set(unresolved.map(edge => edge.specifier).filter(name => local(name) === wantLocal))])
    .map(specifier => {
      const importers = kind => sort([...new Set(unresolved.filter(edge => edge.specifier === specifier && edge.kind === kind).map(edge => edge.from))]);
      return { specifier, eagerImporters: importers('eager'), lazyImporters: importers('lazy') };
    });
  return { entry: report.entry, externals: rows(false), unresolvedLocal: rows(true) };
}

function makeReport(seed) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const edges = [];
  for (const specifier of specifiers) {
    // Every name has multiple importers and both kinds; seeded choices add variety.
    for (const [from, kind] of [[paths[0], 'eager'], [paths[1], 'lazy']]) edges.push({ from, specifier, kind, to: null });
    for (const from of paths.slice(2)) for (const kind of ['eager', 'lazy']) {
      if ((random() >>> 16) % 2) edges.push({ from, specifier, kind, to: null });
    }
  }
  edges.push({ from: 'entry', specifier: `resolved-only-${seed}`, kind: 'eager', to: 'a' });
  edges.push({ from: 'a', specifier: 'pkg/sub', kind: 'lazy', to: 'entry' });
  return {
    entry: 'entry', modules: paths.map(path => ({ path, bytes: 0, eager: true })), edges,
    unknown: [{ from: 'entry', specifier: 'stale-only', kind: 'eager', to: null }],
  };
}

test('seeded unresolved partitions match an independent oracle and ignore permutations', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'partition-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const run = report => {
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  for (let seed = 1; seed <= 25; seed++) {
    const report = makeReport(seed);
    const output = run(report);
    assert.deepEqual(JSON.parse(output), oracle(report), `seed ${seed}`);
    const permuted = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse(), unknown: [...report.unknown].reverse() };
    assert.equal(run(permuted), output, `permutation seed ${seed}`);
  }
});
