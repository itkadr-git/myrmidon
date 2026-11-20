import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceScripts = fileURLToPath(new URL('../../', import.meta.url));
const originalCli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const sentinel = 'SENTINEL_transport_8f2';
const report = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 3, eager: true },
    { path: 'unused', bytes: 7, eager: false },
  ],
  edges: [],
};
const expected = '{"entry":"entry","layers":[{"depth":0,"paths":["entry"],"bytes":3}],"unreachable":["unused"]}\n';

test('CLI transport and diagnostics are independent of cwd and URL-encoded script paths', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'layers-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plainCwd = join(root, 'foreign-cwd');
  const specialCwd = join(root, 'foreign cwd # 100%');
  const copiedScripts = join(root, 'copy scripts # 100%', 'scripts');
  mkdirSync(plainCwd, { recursive: true });
  mkdirSync(specialCwd, { recursive: true });
  cpSync(sourceScripts, copiedScripts, { recursive: true });
  const copiedCli = fileURLToPath(pathToFileURL(join(copiedScripts, 'myrmidon', 'bundle-audit', 'import-report-layers.mjs')));
  const cases = [
    ['valid', JSON.stringify(report), [], 0, expected, ''],
    ['empty', '', [], 1, '', 'json\n'],
    ['truncated', `{"${sentinel}":`, [], 1, '', 'json\n'],
    ['two documents', `{} {"${sentinel}":1}`, [], 1, '', 'json\n'],
    ['argv before json', `{"${sentinel}":`, [sentinel], 1, '', 'argv\n'],
    ['shape', JSON.stringify({ ...report, entry: '', sentinel }), [], 1, '', 'shape\n'],
    ['dangling edge', JSON.stringify({ ...report, edges: [{ from: 'entry', to: sentinel, kind: 'eager', specifier: sentinel }] }), [], 1, '', 'graph\n'],
  ];
  for (const cli of [originalCli, copiedCli]) {
    for (const cwd of [plainCwd, specialCwd]) {
      for (const [name, input, args, status, stdout, stderr] of cases) {
        const result = spawnSync(process.execPath, [cli, ...args], {
          cwd, input, encoding: 'utf8', timeout: 5000,
          env: { ...process.env, TMPDIR: root },
        });
        const context = `${name}; cli=${cli}; cwd=${cwd}`;
        assert.equal(result.error, undefined, context);
        assert.equal(result.signal, null, context);
        assert.equal(result.status, status, context);
        assert.equal(result.stdout, stdout, context);
        assert.equal(result.stderr, stderr, context);
        assert.equal(result.stderr.includes(sentinel), false, context);
      }
    }
  }
});
