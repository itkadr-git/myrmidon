// myrmidon(BOARD-JANITOR): unit tests for settings, policies, and report generation

import { describe, expect, it } from "vitest";
import {
  generateJanitorReportMarkdown,
  judgeMergedPrClosure,
  judgeOverdueDeadline,
  judgeStaleBlock,
  judgeStaleUntouched,
  judgeUnassignedReleaseTask,
  STALE_LABEL_NAME,
  type CommentCandidate,
  type IssueCandidate,
  type WorkProductCandidate,
} from "./policy.js";
import {
  isDueForDailyRun,
  readBoardJanitorSettings,
} from "./settings.js";

const BASE_NOW = new Date("2026-10-28T12:00:00.000Z");

describe("board janitor settings", () => {
  it("reads defaults correctly", () => {
    const settings = readBoardJanitorSettings({});
    expect(settings.enabled).toBe(true);
    expect(settings.runHourIrkutsk).toBe(8);
    expect(settings.serviceTicketId).toBe("a8529883-ab02-4998-a5ab-d70cd81560f8");
    expect(settings.serviceAgentId).toBe("b018f9bf-3f76-48d5-9530-aa9b0bf917f9");
  });

  it("checks daily run timing (08:00 Irkutsk = 00:00 UTC)", () => {
    // 00:05 UTC = 08:05 Irkutsk -> due
    const timeAt0805Irkutsk = new Date("2026-10-28T00:05:00.000Z");
    expect(isDueForDailyRun(timeAt0805Irkutsk, null, 8)).toBe(true);

    // If already ran today at 08:05, should not run again at 08:30
    const timeAt0830Irkutsk = new Date("2026-10-28T00:30:00.000Z");
    expect(isDueForDailyRun(timeAt0830Irkutsk, timeAt0805Irkutsk, 8)).toBe(false);

    // Next day at 08:02 Irkutsk -> due again
    const nextDayIrkutsk = new Date("2026-10-29T00:02:00.000Z");
    expect(isDueForDailyRun(nextDayIrkutsk, timeAt0805Irkutsk, 8)).toBe(true);
  });
});

describe("Rule 1: Merged PR closure", () => {
  it("closes open task when linked PR is merged", () => {
    const task: IssueCandidate = {
      id: "task-1",
      identifier: "OPE-100",
      title: "1.6.7 Fix something",
      status: "in_review",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };
    const wps: WorkProductCandidate[] = [
      {
        id: "wp-1",
        issueId: "task-1",
        type: "pull_request",
        status: "merged",
        url: "https://github.com/itkadr-git/myrmidon/pull/1890",
        metadata: { prNumber: 1890, state: "merged" },
      },
    ];

    const judgment = judgeMergedPrClosure(task, wps);
    expect(judgment).not.toBeNull();
    expect(judgment?.shouldClose).toBe(true);
    expect(judgment?.prNumber).toBe(1890);
    expect(judgment?.comment).toBe("закрыто по влитому PR #1890");
  });

  it("does not close task if PR is still open", () => {
    const task: IssueCandidate = {
      id: "task-1",
      identifier: "OPE-100",
      title: "1.6.7 Fix something",
      status: "in_review",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };
    const wps: WorkProductCandidate[] = [
      {
        id: "wp-1",
        issueId: "task-1",
        type: "pull_request",
        status: "open",
        metadata: { prNumber: 1891, state: "open" },
      },
    ];

    const judgment = judgeMergedPrClosure(task, wps);
    expect(judgment).toBeNull();
  });
});

describe("Rule 2: Stale block resolution vs question holding", () => {
  it("unblocks blocked task to todo when no open blockers and no open children", () => {
    const task: IssueCandidate = {
      id: "task-2",
      identifier: "OPE-200",
      title: "Stale blocked task",
      status: "blocked",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };

    const judgment = judgeStaleBlock(task, 0, 0, null, BASE_NOW);
    expect(judgment).not.toBeNull();
    expect(judgment?.action).toBe("unblock_to_todo");
    if (judgment?.action === "unblock_to_todo") {
      expect(judgment.comment).toBe("блок снят: блокер закрыт/отсутствует");
    }
  });

  it("does NOT unblock if there is an open blocker or open child", () => {
    const task: IssueCandidate = {
      id: "task-2",
      identifier: "OPE-200",
      title: "Stale blocked task",
      status: "blocked",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };

    expect(judgeStaleBlock(task, 1, 0, null, BASE_NOW)).toBeNull();
    expect(judgeStaleBlock(task, 0, 1, null, BASE_NOW)).toBeNull();
  });

  it("retains block if last comment asks a question and notes days waiting", () => {
    const task: IssueCandidate = {
      id: "task-2",
      identifier: "OPE-200",
      title: "Waiting for answer",
      status: "blocked",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };
    const commentDate = new Date(BASE_NOW.getTime() - 4 * 86400 * 1000); // 4 days ago
    const lastComment: CommentCandidate = {
      id: "comm-1",
      issueId: "task-2",
      body: "ADM: нужно согласование по новой архитектуре?",
      createdAt: commentDate,
    };

    const judgment = judgeStaleBlock(task, 0, 0, lastComment, BASE_NOW);
    expect(judgment).not.toBeNull();
    expect(judgment?.action).toBe("keep_waiting_question");
    if (judgment?.action === "keep_waiting_question") {
      expect(judgment.daysWaiting).toBe(4);
      expect(judgment.snippet).toContain("согласование");
    }
  });
});

