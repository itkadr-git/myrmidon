import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-dominators.mjs');
const invoke = (script, ...args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

const imports = {
  'entry.mjs': "import './gate.mjs';\nimport('./lazy.mjs');\nthrow new Error('must not execute');\n",
  'gate.mjs': "import './left.mjs';\nimport './right.mjs';\n",
  'left.mjs': "import './join.mjs';\n",
  'right.mjs': "import './join.mjs';\n",
  'join.mjs': "import './leaf.mjs';\n",
  'leaf.mjs': '',
  'lazy.mjs': '',
};
const edges = [
  ['entry.mjs', './gate.mjs', 'eager', 'gate.mjs'],
  ['entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'],
  ['gate.mjs', './left.mjs', 'eager', 'left.mjs'],
  ['gate.mjs', './right.mjs', 'eager', 'right.mjs'],
  ['join.mjs', './leaf.mjs', 'eager', 'leaf.mjs'],
  ['left.mjs', './join.mjs', 'eager', 'join.mjs'],
  ['right.mjs', './join.mjs', 'eager', 'join.mjs'],
].map(([from, specifier, kind, to]) => ({ from, specifier, kind, to }));

test('scanner refreshes source bytes while dominators remain stable across A B C A', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dominators-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const variants = ["// A\nconst text = 'a';\n", "// longer ASCII comment\nconst text = 'longer';\n", "// \u00e9\u6f22\nconst text = '\ud83d\ude00';\n\n", "// A\nconst text = 'a';\n"];
  let firstOutput, firstReport;
  for (const [index, suffix] of variants.entries()) {
    const sources = Object.fromEntries(Object.entries(imports).map(([name, source]) => [name, source + suffix]));
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(root, name), source);
    const scanned = invoke(scanner, join(root, 'entry.mjs'));
    const report = JSON.parse(scanned);
    const expectedModules = Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, source]) => ({ path, bytes: Buffer.byteLength(source), eager: path !== 'lazy.mjs' }));
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.modules, expectedModules);
    assert.deepEqual(report.edges, edges);
    const reportPath = join(root, `report-${index}.json`);
    writeFileSync(reportPath, scanned);
    if (index === 0) firstReport = scanned;
    else assert.equal(readFileSync(join(root, 'report-0.json'), 'utf8'), firstReport);
    const output = invoke(consumer, reportPath, 'leaf.mjs');
    assert.equal(output, JSON.stringify({ entry: 'entry.mjs', target: 'leaf.mjs', dominators: ['entry.mjs', 'gate.mjs', 'join.mjs', 'leaf.mjs'] }) + '\n');
    if (index === 0) firstOutput = output;
    if (index === 3) assert.equal(output, firstOutput);
  }
});
