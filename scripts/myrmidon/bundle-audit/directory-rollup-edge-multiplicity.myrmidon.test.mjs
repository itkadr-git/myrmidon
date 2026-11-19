import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const entry = 'top.js';
const sizes = { 'top.js': 3, 'src/a.js': 5, 'src/deep/b.js': 11, 'src/c.js': 17, 'other/d.js': 23 };
const fixtures = {
  chain: [['top.js', 'src/a.js', 'eager'], ['src/a.js', 'src/deep/b.js', 'eager']],
  diamond: [['top.js', 'src/a.js', 'eager'], ['top.js', 'src/c.js', 'eager'], ['src/a.js', 'src/deep/b.js', 'eager'], ['src/c.js', 'src/deep/b.js', 'eager'], ['src/deep/b.js', 'other/d.js', 'eager']],
  cycle: [['top.js', 'src/a.js', 'eager'], ['src/a.js', 'src/deep/b.js', 'eager'], ['src/deep/b.js', 'src/a.js', 'eager'], ['src/deep/b.js', 'other/d.js', 'eager']],
  mixed: [['top.js', 'src/a.js', 'eager'], ['src/a.js', 'src/deep/b.js', 'lazy'], ['src/deep/b.js', 'src/c.js', 'eager'], ['src/a.js', null, 'eager'], ['top.js', null, 'lazy']],
};

function reachable(relations) {
  const reached = new Set([entry]);
  let changed;
  do {
    changed = false;
    for (const [from, to, kind] of relations) {
      if (kind === 'eager' && to !== null && reached.has(from) && !reached.has(to)) {
        reached.add(to);
        changed = true;
      }
    }
  } while (changed);
  return reached;
}

function expectedFor(relations) {
  const eager = reachable(relations);
  const groups = {};
  for (const [path, bytes] of Object.entries(sizes)) {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    (groups[directory] ??= []).push({ path, bytes });
  }
  return {
    entry,
    directories: Object.keys(groups).sort().map(directory => ({
      directory,
      modules: groups[directory].length,
      eagerModules: groups[directory].filter(m => eager.has(m.path)).length,
      totalBytes: groups[directory].reduce((sum, m) => sum + m.bytes, 0),
      eagerBytes: groups[directory].filter(m => eager.has(m.path)).reduce((sum, m) => sum + m.bytes, 0),
    })),
  };
}

function reportFor(relations, aliases) {
  const eager = reachable(relations);
  return {
    entry,
    modules: Object.entries(sizes).map(([path, bytes]) => ({ path, bytes, eager: eager.has(path) })),
    edges: relations.flatMap(([from, to, kind], i) => Array.from({ length: to === null ? 1 : aliases }, (_, alias) => ({
      from, to, kind, specifier: `edge-${i}-alias-${alias}`,
    }))),
  };
}

function invoke(report) {
  return spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}

function assertRollup(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

test('directory rollup counts modules once across parallel import aliases and permutations', () => {
  for (const [name, relations] of Object.entries(fixtures)) {
    const expected = expectedFor(relations);
    assert.ok(expected.directories.length > 1, name);
    for (const count of [1, 2, 4]) {
      const report = reportFor(relations, count);
      for (const reversed of [false, true]) {
        const input = reversed ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
        assertRollup(invoke(input), expected);
      }
    }
  }
});

test('the rollup assertion rejects a corrupted expectation', () => {
  const relations = fixtures.diamond;
  const expected = expectedFor(relations);
  const result = invoke(reportFor(relations, 4));
  assertRollup(result, expected);
  const corrupted = structuredClone(expected);
  corrupted.directories[0].totalBytes++;
  assert.throws(() => assertRollup(result, corrupted), assert.AssertionError);
});

test('an exact duplicate import tuple is rejected without stdout', () => {
  const report = reportFor(fixtures.diamond, 2);
  report.edges.push({ ...report.edges[0] });
  const result = invoke(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.notEqual(result.stderr.trim(), '');
});
