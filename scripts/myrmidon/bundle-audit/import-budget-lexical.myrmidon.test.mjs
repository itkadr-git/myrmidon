import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const cases = [
  ['line comments', `// import 'fake-line'; require('fake-line-require');\nrequire('real-line');`],
  ['block comments', `/* import 'fake-block'; require('fake-block-require'); */\nimport 'real-block';`],
  ['quoted strings', `const a = "require('fake-double')"; const b = 'import "fake-single"';\nrequire('real-string');`],
  ['template text and expression', "const a = `import 'fake-template' ${require('real-template')}`;"],
  ['nested template expression', "const a = `require('fake-outer') ${`import 'fake-inner' ${require('real-nested')}`}`;"],
  ['regex class and division', String.raw`const pattern = /[\/{}]require('fake-regex')/; const ratio = value / require('real-division') / 2;`],
  ['escaped quotes and backslashes', String.raw`const a = "escaped \" require('fake-quote')"; const b = 'escaped \\ require("fake-backslash")'; require('real-escape');`],
];

for (const [name, source] of cases) {
  test(`CLI ignores lexical fakes: ${name}`, () => {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    const dir = mkdtempSync(join(root, 'import-budget-lexical-'));
    try {
      const entry = join(dir, 'entry.mjs');
      writeFileSync(entry, source);
      const run = spawnSync(process.execPath, [cli, entry], { encoding: 'utf8', timeout: 10000 });
      assert.equal(run.error, undefined);
      assert.equal(run.status, 0);
      assert.equal(run.signal, null);
      assert.equal(run.stderr, '');
      const report = JSON.parse(run.stdout);
      const real = { 'line comments': 'real-line', 'block comments': 'real-block', 'quoted strings': 'real-string', 'template text and expression': 'real-template', 'nested template expression': 'real-nested', 'regex class and division': 'real-division', 'escaped quotes and backslashes': 'real-escape' }[name];
      const expected = [{ from: 'entry.mjs', specifier: real, kind: 'eager', to: null }];
      assert.deepEqual(report.edges, expected);
      assert.deepEqual(report.unknown, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('CLI reads input without executing it', () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'import-budget-execution-'));
  try {
    const marker = join(dir, 'executed');
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const audit = spawnSync(process.execPath, [cli, entry], { encoding: 'utf8', timeout: 10000 });
    assert.equal(audit.error, undefined);
    assert.equal(audit.status, 0);
    assert.equal(audit.signal, null);
    assert.equal(audit.stderr, '');
    const report = JSON.parse(audit.stdout);
    assert.deepEqual(report.edges, []);
    assert.deepEqual(report.unknown, []);
    assert.equal(existsSync(marker), false);

    const control = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000 });
    assert.equal(control.error, undefined);
    assert.equal(control.status, 0);
    assert.equal(control.signal, null);
    assert.equal(control.stdout, '');
    assert.equal(control.stderr, '');
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
