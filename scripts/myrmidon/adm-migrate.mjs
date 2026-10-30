#!/usr/bin/env node
// Dry-run by default. Migration report and deterministic provenance; no REST mutation without operator review.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const namespaces = {
  rule: 'policy',
  trigger: 'trigger',
  reference: 'reference',
  lesson: 'lessons',
  skill_card: 'skills',
};

function compare(a, b) {
  return a.localeCompare(b);
}

function walk(root, directory, files) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Symlinks are not migration sources');
  for (const name of readdirSync(directory).sort(compare)) {
    if (name === '_archive' || name === '.git' || name.startsWith('.')) continue;
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not migration sources');
    if (stat.isDirectory()) {
      walk(root, path, files);
    } else if (stat.isFile() && name.endsWith('.md')) {
      if (name === 'MEMORY.md') continue;
      files.push(relative(root, path).split('\\').join('/'));
    }
  }
}

export function parseMemoryIndex(content) {
  const index = new Map();
  let currentKind = null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const title = headingMatch[1].toLowerCase();
      if (title.includes('политик') || title.includes('policy') || title.includes('policies')) {
        currentKind = 'rule';
      } else if (title.includes('триггер') || title.includes('trigger')) {
        currentKind = 'trigger';
      } else if (title.includes('урок') || title.includes('инцидент') || title.includes('lesson')) {
        currentKind = 'lesson';
      } else if (title.includes('навык') || title.includes('процедур') || title.includes('skill')) {
        currentKind = 'skill_card';
      } else if (title.includes('справочник') || title.includes('справк') || title.includes('reference') || title.includes('каталог')) {
        currentKind = 'reference';
      } else {
        currentKind = null;
      }
      continue;
    }
    if (!currentKind) continue;
    const matches = line.matchAll(/(?:\[[^\]]*\]\(([^)]+\.md)\)|`([^`]+\.md)`|\b([a-zA-Z0-9._-]+\.md)\b)/g);
    for (const m of matches) {
      const file = m[1] || m[2] || m[3];
      if (file) {
        const cleanName = basename(file);
        index.set(cleanName, currentKind);
        index.set(`memory/${cleanName}`, currentKind);
      }
    }
  }
  return index;
}

export function classify(path, text, memoryIndex = new Map()) {
  if (path === 'CLAUDE.md' || basename(path) === 'CLAUDE.md') return 'rule';
  const cleanName = basename(path);
  if (memoryIndex.has(path)) return memoryIndex.get(path);
  if (memoryIndex.has(cleanName)) return memoryIndex.get(cleanName);
  const explicit = text.match(/^migration_kind:\s*(rule|trigger|reference|lesson|skill_card)\s*$/m)?.[1];
  if (explicit) return explicit;
  return null;
}

function normalizeTitle(body, fallback) {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || basename(fallback, '.md').replace(/[-_]+/g, ' ');
}

function extractTriggers(body) {
  const line = body.match(/^triggers:\s*(.+)$/m)?.[1];
  if (!line) return [];
  return line.split(',').map((x) => x.trim()).filter(Boolean);
}

export function gitleaksScan(text) {
  const bin = process.env.ADM_GITLEAKS_BIN || 'gitleaks';
  const tempDir = mkdtempSync(join(tmpdir(), 'adm-gitleaks-'));
  const reportPath = join(tempDir, 'report.json');
  try {
    const env = { ...process.env };
    delete env.GITLEAKS_CONFIG;
    delete env.GITLEAKS_CONFIG_PATH;
    const run = spawnSync(bin, ['stdin', '--no-banner', '--report-format=json', `--report-path=${reportPath}`], {
      input: text,
      encoding: 'utf8',
      env,
    });
    if (run.error) throw run.error;
    if (run.status === 0) return { clean: true, findings: [] };
    if (run.status === 1) {
      const raw = readFileSync(reportPath, 'utf8');
      const findings = raw.trim() ? JSON.parse(raw) : [];
      return { clean: findings.length === 0, findings };
    }
    throw new Error(`gitleaks scanner failed closed with status ${run.status}: ${run.stderr || run.stdout}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function redactSecrets(text, scan = gitleaksScan) {
  const result = scan(text);
  if (result.clean) return { redacted: text, findings: [] };
  const findings = result.findings || [];
  let current = text;
  for (const finding of findings) {
    if (finding.Secret) {
      current = current.split(finding.Secret).join('[REDACTED_SECRET]');
    }
  }
  const rescanned = scan(current);
  if (!rescanned.clean) {
    return {
      redacted: '<!-- QUARANTINED: sensitive content detected by gitleaks failed safe redaction -->\n',
      findings,
      quarantined: true,
      secretsRemaining: rescanned.findings?.length || 0,
    };
  }
  return { redacted: current, findings, secretsRemaining: 0 };
}

