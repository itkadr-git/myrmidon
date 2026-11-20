import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));

test('CLI resolves competing local candidates and excludes builtins without executing input', (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.myrmidon-test-scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'import-resolution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, content = 'export default 1;') => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const marker = join(dir, 'executed');
  put('entry.mjs', `import './exact'; import './js'; import './mjs'; import './cjs';
import './index-first'; import './index-second'; import './index-third';
import './directory'; import './explicit.mjs'; import './fs.mjs';
import './missing'; import 'example-package';
import 'fs'; import 'node:fs'; import 'fs/promises'; import 'node:fs/promises';
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  for (const name of [
    'exact', 'exact.js', 'exact.mjs', 'exact.cjs',
    'js.js', 'js.mjs', 'js.cjs', 'js/index.js', 'js/index.mjs', 'js/index.cjs',
    'mjs.mjs', 'mjs.cjs', 'mjs/index.js', 'mjs/index.mjs', 'mjs/index.cjs',
    'cjs.cjs', 'cjs/index.js', 'cjs/index.mjs', 'cjs/index.cjs',
    'index-first/index.js', 'index-first/index.mjs', 'index-first/index.cjs',
    'index-second/index.mjs', 'index-second/index.cjs', 'index-third/index.cjs',
    'directory.js', 'directory/index.js', 'explicit.mjs', 'fs.mjs',
    'node_modules/example-package/index.js',
  ]) put(name);
  const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(existsSync(marker), false);
  const report = JSON.parse(run.stdout);
  const edges = [
    { from: 'entry.mjs', specifier: './cjs', kind: 'eager', to: 'cjs.cjs' },
    { from: 'entry.mjs', specifier: './directory', kind: 'eager', to: 'directory.js' },
    { from: 'entry.mjs', specifier: './exact', kind: 'eager', to: 'exact' },
    { from: 'entry.mjs', specifier: './explicit.mjs', kind: 'eager', to: 'explicit.mjs' },
    { from: 'entry.mjs', specifier: './fs.mjs', kind: 'eager', to: 'fs.mjs' },
    { from: 'entry.mjs', specifier: './index-first', kind: 'eager', to: 'index-first/index.js' },
    { from: 'entry.mjs', specifier: './index-second', kind: 'eager', to: 'index-second/index.mjs' },
    { from: 'entry.mjs', specifier: './index-third', kind: 'eager', to: 'index-third/index.cjs' },
    { from: 'entry.mjs', specifier: './js', kind: 'eager', to: 'js.js' },
    { from: 'entry.mjs', specifier: './missing', kind: 'eager', to: null },
    { from: 'entry.mjs', specifier: './mjs', kind: 'eager', to: 'mjs.mjs' },
    { from: 'entry.mjs', specifier: 'example-package', kind: 'eager', to: null },
  ];
  assert.deepEqual(report.edges, edges);
  assert.deepEqual(report.unknown, [edges[9], edges[11]]);
  assert.deepEqual(report.counts, { modules: 11, eagerModules: 11, edges: 12 });
  assert.deepEqual(report.modules.map(module => module.path), [
    'cjs.cjs', 'directory.js', 'entry.mjs', 'exact', 'explicit.mjs', 'fs.mjs',
    'index-first/index.js', 'index-second/index.mjs', 'index-third/index.cjs', 'js.js', 'mjs.mjs',
  ]);
});
