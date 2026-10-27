import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMigration, applyMigration } from './adm-migrate.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'adm-migration-'));
  mkdirSync(join(root, 'memory/policies'), { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), '# Operations\nAlways request approval before deployment.\n');
  writeFileSync(join(root, 'memory/policies/safety.md'), '# Safety\nNever reveal credentials.\n');
  writeFileSync(join(root, 'memory/reference.md'), '# Reference\nService catalog.\n');
  return root;
}
const cleanScanner = () => [];
test('dry run is deterministic, hashed, classified and never writes', () => {
  const root = fixture();
  try {
    const before = readdirSync(root, { recursive: true });
    const a = buildMigration(root, { scan: cleanScanner });
    assert.deepEqual(a, buildMigration(root, { scan: cleanScanner }));
    assert.deepEqual(readdirSync(root, { recursive: true }), before);
    assert.equal(a.items.length, 3);
    assert.equal(a.report.counts.rule, 2);
    assert.equal(a.report.counts.reference, 1);
    for (const item of a.items) {
      assert.match(item.provenance.sha256, /^[a-f0-9]{64}$/);
      assert.ok(item.summary.length > 0 && [...item.summary].length <= 300);
      assert.equal(item.status, 'draft');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('235-source fixture covers dedup, classification, redactions and review findings', () => {
  const root = fixture();
  try {
    for (let i = 1; i <= 14; i++) writeFileSync(join(root, `memory/policies/policy-${i}.md`), `# Policy ${i}\nDistinct policy ${i}.`);
    for (let i = 0; i < 218; i++) writeFileSync(join(root, `memory/reference-${i}.md`), `# Catalog ${i}\nEntry ${i}.`);
    assert.equal(buildMigration(root, { scan: cleanScanner }).manifest.length, 235);
    const plan = buildMigration(root, { scan: cleanScanner });
    assert.equal(plan.report.counts.rule, 16);
    assert.ok(plan.report.sessionStartBytes <= 12 * 1024);
    assert.equal(plan.report.budgetExceeded, false);
    assert.deepEqual(plan, buildMigration(root, { scan: cleanScanner }));
    writeFileSync(join(root, 'memory/copy-reference.md'), readFileSync(join(root, 'memory/reference.md')));
    writeFileSync(join(root, 'memory/unknown.md'), 'Needs human classification');
    writeFileSync(join(root, 'memory/trigger-deploy.md'), '# Deploy\nDeploy after approval.');
    writeFileSync(join(root, 'memory/lesson.md'), '# Incident\nRoot cause recorded.');
    writeFileSync(join(root, 'memory/skill.md'), '# Procedure\nStep 1: inspect.');
    writeFileSync(join(root, 'memory/reference-secret.md'), '# Credentials\npassword=' + 'synthetic-value-for-test');
    const extra = buildMigration(root, { scan: cleanScanner });
    assert.equal(extra.report.duplicates.length, 1);
    assert.deepEqual(extra.report.unrecognized, ['memory/unknown.md']);
    assert.equal(extra.report.redactions.length, 1);
    assert.ok(!JSON.stringify(extra).includes('synthetic-value-for-test'));
    for (const kind of ['trigger', 'lesson', 'skill_card']) assert.equal(extra.report.counts[kind], 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanner failure and residual findings fail closed', () => {
  const root = fixture();
  try {
    assert.throws(() => buildMigration(root, { scan: () => { throw new Error('unavailable'); } }), /unavailable/);
    assert.throws(() => buildMigration(root, { scan: () => [{ start: 1, end: 1 }] }), /Secret remains/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply submits rules, keeps others draft, verifies and reuses without overwriting', async () => {
  const root = fixture();
  try {
    const plan = buildMigration(root, { scan: cleanScanner }), store = new Map();
    let creates = 0, submissions = 0;
    const port = {
      read: async id => store.get(id) ?? [...store.values()].find(i => i.slug === id) ?? null,
      createDraft: async i => { const id = `id-${++creates}`; const item = { id, slug: i.slug, kind: i.kind, summary: i.summary, content: i.body, status: 'draft' }; store.set(id, item); return item; },
      submit: async id => { submissions++; store.get(id).status = 'in_review'; },
    };
    await applyMigration(plan, port);
    assert.equal(creates, 3); assert.equal(submissions, 2);
    await applyMigration(plan, port); assert.equal(creates, 3);
    store.values().next().value.content = 'concurrent change';
    await assert.rejects(applyMigration(plan, port), /conflict/);
    await assert.rejects(applyMigration({ ...plan, report: { ...plan.report, budgetExceeded: true } }, port), /review findings/);
    await assert.rejects(applyMigration(plan, { ...port, read: async () => null }), /read-back/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gitleaks integration removes detected credentials (CI installs scanner)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { gitleaksScan } = await import('./adm-migrate.mjs');
  const scannerDir = mkdtempSync(join(tmpdir(), 'adm-scanner-'));
  const previousPath = process.env.PATH;
  if (spawnSync('gitleaks', ['version']).error) {
    const archive = join(scannerDir, 'scanner.tar.gz');
    assert.equal(spawnSync('curl', ['-fsSL', 'https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz', '-o', archive]).status, 0);
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', scannerDir, 'gitleaks']).status, 0);
    process.env.PATH = scannerDir + ':' + previousPath;
  }
  const root = fixture();
  try {
    // Synthetic provider-shaped value assembled in memory, never a real credential.
    const value = 'AKIA' + 'IOSFODNN7EXAMPLE0';
    writeFileSync(join(root, 'memory/reference-secret.md'), '# Credentials\naws_access_key_id = ' + value);
    const plan = buildMigration(root);
    assert.ok(plan.report.redactions.length > 0);
    assert.ok(!JSON.stringify(plan).includes(value));
    assert.deepEqual(gitleaksScan(JSON.stringify(plan)), []);
  } finally {
    process.env.PATH = previousPath;
    rmSync(scannerDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
