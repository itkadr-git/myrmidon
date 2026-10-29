#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHooks, TRIGGERS } from './hooks.mjs';
import { getRolloutState, MODES } from './rollout.mjs';

/** REST only. Cache D can replace this load port with a verified snapshot. */
export function restLoader({ baseUrl, companyId, token, fetchImpl = fetch }) {
  const root = `${baseUrl.replace(/\/$/, '')}/api/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge`;
  async function get(path) {
    const response = await fetchImpl(root + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Knowledge REST unavailable');
    return response.json();
  }
  return async ({ event, triggers }) => {
    // List is metadata-only. Read revision bodies only for prompt matches, never at startup.
    const { items } = await get('/items?space=adm%2F&status=published&limit=100');
    if (!Array.isArray(items) || items.length >= 100) throw new Error('Incomplete knowledge index');
    const normalized = [];
    for (const item of items) {
      if (!item.slug.startsWith('adm/') || item.status !== 'published') continue;
      const itemTriggers = item.triggers ?? (item.tags ?? []).map(t => t.replace(/^trigger:/, '')).filter(t => t in TRIGGERS);
      let body = '';
      if (event === 'UserPromptSubmit' && itemTriggers.some(t => triggers.includes(t))) {
        const result = await get(`/items/${encodeURIComponent(item.id)}/revisions/${encodeURIComponent(item.deliveredRevisionId)}`);
        if (result.revision?.id !== item.deliveredRevisionId || result.revision.status !== 'approved') throw new Error('Unpublished revision');
        body = result.revision.content;
      }
      normalized.push({ ...item, summary: item.summary ?? '', triggers: itemTriggers, priority: item.priority ?? 0, revision_id: item.deliveredRevisionId, updated_at: item.updatedAt, body });
    }
    return { items: normalized, fetchedAt: Date.now(), degraded: false };
  };
}
export async function main() {
  const dir = process.env.ADM_CONNECTOR_STATE_DIR ?? `${homedir()}/.adm-connector/sessions`;
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const rollout = await getRolloutState({ stateDir: dir });
  if (rollout.mode === MODES.DISABLED) {
    // Kill-switch active: fast-path exit with zero output, zero network calls
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Oversized hook input'); }
  const event = JSON.parse(input);
  const hooks = createHooks({
    stateDir: dir,
    mode: rollout.mode,
    load: restLoader({ baseUrl: process.env.PAPERCLIP_API_URL, companyId: process.env.PAPERCLIP_COMPANY_ID, token: process.env.PAPERCLIP_API_KEY }),
    log: metric => appendFile(`${dir}/metrics.jsonl`, JSON.stringify(metric) + '\n', { mode: 0o600 }),
  });
  const result = await hooks.run(event);
  if (rollout.mode === MODES.MAIN && result.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: result.context } }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('ADM hook failed closed; check connector state/configuration.\n'); process.exitCode = 2; });
