import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
const marker = "throw new Error('source must not execute');\n";
const sources = (removed, shared, lazy) => ({
  'entry.mjs': "import './removed.mjs';\nimport './retained.mjs';\nimport('./lazy.mjs');\n" + marker,
  'removed.mjs': "import './shared.mjs';\n" + marker + `// ${removed}\n`,
  'retained.mjs': "import './shared.mjs';\n" + marker,
  'shared.mjs': marker + `const value = '${shared}';\n`,
  'lazy.mjs': marker + `/* ${lazy} */\n`,
});

test('fresh source bytes flow through scanner and lazy impact across A B C A', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-source-refresh');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'fixture-'));
  try {
    const a = sources('a', 'a', 'a');
    const states = [a, sources('longer ascii removed', 'longer ascii shared', 'longer ascii lazy'), sources('\u00e9\u6f22\nsecond line', '\u732b\u00e9', '\u2603\nnew line'), a];
    let topology, originalOutput;
    for (const [index, files] of states.entries()) {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const scan = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(scan.status, 0, scan.stderr);
      assert.equal(scan.stderr, '');
      const report = JSON.parse(scan.stdout);
      const shape = { entry: report.entry, edges: report.edges, modules: report.modules.map(({ path, eager }) => ({ path, eager })) };
      if (index === 0) topology = shape;
      else assert.deepEqual(shape, topology);
      assert.deepEqual(report.modules.map(({ path, bytes }) => [path, bytes]), Object.keys(files).sort().map(path => [path, Buffer.byteLength(files[path])]));
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, scan.stdout);
      const result = run(consumer, [reportFile, 'entry.mjs', './removed.mjs']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const size = name => Buffer.byteLength(files[name]);
      const retained = size('entry.mjs') + size('retained.mjs') + size('shared.mjs');
      const expected = { entry: 'entry.mjs', selected: { from: 'entry.mjs', specifier: './removed.mjs', to: 'removed.mjs' }, before: { modules: 4, bytes: retained + size('removed.mjs') }, after: { modules: 3, bytes: retained }, removedPaths: ['removed.mjs'], savedBytes: size('removed.mjs') };
      assert.equal(result.stdout, JSON.stringify(expected) + '\n');
      assert.equal(readFileSync(reportFile, 'utf8'), scan.stdout);
      if (index === 0) originalOutput = result.stdout;
      if (index === 3) assert.equal(result.stdout, originalOutput);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