describe("Rule 3: Unassigned release tasks", () => {
  it("queues unassigned release task into role distribution", () => {
    const task: IssueCandidate = {
      id: "task-3",
      identifier: "OPE-300",
      title: "1.6.7 BOARD-JANITOR: cleanup routine",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };

    const judgment = judgeUnassignedReleaseTask(task);
    expect(judgment).not.toBeNull();
    expect(judgment?.shouldQueue).toBe(true);
    expect(judgment?.releasePrefix).toBe("1.6.7");
  });

  it("ignores non-release task or assigned task", () => {
    const nonRelease: IssueCandidate = {
      id: "task-3b",
      identifier: "OPE-300b",
      title: "Miscellaneous investigation",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };
    expect(judgeUnassignedReleaseTask(nonRelease)).toBeNull();

    const assigned: IssueCandidate = {
      id: "task-3c",
      identifier: "OPE-300c",
      title: "1.6.7 Already assigned",
      status: "todo",
      assigneeAgentId: "agent-1",
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };
    expect(judgeUnassignedReleaseTask(assigned)).toBeNull();
  });
});

describe("Rule 4: Tasks untouched >21 days", () => {
  it("marks task untouched >21 days with label and agent comment", () => {
    const task: IssueCandidate = {
      id: "task-4",
      identifier: "OPE-400",
      title: "Untouched task",
      status: "todo",
      assigneeAgentId: "agent-dev-1",
      lastActivityAt: new Date(BASE_NOW.getTime() - 25 * 86400 * 1000),
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
      labels: [],
    };

    const judgment = judgeStaleUntouched(task, BASE_NOW);
    expect(judgment).not.toBeNull();
    expect(judgment?.action).toBe("mark_stale");
    if (judgment?.action === "mark_stale") {
      expect(judgment.daysUntouched).toBe(25);
      expect(judgment.comment).toBe("актуально? закрыть или назначить срок");
    }
  });

  it("moves stale task to backlog after 7 days without response", () => {
    const task: IssueCandidate = {
      id: "task-4b",
      identifier: "OPE-400b",
      title: "Old stale task",
      status: "todo",
      assigneeAgentId: "agent-dev-1",
      lastActivityAt: new Date(BASE_NOW.getTime() - 30 * 86400 * 1000),
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
      labels: [
        {
          name: STALE_LABEL_NAME,
          createdAt: new Date(BASE_NOW.getTime() - 8 * 86400 * 1000),
        },
      ],
    };

    const judgment = judgeStaleUntouched(task, BASE_NOW);
    expect(judgment).not.toBeNull();
    expect(judgment?.action).toBe("move_to_backlog");
    expect(judgment?.comment).toContain("7 дней без ответа");
  });
});

describe("Rule 5: Overdue deadlines", () => {
  it("detects overdue deadline and alerts assignee", () => {
    const task: IssueCandidate = {
      id: "task-5",
      identifier: "OPE-500",
      title: "Urgent fix [дедлайн: 2026-10-01]",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      metadata: { targetDate: "2026-10-01" },
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
    };

    const judgment = judgeOverdueDeadline(task, BASE_NOW);
    expect(judgment).not.toBeNull();
    expect(judgment?.isOverdue).toBe(true);
    expect(judgment?.deadline).toBe("2026-10-01");
  });
});

describe("Rule 6: Report generation", () => {
  it("generates formatted markdown report document", () => {
    const md = generateJanitorReportMarkdown({
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
          issueId: "t-1",
          identifier: "OPE-100",
          prNumber: 1890,
          comment: "закрыто по влитому PR #1890",
        },
      ],
    });

    expect(md).toContain("# Отчёт уборки доски (BOARD-JANITOR): 2026-10-28");
    expect(md).toContain("1055");
    expect(md).toContain("955");
    expect(md).toContain("OPE-100");
  });
});
