// myrmidon(BOARD-JANITOR): pure policy rules and report formatting
//
// Rules:
// 1. Merged PR on open issue -> done, comment "закрыто по влитому PR #N"
// 2. blocked without open blocker and without open children -> todo, comment "блок снят: блокер закрыт/отсутствует".
//    If last comment contains a specific question -> do not unblock, note "ждёт ответа N дней".
// 3. Unassigned issue in release -> role distribution queue (DEVFLOW-9678).
// 4. Untouched >21 days -> label "залежалась". To task owner (agent) -> comment "актуально? закрыть или назначить срок".
//    After 7 days without response -> backlog.
// 5. Overdue deadline -> comment to assignee and row in report.
// 6. Report: single document `janitor-YYYY-MM-DD` on service ticket (OPE-9758).

export const STALE_LABEL_NAME = "залежалась";
export const UNTOUCHED_THRESHOLD_DAYS = 21;
export const STALE_RESPONSE_WINDOW_DAYS = 7;

export interface IssueCandidate {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  parentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt?: Date | null;
  labels?: Array<{ name: string; createdAt?: Date }>;
  metadata?: Record<string, unknown> | null;
}

export interface WorkProductCandidate {
  id: string;
  issueId: string;
  type: string;
  provider?: string | null;
  url?: string | null;
  status?: string | null; // e.g. "merged", "closed", "open"
  metadata?: Record<string, unknown> | null;
}

