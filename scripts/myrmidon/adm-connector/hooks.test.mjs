import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHooks, classify } from './hooks.mjs';
const item = (slug, triggers = [], body = 'Full rule') => ({ slug, title: slug, summary: 'Short policy', revision_id: 'r1', status: 'published', priority: 50, updated_at: '2026-10-27T00:00:00Z', triggers, body });
async function setup(items, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'adm-hooks-'));
  const hooks = createHooks({ stateDir: dir, load: async () => ({ items, fetchedAt: Date.now(), degraded: false }), ...extra });
  return { hooks, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
test('session summaries only, compaction excludes trigger index and bodies', async () => {
  const { hooks, cleanup } = await setup([item('adm/policy/security', [], 'SECRET BODY'), item('adm/trigger/ssh', ['ssh'])]);
  try {
    const first = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'one' });
    assert.ok(first.context.includes('Short policy'));
    assert.ok(first.context.includes('ssh'));
    assert.ok(!first.context.includes('SECRET BODY'));
    const compact = await hooks.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'one' });
    assert.ok(!compact.context.includes('Trigger index'));
    assert.ok(compact.sessionBytes > first.sessionBytes);
  } finally { await cleanup(); }
});
test('zero unmatched, persisted slug/revision dedup and revised rule delivered', async () => {
  const items = [item('adm/trigger/ssh', ['ssh'])];
  const { hooks, cleanup } = await setup(items);
  try {
    assert.equal((await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: '../one', prompt: 'hello' })).bytes, 0);
    const event = { hook_event_name: 'UserPromptSubmit', session_id: '../one', prompt: 'ssh host' };
    assert.ok((await hooks.run(event)).bytes > 0);
    assert.equal((await hooks.run(event)).bytes, 0);
    items[0].revision_id = 'r2';
    assert.ok((await hooks.run(event)).bytes > 0);
  } finally { await cleanup(); }
});
test('UTF8 hard budgets, mandatory policy overflow fails closed; no partial rule', async () => {
  const { hooks, cleanup } = await setup(Array.from({ length: 60 }, (_, i) => item(`adm/policy/p${i}`, [], 'я'.repeat(10000))).map(x => ({ ...x, summary: 'я'.repeat(300) })));
  try {
    const result = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'one' });
    assert.ok(result.bytes <= 12288);
    assert.ok(result.context.includes('fail closed'));
  } finally { await cleanup(); }
});
test('degraded cache signal includes age, no match stays zero', async () => {
  const { hooks, cleanup } = await setup([], { load: async () => ({ items: [item('adm/trigger/ssh', ['ssh'])], fetchedAt: Date.now() - 5000, degraded: true }) });
  try {
    assert.equal((await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'hi' })).context, '');
    const result = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'ssh' });
    assert.match(result.context, /knowledge degraded; cache age=\d+s/);
    assert.ok(result.bytes <= 2048);
  } finally { await cleanup(); }
});
test('trigger boundary does not match scholarship or deploymentless', () => {
  assert.deepEqual(classify('scholarship deploymentless'), []);
  assert.ok(classify('Выкат релиза и SSH').includes('deploy'));
});
