import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-critical-path.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const bytes = source => Buffer.byteLength(source, 'utf8');

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('fresh source bytes change the critical path without changing the graph', t => {
  const dir = mkdtempSync(join(scratch, 'critical-byte-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
  const base = "import './leaf.mjs';\n" + guard;
  const states = [
    { a: base + '// x\n', b: base + '// xxxxxxxxx\n', winner: 'b' },
    { a: base + '// xxxxxxxxxxxxxxxx\n', b: base + '// x\n', winner: 'a' },
    { a: base + '// \u00e9\u00e9\n\n', b: base + '// xxxx\n\n', winner: 'a' },
  ];
  assert.ok(bytes(states[0].a) < bytes(states[0].b));
  assert.ok(bytes(states[1].a) > bytes(states[1].b));
  assert.equal(bytes(states[2].a), bytes(states[2].b));
  const edges = [
    { from: 'a.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'b.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './a.mjs', kind: 'eager', to: 'a.mjs' },
    { from: 'entry.mjs', specifier: './b.mjs', kind: 'eager', to: 'b.mjs' },
  ];
  const sortEdges = list => [...list].sort((x, y) => JSON.stringify([x.from, x.specifier, x.kind, x.to]).localeCompare(JSON.stringify([y.from, y.specifier, y.kind, y.to])));
  let reportA, outputA;
  for (const [index, state] of [states[0], states[1], states[2], states[0]].entries()) {
    const sources = {
      'entry.mjs': "import './a.mjs';\nimport './b.mjs';\n" + guard,
      'a.mjs': state.a,
      'b.mjs': state.b,
      'leaf.mjs': 'export const leaf = 1;\n' + guard,
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
    const text = run(scanner, [join(dir, 'entry.mjs')]);
    const report = JSON.parse(text);
    assert.equal(report.entry, 'entry.mjs');
    assert.deepEqual(report.modules.map(({ path, bytes, eager }) => ({ path, bytes, eager })),
      Object.keys(sources).sort().map(path => ({ path, bytes: bytes(sources[path]), eager: true })), 'scanner freshness');
    assert.deepEqual(sortEdges(report.edges), sortEdges(edges));
    const branch = `${state.winner}.mjs`;
    const expected = { entry: 'entry.mjs', paths: ['entry.mjs', branch, 'leaf.mjs'], bytes: bytes(sources['entry.mjs']) + bytes(sources[branch]) + bytes(sources['leaf.mjs']) };
    const output = run(consumer, [], text);
    assert.equal(output, JSON.stringify(expected) + '\n');
    if (index === 0) { reportA = text; outputA = output; }
    if (index === 1) {
      assert.notEqual(output, outputA);
      assert.equal(run(consumer, [], reportA), outputA);
    }
    if (index === 2) assert.equal(bytes(state.a), bytes(state.b));
    if (index === 3) assert.equal(output, outputA);
    assert.equal(existsSync(sentinel), false);
  }
});
