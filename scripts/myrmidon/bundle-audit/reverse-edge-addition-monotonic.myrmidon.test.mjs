import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const moduleOf = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, kind, specifier) => ({ from, to, kind, specifier });
const chain = {
  entry: 'entry',
  modules: ['entry', 'a', 'b', 't'].map(path => moduleOf(path)).concat(moduleOf('other', false)),
  edges: [edge('entry', 'a', 'eager', 'entry-a'), edge('a', 'b', 'eager', 'a-b'), edge('b', 't', 'eager', 'b-t')],
};
const baseline = { entry: 'entry', target: 't', importers: [
  { path: 'b', distance: 1 }, { path: 'a', distance: 2 }, { path: 'entry', distance: 3 },
] };
const shortcut = edge('a', 't', 'eager', 'a-t');
const first = { entry: 'entry', target: 't', importers: [
  { path: 'a', distance: 1 }, { path: 'b', distance: 1 }, { path: 'entry', distance: 2 },
] };
const second = { entry: 'entry', target: 't', importers: [
  { path: 'a', distance: 1 }, { path: 'b', distance: 1 }, { path: 'entry', distance: 1 },
] };
const disconnected = { entry: 'entry', target: 't', importers: [
  { path: 'b', distance: 1 }, { path: 'other', distance: 1 }, { path: 'a', distance: 2 }, { path: 'entry', distance: 3 },
] };

function check(dir, report, expected) {
  const file = join(dir, 'report.json');
  for (const value of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const input = JSON.stringify(value);
    writeFileSync(file, input);
    for (const source of [file, '-']) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = spawnSync(process.execPath, [cli, source, 't'], { input, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
      }
    }
  }
}

function withFixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-add-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('eager shortcuts shorten distances and removal restores the baseline', t => {
  const dir = withFixture(t);
  const added = { ...chain, edges: [...chain.edges, shortcut] };
  check(dir, chain, baseline);
  check(dir, added, first);
  check(dir, { ...added, edges: [...added.edges, edge('entry', 't', 'eager', 'entry-t')] }, second);
  check(dir, { ...added, edges: added.edges.filter(item => item !== shortcut) }, baseline);
});

test('a lazy shortcut does not change eager reverse distances', t => {
  const dir = withFixture(t);
  check(dir, chain, baseline);
  check(dir, { ...chain, edges: [...chain.edges, edge('a', 't', 'lazy', 'lazy-a-t')] }, baseline);
});

test('an unreachable eager importer is still included', t => {
  const dir = withFixture(t);
  check(dir, chain, baseline);
  check(dir, { ...chain, edges: [...chain.edges, edge('other', 't', 'eager', 'other-t')] }, disconnected);
});

test('missing edge endpoint fails closed without echoing input', () => {
  const report = { ...chain, edges: [...chain.edges, edge('other', 'secret-missing', 'eager', 'secret-specifier')] };
  const result = spawnSync(process.execPath, [cli, '-', 't'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
