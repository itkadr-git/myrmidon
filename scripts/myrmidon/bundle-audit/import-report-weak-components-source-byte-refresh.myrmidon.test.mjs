import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-weak-components.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('fresh source bytes update weak components without changing topology', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'weak-byte-refresh');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  mkdirSync(source);
  const base = {
    'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nthrow new Error('fixture executed');\n",
    'left.mjs': "import './leaf.mjs';\nthrow new Error('fixture executed');\n",
    'right.mjs': "import './leaf.mjs';\nthrow new Error('fixture executed');\n",
    'leaf.mjs': "throw new Error('fixture executed');\n// leaf\n",
    'lazy.mjs': "throw new Error('fixture executed');\n// lazy\n",
  };
  const b = { ...base, 'leaf.mjs': base['leaf.mjs'] + '// longer ASCII leaf\n' };
  const c = { ...b, 'lazy.mjs': base['lazy.mjs'] + '// \u00e9\u732b\n\n' };
  const eager = ['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs'];
  const all = ['entry.mjs', 'lazy.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs'];
  const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
  const edges = [edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'), edge('entry.mjs', './left.mjs', 'eager', 'left.mjs'), edge('entry.mjs', './right.mjs', 'eager', 'right.mjs'), edge('left.mjs', './leaf.mjs', 'eager', 'leaf.mjs'), edge('right.mjs', './leaf.mjs', 'eager', 'leaf.mjs')];
  const component = (paths, files) => ({ id: paths[0], paths, bytes: paths.reduce((sum, path) => sum + Buffer.byteLength(files[path]), 0) });
  const expected = (mode, files) => ({ entry: 'entry.mjs', components: mode === 'eager' ? [component(eager, files), component(['lazy.mjs'], files)] : [component(all, files)] });
  const checkConsumer = (output, files) => {
    for (const mode of ['eager', 'all']) {
      assert.deepEqual(JSON.parse(run(consumer, [mode], dir, output)), expected(mode, files), mode);
    }
  };
  const scan = files => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(source, path), text);
    const output = run(scanner, [join(source, 'entry.mjs')], dir);
    const report = JSON.parse(output);
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.edges, edges);
    assert.deepEqual(report.unknown, []);
    assert.deepEqual(report.modules, all.map(path => ({ path, bytes: Buffer.byteLength(files[path]), eager: path !== 'lazy.mjs' })), 'scanner source-byte freshness');
    checkConsumer(output, files);
    return output;
  };
  const a = scan(base);
  const freshB = scan(b);
  checkConsumer(a, base);
  checkConsumer(freshB, b);
  scan(c);
  assert.equal(scan(base), a);
});
