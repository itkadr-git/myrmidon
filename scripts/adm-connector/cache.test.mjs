import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AdmCache } from './cache.mjs';

const item = { schema_version: 1, status: 'published', sensitivity: 'internal', kind: 'rule', approver_kind: 'owner', slug: 'adm/policy/change-control', id: 'item-1', revision_id: 'rev-1', title: 'Change control', summary: 'Require approval', body: 'Full policy' };
async function fixture(t, options = {}) {
  const scratch = process.env.TMPDIR && !/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(process.env.TMPDIR)
    ? process.env.TMPDIR : join(homedir(), '.cache', 'adm-connector-tests');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const profileDir = await mkdtemp(join(scratch, 'adm-cache-test-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  return new AdmCache({ profileDir, company: 'company', space: 'adm', integrityKey: 'test-only-integrity-key-32-characters', timeoutMs: 10, ...options });
}
test('fresh refresh persists a private, versioned manifest and body checksum', async t => {
  const cache = await fixture(t);
  const result = await cache.read({ fetchItems: async () => [item] });
  assert.equal(result.mode, 'fresh');
  const stored = JSON.parse(await readFile(cache.file, 'utf8'));
  assert.equal(stored.manifest.items[0].id, item.id);
  assert.equal(stored.manifest.items[0].revision, item.revision_id);
  assert.match(stored.manifest.items[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal((await stat(cache.file)).mode & 0o777, 0o600);
  assert.equal((await stat(cache.directory)).mode & 0o777, 0o700);
});
const unavailable = async () => { throw new Error('upstream private detail'); };
test('timeout aborts the request and uses validated cache with age', async t => {
  let now = 1000;
  const events = [];
  const cache = await fixture(t, { now: () => now, metric: event => events.push(event) });
  await cache.read({ fetchItems: async () => [item] });
  now += 100;
  let signal;
  const result = await cache.read({ fetchItems: s => { signal = s; return new Promise(() => {}); } });
  assert.equal(signal.aborted, true);
  assert.equal(result.mode, 'stale-read');
  assert.equal(result.ageMs, 100);
  assert.equal(result.warning, 'knowledge degraded');
  assert(events.some(e => e.name === 'cache_stale'));
});
test('expired cache is readable but cannot authorize a hazardous action', async t => {
  let now = 1000;
  const cache = await fixture(t, { now: () => now, maxAgeMs: 100 });
  await cache.read({ fetchItems: async () => [item] });
  now += 101;
  assert.equal((await cache.read({ fetchItems: unavailable })).mode, 'stale-read');
  const denied = await cache.read({ fetchItems: unavailable, hazardous: true });
  assert.equal(denied.mode, 'fail-closed');
  assert.equal(denied.hazardousAllowed, false);
  assert.deepEqual(denied.items, []);
});
test('missing, truncated, tampered and wrong-signature cache fail closed', async t => {
  const cache = await fixture(t);
  assert.equal((await cache.read({ fetchItems: unavailable })).mode, 'fail-closed');
  await cache.atomic(cache.healthFile, { failures: 0, nextAttempt: 0 });
  await cache.read({ fetchItems: async () => [item] });
  const good = await readFile(cache.file, 'utf8');
  for (const corrupt of ['{', good.replace('Full policy', 'Altered body'), good.replace('"signature":"', '"signature":"bad')]) {
    await writeFile(cache.file, corrupt, { mode: 0o600 });
    assert.equal((await cache.read({ fetchItems: unavailable })).mode, 'fail-closed');
  }
});
test('backoff and circuit state survive a connector restart; recovery resets them', async t => {
  let now = 1000, calls = 0;
  const cache = await fixture(t, { now: () => now, backoffMs: 10, breakerMs: 100, breakerThreshold: 2 });
  const fail = async () => { calls++; throw new Error('offline'); };
  await cache.read({ fetchItems: fail });
  await cache.read({ fetchItems: fail });
  assert.equal(calls, 1);
  now += 10;
  await cache.read({ fetchItems: fail });
  assert.equal(calls, 2);
  const restarted = new AdmCache({ profileDir: cache.directory.split('/adm-connector/')[0], company: 'company', space: 'adm',
    integrityKey: 'test-only-integrity-key-32-characters', now: () => now });
  await restarted.read({ fetchItems: fail });
  assert.equal(calls, 2);
  now += 100;
  assert.equal((await cache.read({ fetchItems: async () => [item] })).mode, 'fresh');
  assert.deepEqual(await cache.health(), { failures: 0, nextAttempt: 0 });
});
test('failed atomic refresh preserves last good snapshot and removes temporary files', async t => {
  const cache = await fixture(t);
  await cache.read({ fetchItems: async () => [item] });
  const before = await readFile(cache.file, 'utf8');
  const circular = {}; circular.self = circular;
  await assert.rejects(cache.atomic(cache.file, circular));
  assert.equal(await readFile(cache.file, 'utf8'), before);
  const { readdir } = await import('node:fs/promises');
  assert(!(await readdir(cache.directory)).some(f => f.endsWith('.tmp')));
});
test('deferred proposals have TTL and cannot publish; secrets are rejected', async t => {
  const cache = await fixture(t, { now: () => 1000 });
  const result = await cache.defer({ base_revision: 'r1', idempotency_key: 'proposal-1', body: 'Update summary' }, { ttlMs: 500 });
  assert.equal(result.mode, 'write-deferred');
  assert.equal(result.publishable, false);
  assert.equal(result.requires_owner_review, true);
  assert.equal(result.expires_at, 1500);
  await assert.rejects(cache.defer({ base_revision: 'r1', idempotency_key: 'bad', body: 'Bearer confidential' }));
});
test('bad metadata cannot replace the good cache; logs do not contain bodies or upstream errors', async t => {
  const events = [];
  const cache = await fixture(t, { metric: event => events.push(event) });
  await cache.read({ fetchItems: async () => [item] });
  assert.equal((await cache.read({ fetchItems: async () => [{ ...item, summary: 'x'.repeat(301) }] })).mode, 'stale-read');
  assert(!JSON.stringify(events).includes('Full policy'));
  assert(!JSON.stringify(events).includes('private detail'));
});
test('context budgets, no-match silence, revision dedup and compaction summary', async t => {
  const { ContextDelivery } = await import('./context.mjs');
  const events = [];
  const cache = await fixture(t, { metric: e => events.push(e) });
  const delivery = new ContextDelivery(cache, 'session-1');
  const items = [{ ...item, triggers: ['deploy'] }, { ...item, slug: 'adm/reference/deploy', triggers: ['deploy'] }];
  const start = await delivery.deliver({ items, phase: 'SessionStart' });
  assert(start.bytes <= 12 * 1024);
  assert(!start.context.includes('Full policy'));
  assert(start.context.includes('triggers'));
  assert.equal((await delivery.deliver({ items, phase: 'UserPromptSubmit', triggers: [] })).bytes, 0);
  const matched = await delivery.deliver({ items, phase: 'UserPromptSubmit', triggers: ['deploy'] });
  assert(matched.bytes > 0 && matched.bytes <= 2 * 1024);
  const restarted = new ContextDelivery(cache, 'session-1');
  assert.equal((await restarted.deliver({ items, phase: 'UserPromptSubmit', triggers: ['deploy'] })).bytes, 0);
  const compact = await restarted.deliver({ items, phase: 'UserPromptSubmit', compacted: true });
  assert(compact.context.includes('adm/policy/'));
  assert(!compact.context.includes('adm/reference/'));
  const changed = items.map(i => ({ ...i, revision_id: 'rev-2' }));
  assert((await restarted.deliver({ items: changed, phase: 'UserPromptSubmit', triggers: ['deploy'] })).bytes > 0);
  assert(events.some(e => e.name === 'context_bytes' && e.messageBytes === 0));
  const journal = await readFile(join(cache.directory, 'journal.jsonl'), 'utf8');
  assert(journal.includes('messageBytes'));
  assert(!journal.includes('Full policy'));
});
test('mandatory policies exceeding context budget fail closed rather than silently disappearing', async t => {
  const { ContextDelivery } = await import('./context.mjs');
  const cache = await fixture(t);
  const items = Array.from({ length: 50 }, (_, n) => ({ ...item, slug: `adm/policy/p-${n}`, summary: 'я'.repeat(300) }));
  await assert.rejects(new ContextDelivery(cache, 'session').deliver({ items, phase: 'SessionStart' }), /ADM_BUDGET_EXCEEDED/);
});
