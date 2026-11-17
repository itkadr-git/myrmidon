import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(process.env.HOME, '.cache');
const run = (script, arg) => {
  const result = spawnSync(process.execPath, [join(dir, script), arg], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('fresh scanner bytes preserve cycle output across A B C A', t => {
  const root = mkdtempSync(join(scratch, 'cycles-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = (scc, lazy) => ({
    'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nthrow new Error('must not execute');\n",
    'left.mjs': `import './leaf.mjs';\nimport './right.mjs';\nconst text = '${scc}';\n`,
    'right.mjs': "import './leaf.mjs';\nimport './left.mjs';\n",
    'leaf.mjs': "export const leaf = true;\n",
    'lazy.mjs': `// ${lazy}\nexport const lazy = true;\n`,
  });
  const expectedEdges = [
    ['entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'],
    ['entry.mjs', './left.mjs', 'eager', 'left.mjs'],
    ['entry.mjs', './right.mjs', 'eager', 'right.mjs'],
    ['left.mjs', './leaf.mjs', 'eager', 'leaf.mjs'],
    ['left.mjs', './right.mjs', 'eager', 'right.mjs'],
    ['right.mjs', './leaf.mjs', 'eager', 'leaf.mjs'],
    ['right.mjs', './left.mjs', 'eager', 'left.mjs'],
  ];
  const expected = JSON.stringify({ entry: 'entry.mjs', eagerCycles: [['left.mjs', 'right.mjs']], allCycles: [['left.mjs', 'right.mjs']] }) + '\n';
  const states = [sources('a', 'a'), sources('longer ascii', 'more ascii'), sources('\u00e9\u6f22', '\u00e9\u6f22\nsecond line'), sources('a', 'a')];
  let firstOutput, firstReport;
  for (const [index, files] of states.entries()) {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
    const scan = run('import-budget.mjs', join(root, 'entry.mjs'));
    const report = JSON.parse(scan);
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.edges.map(({ from, specifier, kind, to }) => [from, specifier, kind, to]), expectedEdges);
    assert.deepEqual(report.modules.map(({ path, bytes, eager }) => [path, bytes, eager]), Object.keys(files).sort().map(path => [path, Buffer.byteLength(files[path]), path !== 'lazy.mjs']));
    const reportPath = join(root, `report-${index}.json`);
    writeFileSync(reportPath, scan);
    const output = run('import-report-cycles.mjs', reportPath);
    assert.equal(output, expected);
    assert.equal(readFileSync(reportPath, 'utf8'), scan);
    if (index === 0) { firstOutput = output; firstReport = scan; }
    if (index === 3) { assert.equal(output, firstOutput); assert.equal(scan, firstReport); }
    if (index > 0) assert.equal(readFileSync(join(root, 'report-0.json'), 'utf8'), firstReport);
  }
});
