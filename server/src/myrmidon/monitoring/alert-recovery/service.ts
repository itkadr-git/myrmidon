import {
  ALERT_RECOVERY_HOLD_MINUTES_DEFAULT,
  ALERT_RECOVERY_UPDATED_ACTION,
  alertRecoveryIdentity,
  mergeAlertRecoverySettings,
  isAlertRecoveryRecurrence,
  pruneAlertRecoveryRecords,
  type AlertRecoveryLimitKey,
  type AlertRecoveryLimitSource,
  type AlertRecoveryRecord,
  type AlertRecoverySettings,
  type AlertRecoverySettingsPatch,
  type AlertRecoveryState,
  type ResolvedAlertRecoverySettings,
} from "@myrmidon/shared";
import {
  alertRecoveryIssueTitle,
  alertRecoveryPriority,
  dueAlertRecoveryRecords,
  planAlertRecoveryEvent,
  renderAlertRecoveryCancelCloseComment,
  renderAlertRecoveryClosedComment,
  renderAlertRecoveryFiringComment,
  renderAlertRecoveryIssueBody,
  renderAlertRecoveryReopenComment,
  renderAlertRecoveryResolvedComment,
  type AlertRecoveryAlert,
  type AlertRecoveryPlanKind,
} from "./domain.js";
import { alertRecoveryRunbooks, type AlertRecoveryRunbook } from "./runbook.js";
import type { AlertRecoveryStore } from "./store.js";
import { logger } from "../../../middleware/logger.js";
import type { LogActivityInput } from "../../../services/activity-log.js";

/**
 * The alert-recovery service (myrmidon 1.6.6 MONITORING, part D).
 *
 * Two entry points, one state:
 *
 * - `ingest(alert)` — one alert event from Zabbix or Alertmanager. It opens the
 *   task of that alert with the runbook's steps when there is none, comments on
 *   the same task while the alert keeps firing, starts the hold when the alert
 *   resolves, cancels the hold when it fires again, and reopens the task when a
 *   repeat lands inside the recurrence window.
 * - `sweep()` — the periodic pass. It closes the tasks whose alert has stayed
 *   resolved for the hold and drops the records whose recurrence window has
 *   passed.
 *
 * Both go through one queue, so an event and a sweep never interleave on the
 * same journal row (the same serialization the host-disk and swarm-claim
 * modules use for read-modify-write settings).
 */

/** How the task write went: applied, already in the wanted state, or refused. */
export type AlertRecoveryIssueWriteResult = "applied" | "already" | "refused";

