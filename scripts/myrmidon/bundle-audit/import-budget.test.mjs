import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-budget.mjs', import.meta.url).pathname;

test('CLI scans nested template expressions without treating strings as syntax', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "const x = `outer ${ { text: '} require(\\\"./fake.mjs\\\")', value: `inner ${require('./child.mjs')}` } }`;\n");
    writeFileSync(join(dir, 'child.mjs'), 'export default 1;');
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(JSON.parse(run.stdout).edges.some(e => e.specifier === './child.mjs' && e.kind === 'eager'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI ignores braces inside regex literals in template expressions', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), 'const x = `outer ${ /}/.test("x") ? require("real-dependency") : 0 }`;');
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown.map(edge => edge.specifier), ['real-dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI ignores braces inside comments in template expressions', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "const x = `value ${ /* } */ require('real-dependency') }`;\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown.map(edge => edge.specifier), ['real-dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI parses braces inside strings in template expressions', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "const x = `value ${ '}' + require('real-dependency') }`;\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown.map(edge => edge.specifier), ['real-dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI ignores regular expressions following return', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "function f() { return /require('fake-package')/; }\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI ignores regex literals after control conditions', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "if (ready) /require('fake-package')/.test(value);\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI ignores regex literals after statement blocks', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), `if (ready) {} /require('fake-package')/.test(value);\n`);
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI sees require after division', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "const x = value / require('dependency') / 2;\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown.map(edge => edge.specifier), ['dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI sees require in division after an object literal', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "const x = {} / require('dependency') / 2;\n");
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).unknown.map(edge => edge.specifier), ['dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI resolves escaped literal specifiers', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), String.raw`import './ch\u0069ld.mjs';`);
    writeFileSync(join(dir, 'child.mjs'), 'export default 1;');
    const run = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).modules.map(m => m.path), ['child.mjs', 'entry.mjs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI reports eager graph, lazy edges, unknowns, and never executes input', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    const put = (name, text) => writeFileSync(join(dir, name), text);
    put('entry.mjs', `import './a.mjs'; import './a.mjs'; export {x} from './b.mjs';
      import('lazy-package'); import('./lazy.mjs'); require('./missing.js');
      import 'node:fs'; import 'uninstalled-package';
      // import './fake1.js';
      const text = "require('./fake2.js')";
      const pattern = /require('.\\/fake-regex.js')/;
      const template = \`text \${require('./template-child.mjs')}\`;
      export const marker = 1
      const from = './fake3.js';
      require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'executed'))}, 'bad');`);
    put('template-child.mjs', 'export default 1;');
    put('a.mjs', "import './entry.mjs'; export const x = 1;");
    put('b.mjs', 'export const x = 2;');
    put('lazy.mjs', "import './lazy-child.mjs';");
    put('lazy-child.mjs', 'export default 1;');
    const run = () => spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, run().stdout);
    const report = JSON.parse(first.stdout);
    assert.equal(existsSync(join(dir, 'executed')), false);
    assert.ok(report.edges.some(e => e.specifier === './template-child.mjs' && e.kind === 'eager'));
    assert.deepEqual(report.modules.filter(m => m.eager).map(m => m.path), ['a.mjs', 'b.mjs', 'entry.mjs', 'template-child.mjs']);
    assert.deepEqual(report.modules.filter(m => !m.eager).map(m => m.path), ['lazy-child.mjs', 'lazy.mjs']);
    assert.equal(report.edges.filter(e => e.from === 'entry.mjs' && e.specifier === './a.mjs').length, 1);
    assert.equal(report.edges.find(e => e.specifier === './lazy.mjs').kind, 'lazy');
    assert.deepEqual(report.unknown.map(e => e.specifier), ['./missing.js', 'lazy-package', 'uninstalled-package']);
    assert.equal(report.counts.eagerModules, 4);
    assert.equal(report.bytes.eager, report.modules.filter(m => m.eager).reduce((n, m) => n + m.bytes, 0));
    assert.equal(report.heaviestEager.length, 4);
    assert.ok(!first.stdout.includes('fake1.js') && !first.stdout.includes('fake2.js'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
