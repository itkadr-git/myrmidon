import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireExclusiveStore } from './exclusive.mjs';

test('credential path symlink cannot bypass the owner lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-exclusive-'));
  try {
    const path = join(dir, 'credentials.sqlite');
    const alias = join(dir, 'alias.sqlite');
    writeFileSync(path, '');
    symlinkSync(path, alias);
    const release = acquireExclusiveStore(path);
    try { assert.throws(() => acquireExclusiveStore(alias), /ownership unavailable/); }
    finally { release(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