/** The issue side of alert recovery, as the service needs it. */
export interface AlertRecoveryIssuePort {
  /** Create the task. The agent assignment is delayed until the alert hold ends. */
  createIssue(input: {
    companyId: string;
    title: string;
    body: string;
    priority: "critical" | "high" | "medium" | "low";
    ownerRole: string;
    /** The alert identity, stamped on the task so the board can trace it back. */
    originId: string;
  }): Promise<{ id: string; identifier: string | null } | null>;
  /** Delay issue assignment and worker dispatch until the configured threshold. */
  holdMinutes?: number;
  /** Can identify a closed task without guessing whether a human closed it. */
  isSystemRecoveryClosed?(issueId: string, companyId: string): Promise<boolean>;
  getIssueStatus?(issueId: string, companyId: string): Promise<string | null>;
  /** Delay assignment and worker wake until hold has elapsed. */
  delayIssueWake?(issueId: string, companyId: string, holdMinutes: number): Promise<void>;
  /** Dispatch only after hold expires if the alert is still active. */
  dispatchAlertWake?(issueId: string, companyId: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<boolean>;
  /** Close the task of a resolved alert, with the closing comment in one write. */
  closeIssue(input: {
    issueId: string;
    companyId: string;
    body: string;
  }): Promise<AlertRecoveryIssueWriteResult>;

  /** Put a repeat back into work on the same task, comment included. */
  reopenIssue(input: {
    issueId: string;
    companyId: string;
    body: string;
  }): Promise<AlertRecoveryIssueWriteResult>;
}

export interface AlertRecoveryServiceDeps {
  store: AlertRecoveryStore;
  issues: AlertRecoveryIssuePort;
  /** Audit line of a settings change, one per company (the instance row is shared). */
  logActivity?: (entry: LogActivityInput) => Promise<unknown>;
  listCompanyIds?: () => Promise<string[]>;
  log?: (event: string, details: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface AlertRecoveryIngestResult {
  kind: AlertRecoveryPlanKind;
  identity: string;
  issueId: string | null;
  issueIdentifier: string | null;
  runbookKey: string;
  ownerRole: string;
  state: AlertRecoveryState | null;
  firedCount: number;
}

export interface AlertRecoverySweepResult {
  /** Records the sweep looked at. */
  examined: number;
  /** Tasks closed by this pass. */
  closed: Array<{ identity: string; issueId: string }>;
  /** Tasks whose close was refused and will be retried. */
  retried: Array<{ identity: string; issueId: string }>;
  /** Records dropped because their recurrence window had passed. */
  pruned: number;
}

export interface AlertRecoveryRecordView extends AlertRecoveryRecord {
  /** When the automatic close is due while the alert stays resolved. */
  closeDueAt: string | null;
}

export interface AlertRecoveryView {
  settings: {
    holdMinutes: number;
    recurrenceWindowMinutes: number;
    owners: Record<string, string>;
    sources: Record<AlertRecoveryLimitKey, AlertRecoveryLimitSource>;
  };
  runbooks: Array<{
    key: string;
    title: string;
    ownerRole: string;
    document: string;
    metric: string;
    triggers: string[];
  }>;
  records: AlertRecoveryRecordView[];
  active: { open: number; awaitingClose: number };
}

/** Who changed the knobs, for the audit line. */
export type AlertRecoveryActor = Pick<
  LogActivityInput,
  "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId"
>;

export interface AlertRecoveryService {
  lookup(alert: AlertRecoveryAlert): Promise<AlertRecoveryRecord | null>;
  bindIssue(identity: string, companyId: string, link: { issueId: string; issueIdentifier: string | null }): Promise<void>;
  ingest(alert: AlertRecoveryAlert): Promise<AlertRecoveryIngestResult>;
  sweep(): Promise<AlertRecoverySweepResult>;
  readSettings(): Promise<ResolvedAlertRecoverySettings>;
  updateSettings(
    patch: AlertRecoverySettingsPatch,
    actor: AlertRecoveryActor,
  ): Promise<ResolvedAlertRecoverySettings>;
  view(companyId: string): Promise<AlertRecoveryView>;
}

/** One write at a time: the journal is read, changed and written back whole. */
let alertRecoveryQueue: Promise<void> = Promise.resolve();

function withAlertRecoveryTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = alertRecoveryQueue.then(run);
  alertRecoveryQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** The close is due this many minutes after the resolution, once the hold is known. */
export function alertRecoveryCloseDueAt(
  record: Pick<AlertRecoveryRecord, "state" | "resolvedAt">,
  holdMinutes: number,
): string | null {
  if (record.state !== "awaiting-close" || !record.resolvedAt) return null;
  const resolvedAt = Date.parse(record.resolvedAt);
  if (Number.isNaN(resolvedAt)) return null;
  return new Date(resolvedAt + holdMinutes * 60 * 1000).toISOString();
}

/** The runbook registry as the view hands it over. */
export function alertRecoveryRunbookViews(
  runbooks: readonly AlertRecoveryRunbook[] = alertRecoveryRunbooks(),
): AlertRecoveryView["runbooks"] {
  return runbooks.map((runbook) => ({
    key: runbook.key,
    title: runbook.title,
    ownerRole: runbook.ownerRole,
    document: runbook.document,
    metric: runbook.metric,
    triggers: [...runbook.match],
  }));
}

function byNewestFirst(a: AlertRecoveryRecord, b: AlertRecoveryRecord): number {
  const left = Date.parse(b.lastFiredAt);
  const right = Date.parse(a.lastFiredAt);
  if (Number.isNaN(left) || Number.isNaN(right)) return b.lastFiredAt.localeCompare(a.lastFiredAt);
  return left - right;
}

export function createAlertRecoveryService(deps: AlertRecoveryServiceDeps): AlertRecoveryService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  async function writeRecord(companyId: string, record: AlertRecoveryRecord): Promise<void> {
    const records = await deps.store.readRecords(companyId);
    const index = records.findIndex((candidate) => candidate.identity === record.identity);
    const next = records.slice();
    if (index >= 0) next[index] = record;
    else next.push(record);
    await deps.store.writeRecords(companyId, next);
  }

  return {
    async lookup(alert) {
      const settings = await deps.store.readResolved();
      const identity = planAlertRecoveryEvent({ alert, record: null, settings: settings.settings, now: now() }).identity;
      return (await deps.store.readRecords(alert.companyId)).find((record) => record.identity === identity) ?? null;
    },
    async bindIssue(identity, companyId, link) {
      const records = await deps.store.readRecords(companyId);
      const record = records.find((candidate) => candidate.identity === identity);
      if (record && !record.issueId) {
        await writeRecord(companyId, { ...record, issueId: link.issueId, issueIdentifier: link.issueIdentifier });
      }
    },
    readSettings: () => deps.store.readResolved(),

    updateSettings: (patch, actor) =>
      withAlertRecoveryTurn(async () => {
        const before = await deps.store.readResolved();
        const next = mergeAlertRecoverySettings(before.settings, patch);
        const changedKeys = (Object.keys(patch) as Array<keyof AlertRecoverySettings>).filter(
          (key) => JSON.stringify(before.settings[key]) !== JSON.stringify(next[key]),
        );

        await deps.store.writeSettings(next);

        const companyIds = deps.listCompanyIds ? await deps.listCompanyIds() : [];
        const logActivity = deps.logActivity;
        if (logActivity) {
          await Promise.all(
            companyIds.map((companyId) =>
              logActivity({
                companyId,
                ...actor,
                action: ALERT_RECOVERY_UPDATED_ACTION,
                entityType: "instance_settings",
                entityId: "alert-recovery",
                details: { previous: before.settings, next, changedKeys },
              }),
            ),
          );
        }

        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "alert recovery settings updated without a restart",
        );
        return deps.store.readResolved();
      }),

    view: async (companyId) => {
      const [resolved, records] = await Promise.all([
        deps.store.readResolved(),
        deps.store.readRecords(companyId),
      ]);
      const sorted = records.slice().sort(byNewestFirst);
      return {
        settings: {
          holdMinutes: resolved.settings.holdMinutes,
          recurrenceWindowMinutes: resolved.settings.recurrenceWindowMinutes,
          owners: resolved.settings.owners,
          sources: resolved.sources,
        },
        runbooks: alertRecoveryRunbookViews(),
        records: sorted.map((record) => ({
          ...record,
          closeDueAt: alertRecoveryCloseDueAt(record, resolved.settings.holdMinutes),
        })),
        active: {
          open: sorted.filter((record) => record.state === "open").length,
          awaitingClose: sorted.filter((record) => record.state === "awaiting-close").length,
        },
      };
    },

    ingest: (alert) =>
      withAlertRecoveryTurn(async () => {
        const at = now();
        const resolved = await deps.store.readResolved();
        const settings = resolved.settings;
        const identity = alertRecoveryIdentity(alert);
        const records = await deps.store.readRecords(alert.companyId);
        const existing = records.find((record) => record.identity === identity) ?? null;
        const plan = planAlertRecoveryEvent({ alert, record: existing, settings, now: at });

        let issueId = plan.issueId;
        let issueIdentifier = existing?.issueIdentifier ?? null;

        if (plan.kind === "create") {
          const withinRecurrence = existing && existing.state === "closed" && isAlertRecoveryRecurrence(existing, at, settings.recurrenceWindowMinutes);
          if (withinRecurrence && existing.issueId) {
            issueId = existing.issueId;
            issueIdentifier = existing.issueIdentifier;
            const status = await deps.issues.getIssueStatus?.(issueId, alert.companyId);
            if (status === "done" || status === "cancelled") {
              await deps.issues.reopenIssue({ issueId, companyId: alert.companyId, body: renderAlertRecoveryReopenComment(alert, existing.closedAt, plan.runbook, plan.ownerRole, settings) });
            }
          } else {
            const alertTitle = alert.title?.trim() || alert.trigger.trim();
            const title = `[${alert.source}] ${alertTitle}${alert.hosts?.length ? ` — ${alert.hosts.join(", ")}` : ""}`;
            const created = await deps.issues.createIssue({
              companyId: alert.companyId,
              title,
              body: renderAlertRecoveryIssueBody(alert, plan.runbook, plan.ownerRole, settings),
              priority: alertRecoveryPriority(alert.severity),
              ownerRole: plan.ownerRole,
              originId: identity,
            });
            if (!created) {
              log("alert_recovery_create_refused", { identity, trigger: alert.trigger });
              return {
                kind: plan.kind,
                identity,
                issueId: null,
                issueIdentifier: null,
                runbookKey: plan.runbook.key,
                ownerRole: plan.ownerRole,
                state: null,
                firedCount: 0,
              };
            }
            issueId = created.id;
            issueIdentifier = created.identifier;
            if (deps.issues.delayIssueWake) {
              await deps.issues.delayIssueWake(
                created.id,
                alert.companyId,
                deps.issues.holdMinutes ?? settings.holdMinutes ?? ALERT_RECOVERY_HOLD_MINUTES_DEFAULT,
              );
            }
          }
        } else if (plan.kind === "join" && issueId) {
          if (existing?.state === "open" && existing.heldAt == null && issueId && deps.issues.delayIssueWake) {
            await deps.issues.delayIssueWake(issueId, alert.companyId, settings.holdMinutes);
          }
          await deps.issues.addComment(
            issueId,
            renderAlertRecoveryFiringComment(alert, plan.record?.firedCount ?? 1, settings),
          );
        } else if (plan.kind === "cancel-close" && issueId) {
          await deps.issues.addComment(issueId, renderAlertRecoveryCancelCloseComment(alert));
        } else if (plan.kind === "reopen" && issueId) {
          const status = await deps.issues.getIssueStatus?.(issueId, alert.companyId);
          if (!status || status === "done" || status === "cancelled") {
            if (!deps.issues.isSystemRecoveryClosed || (await deps.issues.isSystemRecoveryClosed(issueId, alert.companyId))) {
              const body = renderAlertRecoveryReopenComment(alert, existing?.closedAt ?? null, plan.runbook, plan.ownerRole, settings);
              await deps.issues.reopenIssue({ issueId, companyId: alert.companyId, body });
            }
          }
        } else if (plan.kind === "await-close" && issueId) {
          await deps.issues.addComment(issueId, renderAlertRecoveryResolvedComment(alert, at, plan.runbook, settings));
        }

        const record = plan.record
          ? { ...plan.record, issueId: issueId ?? plan.record.issueId, issueIdentifier }
          : null;
        if (record) await writeRecord(alert.companyId, record);

        log("alert_recovery_ingest", {
          identity,
          kind: plan.kind,
          runbookKey: plan.runbook.key,
          ownerRole: plan.ownerRole,
          state: record?.state ?? null,
          firedCount: record?.firedCount ?? 0,
        });

        return {
          kind: plan.kind,
          identity,
          issueId,
          issueIdentifier,
          runbookKey: plan.runbook.key,
          ownerRole: plan.ownerRole,
          state: record?.state ?? null,
          firedCount: record?.firedCount ?? 0,
        };
      }),

    sweep: () =>
      withAlertRecoveryTurn(async () => {
        const at = now();
        const resolved = await deps.store.readResolved();
        const settings = resolved.settings;
        const records = await deps.store.readRecords();
        const pendingWake = records.filter((record) => record.state === "open" && record.heldAt == null);
        for (const record of pendingWake) {
          const age = at.getTime() - Date.parse(record.firstFiredAt);
          const issueStatus = await deps.issues.getIssueStatus?.(record.issueId, record.companyId);
          if (issueStatus !== "todo") continue;
          const stillClosed = await deps.issues.isSystemRecoveryClosed?.(record.issueId, record.companyId);
          if (stillClosed) continue;
          const holdExpired = Number.isFinite(age) && age >= settings.holdMinutes * 60_000;
          if (record.heldAt == null && holdExpired && deps.issues.dispatchAlertWake) {
            await deps.issues.dispatchAlertWake(record.issueId, record.companyId);
            await deps.store.markWakeDispatched(record.identity, at.toISOString());
          }
        }
        const due = dueAlertRecoveryRecords(records, at, settings);
        const closed: AlertRecoverySweepResult["closed"] = [];
        const retried: AlertRecoverySweepResult["retried"] = [];
        const updated = records.slice();

        for (const record of due) {
          const write = await deps.issues.closeIssue({
            issueId: record.issueId,
            companyId: record.companyId,
            body: renderAlertRecoveryClosedComment(record, settings, at),
          });
          if (write === "refused") {
            retried.push({ identity: record.identity, issueId: record.issueId });
            continue;
          }
          const index = updated.findIndex(
            (candidate) => candidate.companyId === record.companyId && candidate.identity === record.identity,
          );
          if (index >= 0) {
            updated[index] = { ...record, state: "closed", closedAt: at.toISOString() };
          }
          closed.push({ identity: record.identity, issueId: record.issueId });
          log("alert_recovery_auto_closed", {
            identity: record.identity,
            issueId: record.issueId,
            resolvedAt: record.resolvedAt,
            firedCount: record.firedCount,
            issueWrite: write,
          });
        }

        const prunedRecords = pruneAlertRecoveryRecords(updated, at, settings.recurrenceWindowMinutes);
        const companyIds = [
          ...new Set([...records.map((record) => record.companyId), ...prunedRecords.map((record) => record.companyId)]),
        ];
        if (closed.length > 0 || prunedRecords.length !== records.length) {
          for (const companyId of companyIds) {
            await deps.store.writeRecords(
              companyId,
              prunedRecords.filter((record) => record.companyId === companyId),
            );
          }
        }

        return {
          examined: records.length,
          closed,
          retried,
          pruned: records.length - prunedRecords.length,
        };
      }),
  };
}

/** The hold the alert-recovery sweep uses when nothing else is configured. */
export const ALERT_RECOVERY_HOLD_FALLBACK_MINUTES = ALERT_RECOVERY_HOLD_MINUTES_DEFAULT;