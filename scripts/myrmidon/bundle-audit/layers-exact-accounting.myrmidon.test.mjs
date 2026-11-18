import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const mod = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier = to, kind = 'eager') => ({ from, to, specifier, kind });
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const expectSuccess = (report, expected) => {
  const result = run(report);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  return result.stdout;
};

test('identities and diamond accounting are exact across twelve input permutations', () => {
  const modules = [mod('__proto__', 1), mod('constructor', 2), mod('toString', 3),
    mod('dir/a|b', 5), mod('dir/a,b', 7), mod('\u96ea/\u03bb', 11),
    mod('z|unused', 13, false), mod('a,unused', 17, false)];
  const edges = [edge('__proto__', 'constructor', 'a|b'), edge('__proto__', 'toString', 'a,b'),
    edge('constructor', 'dir/a|b'), edge('toString', 'dir/a|b'),
    edge('constructor', 'dir/a,b'), edge('dir/a|b', '\u96ea/\u03bb'),
    edge('__proto__', 'z|unused', 'lazy', 'lazy')];
  const expected = { entry: '__proto__', layers: [
    { depth: 0, paths: ['__proto__'], bytes: 1 },
    { depth: 1, paths: ['constructor', 'toString'], bytes: 5 },
    { depth: 2, paths: ['dir/a,b', 'dir/a|b'], bytes: 12 },
    { depth: 3, paths: ['\u96ea/\u03bb'], bytes: 11 },
  ], unreachable: ['a,unused', 'z|unused'] };
  const rotate = (xs, n) => [...xs.slice(n % xs.length), ...xs.slice(0, n % xs.length)];
  let first;
  for (let i = 0; i < 12; i++) {
    const ms = rotate(i % 2 ? [...modules].reverse() : modules, i);
    const es = rotate(i % 2 ? [...edges].reverse() : edges, i * 2);
    const output = expectSuccess({ entry: '__proto__', modules: ms, edges: es }, expected);
    if (first === undefined) first = output;
    assert.equal(output, first);
  }
});

test('safe integer limit applies per layer, not across layers', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const report = { entry: 'entry', modules: [mod('entry', max), mod('a', max - 1), mod('b', 1)],
    edges: [edge('entry', 'a'), edge('entry', 'b')] };
  expectSuccess(report, { entry: 'entry', layers: [
    { depth: 0, paths: ['entry'], bytes: max },
    { depth: 1, paths: ['a', 'b'], bytes: max },
  ], unreachable: [] });
  const overflow = { ...report, modules: [mod('entry', 0), mod('a', max), mod('b', 1)] };
  const result = run(overflow);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'graph\n');
  assert.equal(result.stdout, '');
});
