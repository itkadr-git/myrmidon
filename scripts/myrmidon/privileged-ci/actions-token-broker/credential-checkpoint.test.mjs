import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createSqliteAnchor, provisionSqliteAnchor } from './sqlite-anchor.mjs';
import { createCredentialCheckpoint } from './credential-checkpoint.mjs';

test('interrupted credential mutation fences restart before the database is changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-checkpoint-interrupted-'));
  const path = join(dir, 'credentials.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  const anchor = createSqliteAnchor(anchorPath);
  let store = createCredentialStore(path, key);
  try {
    const checkpoint = await createCredentialCheckpoint(store, anchor, { provision: true });
    await assert.rejects(checkpoint.mutate(async () => { throw new Error('interrupted'); }), /interrupted/);
    store.close();
    store = createCredentialStore(path, key);
    await assert.rejects(createCredentialCheckpoint(store, anchor), /credential checkpoint mismatch/);
  } finally { store.close(); anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent credential checkpoint detects restoring a valid older store after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-checkpoint-'));
  const path = join(dir, 'credentials.sqlite'), snapshot = join(dir, 'snapshot.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  let store = createCredentialStore(path, key), anchor = createSqliteAnchor(anchorPath);
  try {
    await createCredentialCheckpoint(store, anchor, { provision: true });
    store.close(); copyFileSync(path, snapshot);
    store = createCredentialStore(path, key);
    const checkpoint = await createCredentialCheckpoint(store, anchor);
    await store.put('handle', { token: 'fixture' }, 'owner');
    await checkpoint.advance(store);
    store.close(); anchor.close();
    anchor = createSqliteAnchor(anchorPath);
    store = createCredentialStore(path, key);
    await createCredentialCheckpoint(store, anchor);
    store.close(); copyFileSync(snapshot, path);
    store = createCredentialStore(path, key);
    await assert.rejects(createCredentialCheckpoint(store, anchor), /credential checkpoint mismatch/);
  } finally { store.close(); anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});
