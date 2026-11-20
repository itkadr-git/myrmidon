import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-subgraph.mjs');
const root = 'nested/root.js';
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const edges = [
  edge('entry.js', './nested/root.js', 'eager', root),
  edge('entry.js', './sibling.js', 'eager', 'sibling.js'),
  edge('nested/left.js', './leaf.js', 'eager', 'nested/leaf.js'),
  edge('nested/right.js', './leaf.js', 'eager', 'nested/leaf.js'),
  edge(root, './lazy.js', 'lazy', 'nested/lazy.js'),
  edge(root, './left.js', 'eager', 'nested/left.js'),
  edge(root, './right.js', 'eager', 'nested/right.js'),
];
const topology = {
  'entry.js': "import './nested/root.js'; import './sibling.js';\n",
  'nested/root.js': "import './left.js'; import './right.js'; import('./lazy.js');\n",
  'nested/left.js': "import './leaf.js';\n",
  'nested/right.js': "import './leaf.js';\n",
  'nested/leaf.js': 'export {};\n',
  'nested/lazy.js': 'export {};\n',
  'sibling.js': 'export {};\n',
};
function sources(state) {
  const suffix = { A: "// a\nconst value = 'a';\n", B: "// longer ascii comment\nconst value = 'different';\n", C: "// \u00e9\u96ea\nconst value = '\ud83c\udf0d';\n\n" }[state];
  return Object.fromEntries(Object.entries(topology).map(([name, source]) => [name, source + suffix + "throw new Error('must not execute');\n"]));
}
function run(...args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}
function expected(source, mode) {
  const paths = ['nested/leaf.js', 'nested/left.js', 'nested/right.js', root];
  if (mode === 'all') paths.push('nested/lazy.js');
  paths.sort();
  return {
    root, mode,
    modules: paths.map(path => ({ path, bytes: Buffer.byteLength(source[path]), eager: path !== 'nested/lazy.js' })),
    edges: edges.filter(e => paths.includes(e.from) && (mode === 'all' || e.kind === 'eager')),
    unknown: [],
  };
}
test('fresh source bytes flow through a stable nested subgraph A B C A', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-refresh-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  let first;
  for (const [index, state] of ['A', 'B', 'C', 'A'].entries()) {
    const source = sources(state);
    for (const [name, text] of Object.entries(source)) {
      const file = join(tmp, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
    }
    const reportText = run(scanner, join(tmp, 'entry.js'));
    const report = JSON.parse(reportText);
    assert.equal(report.entry, 'entry.js');
    assert.deepEqual(report.edges, edges);
    assert.deepEqual(report.modules, Object.keys(source).sort().map(path => ({ path, bytes: Buffer.byteLength(source[path]), eager: path !== 'nested/lazy.js' })));
    const reportFile = join(tmp, `report-${index}.json`);
    writeFileSync(reportFile, reportText);
    const outputs = ['eager', 'all'].map(mode => {
      const output = run(consumer, reportFile, root, mode);
      assert.equal(output, JSON.stringify(expected(source, mode)) + '\n');
      return output;
    });
    if (index === 0) first = outputs;
    if (index === 3) {
      assert.deepEqual(outputs, first);
      assert.equal(readFileSync(join(tmp, 'report-0.json'), 'utf8'), reportText);
    }
  }
});
