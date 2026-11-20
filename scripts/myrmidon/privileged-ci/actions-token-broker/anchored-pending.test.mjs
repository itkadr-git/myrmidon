import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';

test('anchored pending issuance prevents startup after local reservation is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-pending-'));
  const path = join(dir, 'audit.sqlite'), key = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = {
    async read() { return { ...head }; },
    async compareAndSet(previous, next) {
      if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
      head = { ...next }; return true;
    },
  };
  try {
    const audit = await createAsyncAuthenticatedAudit(path, key, anchor);
    await audit.record('issuance_pending');
    audit.close();
    await assert.rejects(createAsyncAuthenticatedAudit(path, key, anchor), /pending issuance/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
