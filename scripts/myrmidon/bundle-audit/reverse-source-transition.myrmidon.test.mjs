import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const consumer = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();

function fixture(t) {
  const dir = mkdtempSync(join(scratchRoot, 'reverse-source-transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sourceFiles(state) {
  return {
    'entry.mjs': [
      "import './short.mjs';",
      "import './long.mjs';",
      "import('./dynamic-shortcut.mjs');",
      "import('./lazy-only.mjs');",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('./scanner-sentinel', import.meta.url), 'executed');",
      "throw new Error('entry fixture must never execute');",
    ].join('\n') + '\n',
    'short.mjs': state === 'baseline'
      ? "import './target.mjs';\nthrow new Error('short fixture must never execute');\n"
      : "throw new Error('short fixture must never execute');\n",
    'long.mjs': "import './mid.mjs';\nthrow new Error('long fixture must never execute');\n",
    'mid.mjs': state === 'dynamic-target'
      ? "import('./target.mjs');\nthrow new Error('mid fixture must never execute');\n"
      : "import './target.mjs';\nthrow new Error('mid fixture must never execute');\n",
    'dynamic-shortcut.mjs': "import('./target.mjs');\nthrow new Error('dynamic shortcut must never execute');\n",
    'lazy-only.mjs': "import './target.mjs';\nthrow new Error('lazy-only fixture must never execute');\n",
    'target.mjs': "throw new Error('target fixture must never execute');\n",
  };
}

function writeSources(dir, state) {
  for (const [name, source] of Object.entries(sourceFiles(state))) writeFileSync(join(dir, name), source);
}

function runScanner(entry) {
  return spawnSync(process.execPath, [scanner, entry], { encoding: 'utf8', timeout: 5000 });
}

function consume(dir, raw, expected) {
  const reportPath = join(dir, 'scanner-output.json');
  writeFileSync(reportPath, raw);
  const result = spawnSync(process.execPath, [consumer, reportPath, 'target.mjs'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

const expected = {
  baseline: {
    impact: { entry: 'entry.mjs', target: 'target.mjs', importers: [
      { path: 'lazy-only.mjs', distance: 1 },
      { path: 'mid.mjs', distance: 1 },
      { path: 'short.mjs', distance: 1 },
      { path: 'entry.mjs', distance: 2 },
      { path: 'long.mjs', distance: 2 },
    ] },
  },
  'short-removed': {
    impact: { entry: 'entry.mjs', target: 'target.mjs', importers: [
      { path: 'lazy-only.mjs', distance: 1 },
      { path: 'mid.mjs', distance: 1 },
      { path: 'long.mjs', distance: 2 },
      { path: 'entry.mjs', distance: 3 },
    ] },
  },
  'dynamic-target': {
    impact: { entry: 'entry.mjs', target: 'target.mjs', importers: [
      { path: 'lazy-only.mjs', distance: 1 },
    ] },
  },
};

const moduleRow = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, to, kind) => ({ from, specifier: `./${to}`, kind, to });
const scannerExpected = {
  baseline: {
    entry: 'entry.mjs',
    modules: [moduleRow('dynamic-shortcut.mjs', 80, false), moduleRow('entry.mjs', 273, true), moduleRow('lazy-only.mjs', 80, false), moduleRow('long.mjs', 72, true), moduleRow('mid.mjs', 74, true), moduleRow('short.mjs', 76, true), moduleRow('target.mjs', 54, true)],
    edges: [edge('dynamic-shortcut.mjs', 'target.mjs', 'lazy'), edge('entry.mjs', 'dynamic-shortcut.mjs', 'lazy'), edge('entry.mjs', 'lazy-only.mjs', 'lazy'), edge('entry.mjs', 'long.mjs', 'eager'), edge('entry.mjs', 'short.mjs', 'eager'), edge('lazy-only.mjs', 'target.mjs', 'eager'), edge('long.mjs', 'mid.mjs', 'eager'), edge('mid.mjs', 'target.mjs', 'eager'), edge('short.mjs', 'target.mjs', 'eager')],
    unknown: [], counts: { modules: 7, eagerModules: 5, edges: 9 }, bytes: { total: 709, eager: 549 },
    heaviestEager: [moduleRow('entry.mjs', 273, true), moduleRow('short.mjs', 76, true), moduleRow('mid.mjs', 74, true), moduleRow('long.mjs', 72, true), moduleRow('target.mjs', 54, true)],
  },
  'short-removed': {
    entry: 'entry.mjs',
    modules: [moduleRow('dynamic-shortcut.mjs', 80, false), moduleRow('entry.mjs', 273, true), moduleRow('lazy-only.mjs', 80, false), moduleRow('long.mjs', 72, true), moduleRow('mid.mjs', 74, true), moduleRow('short.mjs', 53, true), moduleRow('target.mjs', 54, true)],
    edges: [edge('dynamic-shortcut.mjs', 'target.mjs', 'lazy'), edge('entry.mjs', 'dynamic-shortcut.mjs', 'lazy'), edge('entry.mjs', 'lazy-only.mjs', 'lazy'), edge('entry.mjs', 'long.mjs', 'eager'), edge('entry.mjs', 'short.mjs', 'eager'), edge('lazy-only.mjs', 'target.mjs', 'eager'), edge('long.mjs', 'mid.mjs', 'eager'), edge('mid.mjs', 'target.mjs', 'eager')],
    unknown: [], counts: { modules: 7, eagerModules: 5, edges: 8 }, bytes: { total: 686, eager: 526 },
    heaviestEager: [moduleRow('entry.mjs', 273, true), moduleRow('mid.mjs', 74, true), moduleRow('long.mjs', 72, true), moduleRow('target.mjs', 54, true), moduleRow('short.mjs', 53, true)],
  },
  'dynamic-target': {
    entry: 'entry.mjs',
    modules: [moduleRow('dynamic-shortcut.mjs', 80, false), moduleRow('entry.mjs', 273, true), moduleRow('lazy-only.mjs', 80, false), moduleRow('long.mjs', 72, true), moduleRow('mid.mjs', 75, true), moduleRow('short.mjs', 53, true), moduleRow('target.mjs', 54, false)],
    edges: [edge('dynamic-shortcut.mjs', 'target.mjs', 'lazy'), edge('entry.mjs', 'dynamic-shortcut.mjs', 'lazy'), edge('entry.mjs', 'lazy-only.mjs', 'lazy'), edge('entry.mjs', 'long.mjs', 'eager'), edge('entry.mjs', 'short.mjs', 'eager'), edge('lazy-only.mjs', 'target.mjs', 'eager'), edge('long.mjs', 'mid.mjs', 'eager'), edge('mid.mjs', 'target.mjs', 'lazy')],
    unknown: [], counts: { modules: 7, eagerModules: 4, edges: 8 }, bytes: { total: 687, eager: 473 },
    heaviestEager: [moduleRow('entry.mjs', 273, true), moduleRow('mid.mjs', 75, true), moduleRow('long.mjs', 72, true), moduleRow('short.mjs', 53, true)],
  },
};

test('real scanner and consumer follow reverse impact across source transitions', t => {
  const dir = fixture(t);
  const entry = join(dir, 'entry.mjs');
  writeSources(dir, 'baseline');
  const states = ['baseline', 'short-removed', 'dynamic-target'];
  const rawReports = new Map();
  for (const state of states) {
    if (state !== 'baseline') writeSources(dir, state);
    const before = new Map(Object.keys(sourceFiles(state)).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
    const scan = runScanner(entry);
    assert.equal(scan.status, 0, `${state}: ${scan.stderr}`);
    assert.equal(scan.signal, null, state);
    assert.equal(scan.stderr, '', state);
    assert.notEqual(scan.stdout, '', state);
    const raw = scan.stdout;
    rawReports.set(state, raw);
    assert.deepEqual(JSON.parse(raw), scannerExpected[state], state);
    consume(dir, raw, expected[state].impact);
    for (const [name, contents] of before) assert.equal(readFileSync(join(dir, name), 'utf8'), contents, `${state}: scanner changed ${name}`);
    assert.equal(existsSync(join(dir, 'scanner-sentinel')), false, `${state}: source executed`);

    const repeat = runScanner(entry);
    assert.equal(repeat.status, 0, `${state} repeat: ${repeat.stderr}`);
    assert.equal(repeat.signal, null, `${state} repeat`);
    assert.equal(repeat.stderr, '', `${state} repeat`);
    assert.equal(repeat.stdout, raw, `${state}: stale or nondeterministic report`);
    consume(dir, repeat.stdout, expected[state].impact);
    for (const [name, contents] of before) assert.equal(readFileSync(join(dir, name), 'utf8'), contents, `${state} repeat: changed ${name}`);
    assert.equal(existsSync(join(dir, 'scanner-sentinel')), false, `${state} repeat: source executed`);
  }
  assert.notEqual(rawReports.get('baseline'), rawReports.get('short-removed'));
  assert.notEqual(rawReports.get('short-removed'), rawReports.get('dynamic-target'));
});
