import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'edge-exact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    put(name, value) {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    },
    run(...args) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: dir },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

function report(edges, paths) {
  return { entry: 'entry', modules: paths.map(path => ({ path, bytes: 1, eager: path === 'entry' })), edges };
}

function success(result, expected) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
}

test('preserves exact tuple identities and sorts every field in code-unit order', t => {
  const f = fixture(t);
  const paths = ['entry', '__proto__', 'constructor', 'a', 'a|b', 'b', 'e\u0301', '\u00e9', '\ud800\udc00', '\ue000'];
  const added = [
    edge('__proto__', '', 'lazy', null),
    edge('a', 'b|c', 'lazy', null),
    edge('a|b', 'c', 'lazy', null),
    edge('constructor', '"\\', 'lazy', null),
    edge('entry', '', 'eager', null),
    edge('entry', '', 'lazy', null),
    edge('entry', '', 'lazy', '__proto__'),
    edge('entry', '', 'lazy', 'constructor'),
    edge('entry', '\t', 'lazy', null),
    edge('entry', '\n', 'lazy', null),
    edge('entry', 'e\u0301', 'lazy', null),
    edge('entry', '|', 'lazy', null),
    edge('entry', '\u00e9', 'lazy', null),
    edge('entry', '\ud800\udc00', 'lazy', null),
    edge('entry', '\ue000', 'lazy', null),
    edge('e\u0301', 'x', 'lazy', null),
    edge('\u00e9', 'x', 'lazy', null),
    edge('\ud800\udc00', 'x', 'lazy', null),
    edge('\ue000', 'x', 'lazy', null),
  ];
  const removed = [edge('entry', 'change', 'eager', null), edge('entry', 'gone', 'lazy', 'a')];
  const shared = [edge('entry', 'shared', 'lazy', 'b')];
  const base = f.put('base.json', report([...removed, ...shared], paths));
  const current = f.put('current.json', report([...added, ...shared].reverse(), paths));
  const expected = { entry: 'entry', added, removed };
  success(f.run(base, current), expected);
  const reversedBase = f.put('base-reversed.json', report([...shared, ...removed].reverse(), [...paths].reverse()));
  const reversedCurrent = f.put('current-reversed.json', report([...added, ...shared], [...paths].reverse()));
  success(f.run(reversedBase, reversedCurrent), expected);
  success(f.run(current, reversedCurrent), { entry: 'entry', added: [], removed: [] });
});

test('rejects an exact duplicate without leaking tuple contents', t => {
  const f = fixture(t);
  const paths = ['entry', '__proto__'];
  const item = edge('__proto__', 'private|\t\n"\\', 'lazy', null);
  const base = f.put('base.json', report([], paths));
  const duplicate = f.put('duplicate.json', report([item, item], paths));
  for (const args of [[base, duplicate], [duplicate, base]]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'duplicate edge\n');
  }
});
