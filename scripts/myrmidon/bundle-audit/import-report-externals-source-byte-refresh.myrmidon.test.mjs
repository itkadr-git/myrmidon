import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const run = (program, arg) => {
  const result = spawnSync(process.execPath, [program, arg], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

const expected = {
  entry: 'entry.mjs',
  externals: [
    { specifier: 'pkg', eagerImporters: ['left.mjs', 'right.mjs'], lazyImporters: ['lazy.mjs'] },
    { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['entry.mjs'] },
  ],
  unresolvedLocal: [
    { specifier: './missing.mjs', eagerImporters: ['left.mjs'], lazyImporters: ['lazy.mjs'] },
  ],
};

function sources(text) {
  return {
    'entry.mjs': `import './left.mjs'; import './right.mjs'; import('./lazy.mjs'); import('pkg/sub');\nthrow new Error('source must not execute');\n// ${text}\n`,
    'left.mjs': `import './leaf.mjs'; import 'pkg'; import './missing.mjs';\nconst value = ${JSON.stringify(text)};\n`,
    'right.mjs': `import './leaf.mjs'; import 'pkg';\n// ${text}\n`,
    'leaf.mjs': `export const value = ${JSON.stringify(text)};\n`,
    'lazy.mjs': `import('pkg'); import('./missing.mjs');\n// ${text}\n`,
  };
}

test('fresh scanner bytes preserve external inventory across A B C A', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'externals-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let originalGraph, originalOutput, originalReport;
  for (const [index, text] of ['a', 'longer ASCII text', '\u00e9\u6f22\nnewline', 'a'].entries()) {
    const files = sources(text);
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    const scan = run(scanner, join(dir, 'entry.mjs'));
    const report = JSON.parse(scan);
    const sizes = Object.fromEntries(Object.entries(files).map(([name, source]) => [name, Buffer.byteLength(source)]));
    const expectedBytes = Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a < b ? -1 : 1));
    const assertFreshBytes = value => assert.deepEqual(Object.fromEntries(value.modules.map(m => [m.path, m.bytes])), expectedBytes);
    assertFreshBytes(report);
    if (index === 1) assert.throws(() => assertFreshBytes(JSON.parse(originalReport)));
    const graph = JSON.stringify({ entry: report.entry, modules: report.modules.map(({ path, eager }) => ({ path, eager })), edges: report.edges });
    if (index === 0) { originalGraph = graph; originalReport = scan; }
    assert.equal(graph, originalGraph);
    assert.deepEqual(report.modules.map(({ path, eager }) => [path, eager]), [['entry.mjs', true], ['lazy.mjs', false], ['leaf.mjs', true], ['left.mjs', true], ['right.mjs', true]]);
    const path = join(dir, `report-${index}.json`);
    writeFileSync(path, scan);
    const output = run(consumer, path);
    assert.equal(output, JSON.stringify(expected) + '\n');
    if (index === 0) originalOutput = output;
    assert.equal(output, originalOutput);
    assert.equal(readFileSync(path, 'utf8'), scan);
    assert.equal(readFileSync(join(dir, 'report-0.json'), 'utf8'), originalReport);
    if (index === 3) assert.equal(scan, originalReport);
  }
});
