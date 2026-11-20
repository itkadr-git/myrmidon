import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_FANOUT_TEST_CLI || fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  const parsed = JSON.parse(result.stdout);
  return { parsed, stdout: result.stdout };
}

test('scanner feeds distinct eager targets and bytes to fan-out without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'fanout-integration-'));
  try {
    const sentinel = join(dir, 'executed');
    const danger = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const a = 'export const a = 1;\n';
    const b = 'export const b = 2;\n';
    const lazy = 'export const lazy = 3;\n';
    const entry = dynamic => `import './a';\nimport './a.mjs';\n${dynamic ? "import('./b.mjs');" : "import './b.mjs';"}\nimport('./lazy.mjs');\nimport 'unresolved-external';\n${danger}`;
    writeFileSync(join(dir, 'a.mjs'), a);
    writeFileSync(join(dir, 'b.mjs'), b);
    writeFileSync(join(dir, 'lazy.mjs'), lazy);
    for (const dynamic of [false, true]) {
      const source = entry(dynamic);
      writeFileSync(join(dir, 'entry.mjs'), source);
      const scanned = run(scanner, [join(dir, 'entry.mjs')]);
      assert.deepEqual(scanned.parsed.modules, [
        { path: 'a.mjs', bytes: Buffer.byteLength(a), eager: true },
        { path: 'b.mjs', bytes: Buffer.byteLength(b), eager: !dynamic },
        { path: 'entry.mjs', bytes: Buffer.byteLength(source), eager: true },
        { path: 'lazy.mjs', bytes: Buffer.byteLength(lazy), eager: false },
      ]);
      const edges = [
        { from: 'entry.mjs', specifier: './a', kind: 'eager', to: 'a.mjs' },
        { from: 'entry.mjs', specifier: './a.mjs', kind: 'eager', to: 'a.mjs' },
        { from: 'entry.mjs', specifier: './b.mjs', kind: dynamic ? 'lazy' : 'eager', to: 'b.mjs' },
        { from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' },
        { from: 'entry.mjs', specifier: 'unresolved-external', kind: 'eager', to: null },
      ];
      assert.equal(scanned.parsed.entry, 'entry.mjs');
      assert.deepEqual(scanned.parsed.edges, edges);
      assert.deepEqual(scanned.parsed.unknown, [edges[4]]);
      assert.deepEqual(scanned.parsed.counts, { modules: 4, eagerModules: dynamic ? 2 : 3, edges: 5 });
      const entryBytes = Buffer.byteLength(source);
      const aBytes = Buffer.byteLength(a);
      const bBytes = Buffer.byteLength(b);
      const lazyBytes = Buffer.byteLength(lazy);
      assert.deepEqual(scanned.parsed.bytes, { total: entryBytes + aBytes + bBytes + lazyBytes, eager: entryBytes + aBytes + (dynamic ? 0 : bBytes) });
      assert.deepEqual(scanned.parsed.heaviestEager, [
        { path: 'entry.mjs', bytes: entryBytes, eager: true },
        { path: 'a.mjs', bytes: aBytes, eager: true },
        ...(!dynamic ? [{ path: 'b.mjs', bytes: bBytes, eager: true }] : []),
      ]);
      assert.deepEqual(Object.keys(scanned.parsed).sort(), ['bytes', 'counts', 'edges', 'entry', 'heaviestEager', 'modules', 'unknown']);
      const expected = { entry: 'entry.mjs', modules: [
        { path: 'entry.mjs', bytes: Buffer.byteLength(source), targets: dynamic ? ['a.mjs'] : ['a.mjs', 'b.mjs'], fanOut: dynamic ? 1 : 2 },
        { path: 'a.mjs', bytes: Buffer.byteLength(a), targets: [], fanOut: 0 },
        { path: 'b.mjs', bytes: Buffer.byteLength(b), targets: [], fanOut: 0 },
        { path: 'lazy.mjs', bytes: Buffer.byteLength(lazy), targets: [], fanOut: 0 },
      ] };
      const result = run(consumer, [], scanned.stdout);
      assert.deepEqual(result.parsed, expected);
      assert.equal(run(consumer, [], scanned.stdout).stdout, result.stdout);
      assert.equal(existsSync(sentinel), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
