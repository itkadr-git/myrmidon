import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const modules = [
  { path: 'entry', bytes: 1, eager: true },
  { path: 'bridge', bytes: 2, eager: true },
  { path: 'left', bytes: 3, eager: true },
  { path: 'right', bytes: 5, eager: true },
  { path: 'end', bytes: 7, eager: true },
  { path: 'off', bytes: 11, eager: false },
];
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const base = { entry: 'entry', modules, edges: [
  edge('entry', 'bridge'), edge('bridge', 'left'), edge('bridge', 'right'),
  edge('left', 'end'), edge('right', 'end'), edge('entry', 'end', 'lazy'),
] };
const annotation = { syntheticSentinel: 'producer-extension-sentinel', values: [null, true, false, { nested: ['annotation', { ok: true }] }] };

function extend(report, levels) {
  return {
    ...report,
    ...(levels.includes('report') ? { producerAnnotation: annotation } : {}),
    modules: report.modules.map(m => levels.includes('module') ? { ...m, producerAnnotation: annotation } : { ...m }),
    edges: report.edges.map(e => levels.includes('edge') ? { ...e, producerAnnotation: annotation } : { ...e }),
  };
}

// Independent reachability oracle: repeatedly expand the reachable set to a fixed point.
function expected(report, removed) {
  function reachable(excluded) {
    const reached = new Set(report.entry === excluded ? [] : [report.entry]);
    let size;
    do {
      size = reached.size;
      for (const { from, to, kind } of report.edges) {
        if (kind === 'eager' && to !== null && to !== excluded && reached.has(from)) reached.add(to);
      }
    } while (size !== reached.size);
    return reached;
  }
  const before = reachable(null);
  const after = reachable(removed);
  const lostPaths = [...before].filter(path => !after.has(path)).sort();
  const lostBytes = report.modules.filter(m => lostPaths.includes(m.path)).reduce((sum, m) => sum + m.bytes, 0);
  return { entry: report.entry, removed, lostPaths, lostBytes };
}

function run(report, removed) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'cut-impact-extensions-'));
  const path = join(dir, 'report.json');
  const input = JSON.stringify(report);
  try {
    writeFileSync(path, input);
    const fd = openSync(path, 'r');
    let result;
    try {
      result = spawnSync(process.execPath, [cli, removed], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 });
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path, 'utf8'), input, 'CLI must not mutate input');
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertOutput(result, oracle) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(oracle)}\n`);
}

function assertError(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

test('extensions preserve cut impact across levels, permutations and repeated invocations', () => {
  const levels = [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']];
  for (const removed of ['entry', 'bridge', 'left', 'off']) {
    const oracle = expected(base, removed);
    if (removed !== 'off') assert.ok(oracle.lostPaths.length > 0);
    for (const selection of levels) {
      for (const reverse of [false, true]) {
        const report = extend(base, selection);
        if (reverse) { report.modules.reverse(); report.edges.reverse(); }
        for (let repeat = 0; repeat < 2; repeat++) assertOutput(run(report, removed), oracle);
      }
    }
  }
});

test('extensions do not bypass required field or duplicate edge validation', () => {
  const invalidBytes = extend(base, ['report', 'module', 'edge']);
  invalidBytes.modules[0].bytes = -1;
  assertError(run(invalidBytes, 'bridge'), 'shape');
  const duplicate = extend(base, ['report', 'module', 'edge']);
  duplicate.edges.push({ ...duplicate.edges[0], producerAnnotation: { different: true } });
  assertError(run(duplicate, 'bridge'), 'graph');
});

test('output assertion rejects missing paths and incorrect byte totals', () => {
  const oracle = expected(base, 'bridge');
  const result = run(extend(base, ['report', 'module', 'edge']), 'bridge');
  assertOutput(result, oracle);
  assert.throws(() => assertOutput(result, { ...oracle, lostPaths: oracle.lostPaths.slice(1) }));
  assert.throws(() => assertOutput(result, { ...oracle, lostBytes: oracle.lostBytes + 1 }));
});
