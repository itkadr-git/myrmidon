// myrmidon(BOARD-JANITOR): sweep implementation
//
// Implements the 6 janitor rules:
// 1. Merged PR on open issue -> done, comment "закрыто по влитому PR #N"
// 2. blocked without open blocker and without open children -> todo, comment "блок снят: блокер закрыт/отсутствует".
//    If last comment contains a specific question -> do not unblock, note "ждёт ответа N дней".
// 3. Unassigned issue in release -> role distribution queue (DEVFLOW-9678).
// 4. Untouched >21 days -> label "залежалась". To task owner (agent) -> comment "актуально? закрыть или назначить срок".
//    After 7 days without response -> backlog.
// 5. Overdue deadline -> comment to assignee and row in report.
// 6. Report: single document `janitor-YYYY-MM-DD` on service ticket (OPE-9758).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  issues,
  issueComments,
  issueRelations,
  issueWorkProducts,
  issueLabels,
  labels,
} from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { documentService } from "../../services/documents.js";
import { notifySwarmIssueEvent } from "../swarm-claim/events.js";
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
  type JanitorAction,
  type WorkProductCandidate,
} from "./policy.js";
import {
  readBoardJanitorSettings,
  type BoardJanitorSettings,
} from "./settings.js";

export interface BoardJanitorSweepResult {
  dateStr: string;
  actionsExecuted: number;
  actions: JanitorAction[];
  reportDocumentKey: string;
  reportDocumentId?: string;
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
  dryRun?: boolean;
}

