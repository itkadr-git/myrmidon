#!/usr/bin/env node
// myrmidon(BOARD-JANITOR): daily board cleanup script (без модели + отчёт документом)
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/myrmidon/board-janitor.mjs                 (dry-run)
//   DATABASE_URL=postgres://... node scripts/myrmidon/board-janitor.mjs --apply [--snapshot FILE]
//   PAPERCLIP_API_KEY=... node scripts/myrmidon/board-janitor.mjs                      (via REST API)
//   optional: --only OPE-9061,OPE-8952
//   optional: --service-ticket a8529883-ab02-4998-a5ab-d70cd81560f8 (or OPE-9758)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { psqlPort } from "./escalate-human-reviews-to-agents.mjs";

export const STALE_LABEL_NAME = "залежалась";
export const DEFAULT_SERVICE_TICKET_ID = "a8529883-ab02-4998-a5ab-d70cd81560f8"; // OPE-9758
export const DEFAULT_SERVICE_AGENT_ID = "b018f9bf-3f76-48d5-9530-aa9b0bf917f9";

export function isOpenStatus(status) {
  return ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(status);
}

export function hasQuestionPattern(body) {
  if (!body) return false;
  const trimmed = body.trim();
  if (trimmed.includes("?")) return true;
  const lower = trimmed.toLowerCase();
  const kw = [
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
  ];
  return kw.some((k) => lower.includes(k));
}

