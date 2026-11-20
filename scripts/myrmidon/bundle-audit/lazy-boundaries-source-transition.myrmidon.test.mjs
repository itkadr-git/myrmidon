import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const initial = {
  'entry.mjs': 'import "./a.mjs";\nimport "./b.mjs";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./sentinel", import.meta.url), "executed");\nthrow new Error("executed");\n',
  'a.mjs': 'import("./lazy.mjs");\n',
  'b.mjs': 'import("./lazy.mjs");\n',
  'lazy.mjs': 'import("./deep.mjs");\n',
  'deep.mjs': 'export default 1;\n',
};
const staticPath = 'import "./lazy.mjs";\n';
const mod = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const a = edge('a.mjs', './lazy.mjs', 'lazy', 'lazy.mjs');
const b = edge('b.mjs', './lazy.mjs', 'lazy', 'lazy.mjs');
const entryA = edge('entry.mjs', './a.mjs', 'eager', 'a.mjs');
const entryB = edge('entry.mjs', './b.mjs', 'eager', 'b.mjs');
const entryLazy = edge('entry.mjs', './lazy.mjs', 'eager', 'lazy.mjs');
const deep = edge('lazy.mjs', './deep.mjs', 'lazy', 'deep.mjs');
const beforeModules = [mod('a.mjs', 22, true), mod('b.mjs', 22, true), mod('deep.mjs', 18, false), mod('entry.mjs', 173, true), mod('lazy.mjs', 22, false)];
const afterModules = [mod('a.mjs', 22, true), mod('b.mjs', 22, true), mod('deep.mjs', 18, false), mod('entry.mjs', 194, true), mod('lazy.mjs', 22, true)];
// Independent, explicit graph and frontier oracle for the two source states.
const before = {
  scan: { entry: 'entry.mjs', modules: beforeModules, edges: [a, b, entryA, entryB, deep], unknown: [], counts: { modules: 5, eagerModules: 3, edges: 5 }, bytes: { total: 257, eager: 217 }, heaviestEager: [beforeModules[3], beforeModules[0], beforeModules[1]] },
  report: { entry: 'entry.mjs', boundaries: [{ from: 'a.mjs', specifier: './lazy.mjs', to: 'lazy.mjs', bytes: 22 }, { from: 'b.mjs', specifier: './lazy.mjs', to: 'lazy.mjs', bytes: 22 }] },
};
const after = {
  scan: { entry: 'entry.mjs', modules: afterModules, edges: [a, b, entryA, entryB, entryLazy, deep], unknown: [], counts: { modules: 5, eagerModules: 4, edges: 6 }, bytes: { total: 278, eager: 260 }, heaviestEager: [afterModules[3], afterModules[0], afterModules[1], afterModules[4]] },
  report: { entry: 'entry.mjs', boundaries: [{ from: 'lazy.mjs', specifier: './deep.mjs', to: 'deep.mjs', bytes: 18 }] },
};

test('fresh scans track lazy frontier across source transitions without executing fixtures', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(initial)) writeFileSync(join(dir, name), contents);
  const entry = join(dir, 'entry.mjs'), reportFile = join(dir, 'report.json');
  function check(sources, expected) {
    const run = (cli, arg) => {
      const result = spawnSync(process.execPath, [cli, arg], { encoding: 'utf8', timeout: 5000, cwd: dir });
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout;
    };
    const scan = run(scanner, entry);
    assert.deepEqual(JSON.parse(scan), expected.scan);
    writeFileSync(reportFile, scan);
    const output = run(consumer, reportFile);
    assert.deepEqual(JSON.parse(output), expected.report);
    assert.equal(readFileSync(reportFile, 'utf8'), scan);
    for (const [name, contents] of Object.entries(sources)) assert.equal(readFileSync(join(dir, name), 'utf8'), contents, name);
    assert.equal(existsSync(join(dir, 'sentinel')), false);
  }
  check(initial, before);
  const changed = { ...initial, 'entry.mjs': staticPath + initial['entry.mjs'] };
  writeFileSync(entry, changed['entry.mjs']);
  check(changed, after);
  check(changed, after);
  writeFileSync(entry, initial['entry.mjs']);
  check(initial, before);
});
