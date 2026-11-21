import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const target = 'target';

function report(eagerPaths, imports, otherPaths = []) {
  const entry = eagerPaths[0];
  const modules = [...eagerPaths, ...otherPaths].map((path, index) => ({
    path,
    eager: index < eagerPaths.length,
    bytes: index * (index + 2),
  }));
  const edges = imports.map(([from, to, kind = 'eager', specifier = `./${to}`]) => ({
    from, to, kind, specifier,
  }));
  return { entry, modules, edges };
}

const fixtures = {
  chain: report(['chain-entry', 'first', 'second', target], [
    ['chain-entry', 'first'], ['first', 'second'], ['second', target],
  ]),
  diamond: report(['diamond-entry', 'right', 'left', 'shared', target], [
    ['diamond-entry', 'right'], ['diamond-entry', 'left'],
    ['right', 'shared'], ['left', 'shared'], ['shared', target],
    ['diamond-entry', 'shared'],
  ]),
  'lazy and startup-unreachable modules': report(['startup', 'bridge', target], [
    ['startup', 'bridge'], ['bridge', target], ['startup', target, 'lazy'],
    ['startup', 'plugin', 'lazy'], ['plugin', target], ['detached', 'plugin'],
    ['lazy-only', target, 'lazy'], ['isolated', 'isolated-child'],
  ], ['plugin', 'detached', 'lazy-only', 'isolated', 'isolated-child']),
  'parallel specifiers and a cycle': report(['alias-entry', 'loader', target], [
    ['alias-entry', 'loader'], ['loader', target], ['loader', target, 'eager', '@alias/target'],
    [target, 'alias-entry'], [target, target],
  ]),
};

function expectedImpact({ entry, edges }) {
  const visited = new Set([target]);
  const importers = [];
  let frontier = new Set([target]);
  // Scan the edge list once per reverse BFS layer. The first layer that
  // discovers a path gives its shortest distance, even in a cycle.
  for (let distance = 1; frontier.size; distance++) {
    const next = new Set();
    for (const { from, to, kind } of edges) {
      if (kind === 'eager' && frontier.has(to) && !visited.has(from)) next.add(from);
    }
    for (const path of [...next].sort()) {
      visited.add(path);
      importers.push({ path, distance });
    }
    frontier = next;
  }
  return { entry, target, importers };
}

function assertImpact(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
}

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`reverse impact is weight-independent: ${name}`, () => {
    const expected = expectedImpact(fixture);
    for (const k of [0, 1, 3]) {
      for (const c of [0, 2, 11]) {
        const modules = fixture.modules.map(mod => ({ ...mod, bytes: k * mod.bytes + c }));
        for (const reverseModules of [false, true]) {
          for (const reverseEdges of [false, true]) {
            const input = {
              entry: fixture.entry,
              modules: reverseModules ? [...modules].reverse() : modules,
              edges: reverseEdges ? [...fixture.edges].reverse() : fixture.edges,
            };
            const label = `${name}: k=${k}, c=${c}, reverseModules=${reverseModules}, reverseEdges=${reverseEdges}`;
            const stdout = execFileSync(process.execPath, [cli, '-', target], {
              input: JSON.stringify(input),
              encoding: 'utf8',
              env: {},
              timeout: 5000,
            });
            assertImpact(JSON.parse(stdout), expected, label);
          }
        }
      }
    }
  });
}

test('the impact assertion rejects a missing transitive importer', () => {
  const incomplete = {
    entry: 'chain-entry',
    target,
    importers: [{ path: 'second', distance: 1 }, { path: 'first', distance: 2 }],
  };
  assert.throws(() => assertImpact(incomplete, expectedImpact(fixtures.chain)), {
    code: 'ERR_ASSERTION',
  });
});
