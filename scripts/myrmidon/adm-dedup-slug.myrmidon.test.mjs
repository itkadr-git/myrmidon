import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildMigration } from './adm-migrate.mjs';

const fakeCleanScanner = () => ({ clean: true, findings: [] });
const hash = (text) => createHash('sha256').update(text).digest('hex');

test('migration deduplicates normalized bodies and deterministically assigns slugs', () => {
  const root = mkdtempSync(join(tmpdir(), 'adm-dedup-contract-'));
  try {
    const duplicate = 'migration_kind: reference\n# Shared\nSame body.\n';
    const sources = {
      'CLAUDE.md': 'description: Main rule\n# Main\nMain policy.\n',
      'memory/a/duplicate.md': duplicate,
      'memory/b/duplicate.md': duplicate.replaceAll('\n', '\r\n'),
      'memory/a/same.md': 'migration_kind: reference\n# First\nFirst body.\n',
      'memory/b/same.md': 'migration_kind: reference\n# Second\nSecond body.\n',
      'memory/Hello, WORLD!.md': 'migration_kind: reference\n# Punctuation\nDifferent body.\n',
      'memory/\u6d4b\u8bd5.md': 'migration_kind: reference\n# Unicode\nAnother body.\n',
    };
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory/MEMORY.md'), '# Index\n');
    for (const [path, contents] of Object.entries(sources)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }

    const first = buildMigration(root, { scan: fakeCleanScanner });
    const second = buildMigration(root, { scan: fakeCleanScanner });
    const items = new Map(first.items.map((item) => [item.path, item]));
    const manifest = new Map(first.manifest.map((entry) => [entry.path, entry.hash]));

    assert.equal(first.manifest.length, 7);
    assert.equal(first.items.length, 6);
    assert.equal(manifest.get('memory/a/duplicate.md'), hash(duplicate));
    assert.equal(manifest.get('memory/b/duplicate.md'), hash(duplicate.replaceAll('\n', '\r\n')));
    assert.notEqual(manifest.get('memory/a/duplicate.md'), manifest.get('memory/b/duplicate.md'));
    assert.equal(items.get('memory/a/duplicate.md').body, duplicate);
    assert.equal(items.has('memory/b/duplicate.md'), false);
    assert.deepEqual(first.report.duplicates, [{ duplicate: 'memory/b/duplicate.md', canonical: 'memory/a/duplicate.md' }]);
    assert.equal(items.get('memory/a/same.md').slug, 'same');
    assert.equal(items.get('memory/b/same.md').slug, 'same-memory-b-same-md');
    assert.notEqual(items.get('memory/a/same.md').body, items.get('memory/b/same.md').body);
    assert.equal(items.get('memory/Hello, WORLD!.md').slug, 'hello-world');
    assert.equal(items.get('memory/\u6d4b\u8bd5.md').slug, 'item');
    assert.equal(first.report.counts.rule, 1);
    assert.equal(first.report.counts.reference, 6);
    assert.deepEqual(first.report.conflicts, []);
    assert.equal(first.report.ok, true);
    assert.equal(JSON.stringify(first, null, 2) + '\n', JSON.stringify(second, null, 2) + '\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