export function createBoardJanitorSweep(deps: {
  db: Db;
  settings?: BoardJanitorSettings;
  now?: () => Date;
}) {
  const db = deps.db;
  const nowFn = deps.now ?? (() => new Date());

  return async function runSweep(options: {
    companyId: string;
    dryRun?: boolean;
    onlyIssueIds?: string[];
  }): Promise<BoardJanitorSweepResult> {
    const settings = deps.settings ?? readBoardJanitorSettings();
    const now = nowFn();
    const utcMs = now.getTime();
    const irkutskDate = new Date(utcMs + 8 * 3600 * 1000);
    const dateStr = irkutskDate.toISOString().slice(0, 10);
    const reportDocKey = `janitor-${dateStr}`;

    const openStatuses = ["backlog", "todo", "in_progress", "in_review", "blocked"];

    // 1. Fetch candidate open issues
    const openIssuesQuery = db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        parentId: issues.parentId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        lastActivityAt: issues.lastActivityAt,
        metadata: issues.blockerMetadata,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, options.companyId),
          inArray(issues.status, openStatuses),
          options.onlyIssueIds && options.onlyIssueIds.length > 0
            ? inArray(issues.id, options.onlyIssueIds)
            : sql`true`,
        ),
      );

    const rawOpenIssues = await openIssuesQuery;

    // Fetch labels for candidate issues
    const issueIds = rawOpenIssues.map((i) => i.id);
    const issueLabelMap = new Map<string, Array<{ name: string; createdAt?: Date }>>();

    if (issueIds.length > 0) {
      const labelRows = await db
        .select({
          issueId: issueLabels.issueId,
          name: labels.name,
          createdAt: issueLabels.createdAt,
        })
        .from(issueLabels)
        .innerJoin(labels, eq(issueLabels.labelId, labels.id))
        .where(
          and(
            eq(issueLabels.companyId, options.companyId),
            inArray(issueLabels.issueId, issueIds),
          ),
        );

      for (const row of labelRows) {
        const list = issueLabelMap.get(row.issueId) ?? [];
        list.push({ name: row.name, createdAt: row.createdAt });
        issueLabelMap.set(row.issueId, list);
      }
    }

    const openIssueCandidates: IssueCandidate[] = rawOpenIssues.map((i) => ({
      ...i,
      identifier: i.identifier ?? i.id,
      labels: issueLabelMap.get(i.id) ?? [],
    }));

    // Stats Before
    const statsBefore = {
      totalOpen: openIssueCandidates.length,
      blocked: openIssueCandidates.filter((i) => i.status === "blocked").length,
      noAssignee: openIssueCandidates.filter((i) => !i.assigneeAgentId && !i.assigneeUserId).length,
      onOwner: openIssueCandidates.filter((i) => !!i.assigneeUserId).length,
      untouched21d: openIssueCandidates.filter((i) => {
        const lastAct = i.lastActivityAt || i.updatedAt || i.createdAt;
        return (now.getTime() - new Date(lastAct).getTime()) > 21 * 86400 * 1000;
      }).length,
      overdue: 0,
    };

    // 2. Fetch Work Products (PRs)
    const workProductsByIssue = new Map<string, WorkProductCandidate[]>();
    if (issueIds.length > 0) {
      const wpRows = await db
        .select({
          id: issueWorkProducts.id,
          issueId: issueWorkProducts.issueId,
          type: issueWorkProducts.type,
          provider: issueWorkProducts.provider,
          url: issueWorkProducts.url,
          status: issueWorkProducts.status,
          metadata: issueWorkProducts.metadata,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, options.companyId),
            inArray(issueWorkProducts.issueId, issueIds),
            eq(issueWorkProducts.type, "pull_request"),
          ),
        );

      for (const wp of wpRows) {
        const list = workProductsByIssue.get(wp.issueId) ?? [];
        list.push(wp as WorkProductCandidate);
        workProductsByIssue.set(wp.issueId, list);
      }
    }

    // 3. Fetch Relations for blocked tasks
    const blockedIssueIds = openIssueCandidates.filter((i) => i.status === "blocked").map((i) => i.id);
    const openBlockersByIssue = new Map<string, number>();

    if (blockedIssueIds.length > 0) {
      const relationRows = await db
        .select({
          targetIssueId: issueRelations.relatedIssueId,
          sourceStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, options.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, blockedIssueIds),
          ),
        );

      for (const r of relationRows) {
        if (openStatuses.includes(r.sourceStatus)) {
          openBlockersByIssue.set(r.targetIssueId, (openBlockersByIssue.get(r.targetIssueId) ?? 0) + 1);
        }
      }
    }

    // 4. Open Child count by issue
    const openChildrenByIssue = new Map<string, number>();
    for (const c of openIssueCandidates) {
      if (c.parentId) {
        openChildrenByIssue.set(c.parentId, (openChildrenByIssue.get(c.parentId) ?? 0) + 1);
      }
    }

    // 5. Fetch Latest Comments for blocked tasks
    const lastCommentByIssue = new Map<string, CommentCandidate>();
    if (blockedIssueIds.length > 0) {
      const commentRows = await db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, options.companyId),
            inArray(issueComments.issueId, blockedIssueIds),
          ),
        )
        .orderBy(desc(issueComments.createdAt));

      for (const c of commentRows) {
        if (!lastCommentByIssue.has(c.issueId)) {
          lastCommentByIssue.set(c.issueId, c as CommentCandidate);
        }
      }
    }

    // 6. Evaluate Policies
    const actions: JanitorAction[] = [];

    for (const task of openIssueCandidates) {
      // Rule 1: Merged PR -> done
      const wps = workProductsByIssue.get(task.id) ?? [];
      const prJudgment = judgeMergedPrClosure(task, wps);
      if (prJudgment?.shouldClose) {
        actions.push({
          type: "close_merged_pr",
          issueId: task.id,
          identifier: task.identifier,
          prNumber: prJudgment.prNumber,
          comment: prJudgment.comment,
        });
        continue; // Closed tasks don't need subsequent rules
      }

      // Rule 2: Stale block -> todo or keep waiting question
      if (task.status === "blocked") {
        const openBlockers = openBlockersByIssue.get(task.id) ?? 0;
        const openChildren = openChildrenByIssue.get(task.id) ?? 0;
        const lastComment = lastCommentByIssue.get(task.id) ?? null;
        const blockJudgment = judgeStaleBlock(task, openBlockers, openChildren, lastComment, now);

        if (blockJudgment?.action === "unblock_to_todo") {
          actions.push({
            type: "unblock_stale",
            issueId: task.id,
            identifier: task.identifier,
            comment: blockJudgment.comment,
          });
        } else if (blockJudgment?.action === "keep_waiting_question") {
          actions.push({
            type: "blocked_waiting_question",
            issueId: task.id,
            identifier: task.identifier,
            daysWaiting: blockJudgment.daysWaiting,
            questionSnippet: blockJudgment.snippet,
          });
        }
      }

      // Rule 3: Unassigned release task -> queue role distribution
      const releaseJudgment = judgeUnassignedReleaseTask(task);
      if (releaseJudgment?.shouldQueue) {
        actions.push({
          type: "queue_unassigned_release",
          issueId: task.id,
          identifier: task.identifier,
          releasePrefix: releaseJudgment.releasePrefix,
          comment: releaseJudgment.comment,
        });
      }

      // Rule 4: Untouched >21 days -> mark stale or move to backlog
      const staleJudgment = judgeStaleUntouched(task, now);
      if (staleJudgment?.action === "mark_stale") {
        actions.push({
          type: "mark_stale_untouched",
          issueId: task.id,
          identifier: task.identifier,
          daysUntouched: staleJudgment.daysUntouched,
          comment: staleJudgment.comment,
        });
      } else if (staleJudgment?.action === "move_to_backlog") {
        actions.push({
          type: "move_stale_to_backlog",
          issueId: task.id,
          identifier: task.identifier,
          staleDays: staleJudgment.staleDays,
          comment: staleJudgment.comment,
        });
      }

      // Rule 5: Overdue deadline
      const overdueJudgment = judgeOverdueDeadline(task, now);
      if (overdueJudgment?.isOverdue) {
        statsBefore.overdue += 1;
        actions.push({
          type: "notify_overdue",
          issueId: task.id,
          identifier: task.identifier,
          deadline: overdueJudgment.deadline,
          comment: overdueJudgment.comment,
        });
      }
    }

    // Compute Stats After
    const closedCount = actions.filter((a) => a.type === "close_merged_pr").length;
    const unblockedCount = actions.filter((a) => a.type === "unblock_stale").length;
    const backloggedCount = actions.filter((a) => a.type === "move_stale_to_backlog").length;

    const statsAfter = {
      totalOpen: statsBefore.totalOpen - closedCount,
      blocked: statsBefore.blocked - unblockedCount,
      noAssignee: statsBefore.noAssignee, // stays or queues
      onOwner: statsBefore.onOwner,
      untouched21d: Math.max(0, statsBefore.untouched21d - backloggedCount),
      overdue: statsBefore.overdue,
    };

    // 7. Apply mutations if not dryRun
    if (!options.dryRun && actions.length > 0) {
      await db.transaction(async (tx) => {
        // Ensure "залежалась" label exists in company
        let [staleLabelRow] = await tx
          .select({ id: labels.id })
          .from(labels)
          .where(and(eq(labels.companyId, options.companyId), eq(labels.name, STALE_LABEL_NAME)))
          .limit(1);

        if (!staleLabelRow) {
          [staleLabelRow] = await tx
            .insert(labels)
            .values({
              companyId: options.companyId,
              name: STALE_LABEL_NAME,
              color: "#f59e0b",
            })
            .returning({ id: labels.id });
        }

        for (const action of actions) {
          switch (action.type) {
            case "close_merged_pr": {
              await tx
                .update(issues)
                .set({
                  status: "done",
                  completedAt: now,
                  updatedAt: now,
                  lastActivityAt: now,
                })
                .where(eq(issues.id, action.issueId));

              await tx.insert(issueComments).values({
                companyId: options.companyId,
                issueId: action.issueId,
                authorAgentId: settings.serviceAgentId,
                body: action.comment,
                createdAt: now,
                updatedAt: now,
              });
              break;
            }
            case "unblock_stale": {
              await tx
                .update(issues)
                .set({
                  status: "todo",
                  updatedAt: now,
                  lastActivityAt: now,
                })
                .where(eq(issues.id, action.issueId));

              await tx.insert(issueComments).values({
                companyId: options.companyId,
                issueId: action.issueId,
                authorAgentId: settings.serviceAgentId,
                body: action.comment,
                createdAt: now,
                updatedAt: now,
              });
              break;
            }
            case "queue_unassigned_release": {
              // Ensure status is todo so it's ready for role distribution (DEVFLOW-9678)
              await tx
                .update(issues)
                .set({
                  status: "todo",
                  updatedAt: now,
                  lastActivityAt: now,
                })
                .where(eq(issues.id, action.issueId));

              if (action.comment) {
                await tx.insert(issueComments).values({
                  companyId: options.companyId,
                  issueId: action.issueId,
                  authorAgentId: settings.serviceAgentId,
                  body: action.comment,
                  createdAt: now,
                  updatedAt: now,
                });
              }

              try {
                notifySwarmIssueEvent({
                  issueId: action.issueId,
                  status: "todo",
                  assigneeAgentId: null,
                  touched: ["status"],
                });
              } catch (e) {
                logger.warn({ err: e, issueId: action.issueId }, "failed to notify swarm issue event");
              }
              break;
            }
            case "mark_stale_untouched": {
              if (staleLabelRow) {
                // Link label
                await tx
                  .insert(issueLabels)
                  .values({
                    companyId: options.companyId,
                    issueId: action.issueId,
                    labelId: staleLabelRow.id,
                    createdAt: now,
                  })
                  .onConflictDoNothing();
              }
              if (action.comment) {
                await tx.insert(issueComments).values({
                  companyId: options.companyId,
                  issueId: action.issueId,
                  authorAgentId: settings.serviceAgentId,
                  body: action.comment,
                  createdAt: now,
                  updatedAt: now,
                });
              }
              break;
            }
            case "move_stale_to_backlog": {
              await tx
                .update(issues)
                .set({
                  status: "backlog",
                  updatedAt: now,
                  lastActivityAt: now,
                })
                .where(eq(issues.id, action.issueId));

              await tx.insert(issueComments).values({
                companyId: options.companyId,
                issueId: action.issueId,
                authorAgentId: settings.serviceAgentId,
                body: action.comment,
                createdAt: now,
                updatedAt: now,
              });
              break;
            }
            case "notify_overdue": {
              await tx.insert(issueComments).values({
                companyId: options.companyId,
                issueId: action.issueId,
                authorAgentId: settings.serviceAgentId,
                body: action.comment,
                createdAt: now,
                updatedAt: now,
              });
              break;
            }
            case "blocked_waiting_question": {
              // No DB mutation needed, report only
              break;
            }
          }
        }
      });
    }

    // 8. Generate and save the Report Document on the service ticket
    const reportMarkdown = generateJanitorReportMarkdown({
      dateStr,
      statsBefore,
      statsAfter,
      actions,
    });

    let reportDocumentId: string | undefined;
    if (!options.dryRun && settings.serviceTicketId) {
      try {
        const docResult = await documentService(db).upsertIssueDocument({
          issueId: settings.serviceTicketId,
          key: reportDocKey,
          title: `janitor-${dateStr}`,
          format: "markdown",
          body: reportMarkdown,
          createdByAgentId: settings.serviceAgentId,
        });
        reportDocumentId = docResult?.id ?? undefined;
      } catch (err) {
        logger.warn({ err, reportDocKey }, "Failed to write janitor report document to service ticket");
      }
    }

    return {
      dateStr,
      actionsExecuted: actions.length,
      actions,
      reportDocumentKey: reportDocKey,
      reportDocumentId,
      statsBefore,
      statsAfter,
      dryRun: options.dryRun,
    };
  };
}
