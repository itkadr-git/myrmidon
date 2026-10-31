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
  return { dir, hooks, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
test('enforces SessionStart <= 12 KB, UserPromptSubmit <= 2 KB, 0 bytes on trigger mismatch, and journals byte metrics', async () => {
  const logged = [];
  const items = [
    item('adm/policy/deploy', [], 'Deploy rule body'),
    item('adm/trigger/ssh', ['ssh'], 'SSH rule body'),
  ];
  const { hooks, cleanup } = await setup(items, {
    log: async (entry) => logged.push(entry),
  });
  try {
    const start = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'sess-1' });
    assert.ok(start.bytes <= 12 * 1024);
    assert.equal(start.sessionBytes, start.bytes);

    const mismatch = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'unrelated topic' });
    assert.equal(mismatch.bytes, 0);
    assert.equal(mismatch.context, '');
    assert.equal(mismatch.sessionBytes, start.sessionBytes);

    const match = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'please ssh to server' });
    assert.ok(match.bytes > 0);
    assert.ok(match.bytes <= 2 * 1024);
    assert.equal(match.sessionBytes, start.sessionBytes + match.bytes);

    // Repeated prompt with same trigger -> deduplicated (0 bytes)
    const repeat = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'ssh again' });
    assert.equal(repeat.bytes, 0);
    assert.equal(repeat.sessionBytes, match.sessionBytes);

    assert.equal(logged.length, 4);
    assert.equal(logged[0].event, 'SessionStart');
    assert.equal(logged[1].event, 'UserPromptSubmit');
    assert.equal(logged[1].bytes, 0);
    assert.equal(logged[2].event, 'UserPromptSubmit');
    assert.ok(logged[2].bytes > 0);
    assert.equal(logged[3].bytes, 0);
  } finally { await cleanup(); }
});

test('exercises budget and dedup persistence across process restart and compaction', async () => {
  const items = [
    item('adm/policy/deploy', [], 'Deploy rule body'),
    item('adm/trigger/ssh', ['ssh'], 'SSH rule body'),
    item('adm/trigger/merge', ['merge'], 'Merge rule body'),
  ];
  const { dir, hooks: hooks1, cleanup } = await setup(items);
  try {
    const start1 = await hooks1.run({ hook_event_name: 'SessionStart', session_id: 'session-persist-1' });
    assert.ok(start1.bytes > 0);
    assert.equal(start1.sessionBytes, start1.bytes);

    const prompt1 = await hooks1.run({ hook_event_name: 'UserPromptSubmit', session_id: 'session-persist-1', prompt: 'connect with ssh' });
    assert.ok(prompt1.bytes > 0);
    assert.equal(prompt1.sessionBytes, start1.sessionBytes + prompt1.bytes);

    // Simulate process restart: fresh hooks instance on same stateDir
    const hooks2 = createHooks({
      stateDir: dir,
      load: async () => ({ items, fetchedAt: Date.now(), degraded: false }),
    });

    // Dedup across restart: same trigger prompt yields 0 bytes
    const restartRepeat = await hooks2.run({ hook_event_name: 'UserPromptSubmit', session_id: 'session-persist-1', prompt: 'connect with ssh again' });
    assert.equal(restartRepeat.bytes, 0);
    assert.equal(restartRepeat.sessionBytes, prompt1.sessionBytes);

    // New trigger adds bytes starting from persisted sessionBytes
    const prompt2 = await hooks2.run({ hook_event_name: 'UserPromptSubmit', session_id: 'session-persist-1', prompt: 'please merge this branch' });
    assert.ok(prompt2.bytes > 0);
    assert.equal(prompt2.sessionBytes, prompt1.sessionBytes + prompt2.bytes);

    // Compaction maintains accumulated sessionBytes and excludes trigger index
    const compact = await hooks2.run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'session-persist-1' });
    assert.ok(!compact.context.includes('Trigger index'));
    assert.ok(compact.sessionBytes > prompt2.sessionBytes);
  } finally { await cleanup(); }
});

test('exercises fail-closed warning behavior on budget overflow and omission of oversized bodies', async () => {
  // 1. Mandatory policy overflow fails closed with degraded warning
  const oversizedPolicies = Array.from({ length: 40 }, (_, i) => ({
    ...item(`adm/policy/p${i}`, [], 'policy body '.repeat(100)),
    summary: 'mandatory policy summary '.repeat(20),
  }));
  const { hooks: overflowHooks, cleanup: c1 } = await setup(oversizedPolicies);
  try {
    const res = await overflowHooks.run({ hook_event_name: 'SessionStart', session_id: 'overflow-1' });
    assert.ok(res.bytes <= 12288);
    assert.ok(res.context.includes('fail closed'));
  } finally { await c1(); }

  // 2. Trigger body exceeding 2 KB prompt cap is omitted
  const hugeTriggerItem = item('adm/trigger/ssh', ['ssh'], 'huge body '.repeat(400));
  const { hooks: promptHooks, cleanup: c2 } = await setup([hugeTriggerItem]);
  try {
    const res = await promptHooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'prompt-overflow-1', prompt: 'please ssh' });
    assert.equal(res.bytes, 0);
    assert.equal(res.context, '');
  } finally { await c2(); }
});

test('production hooks invoke createHookLoader() from adapter or option (production hook integration)', async () => {
  const items = [
    item('adm/policy/deploy', [], 'Deploy rule body'),
    item('adm/trigger/ssh', ['ssh'], 'SSH rule body'),
  ];
  let loaderCalled = 0;
  const mockAdapter = {
    createHookLoader() {
      loaderCalled++;
      return async ({ event, triggers }) => {
        return {
          items: items.map(x => ({
            ...x,
            body: event === 'UserPromptSubmit' && triggers.some(t => x.triggers.includes(t)) ? x.body : '',
          })),
          fetchedAt: Date.now(),
          degraded: false,
        };
      };
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'adm-hooks-prod-'));
  try {
    const hooks = createHooks({
      stateDir: dir,
      load: mockAdapter,
    });
    assert.equal(loaderCalled, 1, 'createHooks should call createHookLoader() on adapter');
    const start = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'session-prod-1' });
    assert.ok(start.bytes > 0);
    const submit = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 'session-prod-1', prompt: 'connect with ssh' });
    assert.ok(submit.bytes > 0);
    assert.ok(submit.context.includes('SSH rule body'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
