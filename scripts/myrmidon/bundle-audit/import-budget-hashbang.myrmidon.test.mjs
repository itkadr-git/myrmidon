import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-budget.mjs', import.meta.url).pathname;
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache');

function check(entry, child, edges) {
  const dir = mkdtempSync(join(scratch, 'import-hashbang-'));
  try {
    const marker = join(dir, 'executed');
    entry = entry.replaceAll('MARKER_PATH', JSON.stringify(marker));
    writeFileSync(join(dir, 'entry.mjs'), entry);
    if (child !== null) writeFileSync(join(dir, 'child.mjs'), child);
    const run = () => spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    const first = run(), second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(existsSync(marker), false);
    const report = JSON.parse(first.stdout);
    const modules = [{ path: 'entry.mjs', bytes: Buffer.byteLength(entry), eager: true }];
    if (child !== null) modules.unshift({ path: 'child.mjs', bytes: Buffer.byteLength(child), eager: true });
    const total = modules.reduce((sum, item) => sum + item.bytes, 0);
    assert.deepEqual(report, {
      entry: 'entry.mjs', modules, edges,
      unknown: edges.filter(edge => edge.to === null),
      counts: { modules: modules.length, eagerModules: modules.length, edges: edges.length },
      bytes: { total, eager: total },
      heaviestEager: [...modules].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)),
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const child = 'export default 1;';
const childEdge = { from: 'entry.mjs', specifier: './child.mjs', kind: 'eager', to: 'child.mjs' };
const hashbang = "#!/usr/bin/env -S node require('phantom-package')";

for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`CLI ignores ${label} hashbang but scans following import and does not execute input`, () => {
    check(`${hashbang}${newline}import './child.mjs';${newline}require('node:fs').writeFileSync(MARKER_PATH, 'bad');`, child, [childEdge]);
  });
  test(`CLI scans require following ${label} hashbang`, () => {
    check(`${hashbang}${newline}require('./child.mjs');`, child, [childEdge]);
  });
}

test('CLI ignores a hashbang without a final newline', () => {
  check(hashbang, null, []);
});

test('CLI scans code after an ordinary string containing hashbang', () => {
  check(`const text = "#! require('phantom-package')"; import './child.mjs';`, child, [childEdge]);
});

test('CLI does not discard code after hashbang outside the initial position', () => {
  check(`; #! require('real-package'); import './child.mjs';`, child, [childEdge, { from: 'entry.mjs', specifier: 'real-package', kind: 'eager', to: null }]);
});

test('CLI does not treat a hashbang in a template expression as an initial hashbang', () => {
  check("const value = `${#! require('real-package')}`;", null, [{ from: 'entry.mjs', specifier: 'real-package', kind: 'eager', to: null }]);
});
