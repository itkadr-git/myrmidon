import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const edge = (from, specifier, to) => ({ from, specifier, to, kind: 'eager' });
const edges = [
  edge('entry', 'left', 'left'), edge('entry', 'right', 'right'),
  edge('left', 'shared', 'shared'), edge('right', 'shared', 'shared'),
  edge('left', 'cycle', 'cycle'), edge('cycle', 'back', 'left'),
  edge('cycle', 'self', 'cycle'), edge('entry', 'alias-one', 'alias'),
  edge('entry', 'alias-two', 'alias'), edge('alias', 'leaf', 'leaf'),
  edge('entry', 'direct', 'leaf'), edge('island', 'off', 'off'),
  edge('entry', 'loop', 'entry'),
];
const paths = ['entry', 'left', 'right', 'shared', 'cycle', 'alias', 'leaf', 'island', 'off'];
const bytes = [11, 13, 17, 19, 23, 29, 31, 37, 41];

// Warshall transitive closure models individual edges, including parallel aliases.
function reachable(excluded) {
  const matrix = paths.map((_, i) => paths.map((__, j) => i === j));
  for (const e of edges) {
    if (e !== excluded) matrix[paths.indexOf(e.from)][paths.indexOf(e.to)] = true;
  }
  for (let k = 0; k < paths.length; k++)
    for (let i = 0; i < paths.length; i++)
      for (let j = 0; j < paths.length; j++)
        matrix[i][j] ||= matrix[i][k] && matrix[k][j];
  return paths.filter((_, i) => matrix[0][i]);
}

function expected(selected) {
  const before = reachable(null), after = reachable(selected);
  const total = items => ({ modules: items.length, bytes: items.reduce((sum, p) => sum + bytes[paths.indexOf(p)], 0) });
  const beforeTotals = total(before), afterTotals = total(after);
  return {
    entry: 'entry', selected: { from: selected.from, specifier: selected.specifier, to: selected.to },
    before: beforeTotals, after: afterTotals,
    removedPaths: before.filter(p => !after.includes(p)).sort(),
    savedBytes: beforeTotals.bytes - afterTotals.bytes,
  };
}

test('edge removal matches matrix reachability across graph shapes', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-oracle');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'edge-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = reachable(null);
  const report = { entry: 'entry', modules: paths.map((path, i) => ({ path, bytes: bytes[i], eager: before.includes(path) })), edges };
  const input = join(dir, 'report.json');
  writeFileSync(input, JSON.stringify(report));
  for (const selected of edges) {
    const result = spawnSync(process.execPath, [cli, input, selected.from, selected.specifier], { encoding: 'utf8', timeout: 10000 });
    const label = `${selected.from}:${selected.specifier}`;
    assert.ifError(result.error);
    assert.equal(result.signal, null, label);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.stderr, '', label);
    assert.equal(result.stdout, `${JSON.stringify(expected(selected))}\n`, label);
  }
});
