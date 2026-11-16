import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_CRITICAL_PATH_CLI || fileURLToPath(new URL('./import-report-critical-path.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const bytes = source => Buffer.byteLength(source, 'utf8');
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function scan(dir) {
  const result = run(scanner, [join(dir, 'entry.mjs')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return { text: result.stdout, report: JSON.parse(result.stdout) };
}
function checkConsumer(input, expected) {
  const result = run(consumer, [], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

test('scanner pipeline weighs eager branches without executing fixture modules', t => {
  const dir = mkdtempSync(join(scratch, 'critical-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
  const sources = {
    'entry.mjs': "import './a.mjs';\nimport './b.mjs';\nimport('./leaf.mjs');\nimport('./lazy.mjs');\nimport 'external-package';\n" + guard,
    'a.mjs': "import './leaf.mjs';\n// éééééééééé\n" + guard,
    'b.mjs': "import './leaf.mjs';\n" + guard,
    'leaf.mjs': 'export const leaf = 1;\n' + guard,
    'lazy.mjs': '// ' + 'x'.repeat(4000) + '\n' + guard,
  };
  const edges = [
    edge('a.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
    edge('b.mjs', './leaf.mjs', 'eager', 'leaf.mjs'),
    edge('entry.mjs', './a.mjs', 'eager', 'a.mjs'),
    edge('entry.mjs', './b.mjs', 'eager', 'b.mjs'),
    edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
    edge('entry.mjs', './leaf.mjs', 'lazy', 'leaf.mjs'),
    edge('entry.mjs', 'external-package', 'eager', null),
  ];
  function checkScanner(report) {
    const modules = ['a.mjs', 'b.mjs', 'entry.mjs', 'lazy.mjs', 'leaf.mjs'].map(path => ({ path, bytes: bytes(sources[path]), eager: path !== 'lazy.mjs' }));
    const eager = modules.filter(m => m.eager);
    assert.deepEqual(report, {
      entry: 'entry.mjs', modules, edges, unknown: [edges[6]],
      counts: { modules: 5, eagerModules: 4, edges: 7 },
      bytes: { total: modules.reduce((n, m) => n + m.bytes, 0), eager: eager.reduce((n, m) => n + m.bytes, 0) },
      heaviestEager: [...eager].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)),
    });
  }
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  let result = scan(dir);
  checkScanner(result.report);
  checkConsumer(result.text, { entry: 'entry.mjs', paths: ['entry.mjs', 'a.mjs', 'leaf.mjs'], bytes: bytes(sources['entry.mjs']) + bytes(sources['a.mjs']) + bytes(sources['leaf.mjs']) });
  assert.equal(existsSync(sentinel), false);
  sources['b.mjs'] += '// ' + 'x'.repeat(100) + '\n';
  writeFileSync(join(dir, 'b.mjs'), sources['b.mjs']);
  result = scan(dir);
  checkScanner(result.report);
  checkConsumer(result.text, { entry: 'entry.mjs', paths: ['entry.mjs', 'b.mjs', 'leaf.mjs'], bytes: bytes(sources['entry.mjs']) + bytes(sources['b.mjs']) + bytes(sources['leaf.mjs']) });
  assert.equal(existsSync(sentinel), false);
});

test('scanner pipeline rejects a reachable eager cycle without executing it', t => {
  const dir = mkdtempSync(join(scratch, 'critical-cycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
  const entry = "import './cycle.mjs';\n" + guard;
  const cycle = "import './entry.mjs';\n" + guard;
  writeFileSync(join(dir, 'entry.mjs'), entry);
  writeFileSync(join(dir, 'cycle.mjs'), cycle);
  const result = scan(dir);
  const modules = [{ path: 'cycle.mjs', bytes: bytes(cycle), eager: true }, { path: 'entry.mjs', bytes: bytes(entry), eager: true }];
  assert.deepEqual(result.report, {
    entry: 'entry.mjs', modules,
    edges: [edge('cycle.mjs', './entry.mjs', 'eager', 'entry.mjs'), edge('entry.mjs', './cycle.mjs', 'eager', 'cycle.mjs')],
    unknown: [], counts: { modules: 2, eagerModules: 2, edges: 2 },
    bytes: { total: bytes(entry) + bytes(cycle), eager: bytes(entry) + bytes(cycle) },
    heaviestEager: modules,
  });
  const failure = run(consumer, [], result.text);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(failure.stderr, 'graph\n');
  assert.equal(existsSync(sentinel), false);
});
