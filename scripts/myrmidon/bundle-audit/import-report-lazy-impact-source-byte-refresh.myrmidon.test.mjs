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
  'removed.mjs': "import './shared.mjs';\nimport './unique.mjs';\n" + marker,
  'unique.mjs': marker + `// ${removed}\n`,
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
    const states = [a, sources('longer ascii removed', 'a', 'a'), sources('longer ascii removed', '\u732b\u00e9', '\u2603\nnew line'), a];
    let topology, originalOutput;
    const outputs = [];
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
      const reportFile = join(dir, `report-${index}.json`);
      writeFileSync(reportFile, scan.stdout);
      const result = run(consumer, [reportFile, 'entry.mjs', './removed.mjs']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const size = name => Buffer.byteLength(files[name]);
      const retained = size('entry.mjs') + size('retained.mjs') + size('shared.mjs');
      const saved = size('removed.mjs') + size('unique.mjs');
      const expected = { entry: 'entry.mjs', selected: { from: 'entry.mjs', specifier: './removed.mjs', to: 'removed.mjs' }, before: { modules: 5, bytes: retained + saved }, after: { modules: 3, bytes: retained }, removedPaths: ['removed.mjs', 'unique.mjs'], savedBytes: saved };
      assert.equal(result.stdout, JSON.stringify(expected) + '\n');
      assert.equal(readFileSync(reportFile, 'utf8'), scan.stdout);
      outputs.push(expected);
      if (index === 0) originalOutput = result.stdout;
      if (index === 1) {
        const old = run(consumer, [join(dir, 'report-0.json'), 'entry.mjs', './removed.mjs']);
        assert.equal(old.status, 0, old.stderr);
        assert.equal(old.stderr, '');
        assert.equal(old.stdout, originalOutput);
      }
      if (index === 3) assert.equal(result.stdout, originalOutput);
    }
    const uniqueGrowth = Buffer.byteLength(states[1]['unique.mjs']) - Buffer.byteLength(a['unique.mjs']);
    const sharedGrowth = Buffer.byteLength(states[2]['shared.mjs']) - Buffer.byteLength(states[1]['shared.mjs']);
    assert.ok(uniqueGrowth > 0 && sharedGrowth > 0);
    assert.equal(outputs[1].before.bytes - outputs[0].before.bytes, uniqueGrowth);
    assert.equal(outputs[1].after.bytes, outputs[0].after.bytes);
    assert.equal(outputs[1].savedBytes - outputs[0].savedBytes, uniqueGrowth);
    assert.equal(outputs[2].before.bytes - outputs[1].before.bytes, sharedGrowth);
    assert.equal(outputs[2].after.bytes - outputs[1].after.bytes, sharedGrowth);
    assert.equal(outputs[2].savedBytes, outputs[1].savedBytes);
    const lazyOnly = sources('longer ascii removed', 'a', '\u2603\nnew line');
    for (const [name, text] of Object.entries(lazyOnly)) writeFileSync(join(dir, name), text);
    const lazyScan = run(scanner, [join(dir, 'entry.mjs')]);
    assert.equal(lazyScan.status, 0, lazyScan.stderr);
    assert.equal(lazyScan.stderr, '');
    const lazyReport = JSON.parse(lazyScan.stdout);
    assert.deepEqual({ entry: lazyReport.entry, edges: lazyReport.edges, modules: lazyReport.modules.map(({ path, eager }) => ({ path, eager })) }, topology);
    assert.deepEqual(lazyReport.modules.map(({ path, bytes }) => [path, bytes]), Object.keys(lazyOnly).sort().map(path => [path, Buffer.byteLength(lazyOnly[path])]));
    const lazyReportFile = join(dir, 'report-lazy-only.json');
    writeFileSync(lazyReportFile, lazyScan.stdout);
    const lazyResult = run(consumer, [lazyReportFile, 'entry.mjs', './removed.mjs']);
    assert.equal(lazyResult.status, 0, lazyResult.stderr);
    assert.equal(lazyResult.stderr, '');
    assert.equal(lazyResult.stdout, JSON.stringify(outputs[1]) + '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
