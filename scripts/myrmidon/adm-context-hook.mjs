#!/usr/bin/env node
// Data-only REST selection: never execute knowledge bodies.
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const triggers = ['ssh', 'deploy', 'paperclip-api', 'incident', 'config-change', 'release', 'merge', 'owner-message'];
const bytes = text => Buffer.byteLength(text);
export async function runHook({ event, prompt = '', sessionId, stateDir, logPath, rest }) {
  if (!sessionId || !stateDir || !logPath) throw new Error('Hook session, state and log required');
  const statePath = resolve(stateDir, createHash('sha256').update(sessionId).digest('hex') + '.json');
  let state = { emitted: [], sessionBytes: 0 };
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!Array.isArray(state.emitted) || !Number.isSafeInteger(state.sessionBytes) || state.sessionBytes < 0) throw new Error('Invalid session state');
  const matched = triggers.filter(t => new RegExp(`(?:^|[^a-z])${t}(?:$|[^a-z])`, 'i').test(prompt));
  let candidates = [];
  if (event === 'SessionStart' || event === 'PreCompact') candidates = await rest.list();
  else if (event === 'UserPromptSubmit') {
    for (const trigger of matched) candidates.push(...await rest.search(trigger));
  } else throw new Error('Unsupported hook event');
  const unique = new Map(candidates.map(i => [i.slug, i]));
  const records = [], keys = [];
  for (const item of [...unique.values()].sort((a,b) => a.slug.localeCompare(b.slug))) {
    if (item.status !== 'published' || !item.slug.startsWith('adm/')) continue;
    const policy = item.slug.startsWith('adm/policy/');
    if (event === 'PreCompact' && !policy) continue;
    if (event === 'SessionStart' && !policy && !item.slug.startsWith('adm/trigger/')) continue;
    if (typeof item.summary !== 'string' || !item.summary.trim() || [...item.summary].length > 300) throw new Error('Rule summary required (1..300 characters)');
    const revision = item.deliveredRevisionId || item.revision_id;
    if (!revision) throw new Error('Published revision required');
    const key = `${item.slug}:${revision}`;
    if (event === 'UserPromptSubmit') {
      if (!item.triggers?.some(t => matched.includes(t)) || state.emitted.includes(key)) continue;
      // Re-read selected metadata using REST, no model tool round trip and no body delivery.
      const fresh = await rest.read(item.id);
      if (!fresh || fresh.status !== 'published' || (fresh.deliveredRevisionId || fresh.revision_id) !== revision) continue;
    }
    const record = { slug: item.slug, revision_id: revision, title: item.title, summary: event === 'SessionStart' && !policy ? '' : item.summary, triggers: item.triggers || [] };
    const next = JSON.stringify([...records, record]);
    if (bytes(next) > (event === 'UserPromptSubmit' ? 2048 : 12288)) throw new Error('Hook context budget exceeded');
    records.push(record); keys.push(key);
  }
  const output = records.length ? JSON.stringify(records) : '';
  if (event === 'UserPromptSubmit') state.emitted = [...new Set([...state.emitted, ...keys])];
  state.sessionBytes += bytes(output);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const staging = statePath + `.${process.pid}.new`;
  writeFileSync(staging, JSON.stringify(state), { mode: 0o600 }); renameSync(staging, statePath);
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, JSON.stringify({ event, bytesAdded: bytes(output), sessionBytes: state.sessionBytes }) + '\n', { mode: 0o600 });
  return output;
}
export function hookRest({ baseUrl, companyId, key, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !companyId || !key) throw new Error('Hook REST configuration required');
  const prefix = `${base.origin}/api/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge`;
  async function get(path) {
    const response = await fetchImpl(prefix + path, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Hook REST failed: HTTP ${response.status}`);
    return response.json();
  }
  return {
    list: async () => (await get('/items?status=published&limit=100')).items,
    search: async trigger => (await get('/search?q=' + encodeURIComponent(trigger) + '&limit=100')).items,
    read: async id => (await get('/items/' + encodeURIComponent(id))).item,
  };
}
async function main() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  const output = await runHook({ event: data.hook_event_name, prompt: data.prompt, sessionId: data.session_id, stateDir: process.env.ADM_HOOK_STATE_DIR, logPath: process.env.ADM_HOOK_LOG,
    rest: hookRest({ baseUrl: process.env.PAPERCLIP_API_URL, companyId: process.env.PAPERCLIP_COMPANY_ID, key: process.env.PAPERCLIP_API_KEY }) });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: data.hook_event_name, additionalContext: output } }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('ADM hook failed closed\n'); process.exitCode = 2; });
