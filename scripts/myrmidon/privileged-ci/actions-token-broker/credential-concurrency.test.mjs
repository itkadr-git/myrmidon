import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createSqliteAnchor, provisionSqliteAnchor } from './sqlite-anchor.mjs';
import { createCredentialCheckpoint, checkpointCredentialStore } from './credential-checkpoint.mjs';

test('lost committed fence prevents a competing owner revoke and restart preserves the handle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-cas-loss-'));
  const path = join(dir, 'credentials.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  const anchor = createSqliteAnchor(anchorPath);
  let first = createCredentialStore(path, key), second;
  try {
    let checkpoint = await createCredentialCheckpoint(first, anchor, { provision: true });
    await checkpointCredentialStore(first, checkpoint).put('handle', { token: 'fixture' }, 'owner');
    second = createCredentialStore(path, key);
    const other = checkpointCredentialStore(second, await createCredentialCheckpoint(second, anchor));
    const lost = {
      read: () => anchor.read(),
      async compareAndSet(previous, next) {
        assert.equal(await anchor.compareAndSet(previous, next), true);
        throw new Error('response lost after durable commit');
      },
    };
    checkpoint = await createCredentialCheckpoint(first, lost);
    const revoked = [];
    await assert.rejects(checkpointCredentialStore(first, checkpoint).withOwned('handle', 'owner', async c => revoked.push(c.token)), /response lost/);
    await assert.rejects(other.withOwned('handle', 'owner', async c => revoked.push(c.token)), /checkpoint fence failed/);
    assert.deepEqual(revoked, []);
    first.close(); first = undefined;
    second.close(); second = undefined;
    first = createCredentialStore(path, key);
    assert.equal(first.hasRetainedCredentials(), true);
    await assert.rejects(createCredentialCheckpoint(first, anchor), /checkpoint mismatch/);
  } finally { first?.close(); second?.close(); anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a rejected owner lookup does not poison the credential checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-owner-rejected-'));
  const path = join(dir, 'credentials.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  const anchor = createSqliteAnchor(anchorPath);
  let store = createCredentialStore(path, key);
  try {
    const wrapped = checkpointCredentialStore(store, await createCredentialCheckpoint(store, anchor, { provision: true }));
    await wrapped.put('handle', { token: 'fixture' }, 'owner');
    await assert.rejects(wrapped.withOwned('handle', 'other', async () => assert.fail('not owner')), /credential not found/);
    await wrapped.withOwned('handle', 'owner', async credential => assert.equal(credential.token, 'fixture'));
    store.close(); store = undefined;
    store = createCredentialStore(path, key);
    await createCredentialCheckpoint(store, anchor);
  } finally { store?.close(); anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent checkpoint writers fence owner revoke while another revoke is in flight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-concurrent-'));
  const path = join(dir, 'credentials.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  const anchor = createSqliteAnchor(anchorPath);
  let first = createCredentialStore(path, key), second;
  try {
    const setup = checkpointCredentialStore(first, await createCredentialCheckpoint(first, anchor, { provision: true }));
    await setup.put('handle', { token: 'fixture' }, 'owner');
    second = createCredentialStore(path, key);
    const competing = checkpointCredentialStore(second, await createCredentialCheckpoint(second, anchor));
    let release, entered;
    const running = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const revoked = [];
    const winning = setup.withOwned('handle', 'owner', async credential => {
      revoked.push(credential.token);
      entered();
      await gate;
    });
    await running;
    try {
      await assert.rejects(competing.withOwned('handle', 'owner', async c => revoked.push(c.token)), /checkpoint fence failed/);
    } finally { release(); }
    await winning;
    assert.deepEqual(revoked, ['fixture']);
    first.close(); first = undefined;
    second.close(); second = undefined;
    first = createCredentialStore(path, key);
    assert.equal(first.hasRetainedCredentials(), false);
    await createCredentialCheckpoint(first, anchor);
  } finally { first?.close(); second?.close(); anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});