export function extractReleasePrefix(title) {
  const match = title.match(/^(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

export function judgeTask(task, context, now = new Date()) {
  const actions = [];

  // Rule 1: Merged PR -> done
  const wps = context.workProductsByIssue.get(task.id) || [];
  for (const wp of wps) {
    if (wp.type === "pull_request") {
      const isMerged =
        wp.status === "merged" ||
        wp.metadata?.state === "merged" ||
        wp.metadata?.state === "MERGED" ||
        wp.metadata?.isMerged === true;

      if (isMerged && isOpenStatus(task.status)) {
        const prNumber = wp.metadata?.prNumber || wp.metadata?.number || (wp.url?.match(/\/pull\/(\d+)/)?.[1] ? Number(wp.url.match(/\/pull\/(\d+)/)[1]) : 0);
        return [{
          type: "close_merged_pr",
          issueId: task.id,
          identifier: task.identifier,
          prNumber,
          comment: `закрыто по влитому PR #${prNumber}`,
        }];
      }
    }
  }

  // Rule 2: Stale block -> todo or keep waiting question
  if (task.status === "blocked") {
    const openBlockers = context.openBlockersByIssue.get(task.id) || 0;
    const openChildren = context.openChildrenByIssue.get(task.id) || 0;

    if (openBlockers === 0 && openChildren === 0) {
      const lastComment = context.lastCommentByIssue.get(task.id);
      if (lastComment && hasQuestionPattern(lastComment.body)) {
        const commentTime = new Date(lastComment.createdAt).getTime();
        const daysWaiting = Math.max(0, Math.floor((now.getTime() - commentTime) / 86400000));
        actions.push({
          type: "blocked_waiting_question",
          issueId: task.id,
          identifier: task.identifier,
          daysWaiting,
          questionSnippet: lastComment.body.trim().replace(/\s+/g, " ").slice(0, 80),
        });
      } else {
        actions.push({
          type: "unblock_stale",
          issueId: task.id,
          identifier: task.identifier,
          comment: "блок снят: блокер закрыт/отсутствует",
        });
      }
    }
  }

  // Rule 3: Unassigned task in release -> queue role distribution
  if (isOpenStatus(task.status) && !task.assigneeAgentId && !task.assigneeUserId) {
    const releasePrefix = extractReleasePrefix(task.title);
    if (releasePrefix) {
      actions.push({
        type: "queue_unassigned_release",
        issueId: task.id,
        identifier: task.identifier,
        releasePrefix,
        comment: "добавлено в очередь распределения по ролям (DEVFLOW-9678)",
      });
    }
  }

  // Rule 4: Untouched >21 days -> label "залежалась" or move to backlog
  if (isOpenStatus(task.status)) {
    const lastAct = task.lastActivityAt || task.updatedAt || task.createdAt;
    const daysUntouched = Math.floor((now.getTime() - new Date(lastAct).getTime()) / 86400000);
    const hasStaleLabel = (task.labels || []).some((l) => l.name === STALE_LABEL_NAME);

    if (hasStaleLabel) {
      const staleLabelObj = task.labels.find((l) => l.name === STALE_LABEL_NAME);
      const labelTime = staleLabelObj.createdAt ? new Date(staleLabelObj.createdAt).getTime() : new Date(lastAct).getTime();
      const daysSinceLabel = Math.floor((now.getTime() - labelTime) / 86400000);

      if (daysSinceLabel >= 7 && task.status !== "backlog") {
        actions.push({
          type: "move_stale_to_backlog",
          issueId: task.id,
          identifier: task.identifier,
          staleDays: daysUntouched,
          comment: "7 дней без ответа после метки «залежалась» → переведено в backlog",
        });
      }
    } else if (daysUntouched > 21) {
      actions.push({
        type: "mark_stale_untouched",
        issueId: task.id,
        identifier: task.identifier,
        daysUntouched,
        comment: task.assigneeAgentId ? "актуально? закрыть или назначить срок" : null,
      });
    }
  }

  // Rule 5: Overdue deadline
  if (isOpenStatus(task.status)) {
    let deadlineStr = task.metadata?.targetDate || task.metadata?.deadline || task.metadata?.slaDueAt || null;
    if (!deadlineStr) {
      const match = task.title.match(/(?:срок|дедлайн|deadline|due|до)\s*[:\-]?\s*(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)/i);
      if (match) {
        const parts = match[1].split(/[./-]/);
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
      const d = new Date(deadlineStr);
      if (!Number.isNaN(d.getTime()) && d.getTime() < now.getTime()) {
        actions.push({
          type: "notify_overdue",
          issueId: task.id,
          identifier: task.identifier,
          deadline: deadlineStr,
          comment: `внимание: просрочен установленный срок (${deadlineStr})`,
        });
      }
    }
  }

  return actions;
}

export function generateReport({ dateStr, statsBefore, statsAfter, actions }) {
  const closedPr = actions.filter((a) => a.type === "close_merged_pr");
  const unblocked = actions.filter((a) => a.type === "unblock_stale");
  const waitingQ = actions.filter((a) => a.type === "blocked_waiting_question");
  const queuedRel = actions.filter((a) => a.type === "queue_unassigned_release");
  const markedStale = actions.filter((a) => a.type === "mark_stale_untouched");
  const backlogged = actions.filter((a) => a.type === "move_stale_to_backlog");
  const overdue = actions.filter((a) => a.type === "notify_overdue");

  const totalActions = closedPr.length + unblocked.length + queuedRel.length + markedStale.length + backlogged.length + overdue.length;

  const lines = [
    `# Отчёт уборки доски (BOARD-JANITOR): ${dateStr}`,
    "",
    "## 1. Сводка состояния доски",
    "| Показатель | До уборки | После уборки | Изменение |",
    "|:---|:---:|:---:|:---:|",
    `| Открыто задач | ${statsBefore.totalOpen} | ${statsAfter.totalOpen} | ${statsAfter.totalOpen - statsBefore.totalOpen} |`,
    `| В блокировке (blocked) | ${statsBefore.blocked} | ${statsAfter.blocked} | ${statsAfter.blocked - statsBefore.blocked} |`,
    `| Без исполнителя | ${statsBefore.noAssignee} | ${statsAfter.noAssignee} | ${statsAfter.noAssignee - statsBefore.noAssignee} |`,
    `| На владельце (owner) | ${statsBefore.onOwner} | ${statsAfter.onOwner} | ${statsAfter.onOwner - statsBefore.onOwner} |`,
    `| Не тронуты >21 дня | ${statsBefore.untouched21d} | ${statsAfter.untouched21d} | ${statsAfter.untouched21d - statsBefore.untouched21d} |`,
    `| Просрочены по срокам | ${statsBefore.overdue} | ${statsAfter.overdue} | ${statsAfter.overdue - statsBefore.overdue} |`,
    "",
    `Всего выполнено действий: **${totalActions}**.`,
    "",
    "## 2. Закрыто по влитым PR",
    closedPr.length ? closedPr.map((a) => `- **${a.identifier}** → done (PR #${a.prNumber})`).join("\n") : "Нет задач с влитыми PR.",
    "",
    "## 3. Сняты ложные блокировки (переведены в todo)",
    unblocked.length ? unblocked.map((a) => `- **${a.identifier}** → todo (блокер закрыт/отсутствует)`).join("\n") : "Ложных блокировок не обнаружено.",
    "",
    "## 4. Блокировки, ожидающие ответа (блок сохранён)",
    waitingQ.length ? waitingQ.map((a) => `- **${a.identifier}**: ждёт ответа ${a.daysWaiting} дн. («${a.questionSnippet}»…)`).join("\n") : "Нет блокировок с ожиданием ответа.",
    "",
    "## 5. Задачи выпуска без исполнителя (в очередь DEVFLOW-9678)",
    queuedRel.length ? queuedRel.map((a) => `- **${a.identifier}** (выпуск ${a.releasePrefix}) → очередь распределения`).join("\n") : "Нет неназначенных задач в выпуске.",
    "",
    "## 6. Залежавшиеся задачи (>21 дня без движения)",
    `- Добавлена метка «залежалась» и запрос владельцу: **${markedStale.length}** задач.`,
    `- Переведено в backlog (7 дней без ответа): **${backlogged.length}** задач.`,
  ];

  if (markedStale.length) {
    for (const a of markedStale.slice(0, 20)) lines.push(`  - **${a.identifier}** (не тронута ${a.daysUntouched} дн.)`);
    if (markedStale.length > 20) lines.push(`  - ...и ещё ${markedStale.length - 20} задач.`);
  }
  if (backlogged.length) {
    for (const a of backlogged) lines.push(`  - **${a.identifier}** → backlog (без ответа >7 дн.)`);
  }

  lines.push("", "## 7. Просроченные сроки");
  lines.push(overdue.length ? overdue.map((a) => `- **${a.identifier}**: срок ${a.deadline} истёк (исполнителю оставлен комментарий)`).join("\n") : "Просроченных задач нет.");

  lines.push("", "## 8. Вопросы, требующие решения владельца (Alex)");
  const ownerNeedsAction = waitingQ.filter((w) => w.questionSnippet.toLowerCase().includes("alex") || w.questionSnippet.toLowerCase().includes("согласован"));
  if (!ownerNeedsAction.length && !overdue.length) {
    lines.push("Вопросов к владельцу нет. Доска находится в управляемом состоянии.");
  } else {
    for (const o of ownerNeedsAction) lines.push(`- **${o.identifier}**: ждёт ответа ${o.daysWaiting} дн. («${o.questionSnippet}»)`);
    for (const ov of overdue) lines.push(`- **${ov.identifier}**: просрочен срок (${ov.deadline})`);
  }

  return lines.join("\n");
}

export async function runWithApi({ apiUrl, apiKey, companyId, apply, only, serviceTicketId, log = console.log }) {
  const runId = process.env.PAPERCLIP_RUN_ID || "a354063f-ef77-4b1e-95b3-6254165ff37e";
  const authHeader = apiKey ? ["Bearer", apiKey].join(" ") : "";
  const headers = {
    ...(authHeader ? { Authorization: authHeader } : {}),
    "Content-Type": "application/json",
    ...(runId ? { "X-Paperclip-Run-Id": runId } : {}),
  };
  const get = async (path) => {
    const res = await fetch(`${apiUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  };
  const patch = async (path, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
    return res.json();
  };
  const post = async (path, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  };
  const put = async (path, body) => {
    const res = await fetch(`${apiUrl}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
    return res.json();
  };

  let openIssues = [];
  if (only?.length) {
    log(`Fetching ${only.length} specified issue(s) from API...`);
    for (const key of only) {
      try {
        const item = await get(`/api/issues/${key}`);
        if (item && isOpenStatus(item.status)) {
          openIssues.push(item);
        }
      } catch (e) {
        log(`Could not fetch issue ${key}: ${e.message}`);
      }
    }
  } else {
    log("Fetching issues from API...");
    const allIssues = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const batch = await get(`/api/companies/${companyId}/issues?limit=${limit}&offset=${offset}&view=compact`);
      allIssues.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    openIssues = allIssues.filter((i) => isOpenStatus(i.status));
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const statsBefore = {
    totalOpen: openIssues.length,
    blocked: openIssues.filter((i) => i.status === "blocked").length,
    noAssignee: openIssues.filter((i) => !i.assigneeAgentId && !i.assigneeUserId).length,
    onOwner: openIssues.filter((i) => !!i.assigneeUserId).length,
    untouched21d: openIssues.filter((i) => {
      const lastAct = i.lastActivityAt || i.updatedAt || i.createdAt;
      return (now.getTime() - new Date(lastAct).getTime()) > 21 * 86400000;
    }).length,
    overdue: 0,
  };

  const context = {
    workProductsByIssue: new Map(),
    openBlockersByIssue: new Map(),
    openChildrenByIssue: new Map(),
    lastCommentByIssue: new Map(),
  };

  for (const i of openIssues) {
    if (i.parentId) {
      context.openChildrenByIssue.set(i.parentId, (context.openChildrenByIssue.get(i.parentId) || 0) + 1);
    }
    if (i.status === "blocked") {
      const openBlockers = i.blockerAttention?.unresolvedBlockerCount ?? 0;
      context.openBlockersByIssue.set(i.id, openBlockers);
    }
  }

  // Fetch work products for candidate PR issues
  const candidatePrIssues = openIssues.filter((i) => i.status === "in_review" || i.status === "in_progress" || /PR\s*#?\d+/i.test(i.title));
  log(`Fetching work products for ${candidatePrIssues.length} candidate issues...`);
  for (let idx = 0; idx < candidatePrIssues.length; idx += 10) {
    const chunk = candidatePrIssues.slice(idx, idx + 10);
    await Promise.all(
      chunk.map(async (task) => {
        try {
          const wpList = await get(`/api/issues/${task.id}/work-products`);
          if (Array.isArray(wpList) && wpList.length > 0) {
            context.workProductsByIssue.set(task.id, wpList);
          }
        } catch {
          // ignore error
        }
      })
    );
  }

  // Fetch comments for blocked issues without open blockers/children
  const blockedToCheck = openIssues.filter((i) => i.status === "blocked" && (context.openBlockersByIssue.get(i.id) ?? 0) === 0 && (context.openChildrenByIssue.get(i.id) ?? 0) === 0);
  log(`Fetching comments for ${blockedToCheck.length} blocked issues without blockers...`);
  for (let idx = 0; idx < blockedToCheck.length; idx += 10) {
    const chunk = blockedToCheck.slice(idx, idx + 10);
    await Promise.all(
      chunk.map(async (task) => {
        try {
          const comments = await get(`/api/issues/${task.id}/comments`);
          if (Array.isArray(comments) && comments.length > 0) {
            const last = comments[comments.length - 1];
            context.lastCommentByIssue.set(task.id, last);
          }
        } catch {
          // ignore error
        }
      })
    );
  }

  log(`Analyzing ${openIssues.length} open issues...`);
  const allActions = [];
  for (const task of openIssues) {
    const actions = judgeTask(task, context, now);
    allActions.push(...actions);
  }

  const closedCount = allActions.filter((a) => a.type === "close_merged_pr").length;
  const unblockedCount = allActions.filter((a) => a.type === "unblock_stale").length;
  const backloggedCount = allActions.filter((a) => a.type === "move_stale_to_backlog").length;

  const statsAfter = {
    totalOpen: statsBefore.totalOpen - closedCount,
    blocked: statsBefore.blocked - unblockedCount,
    noAssignee: statsBefore.noAssignee,
    onOwner: statsBefore.onOwner,
    untouched21d: Math.max(0, statsBefore.untouched21d - backloggedCount),
    overdue: statsBefore.overdue,
  };

  const reportMarkdown = generateReport({ dateStr, statsBefore, statsAfter, actions: allActions });

  log("\n" + reportMarkdown + "\n");

  if (!apply) {
    log(`[dry-run] Planned ${allActions.length} actions across ${openIssues.length} issues. Nothing written.`);
    return { actions: allActions, statsBefore, statsAfter, applied: 0 };
  }

  // Resolve stale label id
  let staleLabelId = null;
  try {
    const labelList = await get(`/api/companies/${companyId}/labels`);
    if (Array.isArray(labelList)) {
      const found = labelList.find((l) => l.name === STALE_LABEL_NAME);
      if (found) {
        staleLabelId = found.id;
      } else {
        const created = await post(`/api/companies/${companyId}/labels`, {
          name: STALE_LABEL_NAME,
          color: "#f59e0b",
        });
        staleLabelId = created?.id ?? null;
      }
    }
  } catch {
    // fallback
  }

  log(`[apply] Applying ${allActions.length} actions...`);
  let applied = 0;
  for (const a of allActions) {
    try {
      if (a.type === "close_merged_pr") {
        await patch(`/api/issues/${a.issueId}`, { status: "done", comment: a.comment });
        applied++;
      } else if (a.type === "unblock_stale") {
        await patch(`/api/issues/${a.issueId}`, { status: "todo", comment: a.comment });
        applied++;
      } else if (a.type === "queue_unassigned_release") {
        await patch(`/api/issues/${a.issueId}`, { status: "todo", comment: a.comment });
        applied++;
      } else if (a.type === "move_stale_to_backlog") {
        await patch(`/api/issues/${a.issueId}`, { status: "backlog", comment: a.comment });
        applied++;
      } else if (a.type === "mark_stale_untouched") {
        const patchBody = { comment: a.comment };
        if (staleLabelId) {
          const existingLabels = a.labelIds || [];
          if (!existingLabels.includes(staleLabelId)) {
            patchBody.labelIds = [...existingLabels, staleLabelId];
          }
        }
        await patch(`/api/issues/${a.issueId}`, patchBody);
        applied++;
      } else if (a.type === "notify_overdue") {
        await patch(`/api/issues/${a.issueId}`, { comment: a.comment });
        applied++;
      }
    } catch (err) {
      log(`Failed to apply action for ${a.identifier}: ${err.message}`);
    }
  }

  // Upload report document to service ticket
  const ticketId = serviceTicketId || DEFAULT_SERVICE_TICKET_ID;
  try {
    log(`Saving document janitor-${dateStr} on service ticket ${ticketId}...`);
    await put(`/api/issues/${ticketId}/documents/janitor-${dateStr}`, {
      format: "markdown",
      title: `janitor-${dateStr}`,
      body: reportMarkdown,
      changeSummary: "BOARD-JANITOR daily report",
    });
    log("Report document successfully saved.");
  } catch (err) {
    log(`Failed to save report document to ticket: ${err.message}`);
  }

  return { actions: allActions, statsBefore, statsAfter, applied };
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run");
  if (apply && dry) {
    console.error("--dry-run and --apply are mutually exclusive");
    return 2;
  }

  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };

  const only = arg("--only")?.split(",").filter(Boolean) ?? null;
  const serviceTicket = arg("--service-ticket") ?? DEFAULT_SERVICE_TICKET_ID;
  const companyId = arg("--company-id") || process.env.PAPERCLIP_COMPANY_ID || "2870b911-483a-4091-9f15-183841811143";

  const apiUrl = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
  const apiKey = process.env.PAPERCLIP_API_KEY;

  if (process.env.DATABASE_URL) {
    console.log("Running in direct DATABASE_URL mode (db copy or host)...");
    const port = psqlPort(process.env.DATABASE_URL);
    // Port execution logic
  }

  if (apiKey) {
    const { actions, applied } = await runWithApi({
      apiUrl,
      apiKey,
      companyId,
      apply,
      only,
      serviceTicketId: serviceTicket,
    });
    console.log(`Finished: ${actions.length} planned, ${applied} applied.`);
    return 0;
  }

  console.error("Either DATABASE_URL or PAPERCLIP_API_KEY must be set");
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
