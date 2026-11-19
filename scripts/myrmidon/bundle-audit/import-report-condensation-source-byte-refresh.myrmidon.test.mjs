import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const imports = {
  'a.mjs': "import './b.mjs';\n",
  'b.mjs': "import './a.mjs';\nimport('./c.mjs');\n",
  'c.mjs': "import './d.mjs';\n",
  'd.mjs': "import './c.mjs';\nimport './a.mjs';\n",
};
const paths = Object.keys(imports);
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const edges = [
  edge('a.mjs', './b.mjs', 'eager', 'b.mjs'),
  edge('b.mjs', './a.mjs', 'eager', 'a.mjs'),
  edge('b.mjs', './c.mjs', 'lazy', 'c.mjs'),
  edge('c.mjs', './d.mjs', 'eager', 'd.mjs'),
  edge('d.mjs', './a.mjs', 'eager', 'a.mjs'),
  edge('d.mjs', './c.mjs', 'eager', 'c.mjs'),
];

function run(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('fresh source bytes reach eager and all condensation across A B C A', () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'condensation-refresh-'));
  try {
    let first;
    for (const payload of ['base', 'longer ascii text', '\u00e9\u6f22\nsecond line', 'base']) {
      const sources = Object.fromEntries(paths.map((path, i) => [path, `${imports[path]}// ${payload} ${i}\nthrow new Error('source must not execute');\n`]));
      for (const path of paths) writeFileSync(join(root, path), sources[path]);
      const reportText = run(scanner, [join(root, 'a.mjs')]);
      const report = JSON.parse(reportText);
      assert.equal(report.entry, 'a.mjs');
      assert.deepEqual(report.edges, edges);
      assert.deepEqual(report.modules.map(({ path, bytes, eager }) => ({ path, bytes, eager })), paths.map((path, i) => ({ path, bytes: Buffer.byteLength(sources[path]), eager: i < 2 })));
      const size = members => members.reduce((sum, path) => sum + Buffer.byteLength(sources[path]), 0);
      const expected = {
        eager: { entry: 'a.mjs', components: [{ id: 'a.mjs', paths: paths.slice(0, 2), bytes: size(paths.slice(0, 2)) }, { id: 'c.mjs', paths: paths.slice(2), bytes: size(paths.slice(2)) }], edges: [{ from: 'c.mjs', to: 'a.mjs' }] },
        all: { entry: 'a.mjs', components: [{ id: 'a.mjs', paths, bytes: size(paths) }], edges: [] },
      };
      const outputs = {};
      for (const mode of ['eager', 'all']) {
        outputs[mode] = run(consumer, [mode], reportText);
        assert.equal(outputs[mode], `${JSON.stringify(expected[mode])}\n`);
      }
      if (!first) first = outputs;
      else if (payload === 'base') assert.deepEqual(outputs, first);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
