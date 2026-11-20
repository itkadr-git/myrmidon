import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const sentinel = 'SENTINEL_PRIVATE_INPUT_7421';
const valid = JSON.stringify({ modules: [], edges: [], counts: { modules: 0, eagerModules: 0, edges: 0 }, bytes: { total: 0, eager: 0 } });

test('stdin protocol and error precedence from independent working directories', async t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'summary-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const cases = [
    { name: 'empty EOF', input: '', error: 'Invalid JSON' },
    { name: 'whitespace only', input: ' \t\r\n', error: 'Invalid JSON' },
    { name: 'truncated JSON', input: `{"secret":"${sentinel}`, error: 'Invalid JSON' },
    { name: 'two JSON documents', input: `${valid}\n${JSON.stringify(sentinel)}`, error: 'Invalid JSON' },
    { name: 'extra argument precedes malformed JSON', input: `${sentinel}{`, args: ['unexpected'], error: 'Invalid arguments' },
    { name: 'valid JSON with invalid report shape', input: JSON.stringify({ secret: sentinel }), error: 'Invalid report' },
    { name: 'valid report with whitespace suffix', input: `${valid} \t\r\n`, error: null },
  ];
  for (const cwdName of ['first', 'second']) {
    const cwd = join(root, cwdName);
    mkdirSync(cwd);
    for (const fixture of cases) {
      await t.test(`${cwdName}: ${fixture.name}`, () => {
        const result = spawnSync(process.execPath, [cli, ...(fixture.args || [])], {
          cwd, input: fixture.input, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, TMPDIR: temp },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, fixture.error ? 1 : 0);
        if (fixture.error) {
          assert.equal(result.stdout, '');
          assert.equal(result.stderr, `Error: ${fixture.error}\n`);
          assert.equal((result.stdout + result.stderr).includes(sentinel), false);
        } else {
          assert.equal(result.stderr, '');
          assert.match(result.stdout, /^## Import report summary\n/);
          assert.ok(result.stdout.endsWith('\n'));
        }
      });
    }
  }
});
