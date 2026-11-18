import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-budget.mjs', import.meta.url).pathname;
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();

function runAudit(source) {
  return spawnSync(process.execPath, [cli, source], { encoding: 'utf8', timeout: 5000 });
}

const syntax = [
  ['side-effect import', "import 'fixture-package';", 'eager'],
  ['default import', "import value from 'fixture-package';", 'eager'],
  ['named import', "import { value } from 'fixture-package';", 'eager'],
  ['namespace import', "import * as value from 'fixture-package';", 'eager'],
  ['named export', "export { value } from 'fixture-package';", 'eager'],
  ['star export', "export * from 'fixture-package';", 'eager'],
  ['literal require', "require('fixture-package');", 'eager'],
  ['dynamic import with options', "import('fixture-package', { with: { type: 'json' } });", 'lazy'],
];

for (const [name, source, kind] of syntax) {
  test(`CLI recognizes ${name}`, () => {
    const dir = mkdtempSync(join(scratchRoot, 'import-budget-syntax-'));
    try {
      const marker = join(dir, 'executed');
      const entry = join(dir, 'entry.mjs');
      writeFileSync(entry, `${source}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
      const run = runAudit(entry);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, '');
      const report = JSON.parse(run.stdout);
      const expected = [{ from: 'entry.mjs', specifier: 'fixture-package', kind, to: null }];
      assert.deepEqual(report.edges, expected);
      assert.deepEqual(report.unknown, expected);
      assert.equal(report.counts.edges, 1);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('CLI deduplicates by source, specifier and kind and ignores computed and member calls', () => {
  const dir = mkdtempSync(join(scratchRoot, 'import-budget-identity-'));
  try {
    const put = (name, text) => writeFileSync(join(dir, name), text);
    put('entry.mjs', `
      import './second.mjs';
      require('shared-package'); require('shared-package');
      import('shared-package'); import('shared-package');
      require(variable); import(variable);
      obj.require('not-a-dependency'); obj.import('not-a-dependency');
    `);
    put('second.mjs', "require('shared-package');");
    const run = runAudit(join(dir, 'entry.mjs'));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.edges, [
      { from: 'entry.mjs', specifier: './second.mjs', kind: 'eager', to: 'second.mjs' },
      { from: 'entry.mjs', specifier: 'shared-package', kind: 'eager', to: null },
      { from: 'entry.mjs', specifier: 'shared-package', kind: 'lazy', to: null },
      { from: 'second.mjs', specifier: 'shared-package', kind: 'eager', to: null },
    ]);
    assert.deepEqual(report.unknown, [
      { from: 'entry.mjs', specifier: 'shared-package', kind: 'eager', to: null },
      { from: 'entry.mjs', specifier: 'shared-package', kind: 'lazy', to: null },
      { from: 'second.mjs', specifier: 'shared-package', kind: 'eager', to: null },
    ]);
    assert.equal(report.counts.edges, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
