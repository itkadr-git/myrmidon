import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = process.env.SHORTEST_COUNTS_CLI ?? fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const moduleOf = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, kind, specifier });
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 5000,
});

const report = {
  entry: 'root',
  modules: [
    ...['root', '__proto__', 'constructor', 'a', 'a|b', 'b|c', 'c', 'quote"', 'line\nfeed', '\u96ea', 'leaf'].map(path => moduleOf(path)),
    moduleOf('unused\n"', false), moduleOf('\u96ea-unused', false),
  ],
  edges: [
    edge('root', '__proto__', 'same'), edge('root', '__proto__', 'alias'),
    edge('root', '__proto__', 'same', 'lazy'),
    edge('root', 'constructor', 'same'), edge('root', 'a', 'same'), edge('root', 'a|b', 'same'),
    edge('a|b', 'c', 'd'), edge('a', 'c', 'b|d'), edge('a', 'b|c', 'same'),
    edge('__proto__', 'quote"', 'q"\n\u96ea'), edge('constructor', 'line\nfeed', 'q"\n\u96ea'),
    edge('quote"', '\u96ea', 'same'), edge('line\nfeed', '\u96ea', 'same'),
    edge('__proto__', 'leaf', 'same'), edge('constructor', 'leaf', 'same'),
    edge('root', 'leaf', 'same', 'lazy'),
  ],
};

const expected = {
  entry: 'root',
  modules: [
    { path: '__proto__', depth: 1, shortestPaths: '1' },
    { path: 'a', depth: 1, shortestPaths: '1' },
    { path: 'a|b', depth: 1, shortestPaths: '1' },
    { path: 'b|c', depth: 2, shortestPaths: '1' },
    { path: 'c', depth: 2, shortestPaths: '2' },
    { path: 'constructor', depth: 1, shortestPaths: '1' },
    { path: 'leaf', depth: 2, shortestPaths: '2' },
    { path: 'line\nfeed', depth: 2, shortestPaths: '1' },
    { path: 'quote"', depth: 2, shortestPaths: '1' },
    { path: 'root', depth: 0, shortestPaths: '1' },
    { path: '\u96ea', depth: 3, shortestPaths: '2' },
  ],
  unreachable: ['unused\n"', '\u96ea-unused'],
};

test('exact vertex identities, edge tuples and eager aliases survive input reversal', () => {
  for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
});

test('an exact duplicate edge tuple is rejected in either input order', () => {
  const duplicate = { ...report, edges: [...report.edges, { ...report.edges[0] }] };
  for (const input of [duplicate, { ...duplicate, modules: [...duplicate.modules].reverse(), edges: [...duplicate.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