export function buildMigration(root, { scan = gitleaksScan } = {}) {
  root = resolve(root);
  const paths = [];
  if (lstatSync(resolve(root, 'CLAUDE.md')).isSymbolicLink()) throw new Error('Symlinks are not migration sources');
  paths.push('CLAUDE.md');
  walk(root, resolve(root, 'memory'), paths);
  paths.sort(compare);

  let memoryIndex = new Map();
  const indexCandidates = [resolve(root, 'memory/MEMORY.md'), resolve(root, 'MEMORY.md')];
  for (const cand of indexCandidates) {
    try {
      if (lstatSync(cand).isFile()) {
        memoryIndex = parseMemoryIndex(readFileSync(cand, 'utf8'));
        break;
      }
    } catch {}
  }

  const manifest = [];
  const items = [];
  const seenBodies = new Map();
  const seenSlugs = new Map();

  const report = {
    counts: { rule: 0, trigger: 0, reference: 0, lesson: 0, skill_card: 0 },
    conflicts: [],
    oversized: [],
    unrecognized: [],
    redactions: [],
    duplicates: [],
    missingSummary: [],
    secretsRemaining: 0,
  };
  report.missingSummaries = report.missingSummary;

  for (const path of paths) {
    const full = resolve(root, path);
    const raw = readFileSync(full, 'utf8');
    const hash = createHash('sha256').update(raw).digest('hex');
    manifest.push({ path, hash });

    const category = classify(path, raw, memoryIndex);
    if (!category) {
      report.unrecognized.push(path);
      continue;
    }

    report.counts[category] = (report.counts[category] || 0) + 1;
    const { redacted, findings, quarantined, secretsRemaining } = redactSecrets(raw, scan);
    if (findings.length > 0) {
      report.redactions.push({ path, findings: findings.length, quarantined: Boolean(quarantined) });
    }
    if (secretsRemaining) report.secretsRemaining += secretsRemaining;

    const normalized = redacted.replaceAll('\r\n', '\n');
    const bodyHash = createHash('sha256').update(normalized).digest('hex');
    if (seenBodies.has(bodyHash)) {
      report.duplicates.push({ duplicate: path, canonical: seenBodies.get(bodyHash) });
      continue;
    }
    seenBodies.set(bodyHash, path);

    const title = normalizeTitle(normalized, path);
    const frontmatterMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const frontmatterText = frontmatterMatch ? frontmatterMatch[1] : '';
    const descMatch = frontmatterText.match(/^(?:description|summary):[ \t]*(.*)$/m) || normalized.match(/^(?:description|summary):[ \t]*(.*)$/m);
    const description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '').trim() : '';

    let summary = '';
    if (['rule', 'trigger'].includes(category)) {
      if (!description) {
        report.missingSummary.push(path);
      } else {
        const charLen = [...description].length;
        if (charLen > 300) {
          report.missingSummary.push(path);
          summary = [...description].slice(0, 300).join('');
        } else {
          summary = description;
        }
      }
    } else {
      if (description) {
        summary = [...description].slice(0, 300).join('');
      } else {
        summary = [...normalized.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim()].slice(0, 300).join('') || title;
      }
    }

    const byteLength = Buffer.byteLength(normalized, 'utf8');
    if (byteLength > 64 * 1024) {
      report.oversized.push({ path, byteLength });
    }

    const baseSlug = basename(path, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
    const slug = seenSlugs.has(baseSlug) ? `${baseSlug}-${path.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : baseSlug;
    if (seenSlugs.has(slug)) {
      report.conflicts.push({ slug, current: path, prior: seenSlugs.get(slug) });
    }
    seenSlugs.set(slug, path);

    items.push({
      path,
      source_hash: hash,
      title,
      summary,
      category,
      namespace: namespaces[category],
      slug,
      triggers: extractTriggers(normalized),
      byte_length: byteLength,
      body: normalized,
      provenance: {
        source_path: path,
        source_sha256: hash,
        migrated_at: '2026-10-27T00:00:00.000Z',
      },
    });
  }

  const compact = items.filter(i => i.category === 'rule' || i.category === 'trigger').map(i => ({ slug: i.slug, revision_id: i.source_hash.slice(0, 8), title: i.title, summary: i.category === 'rule' ? i.summary : '', triggers: i.triggers }));
  report.sessionStartBytes = Buffer.byteLength(JSON.stringify(compact));
  report.sessionStartLimit = 12 * 1024;
  report.budgetExceeded = report.sessionStartBytes > report.sessionStartLimit;

  report.ok = (
    report.conflicts.length === 0 &&
    report.secretsRemaining === 0 &&
    !report.budgetExceeded &&
    report.missingSummary.length === 0 &&
    report.unrecognized.length === 0
  );
  report.success = report.ok;

  return { manifest, items, report };
}

export async function main(argv = process.argv.slice(2), { scan } = {}) {
  const root = argv.find(a => !a.startsWith('--'));
  if (!root || argv.some(a => a.startsWith('--') && a !== '--dry-run')) {
    throw new Error('Usage: adm-migrate.mjs SOURCE_ROOT [--dry-run]');
  }
  const plan = buildMigration(root, scan ? { scan } : {});
  const out = JSON.stringify(plan, null, 2) + '\n';
  process.stdout.write(out);
  if (!plan.report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`ADM migration failed closed: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  });
}
