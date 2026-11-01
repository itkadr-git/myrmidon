#!/usr/bin/env node

/**
 * scripts/validate-architecture-docs.mjs
 *
 * Validates architecture documentation in doc/architecture/:
 * - Verifies presence and completeness of all 25 project components (KNOWLEDGE-2.0 L-10).
 * - Checks required sections: 'Как задумано', 'Как сделано', 'Расхождения' (and their English equivalents).
 * - Performs syntax error detection on all markdown files in the directory.
 * - Generates / updates doc/architecture/INDEX.md with the readiness summary table.
 * - Exits with non-zero exit code if syntax errors are detected.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS_25 = [
  // 1. Core queue & heartbeat (Ядро очереди и heartbeat) [OPE-8664]
  {
    id: 1,
    slug: "issue-store-checkout",
    file: "issue-store-checkout.md",
    category: "Ядро очереди и heartbeat",
    titleRu: "Хранилище и захват задач",
    titleEn: "Issue store and checkout",
  },
  {
    id: 2,
    slug: "heartbeat-runner",
    file: "heartbeat-runner.md",
    category: "Ядро очереди и heartbeat",
    titleRu: "Heartbeat и runner",
    titleEn: "Heartbeat and runner",
  },
  {
    id: 3,
    slug: "task-queue",
    file: "task-queue.md",
    category: "Ядро очереди и heartbeat",
    titleRu: "Очередь задач",
    titleEn: "Task queue",
  },
  {
    id: 4,
    slug: "inbox-lite",
    file: "inbox-lite.md",
    category: "Ядро очереди и heartbeat",
    titleRu: "Inbox-lite",
    titleEn: "Inbox-lite",
  },
  {
    id: 5,
    slug: "blocks-dependencies",
    file: "blocks-dependencies.md",
    category: "Ядро очереди и heartbeat",
    titleRu: "Блокировки и зависимости",
    titleEn: "Blocks and dependencies",
  },

  // 2. UI & API orchestrator (UI и API оркестратора) [OPE-8668]
  {
    id: 6,
    slug: "ui-page-structure",
    file: "ui-page-structure.md",
    category: "UI и API оркестратора",
    titleRu: "Структура страниц UI",
    titleEn: "UI page structure",
  },
  {
    id: 7,
    slug: "api-route-topology",
    file: "api-route-topology.md",
    category: "UI и API оркестратора",
    titleRu: "Топология API маршрутов",
    titleEn: "API route topology",
  },
  {
    id: 8,
    slug: "live-run-streaming",
    file: "live-run-streaming.md",
    category: "UI и API оркестратора",
    titleRu: "SSE/стриминг прогонов",
    titleEn: "Live run streaming",
  },
  {
    id: 9,
    slug: "status-cards-dashboard",
    file: "status-cards-dashboard.md",
    category: "UI и API оркестратора",
    titleRu: "Статус-карточки и дашборд",
    titleEn: "Status cards dashboard",
  },
  {
    id: 10,
    slug: "settings-screen",
    file: "settings-screen.md",
    category: "UI и API оркестратора",
    titleRu: "Экран настроек",
    titleEn: "Settings screen",
  },

  // 3. Memory & knowledge (Память и знания) [OPE-8665]
  {
    id: 11,
    slug: "memory-layers",
    file: "memory-layers.md",
    category: "Память и знания",
    titleRu: "Слои памяти (Hindsight / Memory)",
    titleEn: "Memory layers",
  },
  {
    id: 12,
    slug: "para-memory-files",
    file: "para-memory-files.md",
    category: "Память и знания",
    titleRu: "PARA-файлы памяти",
    titleEn: "PARA memory files",
  },
  {
    id: 13,
    slug: "wiki-cortex",
    file: "wiki-cortex.md",
    category: "Память и знания",
    titleRu: "Wiki-cortex",
    titleEn: "Wiki-cortex",
  },
  {
    id: 14,
    slug: "foraging",
    file: "foraging.md",
    category: "Память и знания",
    titleRu: "Foraging (сбор знаний)",
    titleEn: "Foraging",
  },
  {
    id: 15,
    slug: "knowledge-deliveries",
    file: "knowledge-deliveries.md",
    category: "Память и знания",
    titleRu: "Доставка знаний (KNOWLEDGE_INDEX)",
    titleEn: "Knowledge deliveries",
  },

  // 4. Agents & execution (Агенты и исполнение) [OPE-8667]
  {
    id: 16,
    slug: "agent-adapters",
    file: "agent-adapters.md",
    category: "Агенты и исполнение",
    titleRu: "Адаптеры агентов",
    titleEn: "Agent adapters",
  },
  {
    id: 17,
    slug: "execution-workspaces",
    file: "execution-workspaces.md",
    category: "Агенты и исполнение",
    titleRu: "Рабочие пространства исполнения",
    titleEn: "Execution workspaces",
  },
  {
    id: 18,
    slug: "agent-chat",
    file: "agent-chat.md",
    category: "Агенты и исполнение",
    titleRu: "Чат агентов",
    titleEn: "Agent chat",
  },
  {
    id: 19,
    slug: "debates",
    file: "debates.md",
    category: "Агенты и исполнение",
    titleRu: "Дебаты агентов",
    titleEn: "Debates",
  },
  {
    id: 20,
    slug: "agent-exchange",
    file: "agent-exchange.md",
    category: "Агенты и исполнение",
    titleRu: "Обмен сообщениями агентов",
    titleEn: "Agent exchange",
  },

  // 5. Delivery & channels (Доставка и каналы) [OPE-8666]
  {
    id: 21,
    slug: "owner-delivery",
    file: "owner-delivery.md",
    category: "Доставка и каналы",
    titleRu: "Доставка сообщений владельцу",
    titleEn: "Owner delivery",
  },
  {
    id: 22,
    slug: "agent-chat-bridge",
    file: "agent-chat-bridge.md",
    category: "Доставка и каналы",
    titleRu: "Мост чата с агентом (Telegram)",
    titleEn: "Agent chat bridge",
  },
  {
    id: 23,
    slug: "wake-heartbeat-payload",
    file: "wake-heartbeat-payload.md",
    category: "Доставка и каналы",
    titleRu: "Полезная нагрузка wake/heartbeat",
    titleEn: "Wake and heartbeat payload",
  },
  {
    id: 24,
    slug: "comments-interactions",
    file: "comments-interactions.md",
    category: "Доставка и каналы",
    titleRu: "Комментарии и взаимодействия",
    titleEn: "Comments and interactions",
  },
  {
    id: 25,
    slug: "approvals",
    file: "approvals.md",
    category: "Доставка и каналы",
    titleRu: "Согласования",
    titleEn: "Approvals",
  },
];

export const SECTION_PATTERNS = {
  intended: /^##\s+(?:как\s+задумано|замысел|how\s+it\s+(?:is|was)\s+intended|intended\s+design|intended)(?=[\s:.]|$)/i,
  implemented: /^##\s+(?:как\s+сделано|реализация|how\s+it\s+is\s+implemented|implementation|implemented)(?=[\s:.]|$)/i,
  differences: /^##\s+(?:расхождения|отличие\s+от\s+замысла|отличия\s+от\s+замысла|difference\s+from\s+(?:the\s+)?intended\s+design|differences\s+from\s+(?:the\s+)?intended\s+design|difference\s+from\s+intent|divergence|discrepancies)(?=[\s:.]|$)/i,
};

/**
 * Validates markdown syntax of a document.
 * Returns an array of syntax error strings with line numbers if found.
 */
