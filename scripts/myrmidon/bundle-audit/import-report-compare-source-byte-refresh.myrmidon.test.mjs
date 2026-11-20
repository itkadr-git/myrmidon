import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));
const eager = { 'entry.mjs': true, 'left.mjs': true, 'right.mjs': true, 'leaf.mjs': true, 'lazy.mjs': false };
const paths = Object.keys(eager).sort();
const edge = (from, specifier, kind) => ({ from, specifier: `./${specifier}`, kind, to: specifier });
const edges = [edge('entry.mjs', 'lazy.mjs', 'lazy'), edge('entry.mjs', 'left.mjs', 'eager'), edge('entry.mjs', 'right.mjs', 'eager'), edge('left.mjs', 'leaf.mjs', 'eager'), edge('right.mjs', 'leaf.mjs', 'eager')];
const sources = (left, leaf, lazy) => ({
  'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nthrow new Error('fixture must not execute');\n",
  'left.mjs': `import './leaf.mjs';\n// ${left}\n`,
  'right.mjs': "import './leaf.mjs';\nexport const right = 1;\n",
  'leaf.mjs': `export const leaf = '${leaf}';\n`,
  'lazy.mjs': `export const lazy = '${lazy}';\n`,
});
const a = sources('initial comment', 'long initial string', 'x');
const b = sources('longer ASCII comment than before', 's', 'longer lazy string');
const c = sources('multibyte \u96ea\u96ea', '\u00e9\u00e9\u00e9', 'line\n\u732b');
// Keep the fixture valid JavaScript while changing the number of newline bytes.
c['lazy.mjs'] = c['lazy.mjs'].replace('line\n', 'line');
c['right.mjs'] += '\n';
const bytes = (state, path) => Buffer.byteLength(state[path], 'utf8');
const run = (script, ...args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};
const expected = state => ({
  entry: 'entry.mjs',
  delta: {
    modules: 0, eagerModules: 0,
    totalBytes: paths.reduce((n, p) => n + bytes(state, p) - bytes(a, p), 0),
    eagerBytes: paths.filter(p => eager[p]).reduce((n, p) => n + bytes(state, p) - bytes(a, p), 0),
  },
  added: [], removed: [],
  changed: paths.filter(p => bytes(state, p) !== bytes(a, p)).map(path => ({
    path, before: { bytes: bytes(a, path), eager: eager[path] },
    after: { bytes: bytes(state, path), eager: eager[path] },
  })),
});

test('refreshes scanner bytes and compare output across A B C A without changing the graph', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'compare-source-byte-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let baseline, initialOutput;
  for (const [index, state] of [a, b, c, a].entries()) {
    for (const path of paths) writeFileSync(join(dir, path), state[path]);
    const reportText = run(scanner, join(dir, 'entry.mjs'));
    const report = JSON.parse(reportText);
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.edges, edges);
    assert.deepEqual(report.modules, paths.map(path => ({ path, bytes: bytes(state, path), eager: eager[path] })));
    const reportPath = join(dir, `report-${index}.json`);
    writeFileSync(reportPath, reportText);
    if (index === 0) baseline = reportText;
    assert.equal(readFileSync(join(dir, 'report-0.json'), 'utf8'), baseline);
    const output = run(consumer, join(dir, 'report-0.json'), reportPath);
    assert.equal(output, `${JSON.stringify(expected(state), null, 2)}\n`);
    if (index === 0) initialOutput = output;
    if (index === 3) assert.equal(output, initialOutput);
  }
});
