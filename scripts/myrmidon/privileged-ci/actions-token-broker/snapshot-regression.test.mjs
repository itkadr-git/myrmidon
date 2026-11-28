import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthenticatedAudit, createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';
import { createSqliteAnchor, provisionSqliteAnchor } from './sqlite-anchor.mjs';

test('valid older audit snapshot passes HMAC alone but fails against independent head', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-snapshot-rollback-'));
  const path = join(dir, 'audit.sqlite'), snapshot = join(dir, 'snapshot.sqlite'), key = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = {
    async read() { return { ...head }; },
    async compareAndSet(previous, next) {
      if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
      head = { ...next }; return true;
    },
  };
  try {
    let audit = await createAsyncAuthenticatedAudit(path, key, anchor);
    await audit.record('issued');
    audit.close();
    copyFileSync(path, snapshot);
    audit = await createAsyncAuthenticatedAudit(path, key, anchor);
    await audit.record('revoked');
    audit.close();
    copyFileSync(snapshot, path);
    const unanchored = createAuthenticatedAudit(path, key);
    unanchored.close();
    await assert.rejects(createAsyncAuthenticatedAudit(path, key, anchor), /anchor mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restoring a valid audit snapshot fails after the separate durable anchor restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-durable-snapshot-'));
  const path = join(dir, 'audit.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const anchorPath = join(dir, 'anchor.sqlite'), key = randomBytes(32);
  try {
    provisionSqliteAnchor(anchorPath);
    let anchor = createSqliteAnchor(anchorPath);
    let audit = await createAsyncAuthenticatedAudit(path, key, anchor);
    await audit.record('issued');
    audit.close();
    copyFileSync(path, snapshot);
    audit = await createAsyncAuthenticatedAudit(path, key, anchor);
    await audit.record('revoked');
    audit.close();
    anchor.close();
    copyFileSync(snapshot, path);
    anchor = createSqliteAnchor(anchorPath);
    try {
      const unanchored = createAuthenticatedAudit(path, key);
      unanchored.close();
      await assert.rejects(createAsyncAuthenticatedAudit(path, key, anchor), /anchor mismatch/);
    } finally { anchor.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
