import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-validate.mjs', import.meta.url).pathname;
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to ?? 'external' });
const makeReport = (flags, edges) => {
  const modules = Object.entries(flags).map(([path, eager]) => ({ path, eager, bytes: 1 }));
  const eager = modules.filter(m => m.eager);
  return {
    entry: 'a', modules, edges, unknown: edges.filter(e => e.to === null),
    counts: { modules: modules.length, eagerModules: eager.length, edges: edges.length },
    bytes: { total: modules.length, eager: eager.length },
    heaviestEager: [...eager].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(0, 10),
  };
};
const check = (report, valid) => {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, valid ? 0 : 1, result.stderr);
  assert.equal(result.stdout, valid ? 'PASS: import report\n' : '');
  assert.equal(result.stderr, valid ? '' : 'FAIL: inconsistent\n');
};

for (const [name, flags, edges] of [
  ['disconnected eager module', { a: true, b: true }, []],
  ['eager child marked lazy', { a: true, b: false }, [edge('a', 'b')]],
  ['lazy-only module marked eager', { a: true, b: true }, [edge('a', 'b', 'lazy')]],
  ['unreachable eager cycle', { a: true, b: true, c: true }, [edge('b', 'c'), edge('c', 'b')]],
]) test(`rejects ${name}`, () => check(makeReport(flags, edges), false));

for (const [name, flags, edges] of [
  ['entry only', { a: true }, []],
  ['eager diamond', { a: true, b: true, c: true, d: true }, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]],
  ['reachable cycle', { a: true, b: true, c: true }, [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')]],
  ['lazy path with eager descendants', { a: true, b: false, c: false }, [edge('a', 'b', 'lazy'), edge('b', 'c')]],
  ['both kinds on one pair', { a: true, b: true }, [edge('a', 'b', 'lazy'), edge('a', 'b')]],
  ['unknown eager edge', { a: true, b: false }, [edge('a', null)]],
]) test(`accepts ${name} in either order`, () => {
  const report = makeReport(flags, edges);
  check(report, true);
  report.modules.reverse(); report.edges.reverse();
  check(report, true);
});
