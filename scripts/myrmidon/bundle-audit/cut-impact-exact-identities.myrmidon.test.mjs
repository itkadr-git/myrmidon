import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const module = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });

const report = {
  entry: 'entry',
  modules: [module('entry', 9), module('cut', 1), module('a/b', 2), module('a\\b', 2),
    module('__proto__', 0), module('constructor', 3), module('a|b', 4),
    module('e\u0301', 5), module('\u00e9', 5), module('\ud800\udc00', 0), module('\ue000', 1)],
  edges: [edge('entry', 'cut', 'cut'), edge('cut', 'alias|one', 'a/b'),
    edge('cut', 'alias|two', 'a/b'), edge('cut', 'backslash', 'a\\b'),
    edge('cut', '__proto__', '__proto__'), edge('cut', 'constructor', 'constructor'),
    edge('cut', 'a|b', 'a|b'), edge('cut', 'decomposed', 'e\u0301'),
    edge('cut', 'composed', '\u00e9'), edge('cut', 'supplementary', '\ud800\udc00'),
    edge('cut', 'private', '\ue000')],
};

function check(input, removed, lostPaths, lostBytes) {
  const before = JSON.stringify(input);
  const result = spawnSync(process.execPath, [cli, removed], {
    input: before, encoding: 'utf8', cwd: homedir(), timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: 'entry', removed, lostPaths, lostBytes }) + '\n');
  assert.equal(JSON.stringify(input), before);
}

test('exact identities, aliases, code-unit order and byte accounting survive permutations and repeats', () => {
  const lost = ['__proto__', 'a/b', 'a\\b', 'a|b', 'constructor', 'cut', 'e\u0301', '\u00e9', '\ud800\udc00', '\ue000'];
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, reversed, report]) {
    check(input, 'cut', lost, 23);
    check(input, 'a/b', ['a/b'], 2);
    check(input, 'a\\b', ['a\\b'], 2);
    check(input, '__proto__', ['__proto__'], 0);
    check(input, 'constructor', ['constructor'], 3);
    check(input, 'e\u0301', ['e\u0301'], 5);
    check(input, '\u00e9', ['\u00e9'], 5);
  }
});
