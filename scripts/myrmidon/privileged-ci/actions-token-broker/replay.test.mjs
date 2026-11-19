import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReplayStore } from './replay.mjs';

test('replay claims remain atomic across store instances and reopen', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || homedir(), 'broker-replay-'));
  try {
    const file = join(dir, 'replay.sqlite');
    const a = createReplayStore(file);
    const b = createReplayStore(file);
    assert.deepEqual(await Promise.all([a.claimOnce('jti', 2000, 1000), b.claimOnce('jti', 2000, 1000)]), [true, false]);
    a.close();
    b.close();
    const reopened = createReplayStore(file);
    assert.equal(await reopened.claimOnce('jti', 2000, 1001), false);
    assert.equal(await reopened.claimOnce('jti', 3000, 2000), true);
    assert.equal(await reopened.pruneExpired(1999), 0);
    assert.equal(await reopened.pruneExpired(3000), 1);
    assert.equal(await reopened.claimOnce('jti', 4000, 3000), true);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
