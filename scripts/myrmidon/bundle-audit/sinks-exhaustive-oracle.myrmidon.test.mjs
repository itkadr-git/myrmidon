import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to ?? 'unresolved') => ({ from, to, kind, specifier });

// Saturate the edge relation rather than using the CLI's adjacency traversal.
function expected(report) {
  const knownEager = report.edges.filter(e => e.kind === 'eager' && e.to !== null);
  const reached = new Set([report.entry]);
  let size;
  do {
    size = reached.size;
    for (const e of knownEager) if (reached.has(e.from)) reached.add(e.to);
  } while (size !== reached.size);
  const sinks = report.modules
    .filter(m => reached.has(m.path) && !knownEager.some(e => e.from === m.path))
    .map(({ path, bytes }) => ({ path, bytes }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entry: report.entry, sinks, sinkBytes: sinks.reduce((sum, m) => sum + m.bytes, 0) };
}

function check(report, label) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.equal(result.stdout, `${JSON.stringify(expected(report))}\n`, label);
}

test('all 64 directed loop-free graphs match an independent fixed-point oracle', () => {
  const modules = [
    { path: 'z', bytes: 7, eager: false },
    { path: 'a', bytes: 11, eager: true },
    { path: 'm', bytes: 23, eager: false },
  ];
  const pairs = modules.flatMap(from => modules.filter(to => to !== from).map(to => [from.path, to.path]));
  for (let mask = 0; mask < 64; mask++) {
    const edges = pairs.filter((_, i) => mask & (1 << i)).map(([from, to]) => edge(from, to));
    check({ entry: 'z', modules, edges }, `graph mask ${mask}`);
  }
});

test('self loops, cycles with exits, aliases, lazy, unresolved and disconnected edges', () => {
  const modules = [
    { path: 'entry', bytes: 3, eager: false },
    { path: 'z', bytes: 5, eager: false },
    { path: 'a', bytes: 7, eager: true },
    { path: 'unused', bytes: 101, eager: true },
  ];
  const cases = [
    [edge('entry', 'entry')],
    [edge('entry', 'z'), edge('z', 'entry'), edge('z', 'a')],
    [edge('entry', 'z', 'eager', 'first'), edge('entry', 'z', 'eager', 'alias'), edge('entry', 'a')],
    [edge('entry', 'z', 'lazy'), edge('entry', null), edge('unused', 'a')],
    [edge('entry', 'z'), edge('z', 'a', 'lazy'), edge('z', null, 'eager', 'missing')],
  ];
  cases.forEach((edges, i) => check({ entry: 'entry', modules, edges }, `edge case ${i}`));
});
