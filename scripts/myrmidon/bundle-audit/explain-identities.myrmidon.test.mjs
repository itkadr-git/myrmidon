import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-explain.mjs');
const run = (file, target) => spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 10000 });
const moduleRecord = path => ({ path, bytes: 0, eager: true });
const edge = (from, to, specifier = to) => ({ from, to, kind: 'eager', specifier });
function fixture(t, report) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'explain-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const input = JSON.stringify(report);
  writeFileSync(file, input);
  return { file, input };
}
function expectPath(file, entry, target, path) {
  const result = run(file, target);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { entry, target, reachable: true, path });
}

test('identities remain distinct and lexical ties use code-unit order', t => {
  const ids = ['__proto__', 'constructor', 'node:fs', 'Z', 'a', 'a/b', 'a\\b', 'tab\tname'];
  const edges = [edge('__proto__', 'a'), edge('__proto__', 'Z'), edge('__proto__', 'Z', 'alias-Z'),
    edge('Z', 'constructor'), edge('a', 'constructor'), edge('constructor', 'node:fs'),
    edge('node:fs', 'a/b'), edge('a/b', 'a\\b'), edge('a\\b', 'tab\tname')];
  const paths = [
    ['__proto__', ['__proto__']],
    ['Z', ['__proto__', 'Z']],
    ['a', ['__proto__', 'a']],
    ['constructor', ['__proto__', 'Z', 'constructor']],
    ['node:fs', ['__proto__', 'Z', 'constructor', 'node:fs']],
    ['a/b', ['__proto__', 'Z', 'constructor', 'node:fs', 'a/b']],
    ['a\\b', ['__proto__', 'Z', 'constructor', 'node:fs', 'a/b', 'a\\b']],
    ['tab\tname', ['__proto__', 'Z', 'constructor', 'node:fs', 'a/b', 'a\\b', 'tab\tname']],
  ];
  for (const reverse of [false, true]) {
    const report = { entry: '__proto__', modules: (reverse ? [...ids].reverse() : ids).map(moduleRecord), edges: reverse ? [...edges].reverse() : edges };
    const { file, input } = fixture(t, report);
    for (const [target, path] of paths) expectPath(file, report.entry, target, path);
    assert.equal(readFileSync(file, 'utf8'), input);
  }
});

test('quoted newline identities round-trip and similar missing target is rejected', t => {
  const entry = 'entry "quoted"\nline', target = 'target "quoted"\nline';
  const { file, input } = fixture(t, { entry, modules: [entry, target].map(moduleRecord), edges: [edge(entry, target)] });
  expectPath(file, entry, target, [entry, target]);
  const result = run(file, 'target "quoted"\nline ');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: target\n');
  assert.equal(readFileSync(file, 'utf8'), input);
});
