import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMigration } from './adm-migrate.mjs';

const fakeCleanScannerPort = () => ({ clean: true, findings: [] });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'adm-provenance-'));
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'memory/MEMORY.md'), '# Index\n');
    const sources = {
      'CLAUDE.md': 'description: Root policy\n# Root\nRoot policy.\n',
      'memory/z-skill.md': 'migration_kind: skill_card\n# Skill\nUse this skill.\n',
      'memory/y-lesson.md': 'migration_kind: lesson\n# Lesson\nLearn this.\n',
      'memory/x-reference.md': 'migration_kind: reference\n# Reference\nReference text.\n',
      'memory/w-trigger.md': 'migration_kind: trigger\ndescription: Trigger summary\n# Trigger\nRun checks.\n',
      'memory/v-rule.md': 'migration_kind: rule\ndescription: Rule summary\n# Rule\nFollow this.\n',
    };
    for (const [path, text] of Object.entries(sources)) writeFileSync(join(root, path), text);
    run(root, sources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const migrate = (root) => buildMigration(root, { scan: fakeCleanScannerPort });

test('raw source hashes, provenance and category namespaces are reproducible', () => {
  withFixture((root, sources) => {
    const result = migrate(root);
    const expectedPaths = ['CLAUDE.md', 'memory/v-rule.md', 'memory/w-trigger.md', 'memory/x-reference.md', 'memory/y-lesson.md', 'memory/z-skill.md'];
    assert.deepEqual(result.manifest.map((entry) => entry.path), expectedPaths);
    assert.deepEqual(result.items.map((item) => item.path), expectedPaths);
    assert.deepEqual(migrate(root).manifest, result.manifest);
    assert.equal(result.report.ok, true);
    const namespaces = { rule: 'policy', trigger: 'trigger', reference: 'reference', lesson: 'lessons', skill_card: 'skills' };
    assert.deepEqual(new Set(result.items.map((item) => item.category)), new Set(Object.keys(namespaces)));
    for (const item of result.items) {
      const expectedHash = sha256(Buffer.from(sources[item.path], 'utf8'));
      assert.equal(result.manifest.find((entry) => entry.path === item.path).hash, expectedHash, item.path);
      assert.equal(item.source_hash, expectedHash, item.path);
      assert.equal(item.provenance.source_sha256, expectedHash, item.path);
      assert.equal(item.provenance.source_path, item.path);
      assert.equal(item.provenance.migrated_at, '2026-10-27T00:00:00.000Z');
      assert.equal(item.namespace, namespaces[item.category]);
      assert.equal(item.body, sources[item.path]);
      assert.equal(item.byte_length, Buffer.byteLength(item.body, 'utf8'));
    }
  });
});

test('line endings hash raw bytes while body and UTF-8 length are normalized; an edit changes the hash', () => {
  withFixture((root) => {
    const path = 'memory/x-reference.md';
    const lf = 'migration_kind: reference\n# Cafe\nCaf\u00e9 text.\n';
    const crlf = lf.replaceAll('\n', '\r\n');
    const read = (text) => {
      writeFileSync(join(root, path), text);
      const result = migrate(root);
      return { item: result.items.find((entry) => entry.path === path), manifest: result.manifest.find((entry) => entry.path === path) };
    };
    const a = read(lf);
    const b = read(crlf);
    assert.equal(a.item.body, lf);
    assert.equal(b.item.body, lf);
    assert.equal(a.item.byte_length, Buffer.byteLength(lf, 'utf8'));
    assert.equal(b.item.byte_length, Buffer.byteLength(lf, 'utf8'));
    assert.notEqual(Buffer.byteLength(lf, 'utf8'), lf.length);
    assert.equal(a.manifest.hash, sha256(Buffer.from(lf)));
    assert.equal(b.manifest.hash, sha256(Buffer.from(crlf)));
    assert.notEqual(a.manifest.hash, b.manifest.hash);
    assert.equal(b.item.source_hash, sha256(Buffer.from(crlf)));
    assert.equal(b.item.provenance.source_sha256, sha256(Buffer.from(crlf)));
    const edited = read(lf.replace('text', 'test'));
    assert.equal(edited.manifest.hash, sha256(Buffer.from(lf.replace('text', 'test'))));
    assert.notEqual(edited.manifest.hash, a.manifest.hash);
    assert.equal(edited.item.source_hash, edited.manifest.hash);
  });
});
