import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const metadata = { path: 'fake', from: 'fake', to: 'fake', bytes: -1, eager: false, note: sentinel };
const mod = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, to) => ({ from, specifier: to, to, kind: 'eager' });
const cases = [
  {
    name: 'diamond with shared dependency',
    report: { entry: 'entry', modules: [mod('entry', 10), mod('a', 20), mod('b', 30), mod('shared', 5)], edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'shared'), edge('b', 'shared')] },
    expected: { entry: 'entry', selected: { from: 'entry', specifier: 'a', to: 'a' }, before: { modules: 4, bytes: 65 }, after: { modules: 3, bytes: 45 }, removedPaths: ['a'], savedBytes: 20 },
  },
  {
    name: 'alternate direct path',
    report: { entry: 'entry', modules: [mod('entry', 2), mod('a', 3), mod('b', 5), mod('shared', 7)], edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'shared'), edge('b', 'a'), edge('b', 'shared')] },
    expected: { entry: 'entry', selected: { from: 'entry', specifier: 'a', to: 'a' }, before: { modules: 4, bytes: 17 }, after: { modules: 4, bytes: 17 }, removedPaths: [], savedBytes: 0 },
  },
];

function decorate(report, scope) {
  const copy = structuredClone(report);
  if (scope.includes('report')) Object.assign(copy, { x_meta: metadata, x_note: null, x_weight: [true, sentinel] });
  if (scope.includes('module')) copy.modules.forEach((module, i) => Object.assign(module, { x_meta: [metadata, null], x_note: sentinel, x_weight: i % 2 === 0 }));
  if (scope.includes('edge')) copy.edges.forEach(edge => Object.assign(edge, { x_meta: metadata, x_note: [null, false, sentinel], x_weight: 'private' }));
  return copy;
}

function invoke(file, report) {
  const input = JSON.stringify(report);
  writeFileSync(file, input);
  const result = spawnSync(process.execPath, [cli, file, 'entry', 'a'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readFileSync(file, 'utf8'), input);
  return result;
}

function fixture() {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'extension-isolation-'));
}

test('unknown extension fields do not affect lazy impact CLI output', () => {
  const dir = fixture();
  try {
    const file = join(dir, 'report.json');
    for (const { name, report, expected } of cases) {
      for (const scope of [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']]) {
        for (const reverse of [false, true]) {
          const input = decorate(report, scope);
          if (reverse) { input.modules.reverse(); input.edges.reverse(); }
          for (let repeat = 0; repeat < 2; repeat++) {
            const result = invoke(file, input);
            const label = `${name}: ${scope.join('+') || 'base'}, reverse=${reverse}, repeat=${repeat}`;
            assert.equal(result.status, 0, `${label}: ${result.stderr}`);
            assert.equal(result.stderr, '', label);
            assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, label);
            assert.ok(!result.stdout.includes(sentinel), label);
          }
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extension fields cannot make invalid known fields valid or leak into errors', () => {
  const dir = fixture();
  try {
    const file = join(dir, 'report.json');
    for (const { report } of cases) {
      for (const category of ['shape', 'graph']) {
        const input = decorate(report, ['report', 'module', 'edge']);
        if (category === 'shape') input.modules[1].bytes = -1;
        else input.edges[0].to = 'missing';
        const result = invoke(file, input);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `error: ${category}\n`);
        assert.ok(!result.stderr.includes(sentinel));
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
