import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('source bytes refresh across A B C A without changing redundant edges', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'redundant-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
  const base = {
    'entry.mjs': "import './mid.mjs';\nimport './leaf.mjs';\nimport('./lazy.mjs');\n",
    'mid.mjs': "import './leaf.mjs';\n",
    'leaf.mjs': '',
    'lazy.mjs': '',
  };
  const states = [
    ['', '', '', ''],
    ['// entry ascii\n', "const word = 'longer ascii';\n", '// leaf ascii\n', '// lazy ascii\n'],
    ['// \u00e9\u96ea\n\n', "const word = '\u96ea\u00e9';\n\n", '// \u96ea\n\n', '// \u00e9\n\n'],
    ['', '', '', ''],
  ];
  const edges = [
    { from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' },
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './mid.mjs', kind: 'eager', to: 'mid.mjs' },
    { from: 'mid.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
  ];
  const expected = { entry: 'entry.mjs', redundant: [
    { from: 'entry.mjs', specifier: './leaf.mjs', to: 'leaf.mjs', alternativePath: ['entry.mjs', 'mid.mjs', 'leaf.mjs'] },
  ] };
  const expectedRaw = `${JSON.stringify(expected)}\n`;
  let savedA;
  for (const [index, additions] of states.entries()) {
    const sources = Object.fromEntries(Object.entries(base).map(([name, source], i) => [name, source + additions[i] + guard]));
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
    const raw = run(scanner, [join(dir, 'entry.mjs')]);
    if (index === 0) savedA = raw;
    const report = JSON.parse(raw);
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.edges, edges);
    assert.deepEqual(report.modules, Object.keys(sources).sort().map(path => ({
      path, bytes: Buffer.byteLength(sources[path]), eager: path !== 'lazy.mjs',
    })), `scanner freshness state ${index}`);
    assert.equal(existsSync(sentinel), false);
    assert.equal(run(consumer, [], raw), expectedRaw);
    if (index === 1) assert.equal(run(consumer, [], savedA), expectedRaw);
    assert.equal(existsSync(sentinel), false);
  }
});
