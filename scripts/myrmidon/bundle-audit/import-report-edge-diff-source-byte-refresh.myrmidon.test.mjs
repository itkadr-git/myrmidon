import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const run = (...args) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const edges = [
  edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
  edge('entry.mjs', './left.mjs', 'eager', 'left.mjs'),
  edge('entry.mjs', './right.mjs', 'eager', 'right.mjs'),
  edge('left.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
  edge('right.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
];

function sources(note) {
  return {
    'entry.mjs': `import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nthrow Error('source must not execute');\n/* ${note} */\n`,
    'lazy.mjs': `export const lazy = ${JSON.stringify(note)};\n`,
    'leaf.mjs': `export const leaf = ${JSON.stringify(note)};\n`,
    'left.mjs': `import './leaf.mjs';\n/* ${note} */\n`,
    'right.mjs': `import './leaf.mjs';\n/* ${note} */\n`,
  };
}

test('refreshes source bytes across A B C A without changing edge diff', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baseline = join(dir, 'baseline.json');
  const expected = `${JSON.stringify({ entry: 'entry.mjs', added: [], removed: [] }, null, 2)}\n`;
  let firstOutput;
  let baselineText;
  const states = [sources('a'), sources('longer ASCII'), sources('\u00e9\u6f22\nsecond line'), sources('a')];
  for (const [index, files] of states.entries()) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const scannerText = run(scanner, join(dir, 'entry.mjs'));
    const report = JSON.parse(scannerText);
    const modules = Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), eager: path !== 'lazy.mjs' }));
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.modules, modules, `scanner freshness state ${index}`);
    assert.deepEqual(report.edges, edges, `topology state ${index}`);
    if (index === 0) {
      writeFileSync(baseline, scannerText);
      baselineText = scannerText;
    }
    if (index === 1) {
      const stale = JSON.parse(baselineText);
      assert.throws(() => assert.deepEqual(stale.modules, modules, 'negative control'), /negative control/);
    }
    const current = join(dir, `current-${index}.json`);
    writeFileSync(current, scannerText);
    const output = run(consumer, baseline, current);
    assert.equal(output, expected);
    if (index === 0) firstOutput = output;
    if (index === 3) assert.equal(output, firstOutput);
    assert.equal(readFileSync(baseline, 'utf8'), baselineText);
  }
});
