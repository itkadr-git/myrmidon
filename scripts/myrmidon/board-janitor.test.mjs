import assert from "node:assert/strict";
import test from "node:test";
import {
  extractReleasePrefix,
  generateReport,
  hasQuestionPattern,
  isOpenStatus,
  judgeTask,
  STALE_LABEL_NAME,
} from "./board-janitor.mjs";

test("isOpenStatus verifies open vs closed lifecycle", () => {
  assert.equal(isOpenStatus("todo"), true);
  assert.equal(isOpenStatus("in_progress"), true);
  assert.equal(isOpenStatus("blocked"), true);
  assert.equal(isOpenStatus("backlog"), true);
  assert.equal(isOpenStatus("in_review"), true);
  assert.equal(isOpenStatus("done"), false);
  assert.equal(isOpenStatus("cancelled"), false);
});

test("hasQuestionPattern detects Russian and English question patterns", () => {
  assert.equal(hasQuestionPattern("Как лучше сделать миграцию?"), true);
  assert.equal(hasQuestionPattern("Нужно согласование по схеме БД"), true);
  assert.equal(hasQuestionPattern("Уточните требования для OPE-1234"), true);
  assert.equal(hasQuestionPattern("ADM: проверьте пожалуйста"), true);
  assert.equal(hasQuestionPattern("Обычный комментарий с описанием шагов"), false);
});

test("extractReleasePrefix parses version prefix from title", () => {
  assert.equal(extractReleasePrefix("1.6.7 BOARD-JANITOR: уборка"), "1.6.7");
  assert.equal(extractReleasePrefix("1.6.6 P1.2 DEVFLOW: очередь"), "1.6.6");
  assert.equal(extractReleasePrefix("TASK without release"), null);
});

test("judgeTask: Rule 1 closes task when linked PR is merged", () => {
  const task = {
    id: "task-1",
    identifier: "OPE-1001",
    title: "1.6.7 Fix something",
    status: "in_review",
  };
  const context = {
    workProductsByIssue: new Map([
      [
        "task-1",
        [
          {
            type: "pull_request",
            status: "merged",
            metadata: { prNumber: 1234 },
          },
        ],
      ],
    ]),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "close_merged_pr");
  assert.equal(actions[0].prNumber, 1234);
  assert.equal(actions[0].comment, "закрыто по влитому PR #1234");
});

test("judgeTask: Rule 2 unblocks task without open blockers/children to todo", () => {
  const task = {
    id: "task-2",
    identifier: "OPE-1002",
    title: "Waiting on nothing",
    status: "blocked",
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map([["task-2", 0]]),
    openChildrenByIssue: new Map([["task-2", 0]]),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  const unblockAction = actions.find((a) => a.type === "unblock_stale");
  assert.ok(unblockAction);
  assert.equal(unblockAction.comment, "блок снят: блокер закрыт/отсутствует");
});

test("judgeTask: Rule 2 keeps block when last comment asks a question", () => {
  const task = {
    id: "task-3",
    identifier: "OPE-1003",
    title: "Waiting for Alex approval",
    status: "blocked",
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map([["task-3", 0]]),
    openChildrenByIssue: new Map([["task-3", 0]]),
    lastCommentByIssue: new Map([
      [
        "task-3",
        {
          body: "Alex, согласуй пожалуйста новую схему?",
          createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        },
      ],
    ]),
  };

  const actions = judgeTask(task, context);
  const waitingAction = actions.find((a) => a.type === "blocked_waiting_question");
  assert.ok(waitingAction);
  assert.equal(waitingAction.daysWaiting, 3);
  assert.equal(actions.some((a) => a.type === "unblock_stale"), false);
});

test("judgeTask: Rule 3 routes unassigned release task to role distribution queue", () => {
  const task = {
    id: "task-4",
    identifier: "OPE-1004",
    title: "1.6.7 ROUTINE: unassigned release task",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  const queueAction = actions.find((a) => a.type === "queue_unassigned_release");
  assert.ok(queueAction);
  assert.equal(queueAction.releasePrefix, "1.6.7");
});

test("judgeTask: Rule 4 marks task untouched >21 days with label 'залежалась'", () => {
  const task = {
    id: "task-5",
    identifier: "OPE-1005",
    title: "Forgotten task",
    status: "todo",
    assigneeAgentId: "agent-1",
    lastActivityAt: new Date(Date.now() - 25 * 86400000).toISOString(),
    labels: [],
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  const staleAction = actions.find((a) => a.type === "mark_stale_untouched");
  assert.ok(staleAction);
  assert.equal(staleAction.daysUntouched, 25);
  assert.equal(staleAction.comment, "актуально? закрыть или назначить срок");
});

test("judgeTask: Rule 4 moves stale task to backlog after 7 days without response", () => {
  const task = {
    id: "task-6",
    identifier: "OPE-1006",
    title: "Long forgotten task",
    status: "todo",
    assigneeAgentId: "agent-1",
    lastActivityAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    labels: [
      {
        name: STALE_LABEL_NAME,
        createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      },
    ],
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  const backlogAction = actions.find((a) => a.type === "move_stale_to_backlog");
  assert.ok(backlogAction);
  assert.equal(backlogAction.comment, "7 дней без ответа после метки «залежалась» → переведено в backlog");
});

test("judgeTask: Rule 5 flags overdue deadlines", () => {
  const task = {
    id: "task-7",
    identifier: "OPE-1007",
    title: "Task with passed deadline [дедлайн: 2026-10-01]",
    status: "in_progress",
    metadata: { deadline: "2026-10-01" },
  };
  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  const actions = judgeTask(task, context);
  const overdueAction = actions.find((a) => a.type === "notify_overdue");
  assert.ok(overdueAction);
  assert.equal(overdueAction.deadline, "2026-10-01");
});

test("generateReport produces formatted markdown document", () => {
  const report = generateReport({
    dateStr: "2026-10-28",
    statsBefore: {
      totalOpen: 1055,
      blocked: 555,
      noAssignee: 118,
      onOwner: 59,
      untouched21d: 34,
      overdue: 3,
    },
    statsAfter: {
      totalOpen: 955,
      blocked: 308,
      noAssignee: 118,
      onOwner: 59,
      untouched21d: 25,
      overdue: 3,
    },
    actions: [
      {
        type: "close_merged_pr",
        identifier: "OPE-9680",
        prNumber: 1950,
      },
      {
        type: "unblock_stale",
        identifier: "OPE-9000",
      },
    ],
  });

  assert.ok(report.includes("# Отчёт уборки доски (BOARD-JANITOR): 2026-10-28"));
  assert.ok(report.includes("1055"));
  assert.ok(report.includes("955"));
  assert.ok(report.includes("OPE-9680"));
});
