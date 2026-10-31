import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';

export const TRIGGERS = Object.freeze({
  ssh: /(?<![\p{L}\p{N}_])(?:ssh|sshd|scp)(?![\p{L}\p{N}_])/iu,
  deploy: /(?<![\p{L}\p{N}_])(?:deploy|deployment|выкат[\p{L}]*|развёрт[\p{L}]*|разверт[\p{L}]*)(?![\p{L}\p{N}_])/iu,
  'paperclip-api': /(?:paperclip[ -]?api|\/api\/|REST|эндпоинт)/iu,
  incident: /(?<![\p{L}\p{N}_])(?:incident|инцидент[\p{L}]*|авари[\p{L}]*|outage)(?![\p{L}\p{N}_])/iu,
  'config-change': /(?:config(?:uration)?|конфигурац[\p{L}]*|настройк[\p{L}]*|\.env)/iu,
  release: /(?<![\p{L}\p{N}_])(?:release|релиз[\p{L}]*|rc\.\d+)(?![\p{L}\p{N}_])/iu,
  merge: /(?<![\p{L}\p{N}_])(?:merge|rebase|слияни[\p{L}]*|вли[\p{L}]*|ребейз[\p{L}]*)(?![\p{L}\p{N}_])/iu,
  'owner-message': /(?:Alex:|owner:|владелец:)/iu,
});
export const classify = prompt => Object.entries(TRIGGERS).filter(([, re]) => re.test(prompt)).map(([name]) => name);
const bytes = text => Buffer.byteLength(text, 'utf8');
const rank = item => item.slug.startsWith('adm/policy/') ? 0 : item.slug.startsWith('adm/trigger/') ? 1 : 2;
const compare = (a, b) => rank(a) - rank(b) || b.priority - a.priority || Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.slug.localeCompare(b.slug, 'en');
const key = item => JSON.stringify([item.slug, item.revision_id]);
const summary = item => `${Array.from(`${item.title}: ${item.summary}`).slice(0, 300).join('')} [${item.slug}@${item.revision_id}]`;

/** load is the validated cache/REST boundary; never accept an unchecked disk cache here. */
export function createHooks({ stateDir, load, log = async () => {} }) {
  return { async run(event) {
    if (!['SessionStart', 'UserPromptSubmit'].includes(event.hook_event_name) || typeof event.session_id !== 'string' || !event.session_id) throw new Error('Invalid hook event');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = `${stateDir}/${createHash('sha256').update(event.session_id).digest('hex')}.json`;
    // Exclusive lock: concurrent submissions must not deliver the same revision twice.
    const lock = `${path}.lock`;
    await mkdir(lock, { mode: 0o700 });
    try {
      let state = { delivered: [], sessionBytes: 0 };
      try {
        state = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(state.delivered) || !state.delivered.every(x => typeof x === 'string') || !Number.isSafeInteger(state.sessionBytes) || state.sessionBytes < 0) throw new Error('Invalid session state');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const matched = classify(typeof event.prompt === 'string' ? event.prompt : '');
      const cap = event.hook_event_name === 'SessionStart' ? 12 * 1024 : 2 * 1024;
      let context = '';
      const delivered = new Set(state.delivered);
      if (event.hook_event_name === 'SessionStart' || matched.length) {
        try {
          const snapshot = await load({ triggers: matched, event: event.hook_event_name });
          if (!Number.isFinite(snapshot.fetchedAt)) throw new Error('Invalid cache age');
          const items = snapshot.items.filter(x => x.status === 'published');
          for (const x of items) {
            if (!/^adm\/(policy|trigger|reference|skills|lessons)\/[a-z0-9-]+$/.test(x.slug) || typeof x.revision_id !== 'string' || !x.revision_id || typeof x.title !== 'string' || typeof x.summary !== 'string' || !Array.isArray(x.triggers) || x.triggers.some(t => !(t in TRIGGERS)) || !Number.isFinite(x.priority) || !Number.isFinite(Date.parse(x.updated_at))) throw new Error('Invalid metadata');
          }
          const warning = snapshot.degraded ? `knowledge degraded; cache age=${Math.max(0, Math.floor((Date.now() - snapshot.fetchedAt) / 1000))}s; stale knowledge cannot authorize hazardous actions.\n` : '';
          if (event.hook_event_name === 'SessionStart') {
            const policies = items.filter(x => rank(x) === 0).sort(compare);
            context = warning + policies.map(summary).join('\n');
            if (bytes(context) > cap) throw new Error('Mandatory policies exceed budget');
            policies.forEach(x => delivered.add(key(x)));
            if (event.source !== 'compact') {
              const index = `\nTrigger index: ${Object.keys(TRIGGERS).join(', ')}\n${items.filter(x => rank(x) !== 0).sort(compare).map(x => `${x.triggers.join(',')}: ${x.slug}`).join('\n')}\n`;
              if (bytes(context + index) <= cap) context += index;
              else throw new Error('Trigger index exceeds budget');
            }
          } else {
            const candidates = items.filter(x => x.triggers.some(t => matched.includes(t)) && !delivered.has(key(x))).sort(compare);
            for (const x of candidates) {
              const text = `${summary(x)}\n${x.body ?? ''}\n`;
              const next = (context || warning) + text;
              if (bytes(next) <= cap) { context = next; delivered.add(key(x)); }
              else if (rank(x) === 0) throw new Error('Mandatory policies exceed budget');
            }
            if (!context && warning) context = warning;
          }
        } catch {
          delivered.clear();
          state.delivered.forEach(x => delivered.add(x));
          context = 'knowledge degraded; cache age=unknown; fail closed: fresh knowledge or human approval required for hazardous actions.';
        }
      }
      const added = bytes(context);
      const next = { delivered: [...delivered], sessionBytes: state.sessionBytes + added };
      const temp = `${path}.${randomUUID()}`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, path);
      await log({ event: event.hook_event_name, session: createHash('sha256').update(event.session_id).digest('hex'), bytes: added, sessionBytes: next.sessionBytes });
      return { context, bytes: added, sessionBytes: next.sessionBytes };
    } finally { await rm(lock, { recursive: true, force: true }); }
  } };
}
