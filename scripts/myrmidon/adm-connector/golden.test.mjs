import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHooks, classify, TRIGGERS } from './hooks.mjs';
import { restLoader } from './cli.mjs';
const rows = JSON.parse(await readFile(new URL('./golden.json', import.meta.url), 'utf8'));
test('50 source-linked real operational messages: classification, hard cap and zero unmatched', async () => {
  assert.equal(rows.length, 50);
  const dir = await mkdtemp(join(tmpdir(), 'adm-golden-'));
  const metrics = [];
  const items = Object.keys(TRIGGERS).map(t => ({ slug: `adm/trigger/${t}`, revision_id: 'r1', title: t, summary: 'Safety checks', triggers: [t], priority: 80, updated_at: '2026-10-27T00:00:00Z', status: 'published', body: 'Проверь разрешения. '.repeat(8) }));
  const hooks = createHooks({ stateDir: dir, load: async () => ({ items, fetchedAt: Date.now() }), log: async row => metrics.push(row) });
  try {
    for (const [i, row] of rows.entries()) {
      assert.deepEqual(classify(row.prompt), row.expected, row.source);
      const result = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: `golden-${i}`, prompt: row.prompt });
      assert.equal(result.bytes, Buffer.byteLength(result.context));
      assert.ok(result.bytes <= 2048, row.source);
      if (!row.expected.length) assert.equal(result.bytes, 0, row.source);
      else assert.ok(result.bytes > 0, row.source);
    }
    assert.equal(metrics.length, 50);
    assert.ok(metrics.every(m => m.bytes === m.sessionBytes));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('REST shape and approved revision path; no policy body reads at startup', async () => {
  const requests = [];
  const loader = restLoader({ baseUrl: 'https://board.invalid', companyId: 'company', token: 'test', fetchImpl: async url => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('/revisions/') ? { revision: { id: 'r1', status: 'approved', content: 'Rule body' } } : { items: [{ id: 'item', slug: 'adm/trigger/ssh', title: 'SSH', summary: 'Check identity', status: 'published', deliveredRevisionId: 'r1', updatedAt: '2026-10-27T00:00:00Z', tags: ['ssh'] }] } };
  } });
  const start = await loader({ event: 'SessionStart', triggers: [] });
  assert.equal(requests.length, 1);
  assert.equal(start.items[0].body, '');
  const prompt = await loader({ event: 'UserPromptSubmit', triggers: ['ssh'] });
  assert.equal(prompt.items[0].body, 'Rule body');
  assert.ok(requests[2].endsWith('/items/item/revisions/r1'));
});
test('priority and namespace sorting, oversized trigger omitted whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-order-'));
  const make = (slug, priority, body) => ({ slug, title: slug, summary: '', triggers: ['ssh'], revision_id: 'r1', status: 'published', updated_at: '2026-10-27T00:00:00Z', priority, body });
  try {
    const hooks = createHooks({ stateDir: dir, load: async () => ({ fetchedAt: Date.now(), items: [make('adm/reference/a', 100, 'REF'), make('adm/trigger/low', 1, 'LOW'), make('adm/trigger/high', 100, 'HIGH'), make('adm/policy/a', 1, 'POLICY'), make('adm/trigger/huge', 99, 'я'.repeat(3000))] }) });
    const r = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'ssh' });
    assert.ok(r.context.indexOf('POLICY') < r.context.indexOf('HIGH'));
    assert.ok(r.context.indexOf('HIGH') < r.context.indexOf('LOW'));
    assert.ok(r.context.indexOf('LOW') < r.context.indexOf('REF'));
    assert.ok(!r.context.includes('adm/trigger/huge'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
