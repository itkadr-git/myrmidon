import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createChainTasks,
  filterTrackedFiles,
  buildIdempotencyKey,
  buildChainTask,
  extractSourcePrNumber,
  DedupStore,
  TRACKED_PATH_PREFIXES,
} from "./create-chain-tasks.mjs";

const mergeWithDocsFixture = {
  action: "closed",
  merged: true,
  pull_request: {
    number: 1042,
    title: "feat(skills): update agent workflow skills and docs",
    html_url: "https://github.com/itkadr-git/myrmidon/pull/1042",
    merged: true,
    base: { ref: "main" },
    head: { ref: "feature/update-skills" },
    files: [
      { filename: "docs/architecture.md" },
      { filename: "packages/skills-catalog/catalog/bundled/skills.json" },
      { filename: "server/src/ignored.ts" },
    ],
  },
  repository: {
    name: "myrmidon",
    full_name: "itkadr-git/myrmidon",
  },
};

const mergeWithoutDocsFixture = {
  action: "closed",
  merged: true,
  pull_request: {
    number: 1043,
    title: "fix(backend): optimize database query indices",
    html_url: "https://github.com/itkadr-git/myrmidon/pull/1043",
    merged: true,
    base: { ref: "main" },
    head: { ref: "fix/db-perf" },
    files: [
      { filename: "server/src/services/db.ts" },
      { filename: "packages/db/schema.ts" },
    ],
  },
  repository: {
    name: "myrmidon",
    full_name: "itkadr-git/myrmidon",
  },
};

const mergeEnDocsFixture = {
  action: "closed",
  merged: true,
  pull_request: {
    number: 1044,
    title: "[DOCS-EN] Актуализация EN-документации и навыков по PR #1042",
    html_url: "https://github.com/itkadr-git/myrmidon/pull/1044",
    merged: true,
    base: { ref: "main" },
    head: { ref: "bot/docs-chain-en-1042" },
    files: [
      { filename: "docs/architecture.md" },
      { filename: "docs/wiki/overview.md" },
    ],
  },
  repository: {
    name: "myrmidon",
    full_name: "itkadr-git/myrmidon",
  },
};

test("path filter accepts docs, docs/wiki, .agents/skills, packages/skills-catalog and ignores other paths", () => {
  const inputs = [
    "docs/intro.md",
    "docs/wiki/team.md",
    ".agents/skills/pr-gardening/SKILL.md",
    "packages/skills-catalog/catalog/skill.json",
    "server/src/routes.ts",
    "ui/src/App.tsx",
    "README.md",
  ];
  const filtered = filterTrackedFiles(inputs);
  assert.deepEqual(filtered, [
    "docs/intro.md",
    "docs/wiki/team.md",
    ".agents/skills/pr-gardening/SKILL.md",
    "packages/skills-catalog/catalog/skill.json",
  ]);
});

