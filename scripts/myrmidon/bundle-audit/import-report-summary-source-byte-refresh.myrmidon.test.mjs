import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const invoke = (script, args = [], input) => {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

function sources(left, right, lazy, suffix = '') {
  return {
    'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nthrow new Error('SOURCE_EXECUTED');\n",
    'left.mjs': `import './leaf.mjs';\n// ${left}\n`,
    'right.mjs': `import './leaf.mjs';\n// ${right}\n`,
    'leaf.mjs': `export const value = 'leaf';\n${suffix}`,
    'lazy.mjs': `export const value = '${lazy}';\n`,
  };
}

function expected(source) {
  const sizes = Object.fromEntries(Object.entries(source).map(([path, text]) => [path, Buffer.byteLength(text)]));
  const eager = ['entry.mjs', 'left.mjs', 'right.mjs', 'leaf.mjs'];
  const sorted = [...eager].sort((a, b) => sizes[b] - sizes[a] || (a < b ? -1 : a > b ? 1 : 0));
  return [
    '## Import report summary', '', 'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |', '| modules | 5 |', '| eagerModules | 4 |',
    `| totalBytes | ${Object.values(sizes).reduce((a, b) => a + b, 0)} |`,
    `| eagerBytes | ${eager.reduce((n, path) => n + sizes[path], 0)} |`, '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
    ...sorted.map(path => `| ${path} | ${sizes[path]} |`), '',
    '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |', '', 'Omitted: 0', '',
  ].join('\n');
}

test('refreshes source bytes across A B C A without changing the graph or executing source', () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'summary-byte-refresh-'));
  try {
    const a = sources('a'.repeat(180), 'b'.repeat(100), 'small');
    const b = sources('a'.repeat(100), 'b'.repeat(200), 'larger lazy value');
    const c = sources('a'.repeat(100), 'b'.repeat(200), '\u00e9\u732b', '\n');
    const edges = [
      { from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' },
      { from: 'entry.mjs', specifier: './left.mjs', kind: 'eager', to: 'left.mjs' },
      { from: 'entry.mjs', specifier: './right.mjs', kind: 'eager', to: 'right.mjs' },
      { from: 'left.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
      { from: 'right.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    ];
    let initial;
    for (const [index, source] of [a, b, c, a].entries()) {
      for (const [name, text] of Object.entries(source)) writeFileSync(join(dir, name), text);
      const json = invoke(scanner, [join(dir, 'entry.mjs')]);
      const report = JSON.parse(json);
      assert.equal(report.entry, 'entry.mjs');
      assert.deepEqual(report.edges, edges);
      assert.deepEqual(report.modules, Object.keys(source).sort().map(path => ({ path, bytes: Buffer.byteLength(source[path]), eager: path !== 'lazy.mjs' })));
      const output = invoke(consumer, [], json);
      assert.equal(output, expected(source));
      if (index === 0) initial = output;
      if (index === 3) assert.equal(output, initial);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
