import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');

function chain(prefix, count) {
  const paths = [], modules = [], edges = [];
  for (let i = 0; i < count; i++) {
    const path = `${prefix}${String(i).padStart(5, '0')}`;
    paths.push(path);
    modules.push({ path, bytes: 1, eager: false });
    if (i > 0) {
      const previous = paths[i - 1];
      const [from, to] = i % 2 ? [previous, path] : [path, previous];
      edges.push({ from, specifier: to, kind: 'eager', to });
    }
  }
  return { paths, modules, edges };
}

function expectComponents(report, mode, components) {
  const result = spawnSync(process.execPath, [cli, mode], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(),
    timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { entry: report.entry, components });
}

const component = paths => ({ id: paths[0], paths, bytes: paths.length });

test('deep alternating eager chain is complete regardless of entry', { timeout: 30000 }, () => {
  const graph = chain('chain/', 12000);
  for (const entry of [graph.paths[0], graph.paths[graph.paths.length - 1]]) {
    expectComponents({ entry, modules: graph.modules, edges: graph.edges }, 'eager', [component(graph.paths)]);
  }
});

test('a lazy bridge joins two deep chains only in all mode', { timeout: 30000 }, () => {
  const left = chain('left/', 6000), right = chain('right/', 6000);
  const report = {
    entry: right.paths[3000],
    modules: [...left.modules, ...right.modules],
    edges: [...left.edges, ...right.edges, { from: left.paths[5999], specifier: 'bridge', kind: 'lazy', to: right.paths[0] }],
  };
  expectComponents(report, 'eager', [component(left.paths), component(right.paths)]);
  expectComponents(report, 'all', [component([...left.paths, ...right.paths])]);
});
