import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lazy = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const cut = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, specifier, to, kind = 'eager') => ({ from, specifier, to, kind });

function run(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function check(t, report, lazyExpected, cutExpected, afterFlags) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-cut-consistency');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  const actualLazy = run(lazy, [file, 'Entry', 'target']);
  const actualCut = run(cut, ['Target'], JSON.stringify(report));
  assert.deepEqual(actualLazy, lazyExpected);
  assert.deepEqual(actualCut, cutExpected);

  // Validate the separately specified eager flags against the post-edge graph.
  const after = { ...report, modules: report.modules.map(mod => ({ ...mod, eager: afterFlags.includes(mod.path) })), edges: report.edges.filter(edge => !(edge.from === 'Entry' && edge.specifier === 'target')) };
  writeFileSync(file, JSON.stringify(after));
  const afterResult = run(lazy, [file, 'Entry', 'shared']);
  assert.deepEqual(afterResult.before, lazyExpected.after);
}

const base = () => ({
  entry: 'Entry',
  modules: [m('Entry', 10, true), m('Target', 20, true), m('child', 0, true), m('Shared', 7, true), m('off', 3, false)],
  edges: [e('Entry', 'target', 'Target'), e('Target', 'child', 'child'), e('Entry', 'shared', 'Shared'), e('Entry', 'lazy-shortcut', 'child', 'lazy')],
});
const selected = { from: 'Entry', specifier: 'target', to: 'Target' };

test('chain: removing the sole eager edge and cutting its target lose the same closure', t => {
  const report = base();
  check(t, report,
    { entry: 'Entry', selected, before: { modules: 4, bytes: 37 }, after: { modules: 2, bytes: 17 }, removedPaths: ['Target', 'child'], savedBytes: 20 },
    { entry: 'Entry', removed: 'Target', lostPaths: ['Target', 'child'], lostBytes: 20 },
    ['Entry', 'Shared']);
});

test('cycle with outgoing shared dependency remains shared after either cut', t => {
  const report = base();
  report.edges.push(e('child', 'back', 'Target'), e('child', 'shared', 'Shared'));
  check(t, report,
    { entry: 'Entry', selected, before: { modules: 4, bytes: 37 }, after: { modules: 2, bytes: 17 }, removedPaths: ['Target', 'child'], savedBytes: 20 },
    { entry: 'Entry', removed: 'Target', lostPaths: ['Target', 'child'], lostBytes: 20 },
    ['Entry', 'Shared']);
});

test('second incoming eager edge retains target after lazy conversion but not target cut', t => {
  const report = base();
  report.edges.push(e('Shared', 'alternate', 'Target'));
  check(t, report,
    { entry: 'Entry', selected, before: { modules: 4, bytes: 37 }, after: { modules: 4, bytes: 37 }, removedPaths: [], savedBytes: 0 },
    { entry: 'Entry', removed: 'Target', lostPaths: ['Target', 'child'], lostBytes: 20 },
    ['Entry', 'Target', 'child', 'Shared']);
});

test('parallel alias keeps target, whereas a lazy shortcut cannot preserve eager closure', t => {
  const report = base();
  report.edges.push(e('Entry', 'alias', 'Target'));
  check(t, report,
    { entry: 'Entry', selected, before: { modules: 4, bytes: 37 }, after: { modules: 4, bytes: 37 }, removedPaths: [], savedBytes: 0 },
    { entry: 'Entry', removed: 'Target', lostPaths: ['Target', 'child'], lostBytes: 20 },
    ['Entry', 'Target', 'child', 'Shared']);
});
