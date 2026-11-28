import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMigration } from './adm-migrate.mjs';

const fakeCleanScannerPort = () => ({ clean: true, findings: [] });

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'adm-budget-'));
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'CLAUDE.md'), '---\ndescription: Short rule\n---\n# Rule\n');
    writeFileSync(join(root, 'memory/MEMORY.md'), '## Triggers\n- [Trigger](trigger.md)\n## References\n- [Reference](reference.md)\n');
    writeFileSync(join(root, 'memory/trigger.md'), '---\ndescription: Short trigger\ntriggers: deploy\n---\n# Trigger\n');
    writeFileSync(join(root, 'memory/reference.md'), '# Reference\nReference body\n');
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function migrate(root) {
  return buildMigration(root, { scan: fakeCleanScannerPort });
}

function compactBytes(items) {
  const rows = [];
  for (const item of items) {
    if (item.category !== 'rule' && item.category !== 'trigger') continue;
    rows.push({
      slug: item.slug,
      revision_id: item.source_hash.substring(0, 8),
      title: item.title,
      summary: item.category === 'trigger' ? '' : item.summary,
      triggers: item.triggers,
    });
  }
  return Buffer.byteLength(JSON.stringify(rows), 'utf8');
}

test('oversized metadata uses UTF-8 bytes and is only a warning', () => {
  for (const size of [65535, 65536, 65537]) {
    withFixture((root) => {
      const prefix = '# Reference\n\u00e9\n';
      const body = prefix + 'x'.repeat(size - Buffer.byteLength(prefix));
      assert.equal(Buffer.byteLength(body), size);
      writeFileSync(join(root, 'memory/reference.md'), body);
      const { items, report } = migrate(root);
      assert.equal(items.find((item) => item.path === 'memory/reference.md').byte_length, size);
      assert.deepEqual(report.oversized, size > 65536 ? [{ path: 'memory/reference.md', byteLength: size }] : []);
      assert.equal(report.ok, true);
      assert.equal(report.success, true);
    });
  }
});

test('compact SessionStart projection and strict 12288-byte boundary', () => {
  for (const target of [12287, 12288, 12289]) {
    withFixture((root) => {
      const path = join(root, 'CLAUDE.md');
      const header = '---\ndescription: Short rule\n---\n# Rule';
      const initial = migrate(root);
      const padding = target - compactBytes(initial.items);
      assert.ok(padding > 0);
      const body = header + 'x'.repeat(padding) + '\n';
      writeFileSync(path, body);
      const { items, report } = migrate(root);
      const rule = items.find((item) => item.path === 'CLAUDE.md');
      const trigger = items.find((item) => item.path === 'memory/trigger.md');
      assert.equal(rule.source_hash, createHash('sha256').update(body).digest('hex'));
      assert.equal(rule.summary, 'Short rule');
      assert.equal(trigger.summary, 'Short trigger');
      assert.deepEqual(trigger.triggers, ['deploy']);
      assert.equal(items.filter((item) => item.category === 'reference').length, 1);
      assert.equal(compactBytes(items), target);
      assert.equal(report.sessionStartBytes, target);
      assert.equal(report.sessionStartLimit, 12288);
      assert.equal(report.budgetExceeded, target > 12288);
      assert.equal(report.ok, target <= 12288);
      assert.equal(report.success, target <= 12288);

      writeFileSync(join(root, 'memory/reference.md'), '# Changed reference\n' + 'z'.repeat(20000));
      const changed = migrate(root);
      assert.equal(changed.report.sessionStartBytes, target);
      assert.equal(changed.report.budgetExceeded, target > 12288);
    });
  }
});
