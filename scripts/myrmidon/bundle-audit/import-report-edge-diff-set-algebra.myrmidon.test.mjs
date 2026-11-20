import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
// This table is in the specified output order, independently of the CLI.
const tuples = [
  ['a', 'child', 'eager', 'b'],
  ['a', 'child', 'lazy', 'b'],
  ['b', 'external', 'lazy', null],
  ['entry', 'dep', 'eager', null],
  ['entry', 'dep', 'eager', 'a'],
  ['entry', 'dep', 'lazy', null],
  ['entry', 'dep', 'lazy', 'a'],
  ['entry', 'other', 'lazy', 'a'],
];
const rows = tuples.map(([from, specifier, kind, to]) => ({ from, specifier, kind, to }));
// Explicit edge sets: adjacent graphs change kind, target, specifier and source.
const graphs = [
  [], [3], [5], [6], [4], [4, 0], [4, 1], [4, 1, 2],
  [4, 1], [4], [7], [6, 2], [3, 2],
].map(indices => new Set(indices));

function report(set) {
  const edges = [...set].map(i => rows[i]);
  const reached = new Set(['entry']);
  let changed;
  do {
    changed = false;
    for (const { from, kind, to } of edges) {
      if (kind === 'eager' && to !== null && reached.has(from) && !reached.has(to)) {
        reached.add(to);
        changed = true;
      }
    }
  } while (changed);
  return { entry: 'entry', modules: ['entry', 'a', 'b'].map(path => ({ path, bytes: 1, eager: reached.has(path) })), edges };
}

test('edge tuple set algebra holds across a matrix of consistent graphs', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-algebra-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = graphs.map((set, i) => {
    const path = join(dir, `${i}.json`);
    const bytes = JSON.stringify(report(set));
    writeFileSync(path, bytes);
    return { path, bytes };
  });
  function diff(a, b) {
    const result = spawnSync(process.execPath, [cli, files[a].path, files[b].path], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined, `spawn ${a} -> ${b}: ${result.error}`);
    assert.equal(result.signal, null, `signal ${a} -> ${b}`);
    assert.equal(result.status, 0, `exit ${a} -> ${b}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    const added = [], removed = [];
    for (let i = 0; i < rows.length; i++) {
      if (!graphs[a].has(i) && graphs[b].has(i)) added.push(rows[i]);
      if (graphs[a].has(i) && !graphs[b].has(i)) removed.push(rows[i]);
    }
    const expected = { entry: 'entry', added, removed };
    assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`, `${a} -> ${b}`);
    assert.equal(readFileSync(files[a].path, 'utf8'), files[a].bytes);
    assert.equal(readFileSync(files[b].path, 'utf8'), files[b].bytes);
    return JSON.parse(result.stdout);
  }
  const key = row => JSON.stringify([row.from, row.specifier, row.kind, row.to]);
  for (let a = 0; a < graphs.length; a++) {
    assert.deepEqual(diff(a, a), { entry: 'entry', added: [], removed: [] });
    const b = (a + 1) % graphs.length;
    const forward = diff(a, b), reverse = diff(b, a);
    assert.deepEqual(forward.added, reverse.removed);
    assert.deepEqual(forward.removed, reverse.added);
    const replay = new Set([...graphs[a]].map(i => key(rows[i])));
    for (const row of forward.removed) assert.equal(replay.delete(key(row)), true);
    for (const row of forward.added) {
      assert.equal(replay.has(key(row)), false);
      replay.add(key(row));
    }
    assert.deepEqual([...replay].sort(), [...graphs[b]].map(i => key(rows[i])).sort());
    for (const list of [forward.added, forward.removed]) assert.equal(new Set(list.map(key)).size, list.length);
  }
});
