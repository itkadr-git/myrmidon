import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const edge = (from, specifier, to, kind = 'eager') => ({ from, specifier, kind, to });
const found = (from, specifier, to, alternativePath) => ({ from, specifier, to, alternativePath });

test('exact tuple identities, code-unit tie breaks and fixed permutations', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(scratch, 'redundant-identities-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const composed = '\u00e9', decomposed = 'e\u0301';
  const paths = ['root', 'a', 'a|b', 'z', '__proto__', 'constructor', 'a/b', '"quoted"', 'line\nbreak', composed, decomposed];
  const edges = [
    edge('a|b', 'c', 'z'), edge('a', 'b|c', 'z'),
    edge('a|b', 'parallel', 'z'), edge('a', 'parallel', 'z'),
    edge('root', 'shortcut', 'z'),
    edge('root', 'p', '__proto__'), edge('__proto__', 'end', 'z'),
    edge('root', 'c', 'constructor'), edge('constructor', 'end', 'z'),
    edge('root', 'slash', 'a/b'), edge('a/b', 'end', 'z'),
    edge('root', 'quote', '"quoted"'), edge('"quoted"', 'end', 'z'),
    edge('root', 'newline', 'line\nbreak'), edge('line\nbreak', 'end', 'z'),
    edge('root', composed, composed), edge(composed, 'end', 'z'),
    edge('root', decomposed, decomposed), edge(decomposed, 'end', 'z'),
    edge('root', 'self', 'root'), edge('root', 'ignored', 'z', 'lazy'), edge('root', 'external', null),
  ];
  assert.equal(['a|b', 'c', 'eager', 'z'].join('|'), ['a', 'b|c', 'eager', 'z'].join('|'));
  const modules = paths.map(path => ({ path, bytes: 0, eager: true }));
  const expected = { entry: 'root', redundant: [
    found('a', 'b|c', 'z', ['a', 'z']), found('a', 'parallel', 'z', ['a', 'z']),
    found('a|b', 'c', 'z', ['a|b', 'z']), found('a|b', 'parallel', 'z', ['a|b', 'z']),
    found('root', 'shortcut', 'z', ['root', '"quoted"', 'z']),
  ] };
  const permutations = [
    [modules, edges],
    [[...modules].reverse(), [...edges].reverse()],
    [[...modules.slice(3), ...modules.slice(0, 3)], [...edges.slice(7), ...edges.slice(0, 7)]],
  ];
  for (const [permutedModules, permutedEdges] of permutations) {
    const result = spawnSync(process.execPath, [cli], {
      input: JSON.stringify({ entry: 'root', modules: permutedModules, edges: permutedEdges }),
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: tmp },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
});

test('Unicode paths and every tuple field remain observable', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(scratch, 'redundant-observable-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const composed = '\u00e9', decomposed = 'e\u0301';
  const names = ['__proto__', 'a/b', 'constructor', decomposed, 'line\nbreak', composed];
  const modules = ['root', 'unicode-root', 'target', 'other', ...names].map(path => ({ path, bytes: 0, eager: true }));
  const edges = [
    edge('unicode-root', 'shortcut', 'target'),
    edge('unicode-root', 'composed', composed), edge(composed, 'end', 'target'),
    edge('unicode-root', 'decomposed', decomposed), edge(decomposed, 'end', 'target'),
    edge('root', 'same', 'target'), edge('root', 'same', 'other'),
    edge('root', 'same', 'target', 'lazy'),
    ...names.flatMap(name => [edge(name, 'first', 'target'), edge(name, 'second', 'target')]),
  ];
  const expected = { entry: 'root', redundant: [] };
  for (const name of names) {
    if (name === decomposed || name === composed) expected.redundant.push(found(name, 'end', 'target', [name, 'target']));
    expected.redundant.push(found(name, 'first', 'target', [name, 'target']));
    expected.redundant.push(found(name, 'second', 'target', [name, 'target']));
  }
  expected.redundant.splice(expected.redundant.length - 3, 0,
    found('unicode-root', 'shortcut', 'target', ['unicode-root', decomposed, 'target']));
  for (const [ms, es] of [[modules, edges], [[...modules].reverse(), [...edges].reverse()]]) {
    const result = spawnSync(process.execPath, [cli], {
      input: JSON.stringify({ entry: 'root', modules: ms, edges: es }),
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: tmp },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
});
