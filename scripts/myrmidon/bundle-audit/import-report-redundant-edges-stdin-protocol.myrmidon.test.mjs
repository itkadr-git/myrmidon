import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const sentinel = 'stdin-secret-must-not-leak';
const report = {
  entry: 'root',
  modules: ['root', 'middle', 'end'].map(path => ({ path, bytes: 1, eager: true })),
  edges: [
    { from: 'root', to: 'end', specifier: 'direct', kind: 'eager' },
    { from: 'root', to: 'middle', specifier: 'via', kind: 'eager' },
    { from: 'middle', to: 'end', specifier: 'finish', kind: 'eager' },
  ],
  ignored: sentinel,
};
const valid = JSON.stringify(report);
const expected = JSON.stringify({ entry: 'root', redundant: [{ from: 'root', specifier: 'direct', to: 'end', alternativePath: ['root', 'middle', 'end'] }] }) + '\n';

test('stdin protocol is exact and read-only from two unrelated working directories', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(base, 'redundant-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = join(root, 'child-tmp');
  mkdirSync(tmp);
  const cases = [
    { name: 'EOF', input: '', category: 'json' },
    { name: 'trailing whitespace', input: valid + ' \n\t\r', stdout: expected },
    { name: 'malformed', input: `{"secret":"${sentinel}"`, category: 'json' },
    { name: 'two documents', input: `${valid}\n${valid}`, category: 'json' },
    { name: 'shape', input: JSON.stringify({ entry: sentinel }), category: 'shape' },
    { name: 'graph', input: JSON.stringify({ ...report, entry: sentinel }), category: 'graph' },
    { name: 'valid with extra argv', input: valid, args: ['extra'], category: 'argv' },
    { name: 'argv precedes malformed stdin', input: `{"secret":"${sentinel}"`, args: ['extra'], category: 'argv' },
  ];
  for (const dir of ['one', 'two']) {
    const cwd = join(root, dir);
    mkdirSync(cwd);
    const sidecar = join(cwd, 'sidecar');
    const fixture = join(cwd, 'fixture.json');
    writeFileSync(sidecar, 'do not change\n');
    writeFileSync(fixture, valid);
    for (const item of cases) {
      const result = spawnSync(process.execPath, [cli, ...(item.args || [])], {
        cwd, input: item.input, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TMPDIR: tmp },
      });
      const label = `${dir}: ${item.name}`;
      assert.equal(result.error, undefined, label);
      assert.equal(result.signal, null, label);
      assert.equal(result.status, item.category ? 1 : 0, label);
      assert.equal(result.stdout, item.stdout || '', label);
      assert.equal(result.stderr, item.category ? `${item.category}\n` : '', label);
      assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel), label);
      assert.equal(readFileSync(fixture, 'utf8'), valid, label);
      assert.equal(readFileSync(sidecar, 'utf8'), 'do not change\n', label);
    }
  }
});
