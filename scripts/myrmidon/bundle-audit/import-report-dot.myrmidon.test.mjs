import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
const mod = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const success = (report, expected) => {
  const input = JSON.stringify(report);
  const result = run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
  assert.equal(run(input).stdout, expected);
};

test('single module and empty edges', () => {
  success({ entry: 'a', modules: [mod('a')], edges: [] }, 'digraph imports {\n  n0 [label="a", style=solid];\n  // unresolved: 0\n}\n');
});

test('cycles, parallel edges, lazy, unknown, disconnected and shuffled input', () => {
  const report = { entry: 'a', modules: [mod('z', false), mod('b'), mod('a'), mod('c', false)], edges: [edge('a', 'z', 'lazy', 'c'), edge('b', 'back', 'eager', 'a'), edge('a', 'two', 'eager', 'b'), edge('a', 'one', 'eager', 'b'), edge('a', 'self', 'eager', 'a'), edge('a', 'unknown', 'eager', null)] };
  const expected = 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n2 [label="c", style=dashed];\n  n3 [label="z", style=dashed];\n  n0 -> n1 [label="one", style=solid];\n  n0 -> n0 [label="self", style=solid];\n  n0 -> n1 [label="two", style=solid];\n  n0 -> n2 [label="z", style=dashed];\n  n1 -> n0 [label="back", style=solid];\n  // unresolved: 1\n}\n';
  const original = JSON.stringify(report);
  success(report, expected);
  success({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, expected);
  assert.equal(JSON.stringify(report), original);
});

test('quoted malicious labels remain literal DOT strings', () => {
  success({ entry: 'a" ]; URL="evil\\\n\r\t', modules: [mod('a" ]; URL="evil\\\n\r\t')], edges: [edge('a" ]; URL="evil\\\n\r\t', 'x" ]; URL="bad\\\n\r\t', 'eager', 'a" ]; URL="evil\\\n\r\t')] }, 'digraph imports {\n  n0 [label="a\\" ]; URL=\\"evil\\\\\\n\\n\\t", style=solid];\n  n0 -> n0 [label="x\\" ]; URL=\\"bad\\\\\\n\\n\\t", style=solid];\n  // unresolved: 0\n}\n');
});

test('invalid input fails closed with stable categories', () => {
  const good = { entry: 'a', modules: [mod('a')], edges: [] };
  const cases = [
    ['{', [], 'json'], [JSON.stringify(good), ['arg'], 'argv'],
    ...[null, {}, { ...good, modules: [] }, { ...good, modules: [mod('a'), mod('a')] }, { ...good, modules: [{ ...mod('a'), bytes: -1 }] }, { ...good, modules: [{ ...mod('a'), bytes: 1.5 }] }, { ...good, edges: [edge('a', '\u0000', 'eager', null)] }, { ...good, entry: 'a\u007f' }, { ...good, edges: [edge('a', 'x', 'other', null)] }].map(x => [JSON.stringify(x), [], 'shape']),
    ...[{ ...good, entry: 'b' }, { ...good, edges: [edge('b', '', 'eager', null)] }, { ...good, edges: [edge('a', '', 'eager', 'b')] }, { ...good, edges: [edge('a', '', 'eager', null), edge('a', '', 'eager', null)] }, { ...good, modules: [mod('a', false)] }].map(x => [JSON.stringify(x), [], 'graph'])
  ];
  for (const [input, args, category] of cases) {
    const result = run(input, args);
    assert.equal(result.status, 1, `${category}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  }
});

test('real scanner report renders without executing input', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dot-test-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), `import './a.mjs'; import('./lazy.mjs'); import 'missing-package'; throw new Error('executed');`);
    writeFileSync(join(dir, 'a.mjs'), `import './entry.mjs';`);
    writeFileSync(join(dir, 'lazy.mjs'), 'export default 1;');
    const scan = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(scan.status, 0, scan.stderr);
    assert.equal(existsSync(join(dir, 'executed')), false);
    const dot = run(scan.stdout);
    assert.equal(dot.status, 0, dot.stderr);
    assert.equal(dot.stdout, 'digraph imports {\n  n0 [label="a.mjs", style=solid];\n  n1 [label="entry.mjs", style=solid];\n  n2 [label="lazy.mjs", style=dashed];\n  n0 -> n1 [label="./entry.mjs", style=solid];\n  n1 -> n0 [label="./a.mjs", style=solid];\n  n1 -> n2 [label="./lazy.mjs", style=dashed];\n  // unresolved: 1\n}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
