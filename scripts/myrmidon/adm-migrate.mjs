#!/usr/bin/env node
// Offline by default. Import creates drafts/submits rules; never approves or publishes.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hash = text => createHash('sha256').update(text).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const namespaces = { rule: 'policy', trigger: 'trigger', reference: 'reference', lesson: 'lessons', skill_card: 'skills' };
const triggers = ['ssh', 'deploy', 'paperclip-api', 'incident', 'config-change', 'release', 'merge', 'owner-message'];

/** Gitleaks stdin mode: no files, logs, or secret values leave the process. */
export function gitleaksScan(text) {
  const run = spawnSync('gitleaks', ['stdin', '--no-banner', '--redact=100', '--report-format=json', '--report-path=/dev/stdout', '--exit-code=7'],
    { input: text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error || ![0, 7].includes(run.status)) throw new Error('Secret scanner unavailable or failed (install gitleaks >=8.21)');
  if (run.status === 0) return [];
  let findings;
  try { findings = JSON.parse(run.stdout); } catch { throw new Error('Invalid secret scanner report'); }
  if (!Array.isArray(findings) || !findings.length) throw new Error('Missing secret scanner findings');
  return findings.map(f => ({ start: f.StartLine, end: f.EndLine, rule: 'gitleaks' }));
}
function redact(text, scan) {
  const lines = text.split('\n');
  const ranges = scan(text);
  const extra = /(?:-----BEGIN .*PRIVATE KEY-----[\s\S]*?-----END .*PRIVATE KEY-----|\bBearer\s+\S+|\bpcp_[A-Za-z0-9_-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"']+)/gi;
  let count = 0;
  for (const f of ranges) {
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end) || f.start < 1 || f.end < f.start || f.end > lines.length) throw new Error('Invalid secret location');
    for (let i = f.start - 1; i < f.end; i++) lines[i] = '[REDACTED]';
    count++;
  }
  const body = lines.join('\n').replace(extra, () => { count++; return '[REDACTED]'; });
  if (scan(body).length) throw new Error('Secret remains after redaction');
  return { body, count };
}
function walk(root, directory, files) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Symlinks are not migration sources');
  for (const name of readdirSync(directory).sort(compare)) {
    const path = resolve(directory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not migration sources');
    if (stat.isDirectory()) walk(root, path, files);
    else if (stat.isFile() && name.endsWith('.md')) files.push(relative(root, path).replaceAll('\\', '/'));
  }
}
function classify(path, text) {
  if (path === 'CLAUDE.md' || /(?:^|\/)(?:policies|policy)\//i.test(path)) return 'rule';
  const explicit = text.match(/^migration_kind:\s*(rule|trigger|reference|lesson|skill_card)\s*$/m)?.[1];
  if (explicit) return explicit;
  if (/trigger/i.test(path)) return 'trigger';
  if (/lesson|incident|postmortem/i.test(path)) return 'lesson';
  if (/skill|runbook|procedure/i.test(path)) return 'skill_card';
  if (/reference|MEMORY\.md|api|catalog|schema/i.test(path)) return 'reference';
  return null;
}
export function buildMigration(root, { scan = gitleaksScan } = {}) {
  root = resolve(root);
  const paths = [];
  if (lstatSync(resolve(root, 'CLAUDE.md')).isSymbolicLink()) throw new Error('Symlinks are not migration sources');
  paths.push('CLAUDE.md'); walk(root, resolve(root, 'memory'), paths); paths.sort(compare);
  const manifest = [], items = [], seen = new Map(), slugs = new Set();
  const report = { counts: { rule: 0, trigger: 0, reference: 0, lesson: 0, skill_card: 0 }, conflicts: [], oversized: [], unrecognized: [], redactions: [], duplicates: [], secretsRemaining: 0 };
  for (const path of paths) {
    // Paths themselves can carry credentials; never emit an unsafe path.
    if (redact(path, scan).body !== path) throw new Error('Unsafe source filename');
    const raw = readFileSync(resolve(root, path), 'utf8');
    const sha256 = hash(raw), provenance = { path, sha256 };
    manifest.push(provenance);
    const { body, count } = redact(raw, scan);
    if (count) report.redactions.push({ path, count });
    const category = classify(path, body);
    if (!category) { report.unrecognized.push(path); continue; }
    const normalized = body.replace(/\r\n/g, '\n').trim();
    const signature = hash(category + '\n' + normalized);
    if (seen.has(signature)) {
      seen.get(signature).sources.push(provenance);
      report.duplicates.push({ path, duplicateOf: seen.get(signature).provenance.path }); continue;
    }
    const name = path.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = `adm/${namespaces[category]}/${name || hash(path).slice(0, 16)}`;
    if (slugs.has(slug)) { report.conflicts.push({ path, slug }); continue; }
    slugs.add(slug);
    const title = [...(normalized.match(/^#\s+(.+)$/m)?.[1] || basename(path, '.md'))].slice(0, 160).join('');
    const summary = [...normalized.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim()].slice(0, 300).join('') || title;
    const item = { schema_version: 1, slug, kind: ['rule', 'trigger'].includes(category) ? 'rule' : category === 'skill_card' ? 'skill_card' : 'wiki', category, title, summary,
      body: normalized, tags: ['adm', 'migration'], triggers: triggers.filter(t => new RegExp(`(?:^|[^a-z])${t}(?:$|[^a-z])`, 'i').test(path + '\n' + normalized)),
      priority: category === 'rule' ? 100 : 50, owner: 'ADM', source_ref: `file:${path}#sha256=${sha256}`, sensitivity: 'internal', status: 'draft', revision_id: signature,
      updated_at: '1970-01-01T00:00:00.000Z', ...(category === 'rule' || category === 'trigger' ? { approver_kind: 'owner' } : {}), provenance, sources: [provenance] };
    if (Buffer.byteLength(normalized) > 32 * 1024) report.oversized.push({ path, bytes: Buffer.byteLength(normalized) });
    report.counts[category]++; items.push(item); seen.set(signature, item);
  }
  const compact = items.filter(i => i.category === 'rule' || i.category === 'trigger').map(i => ({ slug: i.slug, revision_id: i.revision_id, title: i.title, summary: i.category === 'rule' ? i.summary : '', triggers: i.triggers }));
  report.sessionStartBytes = Buffer.byteLength(JSON.stringify(compact));
  report.sessionStartLimit = 12 * 1024;
  report.budgetExceeded = report.sessionStartBytes > report.sessionStartLimit;
  return { schemaVersion: 1, manifest, items, report };
}
/** Inject the governed E adapter: read-before-create, no overwrite and exact read-back. */
export async function applyMigration(plan, port) {
  if (plan.report.conflicts.length || plan.report.unrecognized.length || plan.report.budgetExceeded) throw new Error('Resolve migration review findings before apply');
  const results = [];
  for (const item of [...plan.items].sort((a, b) => Number(b.kind === 'rule') - Number(a.kind === 'rule') || compare(a.slug, b.slug))) {
    const current = await port.read(item.slug);
    if (current) {
      if (current.content !== item.body || current.summary !== item.summary || current.kind !== item.kind) throw new Error(`Existing item conflict: ${item.slug}`);
      if (item.kind === 'rule' && current.status === 'draft') {
        await port.submit(current.id);
        const submitted = await port.read(current.id);
        if (!submitted || submitted.status !== 'in_review') throw new Error('Proposal read-back mismatch');
      }
      results.push({ slug: item.slug, id: current.id, reused: true }); continue;
    }
    const created = await port.createDraft(item);
    const verified = await port.read(created.id);
    if (!verified || verified.content !== item.body || verified.slug !== item.slug || verified.kind !== item.kind || verified.status !== 'draft') throw new Error('Draft read-back mismatch');
    if (item.kind === 'rule') {
      await port.submit(created.id);
      const submitted = await port.read(created.id);
      if (!submitted || submitted.status !== 'in_review') throw new Error('Proposal read-back mismatch');
    }
    results.push({ slug: item.slug, id: created.id, reused: false });
  }
  return results;
}
export function createRestPort({ baseUrl, companyId, key, runId, fetchImpl = fetch }) {
  if (!baseUrl || !companyId || !key || !runId) throw new Error('Explicit REST connection, company and run required');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid REST URL');
  const prefix = `${base.origin}/api/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge/items`;
  async function request(suffix, data) {
    const response = await fetchImpl(prefix + suffix, { method: data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Paperclip-Run-Id': runId }, ...(data ? { body: JSON.stringify(data) } : {}) });
    if (response.status === 404 && !data) return null;
    if (!response.ok) throw new Error(`Knowledge REST failed: HTTP ${response.status}`);
    return (await response.json()).item;
  }
  return {
    read: id => request('/' + id.split('/').map(encodeURIComponent).join('/')),
    createDraft: item => request('', { slug: item.slug, title: item.title, content: item.body, kind: item.kind, summary: item.summary, tags: item.tags,
      approverKind: item.kind === 'rule' ? 'owner' : null, sources: item.sources.map(s => ({ kind: 'document', ref: `file:${s.path}#sha256=${s.sha256}`, note: 'ADM migration source' })) }),
    submit: id => request('/' + encodeURIComponent(id) + '/submit', {}),
  };
}
async function main() {
  const args = process.argv.slice(2);
  const root = args.find(a => !a.startsWith('--'));
  if (!root || args.some(a => a.startsWith('--') && a !== '--apply')) throw new Error('Usage: adm-migrate.mjs SOURCE_ROOT [--apply]');
  const plan = buildMigration(root);
  if (args.includes('--apply')) {
    const results = await applyMigration(plan, createRestPort({ baseUrl: process.env.PAPERCLIP_API_URL, companyId: process.env.PAPERCLIP_COMPANY_ID, key: process.env.PAPERCLIP_API_KEY, runId: process.env.PAPERCLIP_RUN_ID }));
    process.stdout.write(JSON.stringify({ report: plan.report, results }, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('ADM migration failed closed; check source, scanner and review findings.\n'); process.exitCode = 1; });
