import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, hookRest } from './adm-context-hook.mjs';
test('REST hook bounds context, persists dedup, restores summaries and journals exact bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adm-hook-'));
  const policy = { id: 'p', slug: 'adm/policy/security', title: 'Security', summary: 'Require approval.', status: 'published', deliveredRevisionId: 'r1', content: 'FULL_BODY_NEVER_DELIVERED', triggers: ['deploy'] };
  const trigger = { ...policy, id: 't', slug: 'adm/trigger/deploy', title: 'Deploy', summary: 'Check release.' };
  const requests = [];
  const rest = hookRest({ baseUrl: 'https://board.example', companyId: 'company', key: 'synthetic', fetchImpl: async url => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('/items/') ? { item: url.endsWith('/p') ? policy : trigger } : { items: [policy, trigger] } };
  } });
  const args = { sessionId: 'session-a', stateDir: root, logPath: join(root, 'metrics.jsonl'), rest };
  try {
    const start = await runHook({ ...args, event: 'SessionStart' });
    assert.ok(Buffer.byteLength(start) <= 12288); assert.ok(!start.includes('FULL_BODY'));
    assert.equal(JSON.parse(start).find(i => i.slug.includes('/trigger/')).summary, '');
    const before = requests.length;
    assert.equal(await runHook({ ...args, event: 'UserPromptSubmit', prompt: 'hello' }), '');
    assert.equal(requests.length, before);
    const first = await runHook({ ...args, event: 'UserPromptSubmit', prompt: 'deploy' });
    assert.ok(first.length > 0 && Buffer.byteLength(first) <= 2048);
    assert.ok(requests.some(u => u.includes('/search?q=deploy')));
    assert.ok(requests.some(u => u.endsWith('/items/t')));
    assert.equal(await runHook({ ...args, event: 'UserPromptSubmit', prompt: 'deploy' }), '');
    const restored = JSON.parse(await runHook({ ...args, event: 'PreCompact' }));
    assert.equal(restored.length, 1); assert.equal(restored[0].slug, policy.slug);
    assert.equal(await runHook({ ...args, event: 'UserPromptSubmit', prompt: 'deploy' }), '');
    assert.ok((await runHook({ ...args, sessionId: 'session-b', event: 'UserPromptSubmit', prompt: 'deploy' })).length > 0);
    const metrics = readFileSync(args.logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(metrics[2].bytesAdded, Buffer.byteLength(first));
    assert.equal(metrics[2].sessionBytes, Buffer.byteLength(start) + Buffer.byteLength(first));
    assert.equal(metrics[3].bytesAdded, 0);
    policy.summary = '';
    await assert.rejects(runHook({ ...args, event: 'SessionStart' }), /summary required/);
    delete policy.summary;
    await assert.rejects(runHook({ ...args, event: 'SessionStart' }), /summary required/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