export function checkMarkdownSyntax(content, filename = "document.md") {
  const errors = [];
  if (!content || content.trim().length === 0) {
    errors.push(`${filename}:1: empty document`);
    return errors;
  }

  const lines = content.split(/\r?\n/);
  let insideCodeBlock = false;
  let codeBlockStartLine = 0;
  let insideFrontmatter = false;
  let frontmatterStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Frontmatter check
    if (i === 0 && line.trim() === "---") {
      insideFrontmatter = true;
      frontmatterStartLine = lineNum;
      continue;
    }
    if (insideFrontmatter) {
      if (line.trim() === "---") {
        insideFrontmatter = false;
      }
      continue;
    }

    // Code block check
    if (/^```/.test(line.trim())) {
      if (!insideCodeBlock) {
        insideCodeBlock = true;
        codeBlockStartLine = lineNum;
      } else {
        insideCodeBlock = false;
      }
      continue;
    }

    if (insideCodeBlock) {
      continue;
    }

    // Malformed heading check: #header without space
    if (/^#{1,6}[^\s#]/.test(line.trim())) {
      errors.push(`${filename}:${lineNum}: malformed header without space after '#'`);
    }

    // Unbalanced wikilinks check: [[ ... ]]
    const openWiki = (line.match(/\[\[/g) || []).length;
    const closeWiki = (line.match(/\]\]/g) || []).length;
    if (openWiki !== closeWiki) {
      errors.push(`${filename}:${lineNum}: unbalanced wikilink brackets (${openWiki} '[[' vs ${closeWiki} ']]')`);
    }

    // Unbalanced markdown links check: [text]( without closing )
    // Count [ that look like links vs closing ) on the same line (basic check)
    const linkMatches = line.match(/\[[^\]]+\]\([^\)]*$/);
    if (linkMatches) {
      errors.push(`${filename}:${lineNum}: unclosed markdown link target`);
    }
  }

  if (insideFrontmatter) {
    errors.push(`${filename}:${frontmatterStartLine}: unclosed YAML frontmatter block`);
  }

  if (insideCodeBlock) {
    errors.push(`${filename}:${codeBlockStartLine}: unclosed code block (missing closing '\`\`\`')`);
  }

  return errors;
}

/**
 * Checks sections present in markdown content.
 */
export function checkRequiredSections(content) {
  const lines = content.split(/\r?\n/);
  let hasIntended = false;
  let hasImplemented = false;
  let hasDifferences = false;

  let inCodeBlock = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (SECTION_PATTERNS.intended.test(line.trim())) {
      hasIntended = true;
    }
    if (SECTION_PATTERNS.implemented.test(line.trim())) {
      hasImplemented = true;
    }
    if (SECTION_PATTERNS.differences.test(line.trim())) {
      hasDifferences = true;
    }
  }

  return {
    hasIntended,
    hasImplemented,
    hasDifferences,
    isComplete: hasIntended && hasImplemented && hasDifferences,
  };
}

/**
 * Inspects a component's documentation file against required standards.
 */
export function evaluateComponent(component, archDir) {
  const targetPath = join(archDir, component.file);
  const exists = existsSync(targetPath);

  if (!exists) {
    return {
      ...component,
      exists: false,
      hasIntended: false,
      hasImplemented: false,
      hasDifferences: false,
      status: "missing",
      syntaxErrors: [],
    };
  }

  const content = readFileSync(targetPath, "utf8");
  const syntaxErrors = checkMarkdownSyntax(content, component.file);
  const sections = checkRequiredSections(content);

  let status = "ready";
  if (syntaxErrors.length > 0) {
    status = "syntax_error";
  } else if (!sections.isComplete) {
    status = "incomplete";
  }

  return {
    ...component,
    exists: true,
    hasIntended: sections.hasIntended,
    hasImplemented: sections.hasImplemented,
    hasDifferences: sections.hasDifferences,
    status,
    syntaxErrors,
  };
}

/**
 * Validates the architecture directory.
 */
export function validateArchitectureDirectory(archDir) {
  const componentResults = COMPONENTS_25.map((c) => evaluateComponent(c, archDir));

  // Find any other markdown files in archDir and check syntax
  const allFiles = existsSync(archDir) ? readdirSync(archDir) : [];
  const componentFileNames = new Set(COMPONENTS_25.map((c) => c.file));
  const otherFiles = allFiles.filter(
    (f) => f.endsWith(".md") && f !== "INDEX.md" && !componentFileNames.has(f),
  );

  const otherFileResults = [];
  for (const file of otherFiles) {
    const filePath = join(archDir, file);
    const content = readFileSync(filePath, "utf8");
    const syntaxErrors = checkMarkdownSyntax(content, file);
    otherFileResults.push({
      file,
      syntaxErrors,
    });
  }

  const allSyntaxErrors = [
    ...componentResults.flatMap((c) => c.syntaxErrors),
    ...otherFileResults.flatMap((o) => o.syntaxErrors),
  ];

  const counts = {
    total: COMPONENTS_25.length,
    exists: componentResults.filter((c) => c.exists).length,
    ready: componentResults.filter((c) => c.status === "ready").length,
    incomplete: componentResults.filter((c) => c.status === "incomplete").length,
    missing: componentResults.filter((c) => c.status === "missing").length,
    syntaxErrors: allSyntaxErrors.length,
  };

  return {
    archDir,
    componentResults,
    otherFileResults,
    allSyntaxErrors,
    counts,
  };
}

/**
 * Generates the doc/architecture/INDEX.md content.
 */
export function generateIndexMarkdown(report) {
  const { counts, componentResults, otherFileResults } = report;

  const statusBadge = (status) => {
    switch (status) {
      case "ready":
        return "🟢 Готов";
      case "incomplete":
        return "🟡 В работе (неполный)";
      case "missing":
        return "🔴 Отсутствует";
      case "syntax_error":
        return "❌ Ошибка синтаксиса";
      default:
        return status;
    }
  };

  const boolMark = (val, exists) => {
    if (!exists) return "—";
    return val ? "✅" : "❌";
  };

  const lines = [
    "# Архитектура компонентов Myrmidon / Myrmidon Architecture Index",
    "",
    "> Сводный реестр и статус готовности страниц архитектуры компонентов (KNOWLEDGE-2.0 L-10).",
    "> Автоматически сформировано утилитой `scripts/validate-architecture-docs.mjs`.",
    "",
    "## Сводка готовности / Summary",
    "",
    `- **Всего компонентов:** ${counts.total}`,
    `- **Файлов в наличии:** ${counts.exists} / ${counts.total}`,
    `- **Полностью готовы (все обязательные секции):** ${counts.ready}`,
    `- **В работе / неполные (отсутствуют требуемые секции):** ${counts.incomplete}`,
    `- **Отсутствуют:** ${counts.missing}`,
    `- **Ошибки синтаксиса:** ${counts.syntaxErrors === 0 ? "0 (нет)" : `⚠️ ${counts.syntaxErrors}`}`,
    "",
    "### Обязательные секции шаблона (L-10)",
    "",
    "1. **Как задумано** (`## Как задумано` / `## How it is intended`) — целевая архитектура и инварианты.",
    "2. **Как сделано** (`## Как сделано` / `## How it is implemented`) — фактическая реализация в коде.",
    "3. **Расхождения** (`## Расхождения` / `## Difference from the intended design`) — отклонения, компромиссы, долг.",
    "",
    "---",
    "",
    "## Таблица статусов 25 проектных компонентов",
    "",
    "| № | Компонент | Файл | Группа | Как задумано | Как сделано | Расхождения | Статус |",
    "|---|---|---|---|:---:|:---:|:---:|---|",
  ];

  for (const c of componentResults) {
    const fileCell = c.exists ? `[\`${c.file}\`](./${c.file})` : `\`${c.file}\``;
    const titleCell = `${c.titleRu} <br> *(${c.titleEn})*`;
    const intendedCell = boolMark(c.hasIntended, c.exists);
    const implementedCell = boolMark(c.hasImplemented, c.exists);
    const differencesCell = boolMark(c.hasDifferences, c.exists);
    const statusCell = statusBadge(c.status);

    lines.push(
      `| ${c.id} | ${titleCell} | ${fileCell} | ${c.category} | ${intendedCell} | ${implementedCell} | ${differencesCell} | ${statusCell} |`,
    );
  }

  if (otherFileResults && otherFileResults.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Дополнительные архитектурные документы (Substrate / Runner)");
    lines.push("");
    lines.push("| Документ | Статус синтаксиса |");
    lines.push("|---|---|");
    for (const o of otherFileResults) {
      const errCount = o.syntaxErrors.length;
      const statusText = errCount === 0 ? "🟢 Синтаксис корректен" : `❌ ${errCount} синтаксических ошибок`;
      lines.push(`| [\`${o.file}\`](./${o.file}) | ${statusText} |`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Проверка и актуализация");
  lines.push("");
  lines.push("Для повторной сверки документов и обновления индекса запустите:");
  lines.push("```bash");
  lines.push("node scripts/validate-architecture-docs.mjs");
  lines.push("```");
  lines.push("");
  lines.push("Для проверки соответствия в CI без перезаписи:");
  lines.push("```bash");
  lines.push("node scripts/validate-architecture-docs.mjs --check");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

export function runCli(argv = process.argv.slice(2)) {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let archDir = join(repoRoot, "doc/architecture");
  let outputFile = join(archDir, "INDEX.md");
  let checkOnly = false;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/validate-architecture-docs.mjs [options]

Options:
  --dir <path>       Custom directory containing architecture documents (default: doc/architecture)
  --output <path>    Custom output path for INDEX.md (default: doc/architecture/INDEX.md)
  --check            Validate and assert INDEX.md is up to date without overwriting
  --strict           Fail (exit 1) if any of the 25 components is not fully ready
  --help, -h         Show this help message
`);
      return 0;
    }
    if (arg === "--dir" && argv[i + 1]) {
      archDir = resolve(argv[++i]);
    } else if (arg === "--output" && argv[i + 1]) {
      outputFile = resolve(argv[++i]);
    } else if (arg === "--check") {
      checkOnly = true;
    } else if (arg === "--strict") {
      strict = true;
    }
  }

  const report = validateArchitectureDirectory(archDir);

  console.log("=== Architecture Documentation Validation ===");
  console.log(`Directory:        ${archDir}`);
  console.log(`Components total: ${report.counts.total}`);
  console.log(`Files present:    ${report.counts.exists} / ${report.counts.total}`);
  console.log(`Ready (all 3 req): ${report.counts.ready}`);
  console.log(`Incomplete:       ${report.counts.incomplete}`);
  console.log(`Missing:          ${report.counts.missing}`);
  console.log(`Syntax errors:    ${report.counts.syntaxErrors}`);

  if (report.allSyntaxErrors.length > 0) {
    console.error("\n❌ Syntax errors detected in architecture documents:");
    for (const err of report.allSyntaxErrors) {
      console.error(`  - ${err}`);
    }
    process.exitCode = 1;
    return 1;
  }

  const generatedIndex = generateIndexMarkdown(report);

  if (checkOnly) {
    if (!existsSync(outputFile)) {
      console.error(`\n❌ INDEX.md does not exist at ${outputFile}`);
      process.exitCode = 1;
      return 1;
    }
    const current = readFileSync(outputFile, "utf8");
    if (current !== generatedIndex) {
      console.error(`\n❌ INDEX.md is out of date. Run 'node scripts/validate-architecture-docs.mjs' to update.`);
      process.exitCode = 1;
      return 1;
    }
    console.log(`\n✔ INDEX.md is up to date.`);
  } else {
    writeFileSync(outputFile, generatedIndex, "utf8");
    console.log(`\n✔ Generated and updated ${outputFile}`);
  }

  if (strict && (report.counts.incomplete > 0 || report.counts.missing > 0)) {
    console.error(`\n❌ Strict check failed: ${report.counts.incomplete} incomplete, ${report.counts.missing} missing components.`);
    process.exitCode = 1;
    return 1;
  }

  console.log("✔ Validation completed successfully with zero syntax errors.");
  return 0;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1];
const isDirectExecution =
  invokedFile &&
  (invokedFile === currentFile ||
    resolve(invokedFile) === currentFile ||
    (existsSync(invokedFile) && realpathSync(invokedFile) === realpathSync(currentFile)));
if (isDirectExecution) {
  runCli();
}
