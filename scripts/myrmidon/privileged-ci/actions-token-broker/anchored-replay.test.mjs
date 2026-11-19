import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAnchoredReplayStore } from './anchored-replay.mjs';

test('independent replay anchor rejects restored database and permits restart without rollback', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || homedir(), 'anchored-replay-'));
  const file = join(dir, 'replay.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const key = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = {
    read: async () => ({ ...head }),
    compareAndSet: async (previous, next) => {
      if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
      head = { ...next };
      return true;
    },
  };
  try {
    let store = await createAnchoredReplayStore(file, key, anchor);
    store.close();
    await copyFile(file, snapshot);
    store = await createAnchoredReplayStore(file, key, anchor);
    assert.equal(await store.claimOnce('jti', 2000, 1000), true);
    store.close();
    store = await createAnchoredReplayStore(file, key, anchor);
    assert.equal(await store.claimOnce('jti', 2000, 1001), false);
    assert.equal(await store.claimOnce('other', 2000, 1001), true);
    store.close();
    const db = new DatabaseSync(file);
    db.exec('DELETE FROM replay_events WHERE seq = 2');
    db.close();
    await assert.rejects(createAnchoredReplayStore(file, key, anchor), /anchor mismatch/);
    await copyFile(snapshot, file);
    await assert.rejects(createAnchoredReplayStore(file, key, anchor), /anchor mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
