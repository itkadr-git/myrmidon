import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_CONDENSATION_CLI || fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));

function run(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return result.stdout;
}

test('scanner and condensation preserve cycles, lazy edges and external imports without execution', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'condensation-'));
  try {
    const sentinel = join(dir, 'sentinel');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const entry = `import './a.mjs';\nimport 'external-package';\n${trap}`;
    const a = `import './b.mjs';\n${trap}`;
    const b = `import './a.mjs';\nimport('./entry.mjs');\n${trap}`;
    const bWithoutBackEdge = `import('./entry.mjs');\n${trap}`;
    for (const [name, source] of Object.entries({ 'entry.mjs': entry, 'a.mjs': a, 'b.mjs': b })) writeFileSync(join(dir, name), source);
    const bytes = source => Buffer.byteLength(source);
    const component = (id, paths, size) => ({ id, paths, bytes: size });
    const check = (sourceB, eager, all) => {
      writeFileSync(join(dir, 'b.mjs'), sourceB);
      const report = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(existsSync(sentinel), false, 'scanner executed a fixture');
      for (const [mode, expected] of [['eager', eager], ['all', all]]) {
        const actual = JSON.parse(run(consumer, [mode], report));
        assert.deepEqual(actual, { entry: 'entry.mjs', ...expected });
        assert.equal(existsSync(sentinel), false, 'consumer executed a fixture');
      }
    };
    check(b, {
      components: [component('a.mjs', ['a.mjs', 'b.mjs'], bytes(a) + bytes(b)), component('entry.mjs', ['entry.mjs'], bytes(entry))],
      edges: [{ from: 'entry.mjs', to: 'a.mjs' }],
    }, {
      components: [component('a.mjs', ['a.mjs', 'b.mjs', 'entry.mjs'], bytes(a) + bytes(b) + bytes(entry))],
      edges: [],
    });
    check(bWithoutBackEdge, {
      components: [component('a.mjs', ['a.mjs'], bytes(a)), component('b.mjs', ['b.mjs'], bytes(bWithoutBackEdge)), component('entry.mjs', ['entry.mjs'], bytes(entry))],
      edges: [{ from: 'a.mjs', to: 'b.mjs' }, { from: 'entry.mjs', to: 'a.mjs' }],
    }, {
      components: [component('a.mjs', ['a.mjs', 'b.mjs', 'entry.mjs'], bytes(a) + bytes(bWithoutBackEdge) + bytes(entry))],
      edges: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
