import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-lazy-boundaries.mjs', import.meta.url).pathname;
const run = path => spawnSync(process.execPath, [cli, path], {
  encoding: 'utf8',
  timeout: 10_000,
});

const moduleEntry = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

const report = {
  entry: 'entry',
  modules: [
    moduleEntry('entry', 1, true),
    moduleEntry('__proto__', Number.MAX_SAFE_INTEGER, false),
    moduleEntry('constructor', 23, true),
    moduleEntry('zero', 0, false),
    moduleEntry('other', 11, false),
  ],
  edges: [
    edge('entry', 'constructor-eager-path', 'eager', 'constructor'),
    edge('entry', 'quote"alias', 'lazy', '__proto__'),
    edge('entry', 'line\nalias', 'lazy', '__proto__'),
    edge('entry', 'Z', 'lazy', '__proto__'),
    edge('entry', 'a', 'lazy', '__proto__'),
    edge('entry', 'alternate-eager-path', 'lazy', 'constructor'),
    edge('entry', 'zero', 'lazy', 'zero'),
    edge('entry', 'other', 'lazy', 'other'),
  ],
};

const expected = {
  entry: 'entry',
  boundaries: [
    { from: 'entry', specifier: 'Z', to: '__proto__', bytes: Number.MAX_SAFE_INTEGER },
    { from: 'entry', specifier: 'a', to: '__proto__', bytes: Number.MAX_SAFE_INTEGER },
    { from: 'entry', specifier: 'line\nalias', to: '__proto__', bytes: Number.MAX_SAFE_INTEGER },
    { from: 'entry', specifier: 'other', to: 'other', bytes: 11 },
    { from: 'entry', specifier: 'quote"alias', to: '__proto__', bytes: Number.MAX_SAFE_INTEGER },
    { from: 'entry', specifier: 'zero', to: 'zero', bytes: 0 },
  ],
};

function scratch(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'lazy-boundaries-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeReport(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

function assertCliReport(path, value) {
  const before = readFileSync(path, 'utf8');
  const result = run(path);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(result.stdout), value);
  assert.equal(result.stdout, `${JSON.stringify(value)}\n`);
  assert.equal(readFileSync(path, 'utf8'), before);
}

test('preserves lazy boundary identities, individual bytes, and code-unit order', t => {
  const dir = scratch(t);
  const path = join(dir, 'report.json');
  writeReport(path, report);
  assertCliReport(path, expected);

  writeReport(path, {
    ...report,
    modules: [...report.modules].reverse(),
    edges: [...report.edges].reverse(),
    ignored: { counts: 1 },
  });
  assertCliReport(path, expected);
});

test('alternate eager edge removes only its target boundary', t => {
  const dir = scratch(t);
  const path = join(dir, 'report.json');
  const withoutAlternate = {
    ...report,
    edges: report.edges.filter(item => item.specifier !== 'constructor-eager-path'),
    modules: report.modules.map(item => item.path === 'constructor' ? { ...item, eager: false } : item),
  };
  writeReport(path, withoutAlternate);
  const expectedWithConstructor = {
    ...expected,
    boundaries: [
      expected.boundaries[0],
      expected.boundaries[1],
      { from: 'entry', specifier: 'alternate-eager-path', to: 'constructor', bytes: 23 },
      ...expected.boundaries.slice(2),
    ],
  };
  assertCliReport(path, expectedWithConstructor);
  writeReport(path, report);
  assertCliReport(path, expected);
});
