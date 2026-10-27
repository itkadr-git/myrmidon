import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secret = /(?:Bearer\s+\S+|pcp_[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|password|token)\s*[=:]\s*[^\s,}]+)/i;

/** Profile-local fallback only: never an authority to publish or execute knowledge. */
export class AdmCache {
  constructor({ profileDir, company, space, integrityKey, now = Date.now, timeoutMs = 2000,
    maxAgeMs = 300000, backoffMs = 1000, maxBackoffMs = 30000, breakerThreshold = 3,
    breakerMs = 60000, metric = () => {} }) {
    if (!isAbsolute(profileDir) || !company || !space || !integrityKey || Buffer.byteLength(integrityKey) < 32) throw new Error('ADM_CACHE_INVALID');
    this.sign = value => createHmac('sha256', integrityKey).update(JSON.stringify(value)).digest('hex');
    const path = resolve(profileDir);
    if (/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(path)) throw new Error('ADM_CACHE_INVALID');
    for (const value of [timeoutMs, maxAgeMs, backoffMs, maxBackoffMs, breakerThreshold, breakerMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('ADM_CACHE_INVALID');
    }
    Object.assign(this, { company, space, now, timeoutMs, maxAgeMs, backoffMs,
      maxBackoffMs, breakerThreshold, breakerMs, metric });
    this.profileDir = path;
    this.directory = join(path, 'adm-connector', digest({ company, space }));
    this.file = join(this.directory, 'cache.json');
    this.healthFile = join(this.directory, 'health.json');
  }
  emit(name, details = {}) { this.metric({ name, ...details }); }
  async atomic(file, value) {
    // The deployment profile may itself have trusted symlink ancestors.
    // Reject redirection within the profile-owned connector subtree.
    let ancestor = this.profileDir;
    for (const part of this.directory.slice(ancestor.length + 1).split('/')) {
      ancestor = join(ancestor, part);
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('ADM_CACHE_INVALID'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('ADM_CACHE_INVALID');
    await chmod(this.directory, 0o700);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('ADM_CACHE_INVALID');
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || !/^adm\/(policy|trigger|reference|skills|lessons)\/[a-z0-9][a-z0-9-]*$/.test(item.slug)
        || item.schema_version !== 1 || item.status !== 'published' || item.sensitivity !== 'internal'
        || (item.slug.startsWith('adm/policy/') && (item.kind !== 'rule' || item.approver_kind !== 'owner'))
        || typeof item.id !== 'string' || !item.id || typeof item.revision_id !== 'string' || !item.revision_id
        || typeof item.title !== 'string' || typeof item.summary !== 'string' || item.summary.length > 300
        || seen.has(item.slug) || secret.test(JSON.stringify(item))) throw new Error('ADM_CACHE_INVALID');
      seen.add(item.slug);
    }
  }
  envelope(items) {
    this.validateItems(items);
    const fetched_at = this.now();
    const manifest = { schema_version: 1, connector_version: 1, company: this.company, space: this.space,
      fetched_at, items: items.map(item => ({ slug: item.slug, id: item.id, revision: item.revision_id,
        fetched_at, checksum: digest(item) })) };
    return { manifest, items, checksum: digest({ manifest, items }), signature: this.sign({ manifest, items }) };
  }
  async load() {
    const info = await lstat(this.file);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('ADM_CACHE_INVALID');
    const data = JSON.parse(await readFile(this.file, 'utf8'));
    this.validateItems(data.items);
    const m = data.manifest;
    if (!m || m.company !== this.company || m.space !== this.space || m.schema_version !== 1
      || m.connector_version !== 1 || !Number.isFinite(m.fetched_at) || m.fetched_at > this.now()
      || !Array.isArray(m.items) || m.items.length !== data.items.length
      || data.checksum !== digest({ manifest: m, items: data.items })
      || data.signature !== this.sign({ manifest: m, items: data.items })) throw new Error('ADM_CACHE_INVALID');
    for (let n = 0; n < data.items.length; n++) {
      const i = data.items[n], entry = m.items[n];
      if (entry.slug !== i.slug || entry.id !== i.id || entry.revision !== i.revision_id
        || entry.fetched_at !== m.fetched_at || entry.checksum !== digest(i)) throw new Error('ADM_CACHE_INVALID');
    }
    return data;
  }
  async health() {
    try {
      const h = JSON.parse(await readFile(this.healthFile, 'utf8'));
      if (Number.isInteger(h.failures) && h.failures >= 0 && Number.isFinite(h.nextAttempt)) return h;
    } catch { /* Missing or invalid health never validates knowledge. */ }
    return { failures: 0, nextAttempt: 0 };
  }
  async read({ fetchItems, hazardous = false }) {
    const health = await this.health();
    let failure = 'ADM_UPSTREAM_UNAVAILABLE';
    if (this.now() >= health.nextAttempt) {
      this.emit('knowledge_fetch');
      const controller = new AbortController();
      let timer;
      try {
        const items = await Promise.race([
          Promise.resolve().then(() => fetchItems(controller.signal)),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); }),
        ]);
        const data = this.envelope(items);
        await this.atomic(this.file, data);
        await this.atomic(this.healthFile, { failures: 0, nextAttempt: 0 });
        return { mode: 'fresh', items: data.items, ageMs: 0, hazardousAllowed: true };
      } catch {
        const failures = health.failures + 1;
        const delay = failures >= this.breakerThreshold ? this.breakerMs
          : Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.min(failures - 1, 30));
        try { await this.atomic(this.healthFile, { failures, nextAttempt: this.now() + delay }); } catch { /* Fallback still verifies cache. */ }
      } finally { clearTimeout(timer); }
    }
    try {
      const data = await this.load();
      const ageMs = this.now() - data.manifest.fetched_at;
      if (hazardous && ageMs > this.maxAgeMs) return this.closed('ADM_CACHE_EXPIRED', ageMs);
      this.emit('cache_hit'); this.emit('cache_stale', { ageMs });
      return { mode: 'stale-read', items: data.items, ageMs, hazardousAllowed: ageMs <= this.maxAgeMs,
        warning: 'knowledge degraded', code: failure };
    } catch { failure = 'ADM_CACHE_INVALID'; }
    return this.closed(failure);
  }
  closed(code, ageMs) {
    this.emit('fail_closed');
    return { mode: 'fail-closed', items: [], hazardousAllowed: false, code, ageMs };
  }
  /** Local unpublishable proposals. Caller must re-read base revision and obtain owner approval. */
  async defer(proposal, { ttlMs = 86400000 } = {}) {
    if (!proposal || typeof proposal.base_revision !== 'string' || !proposal.base_revision
      || typeof proposal.idempotency_key !== 'string' || !proposal.idempotency_key
      || secret.test(JSON.stringify(proposal)) || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ADM_SECRET_REJECTED');
    const entry = { proposal, company: this.company, space: this.space, created_at: this.now(),
      expires_at: this.now() + ttlMs, publishable: false, requires_owner_review: true };
    await this.atomic(join(this.directory, `proposal-${digest(proposal.idempotency_key)}.json`), entry);
    this.emit('write_deferred');
    return { mode: 'write-deferred', ...entry };
  }
}