test("merge with docs -> creates 1 EN task; repeat delivery -> 0 (dedup)", async () => {
  const dedupStore = new DedupStore();

  // First delivery
  const firstResult = await createChainTasks(mergeWithDocsFixture, { dedupStore });
  assert.equal(firstResult.createdCount, 1);
  assert.equal(firstResult.deduplicated, false);
  assert.equal(firstResult.tasks.length, 1);

  const task = firstResult.tasks[0];
  assert.equal(task.idempotencyKey, "docs-chain:itkadr-git/myrmidon:1042:en");
  assert.equal(task.role, "engineer");
  assert.equal(task.assigneeAgentId, null);
  assert.equal(
    task.title,
    "[DOCS-EN] Актуализация EN-документации и навыков по PR #1042",
  );
  assert.match(task.description, /Ссылка на исходный PR \/ Source PR: #1042/);
  assert.match(task.description, /Список изменённых разделов \/ Changed sections/);
  assert.match(task.description, /Актуализирована EN-документация/);
  assert.match(task.description, /дубль-проверка/);
  assert.match(task.description, /Правки минимальны: факт, а не рерайт стиля/);
  assert.match(task.description, /run limit/);
  assert.match(task.description, /3–5 прогонов агента/);
  assert.match(task.description, /Ревью обязательно/);
  assert.match(task.description, /автослияния нет \(no auto-merge\)/i);
  assert.match(task.description, /https:\/\/github\.com\/itkadr-git\/myrmidon\/pull\/1042/);
  assert.match(task.description, /docs\/architecture\.md/);

  // Repeat delivery with identical payload
  const repeatResult = await createChainTasks(mergeWithDocsFixture, { dedupStore });
  assert.equal(repeatResult.createdCount, 0);
  assert.equal(repeatResult.deduplicated, true);
  assert.equal(repeatResult.tasks.length, 0);
});

test("merge without docs -> 0 tasks created", async () => {
  const dedupStore = new DedupStore();
  const result = await createChainTasks(mergeWithoutDocsFixture, { dedupStore });
  assert.equal(result.createdCount, 0);
  assert.equal(result.reason, "no_tracked_files");
  assert.equal(result.tasks.length, 0);
});

test("merge of EN-PR -> creates RU task for changed sections only", async () => {
  const dedupStore = new DedupStore();
  const result = await createChainTasks(mergeEnDocsFixture, { dedupStore });
  assert.equal(result.createdCount, 1);
  assert.equal(result.tasks.length, 1);

  const task = result.tasks[0];
  assert.equal(task.idempotencyKey, "docs-chain:itkadr-git/myrmidon:1044:ru");
  assert.equal(
    task.title,
    "[DOCS-RU] Локализация изменённых разделов по PR #1042",
  );
  assert.match(task.description, /Ссылка на исходный PR \/ Source PR: #1042/);
  assert.match(task.description, /Ссылка на EN PR \/ EN docs PR: #1044/);
  assert.match(task.description, /Список изменённых разделов \/ Changed sections/);
  assert.match(task.description, /переведены только изменённые разделы, ссылка на PR есть/);
  assert.match(task.description, /Ревью обязательно/);
  assert.match(task.description, /автослияния нет \(no auto-merge\)/i);
  assert.match(task.description, /run limit/);
  assert.match(task.description, /3–5 прогонов агента/);
  assert.match(task.description, /docs\/wiki\/overview\.md/);
});

test("task titles and bodies follow the canonical doc/DOCS-CHAIN.md templates", () => {
  const enTask = buildChainTask({
    repo: "itkadr-git/myrmidon",
    prNumber: 2001,
    prTitle: "feat: change public API",
    prUrl: "https://github.com/itkadr-git/myrmidon/pull/2001",
    phase: "en",
    changedFiles: ["docs/architecture.md"],
  });
  assert.equal(
    enTask.title,
    "[DOCS-EN] Актуализация EN-документации и навыков по PR #2001",
  );
  assert.match(enTask.description, /doc\/DOCS-CHAIN\.md/);
  assert.doesNotMatch(enTask.title, /1\.7 DOCS-CHAIN/);
  assert.doesNotMatch(enTask.description, /Лимит запусков на PR: 2/);

  const ruTask = buildChainTask({
    repo: "itkadr-git/myrmidon",
    prNumber: 2002,
    prTitle: "[DOCS-EN] Актуализация EN-документации и навыков по PR #2001",
    prUrl: "https://github.com/itkadr-git/myrmidon/pull/2002",
    phase: "ru",
    changedFiles: ["docs/wiki/overview.md"],
  });
  assert.equal(
    ruTask.title,
    "[DOCS-RU] Локализация изменённых разделов по PR #2001",
  );
  assert.equal(ruTask.idempotencyKey, "docs-chain:itkadr-git/myrmidon:2002:ru");
});

test("extractSourcePrNumber picks the PR number from an EN title", () => {
  assert.equal(extractSourcePrNumber("[DOCS-EN] Актуализация EN-документации и навыков по PR #1042"), 1042);
  assert.equal(extractSourcePrNumber("1.7 DOCS-CHAIN EN: #77 fix(x)"), 77);
  assert.equal(extractSourcePrNumber("no number here"), null);
  assert.equal(extractSourcePrNumber(""), null);
});

test("non-merge actions or non-main base branch create 0 tasks", async () => {
  const dedupStore = new DedupStore();

  // Action opened
  const opened = {
    ...mergeWithDocsFixture,
    action: "opened",
    merged: false,
    pull_request: { ...mergeWithDocsFixture.pull_request, merged: false },
  };
  const openedRes = await createChainTasks(opened, { dedupStore });
  assert.equal(openedRes.createdCount, 0);

  // Closed without merge
  const closedUnmerged = {
    ...mergeWithDocsFixture,
    action: "closed",
    merged: false,
    pull_request: { ...mergeWithDocsFixture.pull_request, merged: false },
  };
  const unmergedRes = await createChainTasks(closedUnmerged, { dedupStore });
  assert.equal(unmergedRes.createdCount, 0);

  // Merged into non-main base
  const nonMain = {
    ...mergeWithDocsFixture,
    pull_request: { ...mergeWithDocsFixture.pull_request, base: { ref: "feature-branch" } },
  };
  const nonMainRes = await createChainTasks(nonMain, { dedupStore });
  assert.equal(nonMainRes.createdCount, 0);
});

test("dry-run mode logs planned task and does not create via API client", async () => {
  const dedupStore = new DedupStore();
  let apiCalled = false;
  const apiClient = {
    createIssue: async () => {
      apiCalled = true;
      return { id: "issue-1" };
    },
  };

  const logs = [];
  const result = await createChainTasks(mergeWithDocsFixture, {
    dryRun: true,
    dedupStore,
    apiClient,
    log: (msg) => logs.push(msg),
  });

  assert.equal(result.createdCount, 1);
  assert.equal(result.dryRun, true);
  assert.equal(apiCalled, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[DRY-RUN\]/);
});

test("script prohibits auto-merge and contains no auto-merge capability", async () => {
  const mod = await import("./create-chain-tasks.mjs");
  assert.equal(typeof mod.mergePullRequest, "undefined");
  assert.equal(typeof mod.autoMerge, "undefined");
});
