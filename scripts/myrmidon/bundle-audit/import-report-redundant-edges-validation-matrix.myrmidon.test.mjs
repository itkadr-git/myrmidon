import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const moduleOf = path => ({ path, bytes: 1, eager: true });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const fixture = () => ({
  entry: 'entry',
  modules: ['entry', 'middle', 'end', 'isolated'].map(moduleOf),
  edges: [edge('entry', 'end', 'direct'), edge('entry', 'middle', 'via'), edge('middle', 'end', 'finish'), edge('isolated', 'isolated', 'last')],
});

function harness(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return report => {
    const result = spawnSync(process.execPath, [cli], {
      input: JSON.stringify(report), encoding: 'utf8', shell: false, timeout: 5000,
      env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
}

const missing = Symbol('missing');
function setField(item, key, value) {
  if (value === missing) delete item[key];
  else item[key] = value;
}

test('validates every module and edge before eager analysis', async t => {
  const run = harness(t);
  const cases = [];
  const add = (name, category, mutate) => cases.push({ name, category, mutate });
  for (const value of [null, []]) {
    add(`module ${JSON.stringify(value)}`, 'shape', r => { r.modules[3] = value; });
    add(`edge ${JSON.stringify(value)}`, 'shape', r => { r.edges[3] = value; });
  }
  for (const [name, value] of [['missing', missing], ['null', null], ['string', '1'], ['boolean', true], ['negative', -1], ['fraction', 0.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1]]) {
    add(`bytes ${name}`, 'shape', r => setField(r.modules[3], 'bytes', value));
  }
  add('non-boolean eager', 'shape', r => { r.modules[3].eager = 'true'; });
  add('empty module path', 'shape', r => { r.modules[3].path = ''; });
  add('empty from', 'shape', r => { r.edges[3].from = ''; });
  add('empty specifier', 'shape', r => { r.edges[3].specifier = ''; });
  add('unknown kind', 'shape', r => { r.edges[3].kind = 'other'; });
  for (const [name, value] of [['missing', missing], ['number', 1], ['object', {}]]) {
    add(`target ${name}`, 'shape', r => setField(r.edges[3], 'to', value));
  }
  add('absent entry', 'graph', r => { r.entry = 'absent'; });
  add('duplicate module', 'graph', r => { r.modules[3] = moduleOf('entry'); });
  add('dangling from', 'graph', r => { r.edges[3].from = 'absent'; });
  add('dangling target', 'graph', r => { r.edges[3].to = 'absent'; });
  add('duplicate eager tuple', 'graph', r => { r.edges.push({ ...r.edges[0] }); });
  add('duplicate self-loop tuple', 'graph', r => { r.edges.push({ ...r.edges[3] }); });
  add('duplicate lazy tuple', 'graph', r => { r.edges[3].kind = 'lazy'; r.edges.push({ ...r.edges[3] }); });
  add('invalid lazy reference', 'graph', r => { r.edges[3].kind = 'lazy'; r.edges[3].to = 'absent'; });
  for (const { name, category, mutate } of cases) {
    await t.test(name, () => {
      const report = fixture();
      mutate(report);
      const result = run(report);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${category}\n`);
    });
  }
});

test('parallel specifiers and a null target are valid', t => {
  const run = harness(t);
  const report = fixture();
  report.edges.push(edge('isolated', 'isolated', 'parallel'), edge('isolated', null, 'external', 'lazy'));
  const result = run(report);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"entry":"entry","redundant":[{"from":"entry","specifier":"direct","to":"end","alternativePath":["entry","middle","end"]}]}\n');
});
