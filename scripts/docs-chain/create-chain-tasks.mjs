#!/usr/bin/env node
/**
 * scripts/docs-chain/create-chain-tasks.mjs
 *
 * Handler for GitHub webhook delivery (PR merged into main).
 * Automatically creates documentation chain tasks:
 * - When a PR touching tracked docs/skills is merged into main: creates EN docs task.
 * - When an EN docs chain PR is merged into main: creates RU task for changed sections.
 *
 * Enforces:
 * - Path filter: docs/**, docs/wiki/**, .agents/skills/**, packages/skills-catalog/**
 * - Idempotency key: docs-chain:<repo>:<pr>:<en|ru>
 * - Deduplication: repeat webhook delivery creates 0 tasks
 * - No auto-merge: PR auto-merge is prohibited
 * - Assigned role: engineer via queue pickup (assigneeAgentId: null)
 * - Dry-run mode: prints task payload without creating it
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRACKED_PATH_PREFIXES = [
  "docs/",
  "docs/wiki/",
  ".agents/skills/",
  "packages/skills-catalog/",
];

/**
 * Filter changed files to only tracked documentation and skills paths.
 */
export function filterTrackedFiles(files = []) {
  if (!Array.isArray(files)) return [];
  return files.filter((f) => {
    if (typeof f !== "string") return false;
    const normalized = f.replace(/^\.\//, "");
    return TRACKED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

/**
 * Extract changed files list from various GitHub webhook payload shapes.
 */
export function extractChangedFiles(payload = {}) {
  const candidates = [
    payload.changed_files_list,
    payload.files,
    payload.changed_files,
    payload.pull_request?.files,
    payload.pull_request?.changed_files_list,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            return item.filename || item.path || item.name || "";
          }
          return "";
        })
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Determine if the payload represents a PR merged into main.
 */
export function isMergedToMain(payload = {}) {
  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) return false;
  const isClosed = action === "closed" || payload.merged === true;
  const isMerged = Boolean(pr.merged || payload.merged);
  const baseRef = pr.base?.ref || payload.base_ref;
  return isClosed && isMerged && (baseRef === "main" || baseRef === "refs/heads/main");
}

/**
 * Determine the documentation chain phase ('en' or 'ru').
 */
export function determinePhase(payload = {}, options = {}) {
  if (options.phase) return options.phase;
  if (payload.phase) return payload.phase;
  const pr = payload.pull_request || {};
  const title = pr.title || payload.title || "";
  const branch = pr.head?.ref || payload.head_branch || "";
  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((l) => (typeof l === "string" ? l : l.name || ""))
    : [];

  if (
    /DOCS-CHAIN\s+EN\b/i.test(title) ||
    /docs-chain-en/i.test(branch) ||
    labels.some((l) => /docs-chain-en/i.test(l))
  ) {
    return "ru";
  }
  return "en";
}

/**
 * Construct the canonical idempotency key: docs-chain:<repo>:<pr>:<phase>
 */
export function buildIdempotencyKey({ repo, prNumber, phase }) {
  const normalizedRepo = (repo || "myrmidon")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  return `docs-chain:${normalizedRepo}:${prNumber}:${phase}`;
}

/**
 * Build the task object from the DOCS-CHAIN templates.
 */
export function buildChainTask({ repo, prNumber, prTitle, prUrl, phase, changedFiles }) {
  const idempotencyKey = buildIdempotencyKey({ repo, prNumber, phase });
  const isEn = phase === "en";
  const title = `1.7 DOCS-CHAIN ${isEn ? "EN" : "RU"}: #${prNumber} ${prTitle}`;
  const changedSectionsList = changedFiles.map((f) => `- \`${f}\``).join("\n");

  const description = isEn
    ? `Часть цепочки документации DOCS-CHAIN (выпуск 1.7).
EN docs task: обновление англоязычной документации и навыков по влитому PR.

- Исходный PR: ${prUrl} (#${prNumber})
- Репозиторий: ${repo}
- Изменённые пути:
${changedSectionsList}

Цель:
1. Синхронизировать документацию (docs/**, docs/wiki/**) и каталоги навыков (.agents/skills/**, packages/skills-catalog/**) с изменениями кода.
2. Провести аудит дрейфа: доки и навык, дубль-проверка.

Правила:
- EN docs task
- Ревью обязательно
- Автослияния нет (no auto-merge)
- Лимит запусков на PR: 2
- Роль исполнителя: engineer (захват из очереди, без прямого назначения)

Критерии приёмки:
- Документация и навыки приведены в соответствие с исходным PR ${prUrl}.
- Ссылка на исходный PR включена в описание PR.
- Автослияния нет.`
    : `Часть цепочки документации DOCS-CHAIN (выпуск 1.7).
RU changed sections: перевод на русский язык изменённых разделов по влитому PR.

- Исходный PR: ${prUrl} (#${prNumber})
- Репозиторий: ${repo}
- Список изменённых разделов:
${changedSectionsList}

Цель:
1. Перевести на русский язык ТОЛЬКО изменённые разделы (docs/wiki, русскоязычные разделы документации).
2. Не вносить правок в неизменённые разделы во избежание шума и конфликтов.

Правила:
- RU changed sections
- Ревью обязательно
- Автослияния нет (no auto-merge)
- Лимит запусков на PR: 2
- Роль исполнителя: engineer (захват из очереди, без прямого назначения)

Критерии приёмки:
- переведены только изменённые разделы, ссылка на PR есть
- Ссылка на исходный PR ${prUrl} сохранена в описании задачи и PR
- Автослияния нет.`;

  return {
    title,
    description,
    idempotencyKey,
    assigneeAgentId: null,
    role: "engineer",
    status: "todo",
    priority: "medium",
    phase,
    metadata: {
      source: "docs-chain",
      repo,
      prNumber,
      phase,
      idempotencyKey,
      changedFiles,
    },
  };
}

/**
 * In-memory dedup store for standalone executions and runs.
 */
export class DedupStore {
  constructor(initialKeys = []) {
    this.keys = new Set(initialKeys);
  }
  has(key) {
    return this.keys.has(key);
  }
  add(key) {
    this.keys.add(key);
  }
  clear() {
    this.keys.clear();
  }
}

export const globalDedupStore = new DedupStore();

/**
 * Handle a GitHub webhook delivery payload.
 */
export async function createChainTasks(payload = {}, options = {}) {
  const {
    dryRun = false,
    dedupStore = globalDedupStore,
    log = console.log,
    apiClient = null,
  } = options;

  // 1. Verify PR is merged into main
  if (!isMergedToMain(payload)) {
    return { createdCount: 0, reason: "not_merged_to_main", tasks: [] };
  }

  // 2. Extract and filter changed files
  const changedFiles = extractChangedFiles(payload);
  const trackedFiles = filterTrackedFiles(changedFiles);
  if (trackedFiles.length === 0) {
    return { createdCount: 0, reason: "no_tracked_files", tasks: [] };
  }

  // 3. Extract PR info and phase
  const pr = payload.pull_request || {};
  const prNumber = pr.number || payload.number;
  const prTitle = pr.title || "";
  const repo = payload.repository?.full_name || payload.repository?.name || "itkadr-git/myrmidon";
  const prUrl = pr.html_url || `https://github.com/${repo}/pull/${prNumber}`;
  const phase = determinePhase(payload, options);

  const task = buildChainTask({
    repo,
    prNumber,
    prTitle,
    prUrl,
    phase,
    changedFiles: trackedFiles,
  });

  // 4. Check deduplication
  if (dedupStore.has(task.idempotencyKey)) {
    return {
      createdCount: 0,
      deduplicated: true,
      reason: "deduplicated",
      idempotencyKey: task.idempotencyKey,
      tasks: [],
    };
  }

  // 5. Dry-run mode: prints task, does not create via API
  if (dryRun) {
    dedupStore.add(task.idempotencyKey);
    log(`[DRY-RUN] Task planned: ${task.idempotencyKey} ("${task.title}")`);
    return {
      createdCount: 1,
      dryRun: true,
      deduplicated: false,
      tasks: [task],
    };
  }

  // 6. API creation if apiClient is provided
  if (apiClient && typeof apiClient.createIssue === "function") {
    const res = await apiClient.createIssue(task);
    if (res?.deduplicated) {
      dedupStore.add(task.idempotencyKey);
      return {
        createdCount: 0,
        deduplicated: true,
        reason: "deduplicated_by_api",
        idempotencyKey: task.idempotencyKey,
        tasks: [],
      };
    }
  }

  dedupStore.add(task.idempotencyKey);
  return {
    createdCount: 1,
    deduplicated: false,
    tasks: [task],
  };
}

// CLI runner
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const payloadArgIndex = args.indexOf("--payload");
  const payloadPath = payloadArgIndex !== -1 ? args[payloadArgIndex + 1] : null;

  let payload = {};
  if (payloadPath) {
    if (payloadPath === "-") {
      payload = JSON.parse(fs.readFileSync(0, "utf8"));
    } else {
      payload = JSON.parse(fs.readFileSync(path.resolve(payloadPath), "utf8"));
    }
  }

  createChainTasks(payload, { dryRun })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
