import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPONENTS_25,
  checkMarkdownSyntax,
  checkRequiredSections,
  evaluateComponent,
  generateIndexMarkdown,
  runCli,
  validateArchitectureDirectory,
} from "./validate-architecture-docs.mjs";

test("COMPONENTS_25 inventory contains exactly 25 unique components across 5 categories", () => {
  assert.equal(COMPONENTS_25.length, 25);

  const ids = COMPONENTS_25.map((c) => c.id);
  assert.equal(new Set(ids).size, 25);

  const slugs = COMPONENTS_25.map((c) => c.slug);
  assert.equal(new Set(slugs).size, 25);

  const files = COMPONENTS_25.map((c) => c.file);
  assert.equal(new Set(files).size, 25);
  for (const f of files) {
    assert.ok(f.endsWith(".md"));
  }

  const categories = new Set(COMPONENTS_25.map((c) => c.category));
  assert.equal(categories.size, 5);
  assert.ok(categories.has("Ядро очереди и heartbeat"));
  assert.ok(categories.has("UI и API оркестратора"));
  assert.ok(categories.has("Память и знания"));
  assert.ok(categories.has("Агенты и исполнение"));
  assert.ok(categories.has("Доставка и каналы"));
});

test("checkMarkdownSyntax accepts valid markdown and frontmatter", () => {
  const content = `---
title: Test Component
---

# Test Component

## Purpose

Some introductory text with a [[link-to-target]] wikilink and [regular link](https://example.com).

\`\`\`typescript
const x = 1;
// Comments with # or [[ inside code blocks are fine
\`\`\`

## Related
- [[another-link]]
`;
  const errors = checkMarkdownSyntax(content, "test.md");
  assert.deepEqual(errors, []);
});

test("checkMarkdownSyntax flags unclosed code blocks, unclosed frontmatter, and empty docs", () => {
  // Empty
  assert.ok(checkMarkdownSyntax("", "empty.md").length > 0);
  assert.ok(checkMarkdownSyntax("   \n\t  ", "blank.md").length > 0);

  // Unclosed code fence
  const unclosedFence = `
# Title
\`\`\`ts
const x = 1;
`;
  const fenceErrors = checkMarkdownSyntax(unclosedFence, "unclosed.md");
  assert.ok(fenceErrors.some((e) => e.includes("unclosed code block")));

  // Unclosed frontmatter
  const unclosedFm = `---
title: Broken
no closing frontmatter
# Title
`;
  const fmErrors = checkMarkdownSyntax(unclosedFm, "fm.md");
  assert.ok(fmErrors.some((e) => e.includes("unclosed YAML frontmatter")));

  // Malformed header
  const badHeader = `
#Valid Title
#BrokenHeaderWithoutSpace
`;
  const headerErrors = checkMarkdownSyntax(badHeader, "bad-header.md");
  assert.ok(headerErrors.some((e) => e.includes("malformed header")));

  // Unbalanced wikilinks
  const badWiki = `
# Title
Text with [[unbalanced wikilink
`;
  const wikiErrors = checkMarkdownSyntax(badWiki, "wiki.md");
  assert.ok(wikiErrors.some((e) => e.includes("unbalanced wikilink")));
});

test("checkRequiredSections recognizes both Russian and English section headers", () => {
  const russianDoc = `
# Компонент

## Где в коде
- \`server/src/myrmidon/example.ts\`

## Как задумано
Инварианты и архитектурный замысел.

## Как сделано
Фактическая реализация в сервисе.

## Расхождения
Отклонения от первоначального замысла.
`;
  const ruResult = checkRequiredSections(russianDoc);
  assert.equal(ruResult.hasIntended, true);
  assert.equal(ruResult.hasImplemented, true);
  assert.equal(ruResult.hasDifferences, true);
  assert.equal(ruResult.isComplete, true);

  const englishDoc = `
# Component

## Where in code
- \`server/src/example.ts\`

## How it is intended
Architectural intent and invariants.

## How it is implemented
Implementation details in service.

## Difference from the intended design
Differences observed in production.
`;
  const enResult = checkRequiredSections(englishDoc);
  assert.equal(enResult.hasIntended, true);
  assert.equal(enResult.hasImplemented, true);
  assert.equal(enResult.hasDifferences, true);
  assert.equal(enResult.isComplete, true);
});

test("checkRequiredSections flags missing sections and ignores headers inside code fences", () => {
  const incompleteDoc = `
# Component

## Purpose
Introductory text.

## How it is implemented
Implementation details.
`;
  const result = checkRequiredSections(incompleteDoc);
  assert.equal(result.hasIntended, false);
  assert.equal(result.hasImplemented, true);
  assert.equal(result.hasDifferences, false);
  assert.equal(result.isComplete, false);

  const fakeInCode = `
# Component

\`\`\`markdown
## Как задумано
Inside code fence
## Как сделано
Inside code fence
## Расхождения
Inside code fence
\`\`\`
`;
  const fakeResult = checkRequiredSections(fakeInCode);
  assert.equal(fakeResult.isComplete, false);
});

test("validateArchitectureDirectory and generateIndexMarkdown run end-to-end on temp workspace", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "myrmidon-arch-test-"));

  try {
    // Component 1 complete
    writeFileSync(
      join(tempDir, "issue-store-checkout.md"),
      `# Issue store
## How it is intended
Target
## How it is implemented
Actual
## Difference from the intended design
None
`,
      "utf8",
    );

    // Component 2 incomplete
    writeFileSync(
      join(tempDir, "heartbeat-runner.md"),
      `# Heartbeat
## Purpose
Legacy overview
`,
      "utf8",
    );

    const report = validateArchitectureDirectory(tempDir);
    assert.equal(report.counts.total, 25);
    assert.equal(report.counts.exists, 2);
    assert.equal(report.counts.ready, 1);
    assert.equal(report.counts.incomplete, 1);
    assert.equal(report.counts.missing, 23);
    assert.equal(report.counts.syntaxErrors, 0);

    const indexMd = generateIndexMarkdown(report);
    assert.ok(indexMd.includes("# Архитектура компонентов Myrmidon"));
    assert.ok(indexMd.includes("🟢 Готов"));
    assert.ok(indexMd.includes("🟡 В работе (неполный)"));
    assert.ok(indexMd.includes("🔴 Отсутствует"));
    assert.ok(indexMd.includes("`issue-store-checkout.md`"));
    assert.ok(indexMd.includes("`heartbeat-runner.md`"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCli terminates with exit code 1 upon syntax errors in documents", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "myrmidon-arch-cli-test-"));
  const prevExitCode = process.exitCode;

  try {
    writeFileSync(
      join(tempDir, "broken-syntax.md"),
      `# Broken Document
\`\`\`typescript
const x = 1;
// Unclosed code block!
`,
      "utf8",
    );

    const code = runCli(["--dir", tempDir, "--output", join(tempDir, "INDEX.md")]);
    assert.equal(code, 1);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevExitCode;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
