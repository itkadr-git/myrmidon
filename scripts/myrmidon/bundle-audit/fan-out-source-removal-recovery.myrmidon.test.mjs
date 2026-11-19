import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  JSON.parse(result.stdout);
  return result.stdout;
}

test('fan-out tracks physical source removal and recovery through the scanner CLI', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'fan-out-recovery');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(source); mkdirSync(cwd);
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('executed');\n`;
  const sources = {
    'entry.mjs': `import './leaf';\nimport './leaf.mjs';\nimport './branch.mjs';\nimport('./lazy.mjs');\n${guard}`,
    'branch.mjs': `import './leaf.mjs';\n${guard}// branch padding\n`,
    'leaf.mjs': `${guard}// leaf\n`,
    'lazy.mjs': `${guard}// lazy padding for unique length\n`,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(source, name), text);
  const bytes = name => Buffer.byteLength(sources[name]);
  assert.equal(new Set(Object.keys(sources).map(bytes)).size, Object.keys(sources).length);
  const row = (path, targets) => ({ path, bytes: bytes(path), targets, fanOut: targets.length });
  const expected = present => ({ entry: 'entry.mjs', modules: present ? [
    row('entry.mjs', ['branch.mjs', 'leaf.mjs']),
    row('branch.mjs', ['leaf.mjs']),
    row('lazy.mjs', []), row('leaf.mjs', []),
  ] : [
    row('entry.mjs', ['branch.mjs']),
    row('branch.mjs', []), row('lazy.mjs', []),
  ] });
  const unchanged = present => {
    for (const [name, text] of Object.entries(sources)) {
      if (name === 'leaf.mjs' && !present) assert.equal(existsSync(join(source, name)), false);
      else assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false);
  };
  const scan = present => {
    const raw = run(scanner, [join(source, 'entry.mjs')], cwd);
    unchanged(present);
    return raw;
  };
  const consume = (raw, present) => {
    const output = run(consumer, [], cwd, raw);
    unchanged(present);
    assert.deepEqual(JSON.parse(output), expected(present));
  };

  const original = scan(true);
  consume(original, true);
  unlinkSync(join(source, 'leaf.mjs'));
  const missing = scan(false);
  const report = JSON.parse(missing);
  assert.equal(report.modules.some(m => m.path === 'leaf.mjs'), false);
  const unknown = [
    { from: 'entry.mjs', specifier: './leaf', kind: 'eager', to: null },
    { from: 'branch.mjs', specifier: './leaf.mjs', kind: 'eager', to: null },
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: null },
  ];
  assert.deepEqual(report.unknown, unknown);
  for (const edge of unknown) assert.ok(report.edges.some(actual => JSON.stringify(actual) === JSON.stringify(edge)));
  consume(missing, false);
  writeFileSync(join(source, 'leaf.mjs'), sources['leaf.mjs']);
  const restored = scan(true);
  assert.deepEqual(JSON.parse(restored), JSON.parse(original));
  consume(restored, true);
});
