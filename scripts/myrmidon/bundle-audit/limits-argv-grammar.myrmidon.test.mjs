import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const report = JSON.stringify({ modules: [], counts: { eagerModules: 0 }, bytes: { eager: 0 } });
const invalidReport = 'INVALID_STDIN_SENTINEL';
const run = (argv, input) => spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8', timeout: 10000 });

test('decimal budgets accept both orders, leading zeroes and safe boundaries', () => {
  const cases = [
    [['--max-eager-bytes', '0', '--max-eager-modules', '0'], 0, 0],
    [['--max-eager-modules', '0002', '--max-eager-bytes', '00001'], 1, 2],
    [['--max-eager-bytes', '9007199254740991', '--max-eager-modules', '9007199254740991'], 9007199254740991, 9007199254740991],
    [['--max-eager-modules', '9007199254740991', '--max-eager-bytes', '000'], 0, 9007199254740991],
  ];
  for (const [argv, bytes, modules] of cases) {
    const result = run(argv, report);
    assert.equal(result.status, 0, JSON.stringify(argv));
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify({ ok: true, eagerBytes: 0, eagerModules: 0, maxEagerBytes: bytes, maxEagerModules: modules, violations: [] })}\n`);
    const badInput = run(argv, invalidReport);
    assert.equal(badInput.status, 2, JSON.stringify(argv));
    assert.equal(badInput.stdout, '');
    assert.equal(badInput.stderr, 'report error\n');
  }
});

test('invalid argv takes precedence over invalid stdin and never echoes it', () => {
  const bytes = '--max-eager-bytes';
  const modules = '--max-eager-modules';
  const cases = [
    [], [bytes, '1'], [bytes, '1', modules], [bytes, '1', bytes, '2'],
    [modules, '1', modules, '2'], ['--unknown', '1', modules, '1'],
    [bytes, '1', modules, '1', 'extra'], [bytes, '1', modules, '1', '--unknown'],
    ...['', '-1', '+1', ' 1', '1 ', '\t1', '1e2', '0x10', '1.0', '9007199254740992'].flatMap(value => [
      [bytes, value, modules, '1'], [modules, value, bytes, '1'],
    ]),
  ];
  for (const argv of cases) {
    for (const input of [report, invalidReport]) {
      const result = run(argv, input);
      const label = `${JSON.stringify(argv)} with ${input === report ? 'valid' : 'invalid'} stdin`;
      assert.equal(result.status, 2, label);
      assert.equal(result.stdout, '', label);
      assert.equal(result.stderr, 'argv error\n', label);
      assert.ok(!result.stderr.includes(invalidReport), label);
    }
  }
});
