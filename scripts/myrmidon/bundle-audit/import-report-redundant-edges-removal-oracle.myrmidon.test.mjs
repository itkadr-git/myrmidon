import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const edge = (from, to, specifier = `${from}-${to}`, kind = 'eager') => ({ from, to, specifier, kind });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Enumerate simple paths after removing exactly one tuple, independently of the CLI's traversal.
function oracle(edges) {
  const eager = edges.filter(e => e.kind === 'eager' && e.to !== null);
  const result = [];
  for (const candidate of eager.filter(e => e.from !== e.to)) {
    const paths = [];
    function visit(path) {
      const last = path.at(-1);
      if (last === candidate.to) { paths.push(path); return; }
      for (const next of eager) {
        if (next === candidate || next.from !== last || path.includes(next.to)) continue;
        visit([...path, next.to]);
      }
    }
    visit([candidate.from]);
    paths.sort((a, b) => a.length - b.length || compare(JSON.stringify(a), JSON.stringify(b)));
    if (paths.length) result.push({ from: candidate.from, specifier: candidate.specifier, to: candidate.to, alternativePath: paths[0] });
  }
  return result.sort((a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.to, b.to));
}

function check(paths, edges, tmp, label) {
  const report = { entry: paths[0], modules: paths.map(path => ({ path, bytes: 0, eager: true })), edges };
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TMPDIR: tmp },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, label);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.deepEqual(JSON.parse(result.stdout), { entry: paths[0], redundant: oracle(edges) }, label);
}

test('exhaustive directed graphs through three vertices match removal oracle', t => {
  const tmp = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'removal-oracle-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (let count = 1; count <= 3; count++) {
    const paths = ['a', 'b', 'c'].slice(0, count);
    const possible = paths.flatMap(from => paths.map(to => edge(from, to)));
    for (let mask = 0; mask < 2 ** possible.length; mask++) {
      const edges = possible.filter((_, i) => mask & (1 << i));
      check(paths, edges, tmp, `vertices=${count} mask=${mask}`);
    }
  }
});

test('diamonds, cycles, parallel tuples and lazy or null edges match removal oracle', t => {
  const tmp = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'removal-oracle-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = ['a', 'b', 'c', 'd'];
  const cases = [
    [edge('a', 'd'), edge('a', 'c'), edge('c', 'd'), edge('a', 'b'), edge('b', 'd')],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'a'), edge('a', 'c'), edge('b', 'd')],
    [edge('a', 'b', 'one'), edge('a', 'b', 'two'), edge('b', 'c'), edge('a', 'c'), edge('c', 'a')],
    [edge('a', 'd'), edge('a', 'b'), edge('b', 'd', 'lazy', 'lazy'), edge('a', null, 'external'), edge('a', 'a'), edge('b', 'd', 'external', 'lazy')],
  ];
  cases.forEach((edges, i) => check(paths, edges, tmp, `case=${i}`));
});
