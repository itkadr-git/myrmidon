import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const mod = (path, bytes) => ({ path, bytes, eager: false });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unresolved') => ({ from, to, kind, specifier });

test('reachable sink identities remain exact and sorted after input permutation', () => {
  const entry = 'entry';
  const modules = [
    mod(entry, 1), mod('__proto__', 2), mod('constructor', 3),
    mod('toString', 5), mod('caf\u00e9', 7), mod('dir/file', 11),
    mod('dir\\file', 13), mod('a|b\nC', 17), mod('prefix', 19),
    mod('prefix/child', 23), mod('lazy-only', 29), mod('disconnected', 31),
  ];
  const edges = [
    ...modules.slice(1, 10).map(({ path }) => edge(entry, path)),
    edge(entry, 'lazy-only', 'lazy'), edge(entry, null),
    edge('__proto__', null), edge('constructor', 'disconnected', 'lazy'),
  ];
  const expected = {
    entry,
    sinks: [
      { path: '__proto__', bytes: 2 },
      { path: 'a|b\nC', bytes: 17 },
      { path: 'caf\u00e9', bytes: 7 },
      { path: 'constructor', bytes: 3 },
      { path: 'dir/file', bytes: 11 },
      { path: 'dir\\file', bytes: 13 },
      { path: 'prefix', bytes: 19 },
      { path: 'prefix/child', bytes: 23 },
      { path: 'toString', bytes: 5 },
    ],
    sinkBytes: 100,
  };
  for (const input of [
    { entry, modules, edges },
    { entry, modules: [...modules].reverse(), edges: [...edges].reverse() },
  ]) {
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});
