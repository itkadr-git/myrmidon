import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const valid = {
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'child', bytes: 2, eager: true }],
  edges: [
    { from: 'entry', specifier: './child', kind: 'eager', to: 'child' },
    { from: 'entry', specifier: 'external', kind: 'lazy', to: null },
  ],
};

function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
}

function run(base, current) {
  return spawnSync(process.execPath, [cli, base, current], { encoding: 'utf8', timeout: 10000 });
}
function rejected(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

const mutations = [
  ['null root', () => null, 'invalid report'],
  ['array root', () => [], 'invalid report'],
  ['missing entry', r => { r.entry = ''; }, 'invalid report'],
  ['empty modules', r => { r.modules = []; }, 'invalid report'],
  ['non-array edges', r => { r.edges = {}; }, 'invalid report'],
  ['duplicate module', r => { r.modules[1].path = 'entry'; }, 'duplicate module'],
  ['negative bytes', r => { r.modules[1].bytes = -1; }, 'invalid module'],
  ['fractional bytes', r => { r.modules[1].bytes = 1.5; }, 'invalid module'],
  ['unsafe bytes', r => { r.modules[1].bytes = Number.MAX_SAFE_INTEGER + 1; }, 'invalid module'],
  ['non-boolean eager', r => { r.modules[1].eager = 'true'; }, 'invalid module'],
  ['dangling entry', r => { r.entry = 'missing'; }, 'dangling entry'],
  ['invalid kind', r => { r.edges[0].kind = 'unknown'; }, 'invalid edge'],
  ['dangling from', r => { r.edges[0].from = 'missing'; }, 'dangling edge'],
  ['dangling to', r => { r.edges[0].to = 'missing'; }, 'dangling edge'],
  ['duplicate tuple', r => { r.edges[1] = structuredClone(r.edges[0]); }, 'duplicate edge'],
  ['inconsistent closure', r => { r.modules[1].eager = false; }, 'invalid eager closure'],
];

test('each invalid report is rejected on either side with exact diagnostics', async t => {
  const put = fixture(t);
  const good = put('valid.json', valid);
  for (const [name, mutate, category] of mutations) {
    await t.test(name, () => {
      const copy = structuredClone(valid);
      const changed = mutate(copy);
      const bad = put('invalid.json', changed === undefined ? copy : changed);
      rejected(run(bad, good), category);
      rejected(run(good, bad), category);
    });
  }
});

test('entry mismatch follows report validation, without partial diff output', t => {
  const put = fixture(t);
  const other = { entry: 'other', modules: [{ path: 'other', bytes: 1, eager: true }], edges: [] };
  const good = put('good.json', valid);
  const mismatch = put('other.json', other);
  rejected(run(good, mismatch), 'entry mismatch');
  rejected(run(mismatch, good), 'entry mismatch');
  const bad = structuredClone(valid);
  bad.edges[1].to = 'missing';
  const invalid = put('late.json', bad);
  rejected(run(mismatch, invalid), 'dangling edge');
  rejected(run(invalid, mismatch), 'dangling edge');
});

test('equal reports and distinct aliases are accepted', t => {
  const put = fixture(t);
  const aliases = structuredClone(valid);
  aliases.edges[1] = { ...aliases.edges[0], specifier: 'alias' };
  for (const [name, report] of [['same', valid], ['aliases', aliases]]) {
    const path = put(`${name}.json`, report);
    const result = run(path, path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { entry: 'entry', added: [], removed: [] });
  }
});
