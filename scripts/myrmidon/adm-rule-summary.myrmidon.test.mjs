import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildMigration } from './adm-migrate.mjs';

const fakeCleanScannerPort = () => ({ clean: true, findings: [] });

function scratchRoot() {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR
    || process.env.PAPERCLIP_SCRATCH_DIR
    || homedir();
  return mkdtempSync(join(base, 'adm-summary-'));
}

function migrate(kind, content) {
  const root = scratchRoot();
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'CLAUDE.md'), '---\ndescription: Base policy\n---\n# Base\n');
    writeFileSync(join(root, 'memory/MEMORY.md'), `# Index\n## ${kind === 'rule' ? 'Policies' : 'Triggers'}\n- [Target](target.md)\n`);
    writeFileSync(join(root, 'memory/target.md'), content);
    const plan = buildMigration(root, { scan: fakeCleanScannerPort });
    const item = plan.items.find((entry) => entry.path === 'memory/target.md');
    assert.ok(item);
    assert.equal(item.category, kind);
    assert.strictEqual(plan.report.missingSummaries, plan.report.missingSummary);
    assert.equal(plan.report.success, plan.report.ok);
    return { item, report: plan.report };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const kind of ['rule', 'trigger']) {
  for (const [name, content, expected] of [
    ['description frontmatter', '---\ndescription: Front description\n---\n# Target\n', 'Front description'],
    ['summary frontmatter', '---\nsummary: Front summary\n---\n# Target\n', 'Front summary'],
    ['double quoted whitespace', '---\ndescription:  "  quoted value  "  \n---\n# Target\n', 'quoted value'],
    ['single quoted whitespace', "---\nsummary:  '  quoted value  '  \n---\n# Target\n", 'quoted value'],
    ['outside frontmatter fallback', '# Target\ndescription: Outside description\n', 'Outside description'],
    ['frontmatter takes precedence', '---\nsummary: Front value\n---\n# Target\ndescription: Outside value\n', 'Front value'],
  ]) {
    test(`${kind}: ${name}`, () => {
      const { item, report } = migrate(kind, content);
      assert.equal(item.summary, expected);
      assert.deepEqual(report.missingSummary, []);
      assert.equal(report.ok, true);
      assert.equal(report.success, true);
    });
  }

  for (const [name, content] of [
    ['missing', '# Target\nNo summary here.\n'],
    ['empty', '---\nsummary: "  "\n---\n# Target\n'],
  ]) {
    test(`${kind}: ${name} summary fails report`, () => {
      const { item, report } = migrate(kind, content);
      assert.equal(item.summary, '');
      assert.deepEqual(report.missingSummary, ['memory/target.md']);
      assert.deepEqual(report.missingSummaries, ['memory/target.md']);
      assert.equal(report.ok, false);
      assert.equal(report.success, false);
    });
  }

  for (const length of [299, 300, 301]) {
    test(`${kind}: ${length} Unicode codepoints preserve astral boundary`, () => {
      const description = 'a'.repeat(299) + (length >= 300 ? '\u{1F680}' : '') + (length === 301 ? 'z' : '');
      const { item, report } = migrate(kind, `---\ndescription: ${description}\n---\n# Target\n`);
      const expected = length === 301 ? 'a'.repeat(299) + '\u{1F680}' : description;
      assert.equal(item.summary, expected);
      assert.equal([...item.summary].length, Math.min(length, 300));
      assert.equal(item.summary.isWellFormed(), true);
      assert.deepEqual(report.missingSummary, length > 300 ? ['memory/target.md'] : []);
      assert.equal(report.ok, length <= 300);
      assert.equal(report.success, length <= 300);
    });
  }
}
