import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const run = (script, args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};
const marker = "throw new Error('source must not execute');\n";
const sources = value => ({
  'entry.mjs': `import './left.mjs'; import './right.mjs'; import('./lazy.mjs');\n${marker}`,
  'left.mjs': `import './target.mjs';\n/* ${value} */\n${marker}`,
  'right.mjs': `import './target.mjs';\n${marker}`,
  'target.mjs': `import './left.mjs';\nconst text = ${JSON.stringify(value)};\n${marker}`,
  'lazy.mjs': `import './target.mjs';\n/* ${value} */\n${marker}`,
});
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const expectedEdges = [
  edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
  edge('entry.mjs', './left.mjs', 'eager', 'left.mjs'),
  edge('entry.mjs', './right.mjs', 'eager', 'right.mjs'),
  edge('lazy.mjs', './target.mjs', 'eager', 'target.mjs'),
  edge('left.mjs', './target.mjs', 'eager', 'target.mjs'),
  edge('right.mjs', './target.mjs', 'eager', 'target.mjs'),
  edge('target.mjs', './left.mjs', 'eager', 'left.mjs'),
];
const expectedOutput = `${JSON.stringify({ entry: 'entry.mjs', target: 'target.mjs', importers: [
  { path: 'lazy.mjs', distance: 1 }, { path: 'left.mjs', distance: 1 },
  { path: 'right.mjs', distance: 1 }, { path: 'entry.mjs', distance: 2 },
] })}\n`;

test('reverse impact stays exact while scanner refreshes source bytes A to B to C to A', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-byte-refresh-'));
  try {
    let originalOutput;
    let previousBytes;
    for (const value of ['a', 'longer ASCII', '\u00e9\u6f22\nline', 'a']) {
      const files = sources(value);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const report = JSON.parse(run(scanner, [join(dir, 'entry.mjs')]));
      const expectedModules = Object.keys(files).sort().map(path => ({ path, bytes: Buffer.byteLength(files[path]), eager: path !== 'lazy.mjs' }));
      assert.equal(report.entry, 'entry.mjs');
      assert.deepEqual(report.edges, expectedEdges);
      assert.deepEqual(report.modules, expectedModules);
      assert.deepEqual(report.bytes, {
        total: expectedModules.reduce((sum, mod) => sum + mod.bytes, 0),
        eager: expectedModules.filter(mod => mod.eager).reduce((sum, mod) => sum + mod.bytes, 0),
      });
      const currentBytes = expectedModules.map(mod => mod.bytes);
      if (previousBytes) assert.notDeepEqual(currentBytes, previousBytes);
      previousBytes = currentBytes;
      const file = join(dir, 'report.json');
      writeFileSync(file, JSON.stringify(report));
      const output = run(consumer, [file, 'target.mjs']);
      assert.equal(output, expectedOutput);
      if (originalOutput === undefined) originalOutput = output;
      else assert.equal(output, originalOutput);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
