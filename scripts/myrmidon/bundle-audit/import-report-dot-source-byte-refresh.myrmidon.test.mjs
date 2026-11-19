import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const edges = [
  { from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' },
  { from: 'entry.mjs', specifier: './left.mjs', kind: 'eager', to: 'left.mjs' },
  { from: 'entry.mjs', specifier: './right.mjs', kind: 'eager', to: 'right.mjs' },
  { from: 'entry.mjs', specifier: 'unresolved-package', kind: 'eager', to: null },
  { from: 'left.mjs', specifier: './shared.mjs', kind: 'eager', to: 'shared.mjs' },
  { from: 'right.mjs', specifier: './shared.mjs', kind: 'eager', to: 'shared.mjs' },
];
const dot = `digraph imports {
  n0 [label="entry.mjs", style=solid];
  n1 [label="lazy.mjs", style=dashed];
  n2 [label="left.mjs", style=solid];
  n3 [label="right.mjs", style=solid];
  n4 [label="shared.mjs", style=solid];
  n0 -> n1 [label="./lazy.mjs", style=dashed];
  n0 -> n2 [label="./left.mjs", style=solid];
  n0 -> n3 [label="./right.mjs", style=solid];
  n2 -> n4 [label="./shared.mjs", style=solid];
  n3 -> n4 [label="./shared.mjs", style=solid];
  // unresolved: 1
}
`;

function sources(value, suffix) {
  return {
    'entry.mjs': `throw new Error('fixture must not execute');\nimport './left.mjs';\nimport './right.mjs';\nimport 'unresolved-package';\nimport('./lazy.mjs');\n// ${value}${suffix}`,
    'left.mjs': `import './shared.mjs';\nexport const left = '${value}';${suffix}`,
    'right.mjs': `import './shared.mjs';\nexport const right = '${value}';${suffix}`,
    'shared.mjs': `export const shared = '${value}';${suffix}`,
    'lazy.mjs': `export const lazy = '${value}';${suffix}`,
  };
}

test('DOT remains identical while scanner source bytes refresh A B C A', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dot-byte-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (script, args, input) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const render = report => {
    const output = run(consumer, [], report);
    assert.equal(output, dot);
    return output;
  };
  const phase = files => {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    const report = run(scanner, [join(dir, 'entry.mjs')]);
    const parsed = JSON.parse(report);
    const expectedModules = Object.entries(files).map(([path, source]) => ({ path, bytes: Buffer.byteLength(source), eager: path !== 'lazy.mjs' })).sort((a, b) => a.path < b.path ? -1 : 1);
    assert.deepEqual(parsed.modules, expectedModules, 'scanner freshness');
    assert.equal(parsed.entry, 'entry.mjs');
    assert.deepEqual(parsed.edges, edges);
    assert.deepEqual(parsed.unknown, [edges[3]]);
    render(report);
    return report;
  };
  const a = sources('a', '\n');
  const b = sources('longer ASCII value', '\n');
  const c = sources('\u00e9\u6f22\ud83d\ude00', '\n\n');
  const first = phase(a);
  const second = phase(b);
  assert.notEqual(first, second);
  assert.equal(render(first), render(second));
  const third = phase(c);
  assert.notEqual(second, third);
  assert.equal(phase(a), first);
  assert.equal(render(first), dot);
});
