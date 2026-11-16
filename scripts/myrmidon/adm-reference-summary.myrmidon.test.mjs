import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMigration } from './adm-migrate.mjs';

// Scanner behavior is outside this contract; exercise the actual migration builder.
const fakeCleanScanner = () => ({ clean: true, findings: [] });

function migrate(category, content, name = 'sample-file_name.md') {
  const root = mkdtempSync(join(tmpdir(), 'adm-summary-'));
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'CLAUDE.md'), '---\ndescription: Policy\n---\n# Policy\n');
    const headings = { reference: 'References', lesson: 'Lessons', skill_card: 'Skills' };
    writeFileSync(join(root, 'memory/MEMORY.md'), `# Index\n## ${headings[category]}\n- [Item](${name})\n`);
    writeFileSync(join(root, 'memory', name), content);
    const plan = buildMigration(root, { scan: fakeCleanScanner });
    const item = plan.items.find((entry) => entry.path === `memory/${name}`);
    assert.ok(item, 'fixture must be migrated');
    assert.equal(item.category, category);
    assert.equal(plan.report.missingSummary.includes(item.path), false);
    return item;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const category of ['reference', 'lesson', 'skill_card']) {
  test(`${category}: description takes priority over body and title`, () => {
    const item = migrate(category, '---\ndescription: "Preferred summary"\n---\n# Heading\nDifferent body\n');
    assert.equal(item.title, 'Heading');
    assert.equal(item.summary, 'Preferred summary');
  });

  test(`${category}: description truncates at 300 Unicode codepoints`, () => {
    const description = 'a'.repeat(299) + '\u{1f680}' + 'discarded';
    const item = migrate(category, `---\ndescription: ${description}\n---\n# Heading\nBody\n`);
    assert.equal(item.summary, 'a'.repeat(299) + '\u{1f680}');
    assert.equal([...item.summary].length, 300);
  });

  test(`${category}: fallback strips frontmatter and markdown, collapses whitespace`, () => {
    const item = migrate(category, '---\nowner: hidden metadata\n---\n# Heading\n\n**Bold**   and `code`\n  next line\n');
    assert.equal(item.title, 'Heading');
    assert.equal(item.summary, 'Heading Bold and code next line');
    assert.equal(item.summary.includes('hidden metadata'), false);
  });

  test(`${category}: empty content falls back to normalized basename`, () => {
    const item = migrate(category, '---\nowner: hidden metadata\n---\n\n');
    assert.equal(item.title, 'sample file name');
    assert.equal(item.summary, 'sample file name');
  });

  test(`${category}: first H1 supplies title and body fallback truncates by codepoint`, () => {
    const item = migrate(category, `# First title\n# Second title\n${'x'.repeat(274)}\u{1f680}discarded`);
    assert.equal(item.title, 'First title');
    assert.equal(item.summary, 'First title Second title ' + 'x'.repeat(274) + '\u{1f680}');
    assert.equal([...item.summary].length, 300);
  });
}
