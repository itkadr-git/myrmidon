import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const fixture = {
  entry: 'root',
  modules: [moduleOf('root', 2), moduleOf('a', 7), moduleOf('b', 3), moduleOf('end', 5), moduleOf('lazy', 40, false)],
  edges: [edge('root', 'b', './b'), edge('root', 'a', './a'), edge('a', 'end', './end'), edge('b', 'end', './end'), edge('root', 'lazy', './lazy', 'lazy'), edge('a', null, 'external')],
};
const maps = [
  { root: 'entry', a: 'z', b: 'y', end: 'finish', lazy: 'idle' },
  { root: 'src/main', a: 'src/z/index', b: 'src/a/index', end: 'lib/end', lazy: 'lib/lazy' },
  { root: '\u03c1/root', a: '\u03c9/a', b: '\u03b1/b', end: '\u7d42/end', lazy: '\u03bb/lazy' },
];
function rename(report, names) {
  return {
    ...report,
    entry: names[report.entry],
    modules: report.modules.map(mod => ({ ...mod, path: names[mod.path] })),
    edges: report.edges.map(item => ({ ...item, from: names[item.from], to: item.to === null ? null : names[item.to] })),
  };
}
function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000 });
}
function expectSuccess(report, expected) {
  const first = run(report);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, JSON.stringify(expected) + '\n');
  const second = run(report);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, first.stdout);
  return JSON.parse(first.stdout);
}

test('unique weighted path survives identity bijections', () => {
  const before = JSON.stringify(fixture);
  const expected = { entry: 'root', paths: ['root', 'a', 'end'], bytes: 14 };
  expectSuccess(fixture, expected);
  for (const names of maps) {
    assert.equal(new Set(Object.values(names)).size, fixture.modules.length);
    const actual = expectSuccess(rename(fixture, names), { entry: names.root, paths: [names.root, names.a, names.end], bytes: 14 });
    const inverse = Object.fromEntries(Object.entries(names).map(([oldName, newName]) => [newName, oldName]));
    assert.deepEqual({ ...actual, entry: inverse[actual.entry], paths: actual.paths.map(path => inverse[path]) }, expected);
  }
  assert.equal(JSON.stringify(fixture), before);
});

test('equal-weight diamond chooses the first new identity, not input order', () => {
  const diamond = { ...fixture, modules: fixture.modules.map(mod => mod.path === 'b' ? { ...mod, bytes: 7 } : mod) };
  const before = JSON.stringify(diamond);
  expectSuccess(diamond, { entry: 'root', paths: ['root', 'a', 'end'], bytes: 14 });
  for (const names of maps) {
    expectSuccess(rename(diamond, names), { entry: names.root, paths: [names.root, names.b, names.end], bytes: 14 });
  }
  assert.equal(JSON.stringify(diamond), before);
});

test('colliding identities are rejected by the CLI', () => {
  const names = { ...maps[0], b: maps[0].a };
  const result = run(rename(fixture, names));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
