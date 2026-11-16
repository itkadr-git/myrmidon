import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const number = n => String(n).padStart(2, '0');

// These lists are constructed in the required output order, independently of the CLI.
function fixture(eagerCount, edgeCount) {
  const eager = Array.from({ length: eagerCount }, (_, i) => ({
    path: `module${number(i)}`, bytes: 100 - Math.floor(i / 3), eager: true,
  }));
  const modules = [...eager, { path: 'sourceA', bytes: 7, eager: false },
    { path: 'sourceB', bytes: 13, eager: false }];
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    specifier: `package${number(Math.floor(i / 4))}`,
    kind: i % 4 < 2 ? 'eager' : 'lazy',
    from: i % 2 === 0 ? 'sourceA' : 'sourceB', to: null,
  }));
  const eagerBytes = eager.reduce((sum, module) => sum + module.bytes, 0);
  const report = {
    modules, edges,
    counts: { modules: modules.length, eagerModules: eagerCount, edges: edgeCount },
    bytes: { total: eagerBytes + 20, eager: eagerBytes },
  };
  return { report, eager, edges, eagerBytes };
}

function expected({ report, eager, edges, eagerBytes }) {
  return [
    '## Import report summary', '',
    'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |',
    `| modules | ${report.modules.length} |`, `| eagerModules | ${eager.length} |`,
    `| totalBytes | ${eagerBytes + 20} |`, `| eagerBytes | ${eagerBytes} |`, '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
    ...eager.slice(0, 10).map(m => `| ${m.path} | ${m.bytes} |`), '',
    '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |',
    ...edges.slice(0, 50).map(e => `| ${e.specifier} | ${e.kind} | ${e.from} |`), '',
    `Omitted: ${Math.max(0, edges.length - 50)}`, '',
  ].join('\n');
}

test('truncation boundaries preserve exact ordering, totals and permutation invariance', () => {
  for (const eagerCount of [0, 1, 9, 10, 11, 12]) {
    for (const edgeCount of [0, 49, 50, 51, 53]) {
      const data = fixture(eagerCount, edgeCount);
      const reversed = { ...data.report, modules: [...data.report.modules].reverse(), edges: [...data.report.edges].reverse() };
      const want = expected(data);
      for (const input of [data.report, reversed]) {
        const result = run(input);
        const label = `eager=${eagerCount} unresolved=${edgeCount}`;
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.equal(result.stderr, '', label);
        assert.equal(result.stdout, want, label);
      }
    }
  }
});

test('empty report retains the disclaimer and empty tables', () => {
  const result = run({ modules: [], edges: [], counts: { modules: 0, eagerModules: 0, edges: 0 }, bytes: { total: 0, eager: 0 } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    '## Import report summary', '', 'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |', '| modules | 0 |', '| eagerModules | 0 |', '| totalBytes | 0 |', '| eagerBytes | 0 |', '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |', '',
    '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |', '', 'Omitted: 0', '',
  ].join('\n'));
});
