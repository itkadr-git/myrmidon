import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-subgraph.mjs');
const entrySource = 'import "./root.js";\n';
const leafSource = 'export {};\n';
const suffix = 'import("./lazy.js");\nimport "missing-pkg";\nimport { writeFileSync } from "node:fs";\nwriteFileSync("sentinel", "x");\nthrow new Error("executed");\n';
const sources = [
  'import "./branch.js";\n' + suffix,
  'import("./branch.js");\n' + suffix,
  suffix,
];
const branchEager = { from: 'root.js', specifier: './branch.js', kind: 'eager', to: 'branch.js' };
const branchLazy = { from: 'root.js', specifier: './branch.js', kind: 'lazy', to: 'branch.js' };
const lazy = { from: 'root.js', specifier: './lazy.js', kind: 'lazy', to: 'lazy.js' };
const unknown = { from: 'root.js', specifier: 'missing-pkg', kind: 'eager', to: null };
// These are independent expectations for static, dynamic, and removed imports.
const expected = [
  [
    { root: 'root.js', mode: 'eager', modules: [{ path: 'branch.js', bytes: 11, eager: true }, { path: 'root.js', bytes: 167, eager: true }], edges: [branchEager, unknown], unknown: [unknown] },
    { root: 'root.js', mode: 'all', modules: [{ path: 'branch.js', bytes: 11, eager: true }, { path: 'lazy.js', bytes: 11, eager: false }, { path: 'root.js', bytes: 167, eager: true }], edges: [branchEager, lazy, unknown], unknown: [unknown] },
  ],
  [
    { root: 'root.js', mode: 'eager', modules: [{ path: 'root.js', bytes: 168, eager: true }], edges: [unknown], unknown: [unknown] },
    { root: 'root.js', mode: 'all', modules: [{ path: 'branch.js', bytes: 11, eager: false }, { path: 'lazy.js', bytes: 11, eager: false }, { path: 'root.js', bytes: 168, eager: true }], edges: [branchLazy, lazy, unknown], unknown: [unknown] },
  ],
  [
    { root: 'root.js', mode: 'eager', modules: [{ path: 'root.js', bytes: 145, eager: true }], edges: [unknown], unknown: [unknown] },
    { root: 'root.js', mode: 'all', modules: [{ path: 'lazy.js', bytes: 11, eager: false }, { path: 'root.js', bytes: 145, eager: true }], edges: [lazy, unknown], unknown: [unknown] },
  ],
];

function run(cwd, args, input) {
  const result = spawnSync(process.execPath, args, { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('rescans source transitions and projects the fresh report without executing fixtures', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-transition-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const files = { 'entry.js': entrySource, 'branch.js': leafSource, 'lazy.js': leafSource };
  for (const [name, source] of Object.entries(files)) writeFileSync(join(tmp, name), source);
  const reportPath = join(tmp, 'report.json');
  for (let state = 0; state < sources.length; state++) {
    files['root.js'] = sources[state];
    writeFileSync(join(tmp, 'root.js'), files['root.js']);
    // Scan twice in the same directory so no previous report can be reused.
    for (let repeat = 0; repeat < 2; repeat++) {
      const scan = run(tmp, [scanner, join(tmp, 'entry.js')]);
      writeFileSync(reportPath, scan);
      for (const [index, mode] of ['eager', 'all'].entries()) {
        const fileOutput = run(tmp, [consumer, reportPath, 'root.js', mode]);
        const stdinOutput = run(tmp, [consumer, '-', 'root.js', mode], scan);
        assert.deepEqual(JSON.parse(fileOutput), expected[state][index], `state ${state} ${mode} file`);
        assert.deepEqual(JSON.parse(stdinOutput), expected[state][index], `state ${state} ${mode} stdin`);
      }
      assert.equal(readFileSync(reportPath, 'utf8'), scan);
      for (const [name, source] of Object.entries(files)) assert.equal(readFileSync(join(tmp, name), 'utf8'), source);
      assert.equal(existsSync(join(tmp, 'sentinel')), false);
    }
  }
});
