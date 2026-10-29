import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildMigration, classify, parseMemoryIndex } from './adm-migrate.mjs';

function cleanScanner() {
  return { clean: true, findings: [] };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'adm-migration-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  mkdirSync(join(root, 'memory/_archive'), { recursive: true });

  writeFileSync(
    join(root, 'CLAUDE.md'),
    '---\ndescription: Request approval before deployment.\n---\n# Operations\nAlways request approval before deployment.\n'
  );

  const memoryIndex = `# ADM Memory Index

## Политики — всегда
- [Безопасность](safety.md): Never reveal credentials.

## Справочники
- [Каталог](reference.md): Service catalog.

## Триггеры
- [Деплой](deploy-trigger.md): Deployment procedure trigger.
`;
  writeFileSync(join(root, 'memory/MEMORY.md'), memoryIndex);

  writeFileSync(
    join(root, 'memory/safety.md'),
    '---\ndescription: Never reveal credentials.\n---\n# Safety\nNever reveal credentials.\n'
  );
  writeFileSync(
    join(root, 'memory/reference.md'),
    '---\ndescription: Service catalog.\n---\n# Reference\nService catalog.\n'
  );
  writeFileSync(
    join(root, 'memory/deploy-trigger.md'),
    '---\ndescription: Deployment trigger.\ntriggers: deploy, release\n---\n# Deploy Trigger\nRun deploy checks.\n'
  );
  writeFileSync(
    join(root, 'memory/_archive/deprecated.md'),
    '---\ndescription: Old archived policy.\n---\n# Deprecated\nArchived.\n'
  );

  return root;
}

test('dry-run classification, provenance and reproducible counts over 235 sources', () => {
  const root = fixture();
  // 1 CLAUDE.md + 1 MEMORY.md + 1 safety.md + 1 reference.md + 1 deploy-trigger.md = 5 base files.
  // Add 14 policies (total 15 in memory + CLAUDE.md = 16 rules).
  // Add 216 references (total 218 references).
  // Total sources = 16 rules + 218 references + 1 trigger = 235 sources.
  let policyLinks = '- [Безопасность](safety.md): Never reveal credentials.\n';
  for (let i = 1; i <= 14; i++) {
    policyLinks += `- [Политика ${i}](policy-${i}.md): Policy ${i} description.\n`;
    writeFileSync(
      join(root, `memory/policy-${i}.md`),
      `---\ndescription: Policy ${i} description.\n---\n# Policy ${i}\nEnforce rule ${i}.\n`
    );
  }

  let refLinks = '- [Каталог](reference.md): Service catalog.\n';
  for (let i = 1; i <= 216; i++) {
    refLinks += `- [Справка ${i}](doc-${i}.md): Reference document ${i}.\n`;
    writeFileSync(
      join(root, `memory/doc-${i}.md`),
      `---\ndescription: Reference document ${i}.\n---\n# Reference ${i}\nReference detail ${i}.\n`
    );
  }

  const updatedIndex = `# ADM Memory Index

## Политики — всегда
${policyLinks}
## Справочники
${refLinks}
## Триггеры
- [Деплой](deploy-trigger.md): Deployment procedure trigger.
`;
  writeFileSync(join(root, 'memory/MEMORY.md'), updatedIndex);

  const first = buildMigration(root, { scan: cleanScanner });
  const second = buildMigration(root, { scan: cleanScanner });

  assert.equal(first.manifest.length, 235);
  assert.equal(first.items.length, 235);
  assert.equal(first.report.counts.rule, 16);
  assert.equal(first.report.counts.reference, 218);
  assert.equal(first.report.counts.trigger, 1);
  assert.equal(first.report.secretsRemaining, 0);
  assert.equal(first.report.conflicts.length, 0);
  assert.equal(first.report.missingSummary.length, 0);
  assert.equal(first.report.unrecognized.length, 0);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.budgetExceeded, false);
});

test('policy summary uses frontmatter description and missing description writes to report without throw', () => {
  const root = fixture();
  writeFileSync(
    join(root, 'memory/unsummarized.md'),
    '# Unsummarized Policy\nNo frontmatter description provided.\n'
  );
  const updatedIndex = readFileSync(join(root, 'memory/MEMORY.md'), 'utf8') + '\n- [Без описания](unsummarized.md)\n';
  writeFileSync(join(root, 'memory/MEMORY.md'), updatedIndex);

  let plan;
  assert.doesNotThrow(() => {
    plan = buildMigration(root, { scan: cleanScanner });
  });
  assert.ok(plan.report.missingSummary.includes('memory/unsummarized.md'));
});

test('_archive directory is skipped by source walker', () => {
  const root = fixture();
  writeFileSync(join(root, 'memory/_archive/hidden.md'), '# Should not appear\n');
  const plan = buildMigration(root, { scan: cleanScanner });
  const archived = plan.manifest.find((m) => m.path.includes('_archive'));
  assert.equal(archived, undefined);
});

test('unindexed files without explicit category are recorded in report.unrecognized', () => {
  const root = fixture();
  writeFileSync(join(root, 'memory/unknown.md'), '# Unknown\nNeeds human classification\n');
  const plan = buildMigration(root, { scan: cleanScanner });
  assert.ok(plan.report.unrecognized.includes('memory/unknown.md'));
});

test('gitleaks binary archive hash verification and secret scanning', async () => {
  const scannerDir = mkdtempSync(join(tmpdir(), 'adm-scanner-test-'));
  const archive = join(scannerDir, 'gitleaks.tar.gz');
  const previousPath = process.env.PATH || '';
  try {
    assert.equal(
      spawnSync('curl', [
        '-fsSL',
        'https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz',
        '-o',
        archive,
      ]).status,
      0
    );
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
    assert.equal(
      hash,
      '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c',
      'gitleaks binary archive hash mismatch'
    );
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', scannerDir, 'gitleaks']).status, 0);
    process.env.PATH = scannerDir + ':' + previousPath;
    process.env.ADM_GITLEAKS_BIN = join(scannerDir, 'gitleaks');
    assert.match(
      spawnSync(process.env.ADM_GITLEAKS_BIN, ['version'], { encoding: 'utf8' }).stdout,
      /8\.24\.3/
    );

    const root = fixture();
    const { randomBytes } = await import('node:crypto');
    const secretVal = 'ghp_' + randomBytes(18).toString('hex');
    writeFileSync(
      join(root, 'memory/leak.md'),
      '---\ndescription: Leaked key fixture.\n---\n# Leak\nsecret_token = ' + secretVal + '\n'
    );
    const updatedIndex = readFileSync(join(root, 'memory/MEMORY.md'), 'utf8') + '\n- [Утечка](leak.md)\n';
    writeFileSync(join(root, 'memory/MEMORY.md'), updatedIndex);

    const plan = buildMigration(root);
    assert.equal(plan.report.redactions.length, 1);
    assert.equal(plan.report.redactions[0].path, 'memory/leak.md');
    assert.equal(plan.report.secretsRemaining, 0);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.ADM_GITLEAKS_BIN;
  }
});
