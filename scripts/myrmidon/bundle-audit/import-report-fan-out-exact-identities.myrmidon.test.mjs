import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const m = (path, bytes) => ({ path, bytes, eager: true });
const e = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
const special = 'quote"\\\n\u00e9';
const report = {
  entry: 'a',
  modules: [m('a', 0), m('a|b', Number.MAX_SAFE_INTEGER), m('target', 2), m('__proto__', 3), m(special, 4), m(':,', 5)],
  edges: [
    e('a', 'b|c', 'target'), e('a|b', 'c', 'target'),
    e('a', 'alias:comma,', '__proto__'), e('a', 'alias"\\\n\u00e9', '__proto__'),
    e('a', '__proto__', special), e('a', '|:,', ':,'),
    e('a|b', 'other', '__proto__'), e('a|b', 'more', special), e('a|b', 'last', ':,'),
  ],
};
const expected = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 0, targets: [':,', '__proto__', special, 'target'], fanOut: 4 },
    { path: 'a|b', bytes: Number.MAX_SAFE_INTEGER, targets: [':,', '__proto__', special, 'target'], fanOut: 4 },
    { path: ':,', bytes: 5, targets: [], fanOut: 0 },
    { path: '__proto__', bytes: 3, targets: [], fanOut: 0 },
    { path: special, bytes: 4, targets: [], fanOut: 0 },
    { path: 'target', bytes: 2, targets: [], fanOut: 0 },
  ],
};

function run(t, value) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'fan-out-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(value), encoding: 'utf8', cwd: dir,
    env: { ...process.env, HOME: dir, TMPDIR: dir }, shell: false,
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test('exact identities, ordering, aliases and permutation', t => {
  const original = run(t, report);
  assert.equal(original.stdout, JSON.stringify(expected) + '\n');
  assert.equal(original.status, 0);
  assert.equal(original.stderr, '');
  const reversed = run(t, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() });
  assert.equal(reversed.status, 0);
  assert.equal(reversed.stderr, '');
  assert.equal(reversed.stdout, JSON.stringify(expected) + '\n');
  assert.equal(reversed.stdout, original.stdout);
});

test('duplicate exact edge tuple is rejected', t => {
  const duplicate = run(t, { ...report, edges: [...report.edges, { ...report.edges[0] }] });
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, '');
  assert.equal(duplicate.stderr, 'graph\n');
});
