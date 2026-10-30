import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Context delivery is separate from raw cache: full bodies never enter hook output. */
export class ContextDelivery {
  constructor(cache, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('ADM_INVALID_METADATA');
    this.cache = cache;
    this.file = join(cache.directory, `session-${createHash('sha256').update(sessionId).digest('hex')}.json`);
    this.queue = Promise.resolve();
  }
  deliver({ items, phase, triggers = [], compacted = false }) {
    const operation = this.queue.then(() => this.render({ items, phase, triggers, compacted }));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async render({ items, phase, triggers, compacted }) {
    if (!['SessionStart', 'UserPromptSubmit'].includes(phase)) throw new Error('ADM_INVALID_METADATA');
    this.cache.validateItems(items);
    let state = { seen: [], bytes: 0 };
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(saved.seen) && saved.seen.every(s => typeof s === 'string')
        && Number.isFinite(saved.bytes) && saved.bytes >= 0) state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('ADM_CACHE_INVALID');
    }
    const summaryOnly = phase === 'SessionStart' || compacted;
    const candidates = items.filter(i => summaryOnly ? i.slug.startsWith('adm/policy/')
      : Array.isArray(i.triggers) && i.triggers.some(trigger => triggers.includes(trigger)));
    candidates.sort((a, b) => Number(b.slug.startsWith('adm/policy/')) - Number(a.slug.startsWith('adm/policy/'))
      || (b.priority ?? 0) - (a.priority ?? 0) || a.slug.localeCompare(b.slug));
    const cap = phase === 'SessionStart' ? 12 * 1024 : 2 * 1024;
    const entries = [], delivered = [];
    for (const i of candidates) {
      const key = JSON.stringify([i.slug, i.revision_id]);
      if (!summaryOnly && state.seen.includes(key)) continue;
      // title + summary is at most 300 Unicode code points, not 300 bytes.
      const text = Array.from(`${i.title}: ${i.summary}`).slice(0, 300).join('');
      const line = JSON.stringify({ slug: i.slug, revision: i.revision_id, text });
      if (Buffer.byteLength([...entries, line].join('\n')) > cap) {
        if (i.slug.startsWith('adm/policy/')) throw new Error('ADM_BUDGET_EXCEEDED');
        continue;
      }
      entries.push(line); delivered.push(key);
    }
    if (phase === 'SessionStart' && !compacted) {
      const index = JSON.stringify({ triggers: [...new Set(items.flatMap(i => i.triggers ?? []))].sort() });
      if (Buffer.byteLength([...entries, index].join('\n')) > cap) throw new Error('ADM_BUDGET_EXCEEDED');
      entries.push(index);
    }
    const context = entries.join('\n'), bytes = Buffer.byteLength(context);
    await this.cache.atomic(this.file, { seen: [...new Set([...state.seen, ...delivered])], bytes: state.bytes + bytes });
    this.cache.emit('context_bytes', { phase, messageBytes: bytes, sessionBytes: state.bytes + bytes });
    return { context, bytes, sessionBytes: state.bytes + bytes };
  }
}
