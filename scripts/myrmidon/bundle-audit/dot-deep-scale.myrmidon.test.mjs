import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const count = 12000;
const path = i => `module-${String(i).padStart(5, '0')}.mjs`;

function fixture(withTail) {
  const modules = Array.from({ length: count }, (_, i) => ({ path: path(i), bytes: 0, eager: true }));
  const edges = Array.from({ length: count - 1 }, (_, i) => ({ from: path(i), specifier: 'next', kind: 'eager', to: path(i + 1) }));
  if (withTail) {
    modules.push({ path: 'tail-a.mjs', bytes: 0, eager: false }, { path: 'tail-b.mjs', bytes: 0, eager: false });
    edges.push({ from: 'tail-a.mjs', specifier: 'lazy-next', kind: 'lazy', to: 'tail-b.mjs' });
  }
  return { entry: path(0), modules, edges };
}

function expectedDot(withTail) {
  const lines = ['digraph imports {'];
  for (let i = 0; i < count; i++) lines.push(`  n${i} [label="${path(i)}", style=solid];`);
  if (withTail) lines.push(`  n${count} [label="tail-a.mjs", style=dashed];`, `  n${count + 1} [label="tail-b.mjs", style=dashed];`);
  for (let i = 0; i < count - 1; i++) lines.push(`  n${i} -> n${i + 1} [label="next", style=solid];`);
  if (withTail) lines.push(`  n${count} -> n${count + 1} [label="lazy-next", style=dashed];`);
  return [...lines, '  // unresolved: 0', '}', ''].join('\n');
}

function render(report) {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

for (const withTail of [false, true]) {
  test(`12,000-module eager chain renders completely${withTail ? ' with disconnected lazy tail' : ''}`, () => {
    const report = fixture(withTail);
    const expected = expectedDot(withTail);
    const actual = render(report);
    const lines = actual.split('\n');
    assert.equal(lines.filter(line => /^  n\d+ \[label=/.test(line)).length, count + (withTail ? 2 : 0));
    assert.equal(lines.filter(line => /^  n\d+ -> n\d+ /.test(line)).length, count - 1 + (withTail ? 1 : 0));
    assert.ok(lines.includes(`  n0 [label="${path(0)}", style=solid];`));
    assert.ok(lines.includes(`  n${count - 1} [label="${path(count - 1)}", style=solid];`));
    assert.equal(actual, expected);
    assert.equal(render({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }), expected);
  });
}
