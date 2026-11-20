import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-explain.mjs');
const entry = 'import "./a.mjs";\nimport "./b.mjs";\nimport("./target.mjs");\nimport { writeFileSync } from "node:fs";\nwriteFileSync("sentinel", "executed");\nthrow new Error("must not execute");\n';
const linked = 'import "./target.mjs";\n';
const unlinked = 'export {};\n';
const target = 'export const value = 1;\n';
const record = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const a = record('a.mjs', 23), a0 = record('a.mjs', 11);
const b = record('b.mjs', 23), b0 = record('b.mjs', 11);
const e = record('entry.mjs', 177), direct = record('entry.mjs', 200);
const z = record('target.mjs', 24), lazyZ = record('target.mjs', 24, false);
const ea = edge('entry.mjs', './a.mjs', 'eager', 'a.mjs');
const eb = edge('entry.mjs', './b.mjs', 'eager', 'b.mjs');
const ez = edge('entry.mjs', './target.mjs', 'lazy', 'target.mjs');
const ed = edge('entry.mjs', './target.mjs', 'eager', 'target.mjs');
const az = edge('a.mjs', './target.mjs', 'eager', 'target.mjs');
const bz = edge('b.mjs', './target.mjs', 'eager', 'target.mjs');
// All values are fixture constants, not derived from the scanner output.
const states = [
  { files: [entry, linked, linked, target], modules: [a, b, e, z], edges: [az, bz, ea, eb, ez], counts: [4, 4, 5], bytes: [247, 247], heavy: [e, z, a, b], path: ['entry.mjs', 'a.mjs', 'target.mjs'] },
  { files: [entry, unlinked, linked, target], modules: [a0, b, e, z], edges: [bz, ea, eb, ez], counts: [4, 4, 4], bytes: [235, 235], heavy: [e, z, b, a0], path: ['entry.mjs', 'b.mjs', 'target.mjs'] },
  { files: [entry, unlinked, unlinked, target], modules: [a0, b0, e, lazyZ], edges: [ea, eb, ez], counts: [4, 3, 3], bytes: [223, 199], heavy: [e, a0, b0], path: [] },
  { files: [entry + linked, unlinked, unlinked, target], modules: [a0, b0, direct, z], edges: [ea, eb, ed, ez], counts: [4, 4, 4], bytes: [246, 246], heavy: [direct, z, a0, b0], path: ['entry.mjs', 'target.mjs'] },
];
const names = ['entry.mjs', 'a.mjs', 'b.mjs', 'target.mjs'];
function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
}
function run(script, args, cwd, input) {
  return spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
}
test('fresh scanner reports follow source transitions without executing modules', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(scratch, 'explain-source-transition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportFile = join(root, 'report.json');
  for (const [index, state] of states.entries()) {
    names.forEach((name, i) => writeFileSync(join(root, name), state.files[i]));
    // Repeat the changed state in the same directory to catch stale reports.
    for (let repeat = 0; repeat < (index === 1 ? 2 : 1); repeat++) {
      const scan = run(scanner, [join(root, names[0])], root);
      success(scan);
      const expected = { entry: 'entry.mjs', modules: state.modules, edges: state.edges, unknown: [], counts: { modules: state.counts[0], eagerModules: state.counts[1], edges: state.counts[2] }, bytes: { total: state.bytes[0], eager: state.bytes[1] }, heaviestEager: state.heavy };
      assert.deepEqual(JSON.parse(scan.stdout), expected, `scanner state ${index} repeat ${repeat}`);
      writeFileSync(reportFile, scan.stdout);
      const explained = run(consumer, [reportFile, 'target.mjs'], root);
      success(explained);
      assert.deepEqual(JSON.parse(explained.stdout), { entry: 'entry.mjs', target: 'target.mjs', reachable: state.path.length > 0, path: state.path }, `explain state ${index} repeat ${repeat}`);
      assert.equal(readFileSync(reportFile, 'utf8'), scan.stdout);
      names.forEach((name, i) => assert.equal(readFileSync(join(root, name), 'utf8'), state.files[i]));
      assert.equal(existsSync(join(root, 'sentinel')), false);
    }
  }
});
