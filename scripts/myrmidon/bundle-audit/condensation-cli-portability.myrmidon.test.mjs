import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
// Two cycles, with a lazy edge from the first to the second and an external edge.
const report = {
  entry: 'a.js',
  modules: [
    { path: 'a.js', bytes: 2, eager: true }, { path: 'b.js', bytes: 3, eager: true },
    { path: 'c.js', bytes: 5, eager: false }, { path: 'd.js', bytes: 7, eager: false },
  ],
  edges: [
    { from: 'a.js', to: 'b.js', kind: 'eager', specifier: './b.js' },
    { from: 'b.js', to: 'a.js', kind: 'eager', specifier: './a.js' },
    { from: 'c.js', to: 'd.js', kind: 'eager', specifier: './d.js' },
    { from: 'd.js', to: 'c.js', kind: 'eager', specifier: './c.js' },
    { from: 'b.js', to: 'c.js', kind: 'lazy', specifier: './c.js' },
    { from: 'a.js', to: null, kind: 'eager', specifier: 'external' },
  ],
};
const eager = '{"entry":"a.js","components":[{"id":"a.js","paths":["a.js","b.js"],"bytes":5},{"id":"c.js","paths":["c.js","d.js"],"bytes":12}],"edges":[]}\n';
const all = '{"entry":"a.js","components":[{"id":"a.js","paths":["a.js","b.js"],"bytes":5},{"id":"c.js","paths":["c.js","d.js"],"bytes":12}],"edges":[{"from":"a.js","to":"c.js"}]}\n';

function snapshot(root) {
  const entries = [];
  function walk(dir, relative = '') {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, item.name), full = join(dir, item.name);
      if (item.isDirectory()) { entries.push([path, 'directory']); walk(full, path); }
      else if (item.isFile()) entries.push([path, 'file', readFileSync(full).toString('base64')]);
      else entries.push([path, 'other']);
    }
  }
  walk(root);
  return entries;
}

test('CLI is portable and does not write in foreign working directories or TMPDIR', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(base, 'condensation-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwdList = [join(root, 'foreign space # \u96ea'), join(root, 'other # \u00e9 space')];
  const tmp = join(root, 'child tmp # \u96ea');
  for (const dir of [...cwdList, tmp]) {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'sidecar.bin'), Buffer.from([0, 1, 255, 10]));
  }
  for (const cwd of cwdList) {
    // These files would create a sentinel if a report module were executed.
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
      writeFileSync(join(cwd, name), "require('node:fs').writeFileSync('EXECUTED_SENTINEL', 'bad');\n");
    }
    const beforeCwd = snapshot(cwd), beforeTmp = snapshot(tmp);
    const cases = [
      ['eager', ['eager'], JSON.stringify(report), 0, eager, ''],
      ['all', ['all'], JSON.stringify(report), 0, all, ''],
      ['shape', ['eager'], JSON.stringify({ ...report, modules: null }), 1, '', 'shape\n'],
      ['graph', ['all'], JSON.stringify({ ...report, entry: 'missing' }), 1, '', 'graph\n'],
      ['missing argv', [], JSON.stringify(report), 1, '', 'argv\n'],
      ['extra argv', ['all', 'extra'], JSON.stringify(report), 1, '', 'argv\n'],
      ['unknown mode', ['unknown'], JSON.stringify(report), 1, '', 'argv\n'],
    ];
    for (const [name, args, input, status, stdout, stderr] of cases) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd, input, encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: tmp },
      });
      assert.equal(result.error, undefined, name);
      assert.equal(result.signal, null, name);
      assert.equal(result.status, status, name);
      assert.equal(result.stdout, stdout, name);
      if (name === 'eager') {
        assert.throws(() => assert.equal(result.stdout, eager.replace('"bytes":5', '"bytes":6')), assert.AssertionError);
      }
      assert.equal(result.stderr, stderr, name);
      assert.deepEqual(snapshot(cwd), beforeCwd, `${name}: cwd changed`);
      assert.deepEqual(snapshot(tmp), beforeTmp, `${name}: TMPDIR changed`);
    }
  }
});

test('the exact-output oracle rejects a corrupted expected result', () => {
  assert.throws(() => assert.equal(eager, eager.replace('"bytes":5', '"bytes":6')), assert.AssertionError);
});
