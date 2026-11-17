import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-lazy-boundaries.mjs', import.meta.url).pathname;

test('subdividing a lazy edge includes the eager descendant in the lazy closure', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-edge-'));
  try {
    const path = join(dir, 'report.json');
    const fixture = {
      entry: 'entry',
      modules: [
        { path: 'entry', bytes: 1, eager: true },
        { path: 'intermediate', bytes: 3, eager: false },
        { path: 'target', bytes: 7, eager: false },
      ],
      edges: [
        { from: 'entry', specifier: './intermediate', kind: 'lazy', to: 'intermediate' },
        { from: 'intermediate', specifier: './target', kind: 'eager', to: 'target' },
      ],
    };
    writeFileSync(path, JSON.stringify(fixture));
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify({ entry: 'entry', boundaries: [
      { from: 'entry', specifier: './intermediate', to: 'intermediate', bytes: 10 },
    ] })}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
