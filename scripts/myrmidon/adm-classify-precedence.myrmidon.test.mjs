import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMigration, classify } from './adm-migrate.mjs';

test('classify respects rule, exact path, basename and explicit kind precedence', () => {
  const index = new Map([
    ['CLAUDE.md', 'lesson'],
    ['memory/nested/CLAUDE.md', 'trigger'],
    ['memory/nested/topic.md', 'reference'],
    ['topic.md', 'lesson'],
    ['basename.md', 'trigger'],
  ]);
  const cases = [
    ['CLAUDE.md', 'migration_kind: skill_card', 'rule'],
    ['memory/nested/CLAUDE.md', 'migration_kind: skill_card', 'rule'],
    ['memory/other/CLAUDE.md', 'migration_kind: lesson', 'rule'],
    ['memory/nested/topic.md', 'migration_kind: rule', 'reference'],
    ['memory/other/topic.md', 'migration_kind: rule', 'lesson'],
    ['memory/basename.md', 'migration_kind: reference', 'trigger'],
    ['memory/rule.md', 'migration_kind: rule', 'rule'],
    ['memory/trigger.md', 'migration_kind: trigger', 'trigger'],
    ['memory/reference.md', 'migration_kind: reference', 'reference'],
    ['memory/lesson.md', 'migration_kind: lesson', 'lesson'],
    ['memory/skill.md', 'migration_kind: skill_card', 'skill_card'],
    ['memory/unknown.md', 'migration_kind: unknown', null],
    ['memory/case.md', 'migration_kind: Rule', null],
    ['memory/key.md', 'Migration_kind: rule', null],
    ['memory/plain.md', '# Just text\n', null],
    ['memory/claude.md', 'plain text', null],
    ['memory/MEMORY.md', 'migration_kind: lesson', 'lesson'],
  ];
  for (const [path, text, expected] of cases) {
    assert.equal(classify(path, text, index), expected, path);
  }
});

test('migration applies classification and excludes the index from sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'adm-classify-contract-'));
  try {
    mkdirSync(join(root, 'memory', 'nested'), { recursive: true });
    const sources = {
      'CLAUDE.md': 'description: Root policy\n# Root policy\n',
      'memory/nested/CLAUDE.md': 'description: Nested policy\nmigration_kind: lesson\n# Nested policy\n',
      'memory/indexed.md': 'description: Indexed policy\nmigration_kind: lesson\n# Indexed policy\n',
      'memory/explicit.md': 'migration_kind: reference\n# Explicit reference\n',
      'memory/unknown.md': 'migration_kind: Unknown\n# Unknown\n',
    };
    writeFileSync(join(root, 'memory/MEMORY.md'), '## Policies\n- [Indexed](indexed.md)\n');
    for (const [path, body] of Object.entries(sources)) writeFileSync(join(root, path), body);
    const fakeCleanScannerPort = () => ({ clean: true, findings: [] });
    const { manifest, items, report } = buildMigration(root, { scan: fakeCleanScannerPort });
    assert.deepEqual(Object.fromEntries(items.map(({ path, category }) => [path, category])), {
      'CLAUDE.md': 'rule',
      'memory/explicit.md': 'reference',
      'memory/indexed.md': 'rule',
      'memory/nested/CLAUDE.md': 'rule',
    });
    assert.deepEqual(report.unrecognized, ['memory/unknown.md']);
    assert.equal(report.ok, false);
    assert.equal(manifest.some(({ path }) => path === 'memory/MEMORY.md'), false);
    assert.equal(items.some(({ path }) => path === 'memory/MEMORY.md'), false);
    assert.equal(manifest.find(({ path }) => path === 'memory/indexed.md').hash,
      createHash('sha256').update(sources['memory/indexed.md']).digest('hex'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