export interface CommentCandidate {
  id: string;
  issueId: string;
  body: string;
  createdAt: Date;
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export type JanitorAction =
  | {
      type: "close_merged_pr";
      issueId: string;
      identifier: string;
      prNumber: number;
      comment: string;
    }
  | {
      type: "unblock_stale";
      issueId: string;
      identifier: string;
      comment: string;
    }
  | {
      type: "blocked_waiting_question";
      issueId: string;
      identifier: string;
      daysWaiting: number;
      questionSnippet: string;
    }
  | {
      type: "queue_unassigned_release";
      issueId: string;
      identifier: string;
      releasePrefix: string;
      comment: string;
    }
  | {
      type: "mark_stale_untouched";
      issueId: string;
      identifier: string;
      daysUntouched: number;
      comment: string | null;
    }
  | {
      type: "move_stale_to_backlog";
      issueId: string;
      identifier: string;
      staleDays: number;
      comment: string;
    }
  | {
      type: "notify_overdue";
      issueId: string;
      identifier: string;
      deadline: string;
      comment: string;
    };

export function isOpenStatus(status: string): boolean {
  return ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(status);
}

/**
 * Extracts PR number from a work product URL or metadata.
 */
export function extractPrNumber(wp: WorkProductCandidate): number | null {
  if (wp.metadata && typeof wp.metadata.prNumber === "number") {
    return wp.metadata.prNumber;
  }
  if (wp.metadata && typeof wp.metadata.number === "number") {
    return wp.metadata.number;
  }
  if (wp.url) {
    const match = wp.url.match(/\/pull\/(\d+)/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Rule 1: Merged PR on open issue -> done, comment "закрыто по влитому PR #N"
 */
export function judgeMergedPrClosure(
  task: IssueCandidate,
  workProducts: WorkProductCandidate[],
): { shouldClose: boolean; prNumber: number; comment: string } | null {
  if (!isOpenStatus(task.status)) return null;

  for (const wp of workProducts) {
    if (wp.type !== "pull_request") continue;
    const isMerged =
      wp.status === "merged" ||
      wp.metadata?.state === "merged" ||
      wp.metadata?.state === "MERGED" ||
      wp.metadata?.isMerged === true;

    if (isMerged) {
      const prNum = extractPrNumber(wp) || 0;
      return {
        shouldClose: true,
        prNumber: prNum,
        comment: `закрыто по влитому PR #${prNum}`,
      };
    }
  }
  return null;
}

/**
 * Checks if a comment text asks a question or requires human/owner input.
 */
export function hasQuestionPattern(body: string | undefined | null): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  if (trimmed.includes("?")) return true;

  const lower = trimmed.toLowerCase();
  const questionKeywords = [
    "вопрос",
    "согласован",
    "уточн",
    "как поступить",
    "нужно решение",
    "жду ответ",
    "ждём ответ",
    "ждёт ответ",
    "adm:",
    "alex:",
    "blocking question",
    "awaiting input",
    "please confirm",
  ];

  return questionKeywords.some((kw) => lower.includes(kw));
}

/**
 * Rule 2: blocked without open blocker and without open children -> todo,
 * comment "блок снят: блокер закрыт/отсутствует".
 * If last comment contains a specific question -> do not unblock, note "ждёт ответа N дней".
 */
export function judgeStaleBlock(
  task: IssueCandidate,
  openBlockerCount: number,
  openChildCount: number,
  lastComment: CommentCandidate | null,
  now: Date = new Date(),
):
  | { action: "unblock_to_todo"; comment: string }
  | { action: "keep_waiting_question"; daysWaiting: number; snippet: string }
  | null {
  if (task.status !== "blocked") return null;
  if (openBlockerCount > 0 || openChildCount > 0) return null;

  if (lastComment && hasQuestionPattern(lastComment.body)) {
    const commentTime = new Date(lastComment.createdAt).getTime();
    const daysWaiting = Math.max(0, Math.floor((now.getTime() - commentTime) / (86400 * 1000)));
    const snippet = lastComment.body.trim().replace(/\s+/g, " ").slice(0, 80);
    return {
      action: "keep_waiting_question",
      daysWaiting,
      snippet,
    };
  }

  return {
    action: "unblock_to_todo",
    comment: "блок снят: блокер закрыт/отсутствует",
  };
}

/**
 * Checks if a task belongs to a release version.
 */
export function extractReleasePrefix(title: string): string | null {
  const match = title.match(/^(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/**
 * Rule 3: Unassigned task in a release -> role distribution queue (DEVFLOW-9678).
 */
export function judgeUnassignedReleaseTask(
  task: IssueCandidate,
): { shouldQueue: boolean; releasePrefix: string; comment: string } | null {
  if (!isOpenStatus(task.status)) return null;
  if (task.assigneeAgentId || task.assigneeUserId) return null;

  const releasePrefix = extractReleasePrefix(task.title);
  if (!releasePrefix) return null;

  return {
    shouldQueue: true,
    releasePrefix,
    comment: "добавлено в очередь распределения по ролям (DEVFLOW-9678)",
  };
}

/**
 * Rule 4: Untouched >21 days -> label "залежалась". To task owner (agent) -> comment
 * "актуально? закрыть или назначить срок". Through 7 days without response -> backlog.
 */
export function judgeStaleUntouched(
  task: IssueCandidate,
  now: Date = new Date(),
):
  | { action: "mark_stale"; daysUntouched: number; comment: string | null }
  | { action: "move_to_backlog"; staleDays: number; comment: string }
  | null {
  if (!isOpenStatus(task.status)) return null;

  const lastAct = task.lastActivityAt || task.updatedAt || task.createdAt;
  const daysUntouched = Math.floor((now.getTime() - new Date(lastAct).getTime()) / (86400 * 1000));

  const staleLabel = task.labels?.find((l) => l.name === STALE_LABEL_NAME);

  if (staleLabel) {
    // If already labeled "залежалась", check how long it has been since the label / last activity
    const labelTime = staleLabel.createdAt ? new Date(staleLabel.createdAt).getTime() : new Date(lastAct).getTime();
    const daysSinceLabel = Math.floor((now.getTime() - labelTime) / (86400 * 1000));

    if (daysSinceLabel >= STALE_RESPONSE_WINDOW_DAYS && task.status !== "backlog") {
      return {
        action: "move_to_backlog",
        staleDays: daysUntouched,
        comment: "7 дней без ответа после метки «залежалась» → переведено в backlog",
      };
    }
    return null;
  }

  if (daysUntouched > UNTOUCHED_THRESHOLD_DAYS) {
    const comment = task.assigneeAgentId ? "актуально? закрыть или назначить срок" : null;
    return {
      action: "mark_stale",
      daysUntouched,
      comment,
    };
  }

  return null;
}

/**
 * Rule 5: Overdue deadline -> comment to assignee and row in report.
 */
export function judgeOverdueDeadline(
  task: IssueCandidate,
  now: Date = new Date(),
): { isOverdue: boolean; deadline: string; comment: string } | null {
  if (!isOpenStatus(task.status)) return null;

  // Check explicit targetDate or deadline in metadata
  let deadlineStr: string | null = null;
  if (task.metadata?.targetDate && typeof task.metadata.targetDate === "string") {
    deadlineStr = task.metadata.targetDate;
  } else if (task.metadata?.deadline && typeof task.metadata.deadline === "string") {
    deadlineStr = task.metadata.deadline;
  } else if (task.metadata?.slaDueAt && typeof task.metadata.slaDueAt === "string") {
    deadlineStr = task.metadata.slaDueAt;
  } else {
    // Check regex in title/description
    const titleMatch = task.title.match(/(?:срок|дедлайн|deadline|due|до)\s*[:\-]?\s*(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)/i);
    if (titleMatch) {
      const parts = titleMatch[1].split(/[./-]/);
      if (parts.length >= 2) {
        const day = Number.parseInt(parts[0], 10);
        const month = Number.parseInt(parts[1], 10);
        const year = parts[2] ? Number.parseInt(parts[2].length === 2 ? `20${parts[2]}` : parts[2], 10) : now.getUTCFullYear();
        const d = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
        if (!Number.isNaN(d.getTime())) {
          deadlineStr = d.toISOString().slice(0, 10);
        }
      }
    }
  }

  if (deadlineStr) {
    const deadlineDate = new Date(deadlineStr);
    if (!Number.isNaN(deadlineDate.getTime()) && deadlineDate.getTime() < now.getTime()) {
      return {
        isOverdue: true,
        deadline: deadlineStr,
        comment: `внимание: просрочен установленный срок (${deadlineStr})`,
      };
    }
  }

  return null;
}

/**
 * Rule 6: Generate janitor-YYYY-MM-DD markdown document for service ticket.
 */
export function generateJanitorReportMarkdown(input: {
  dateStr: string; // YYYY-MM-DD
  statsBefore: {
    totalOpen: number;
    blocked: number;
    noAssignee: number;
    onOwner: number;
    untouched21d: number;
    overdue: number;
  };
  statsAfter: {
    totalOpen: number;
    blocked: number;
    noAssignee: number;
    onOwner: number;
    untouched21d: number;
    overdue: number;
  };
  actions: JanitorAction[];
}): string {
  const { dateStr, statsBefore, statsAfter, actions } = input;

  const closedPr = actions.filter((a): a is Extract<JanitorAction, { type: "close_merged_pr" }> => a.type === "close_merged_pr");
  const unblocked = actions.filter((a): a is Extract<JanitorAction, { type: "unblock_stale" }> => a.type === "unblock_stale");
  const waitingQ = actions.filter((a): a is Extract<JanitorAction, { type: "blocked_waiting_question" }> => a.type === "blocked_waiting_question");
  const queuedRel = actions.filter((a): a is Extract<JanitorAction, { type: "queue_unassigned_release" }> => a.type === "queue_unassigned_release");
  const markedStale = actions.filter((a): a is Extract<JanitorAction, { type: "mark_stale_untouched" }> => a.type === "mark_stale_untouched");
  const backlogged = actions.filter((a): a is Extract<JanitorAction, { type: "move_stale_to_backlog" }> => a.type === "move_stale_to_backlog");
  const overdue = actions.filter((a): a is Extract<JanitorAction, { type: "notify_overdue" }> => a.type === "notify_overdue");

  const totalActions = closedPr.length + unblocked.length + queuedRel.length + markedStale.length + backlogged.length + overdue.length;

  const lines: string[] = [];
  lines.push(`# Отчёт уборки доски (BOARD-JANITOR): ${dateStr}`);
  lines.push("");
  lines.push("## 1. Сводка состояния доски");
  lines.push("| Показатель | До уборки | После уборки | Изменение |");
  lines.push("|:---|:---:|:---:|:---:|");
  lines.push(`| Открыто задач | ${statsBefore.totalOpen} | ${statsAfter.totalOpen} | ${statsAfter.totalOpen - statsBefore.totalOpen} |`);
  lines.push(`| В блокировке (blocked) | ${statsBefore.blocked} | ${statsAfter.blocked} | ${statsAfter.blocked - statsBefore.blocked} |`);
  lines.push(`| Без исполнителя | ${statsBefore.noAssignee} | ${statsAfter.noAssignee} | ${statsAfter.noAssignee - statsBefore.noAssignee} |`);
  lines.push(`| На владельце (owner) | ${statsBefore.onOwner} | ${statsAfter.onOwner} | ${statsAfter.onOwner - statsBefore.onOwner} |`);
  lines.push(`| Не тронуты >21 дня | ${statsBefore.untouched21d} | ${statsAfter.untouched21d} | ${statsAfter.untouched21d - statsBefore.untouched21d} |`);
  lines.push(`| Просрочены по срокам | ${statsBefore.overdue} | ${statsAfter.overdue} | ${statsAfter.overdue - statsBefore.overdue} |`);
  lines.push("");
  lines.push(`Всего выполнено действий: **${totalActions}**.`);
  lines.push("");

  lines.push("## 2. Закрыто по влитым PR");
  if (closedPr.length === 0) {
    lines.push("Нет задач с влитыми PR.");
  } else {
    for (const a of closedPr) {
      lines.push(`- **${a.identifier}** → done (PR #${a.prNumber})`);
    }
  }
  lines.push("");

  lines.push("## 3. Сняты ложные блокировки (переведены в todo)");
  if (unblocked.length === 0) {
    lines.push("Ложных блокировок не обнаружено.");
  } else {
    for (const a of unblocked) {
      lines.push(`- **${a.identifier}** → todo (блокер закрыт/отсутствует)`);
    }
  }
  lines.push("");

  lines.push("## 4. Блокировки, ожидающие ответа (блок сохранён)");
  if (waitingQ.length === 0) {
    lines.push("Нет блокировок с ожиданием ответа.");
  } else {
    for (const a of waitingQ) {
      lines.push(`- **${a.identifier}**: ждёт ответа ${a.daysWaiting} дн. («${a.questionSnippet}»…)`);
    }
  }
  lines.push("");

  lines.push("## 5. Задачи выпуска без исполнителя (в очередь DEVFLOW-9678)");
  if (queuedRel.length === 0) {
    lines.push("Нет неназначенных задач в выпуске.");
  } else {
    for (const a of queuedRel) {
      lines.push(`- **${a.identifier}** (выпуск ${a.releasePrefix}) → очередь распределения`);
    }
  }
  lines.push("");

  lines.push("## 6. Залежавшиеся задачи (>21 дня без движения)");
  lines.push(`- Добавлена метка «залежалась» и запрос владельцу: **${markedStale.length}** задач.`);
  lines.push(`- Переведено в backlog (7 дней без ответа): **${backlogged.length}** задач.`);
  if (markedStale.length > 0) {
    for (const a of markedStale.slice(0, 20)) {
      lines.push(`  - **${a.identifier}** (не тронута ${a.daysUntouched} дн.)`);
    }
    if (markedStale.length > 20) {
      lines.push(`  - ...и ещё ${markedStale.length - 20} задач.`);
    }
  }
  if (backlogged.length > 0) {
    for (const a of backlogged) {
      lines.push(`  - **${a.identifier}** → backlog (без ответа >7 дн.)`);
    }
  }
  lines.push("");

  lines.push("## 7. Просроченные сроки");
  if (overdue.length === 0) {
    lines.push("Просроченных задач нет.");
  } else {
    for (const a of overdue) {
      lines.push(`- **${a.identifier}**: срок ${a.deadline} истёк (исполнителю оставлен комментарий)`);
    }
  }
  lines.push("");

  lines.push("## 8. Вопросы, требующие решения владельца (Alex)");
  // Only surface items where Alex specifically needs to make a decision
  const ownerNeedsAction = waitingQ.filter((w) => w.questionSnippet.toLowerCase().includes("alex") || w.questionSnippet.toLowerCase().includes("согласован"));
  if (ownerNeedsAction.length === 0 && overdue.length === 0) {
    lines.push("Вопросов к владельцу нет. Доска находится в управляемом состоянии.");
  } else {
    for (const o of ownerNeedsAction) {
      lines.push(`- **${o.identifier}**: ждёт ответа ${o.daysWaiting} дн. («${o.questionSnippet}»)`);
    }
    for (const ov of overdue) {
      lines.push(`- **${ov.identifier}**: просрочен срок (${ov.deadline})`);
    }
  }

  return lines.join("\n");
}
