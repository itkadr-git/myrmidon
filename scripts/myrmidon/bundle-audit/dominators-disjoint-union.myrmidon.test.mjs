import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const edge = (from, to) => ({ from, specifier: `./${to}`, kind: 'eager', to });
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });

// Expected output is specified independently for each graph, not derived from the CLI.
const cases = [
  {
    name: 'chains',
    a: { entry: 'a0', modules: [moduleOf('a0', 1), moduleOf('a1', 2), moduleOf('a2', 3)], edges: [edge('a0', 'a1'), edge('a1', 'a2')] },
    b: { entry: 'b0', modules: [moduleOf('b0', 5), moduleOf('b1', 8)], edges: [edge('b0', 'b1')] },
    targetA: 'a2', targetB: 'b1',
    expectedA: '{"entry":"a0","target":"a2","dominators":["a0","a1","a2"]}\n',
    expectedB: '{"entry":"b0","target":"b1","dominators":["b0","b1"]}\n',
  },
  {
    name: 'diamond',
    a: { entry: 'c0', modules: [moduleOf('c0', 11), moduleOf('c1', 12), moduleOf('c2', 13), moduleOf('c3', 14)], edges: [edge('c0', 'c1'), edge('c0', 'c2'), edge('c1', 'c3'), edge('c2', 'c3')] },
    b: { entry: 'd0', modules: [moduleOf('d0', 15), moduleOf('d1', 16), moduleOf('d2', 17)], edges: [edge('d0', 'd1'), edge('d1', 'd2')] },
    targetA: 'c3', targetB: 'd2',
    expectedA: '{"entry":"c0","target":"c3","dominators":["c0","c3"]}\n',
    expectedB: '{"entry":"d0","target":"d2","dominators":["d0","d1","d2"]}\n',
  },
  {
    name: 'cycle',
    a: { entry: 'e0', modules: [moduleOf('e0', 21), moduleOf('e1', 22), moduleOf('e2', 23), moduleOf('e3', 24)], edges: [edge('e0', 'e1'), edge('e1', 'e2'), edge('e2', 'e1'), edge('e2', 'e3')] },
    b: { entry: 'f0', modules: [moduleOf('f0', 25), moduleOf('f1', 26)], edges: [edge('f0', 'f1')] },
    targetA: 'e3', targetB: 'f1',
    expectedA: '{"entry":"e0","target":"e3","dominators":["e0","e1","e2","e3"]}\n',
    expectedB: '{"entry":"f0","target":"f1","dominators":["f0","f1"]}\n',
  },
];

function runCase(root, report, target, expected, category = null) {
  const path = join(root, 'report.json');
  const input = JSON.stringify(report);
  writeFileSync(path, input);
  const result = spawnSync(process.execPath, [cli, path, target], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, category ? 1 : 0, result.stderr);
  assert.equal(result.stderr, category ? `${category}\n` : '');
  assert.equal(result.stdout, expected);
  assert.equal(readFileSync(path, 'utf8'), input);
}

for (const { name, a, b, targetA, targetB, expectedA, expectedB } of cases) {
  test(`disjoint union isolates ${name}`, () => {
    const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'disjoint-'));
    try {
      const unionA = { entry: a.entry, modules: [...a.modules, ...b.modules.map(m => ({ ...m, eager: false }))], edges: [...a.edges, ...b.edges] };
      const unionB = { entry: b.entry, modules: [...a.modules.map(m => ({ ...m, eager: false })), ...b.modules], edges: [...a.edges, ...b.edges] };
      const reverse = r => ({ ...r, modules: [...r.modules].reverse(), edges: [...r.edges].reverse() });
      for (const report of [a, reverse(a), a]) runCase(root, report, targetA, expectedA);
      for (const report of [b, reverse(b), b]) runCase(root, report, targetB, expectedB);
      for (const report of [unionA, reverse(unionA), unionA]) {
        runCase(root, report, targetA, expectedA);
        runCase(root, report, targetB, '', 'graph');
      }
      for (const report of [unionB, reverse(unionB), unionB]) runCase(root, report, targetB, expectedB);
      runCase(root, { ...unionA, edges: [...unionA.edges, edge(a.entry, 'missing')] }, targetA, '', 'graph');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
