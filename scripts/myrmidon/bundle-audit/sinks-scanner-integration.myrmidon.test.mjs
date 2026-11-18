import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_SINKS_TEST_CLI || fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

test('real scanner feeds sinks for a diamond and a newly extended leaf without executing fixtures', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'sinks-integration-'));
  try {
    const sentinel = join(dir, 'executed');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const sources = {
      'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport './terminal.mjs';\nimport 'unresolved-package';\nimport('./lazy.mjs');\n" + trap,
      'left.mjs': "import './shared.mjs';\n" + trap,
      'right.mjs': "import './shared.mjs';\n" + trap,
      'shared.mjs': trap,
      'terminal.mjs': "import 'another-unresolved-package';\n" + trap,
      'lazy.mjs': trap,
      'new-leaf.mjs': trap,
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
    const bytes = name => readFileSync(join(dir, name)).length;
    const pipeline = expected => {
      const scanned = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(existsSync(sentinel), false, 'scanner executed a fixture');
      const consumed = run(consumer, [], scanned.raw);
      assert.equal(existsSync(sentinel), false, 'consumer executed a fixture');
      assert.deepEqual(consumed.json, expected);
      return scanned.json;
    };
    const first = pipeline({ entry: 'entry.mjs', sinks: [
      { path: 'shared.mjs', bytes: bytes('shared.mjs') },
      { path: 'terminal.mjs', bytes: bytes('terminal.mjs') },
    ], sinkBytes: bytes('shared.mjs') + bytes('terminal.mjs') });
    assert.deepEqual(first.modules.map(({ path, eager }) => ({ path, eager })), [
      { path: 'entry.mjs', eager: true }, { path: 'lazy.mjs', eager: false },
      { path: 'left.mjs', eager: true }, { path: 'right.mjs', eager: true },
      { path: 'shared.mjs', eager: true }, { path: 'terminal.mjs', eager: true },
    ]);
    assert.ok(first.edges.some(edge => edge.from === 'entry.mjs' && edge.specifier === 'unresolved-package' && edge.to === null && edge.kind === 'eager'));
    assert.ok(first.edges.some(edge => edge.from === 'terminal.mjs' && edge.specifier === 'another-unresolved-package' && edge.to === null && edge.kind === 'eager'));
    writeFileSync(join(dir, 'shared.mjs'), "import './new-leaf.mjs';\n" + trap);
    pipeline({ entry: 'entry.mjs', sinks: [
      { path: 'new-leaf.mjs', bytes: bytes('new-leaf.mjs') },
      { path: 'terminal.mjs', bytes: bytes('terminal.mjs') },
    ], sinkBytes: bytes('new-leaf.mjs') + bytes('terminal.mjs') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
