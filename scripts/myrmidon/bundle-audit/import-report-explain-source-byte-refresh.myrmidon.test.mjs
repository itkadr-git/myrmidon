import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [join(dir, script), ...args], { encoding: 'utf8', timeout: 10000 });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const edges = [
  edge('a.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
  edge('b.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
  edge('entry.mjs', './a.mjs', 'eager', 'a.mjs'),
  edge('entry.mjs', './b.mjs', 'eager', 'b.mjs'),
  edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
];

function sources(value, comment) {
  return {
    'entry.mjs': `import './b.mjs';\nimport './a.mjs';\nimport('./lazy.mjs');\nthrow new Error('must not execute');\n// ${comment}\n`,
    'a.mjs': `import './leaf.mjs';\nexport const a = '${value}';\n`,
    'b.mjs': `import './leaf.mjs';\n// ${comment}\n`,
    'leaf.mjs': `export const leaf = '${value}';\n`,
    'lazy.mjs': `export const lazy = '${value}';\n`,
  };
}
function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
}
function expectedReport(source) {
  const modules = Object.keys(source).sort().map(path => ({ path, bytes: Buffer.byteLength(source[path]), eager: path !== 'lazy.mjs' }));
  const eager = modules.filter(m => m.eager);
  return {
    entry: 'entry.mjs', modules, edges, unknown: [],
    counts: { modules: 5, eagerModules: 4, edges: 5 },
    bytes: { total: modules.reduce((n, m) => n + m.bytes, 0), eager: eager.reduce((n, m) => n + m.bytes, 0) },
    heaviestEager: [...eager].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

test('scanner refreshes source bytes while explain paths stay stable across A B C A', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'explain-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const states = [sources('a', 'small'), sources('longer ascii', 'expanded ascii'), sources('\u00e9\u6f22', 'multibyte\u03bb\n// extra line'), sources('a', 'small')];
  let firstReport, firstOutputs;
  for (const [index, source] of states.entries()) {
    for (const [path, text] of Object.entries(source)) writeFileSync(join(root, path), text);
    const scan = run('import-budget.mjs', [join(root, 'entry.mjs')]);
    success(scan);
    const report = JSON.parse(scan.stdout);
    assert.deepEqual(report.modules.map(({ path, bytes }) => [path, bytes]), Object.entries(source).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, text]) => [path, Buffer.byteLength(text)]));
    assert.equal(scan.stdout, JSON.stringify(expectedReport(source), null, 2) + '\n');
    const reportPath = join(root, `report-${index}.json`);
    writeFileSync(reportPath, scan.stdout);
    const outputs = [];
    for (const [target, reachable, path] of [['leaf.mjs', true, ['entry.mjs', 'a.mjs', 'leaf.mjs']], ['lazy.mjs', false, []]]) {
      const result = run('import-report-explain.mjs', [reportPath, target]);
      success(result);
      assert.equal(result.stdout, JSON.stringify({ entry: 'entry.mjs', target, reachable, path }) + '\n');
      outputs.push(result.stdout);
    }
    if (index === 0) { firstReport = scan.stdout; firstOutputs = outputs; }
    if (index === 3) { assert.equal(scan.stdout, firstReport); assert.deepEqual(outputs, firstOutputs); }
    assert.equal(readFileSync(join(root, 'report-0.json'), 'utf8'), firstReport);
  }
});
