import {
  ALERT_RECOVERY_HOLD_MINUTES_DEFAULT,
  ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT,
  alertRecoveryIdentity,
  isAlertRecoveryCloseDue,
  isAlertRecoveryRecurrence,
  normalizeAlertHosts,
  normalizeAlertTrigger,
  type AlertRecoveryRecord,
  type AlertRecoverySettings,
} from "@paperclipai/shared";
import {
  renderAlertRecoverySection,
  selectAlertRecoveryRunbook,
  type AlertRecoveryRunbook,
} from "./runbook.js";

/**
 * The alert → task policy of alert recovery (myrmidon 1.6.6 MONITORING, part D).
 *
 * Everything here is pure: an alert event, the record of the task that already
 * exists for that alert, the settings in force and the current time go in; the
 * decision and the text that goes on the task come out. The service does the
 * writing, so the whole lifecycle — fire, repeat, resolve, hold, close,
 * repeat-after-close — is decided and tested without a database.
 */

/** An alert as the ingestion side (Zabbix / Alertmanager) hands it over. */
export interface AlertRecoveryAlert {
  companyId: string;
  /** Alert source: `zabbix` or `alertmanager`. */
  source: string;
  /** Trigger name (Zabbix) or alertname (Alertmanager). */
  trigger: string;
  status: "firing" | "resolved";
  severity?: string | null;
  summary?: string | null;
  /** Hosts the alert covers; part of the alert identity. */
  hosts?: readonly string[] | null;
  /** When the source saw the transition, ISO. */
  happenedAt: string;
  /** Link to the alert in its own source, when the source provides one. */
  url?: string | null;
}

/** What one alert event means for the task of that alert. */
export type AlertRecoveryPlanKind =
  /** No task yet: open one with the runbook's steps. */
  | "create"
  /** The task is open and the alert fired again: comment on the same task. */
  | "join"
  /** The alert of a waiting task fired again: the automatic close is cancelled. */
  | "cancel-close"
  /** The task closed and the alert fired again inside the recurrence window: reopen it. */
  | "reopen"
  /** The alert resolved: the task starts waiting out the hold. */
  | "await-close"
  /** Nothing to do (a resolve without a task, a repeated resolve, a resolve after close). */
  | "ignore";

export interface AlertRecoveryPlan {
  kind: AlertRecoveryPlanKind;
  identity: string;
  runbook: AlertRecoveryRunbook;
  ownerRole: string;
  /** The task this event acts on; null when the plan opens a new one. */
  issueId: string | null;
  /** The resolution the automatic close counts from. */
  resolvedAt: string | null;
  /**
   * The record after the event, already in its next state; null when there is
   * no record to write (a resolve that arrives before any task exists).
   */
  record: AlertRecoveryRecord | null;
}

/** The role that owns the recovery: the per-trigger override wins over the runbook's own. */
export function resolveAlertRecoveryOwnerRole(
  trigger: string,
  runbook: AlertRecoveryRunbook,
  settings: AlertRecoverySettings,
): string {
  const override = settings.owners[normalizeAlertTrigger(trigger)];
  return override?.trim() || runbook.ownerRole;
}

/** Alert severity → task priority (Zabbix and Alertmanager spellings both land here). */
export function alertRecoveryPriority(severity: string | null | undefined): "critical" | "high" | "medium" | "low" {
  const value = (severity ?? "").trim().toLowerCase();
  if (["critical", "disaster", "fatal", "emergency", "page"].includes(value)) return "critical";
  if (["high", "error", "major"].includes(value)) return "high";
  if (["average", "warning", "warn", "minor", "medium"].includes(value)) return "medium";
  return "low";
}

/** Title of the task: source, trigger and the hosts it covers. */
export function alertRecoveryIssueTitle(alert: AlertRecoveryAlert): string {
  const hosts = normalizeAlertHosts(alert.hosts);
  const suffix = hosts.length ? ` — ${hosts.join(", ")}` : "";
  return `Тревога ${alert.source}: ${alert.trigger.trim()}${suffix}`;
}

function alertFacts(alert: AlertRecoveryAlert): string[] {
  const hosts = normalizeAlertHosts(alert.hosts);
  const lines = [
    `- Источник: \`${alert.source}\``,
    `- Триггер: \`${alert.trigger.trim()}\``,
  ];
  if (hosts.length) lines.push(`- Хосты: ${hosts.join(", ")}`);
  if (alert.severity) lines.push(`- Важность: ${alert.severity}`);
  if (alert.summary?.trim()) lines.push(`- Описание: ${alert.summary.trim()}`);
  if (alert.url?.trim()) lines.push(`- Тревога в источнике: ${alert.url.trim()}`);
  lines.push(`- Сработала: ${alert.happenedAt}`);
  return lines;
}

/** Body of the task a firing alert opens: the facts and the runbook's steps. */
export function renderAlertRecoveryIssueBody(
  alert: AlertRecoveryAlert,
  runbook: AlertRecoveryRunbook,
  ownerRole: string,
  settings: AlertRecoverySettings,
): string {
  return [
    `Тревога сработала в источнике \`${alert.source}\` и открыла эту задачу роли-владельцу.`,
    "",
    ...alertFacts(alert),
    "",
    renderAlertRecoverySection(runbook, ownerRole),
    "",
    "## Автозакрытие",
    "",
    `Когда тревога снимется и продержится снятой ${settings.holdMinutes} мин, задача закроется сама.`,
    `Повторное срабатывание в течение ${settings.recurrenceWindowMinutes} мин после автозакрытия вернётся в эту же задачу — новую открывать не нужно.`,
  ].join("\n");
}

/** Comment on a repeated firing: still the same problem, still the same task. */
export function renderAlertRecoveryFiringComment(
  alert: AlertRecoveryAlert,
  firedCount: number,
  settings: AlertRecoverySettings,
): string {
  return [
    `Тревога сработала снова (срабатывание №${firedCount}) — задача остаётся открытой.`,
    "",
    ...alertFacts(alert),
    "",
    `Автозакрытие не сработает, пока тревога горит; отсчёт ${settings.holdMinutes} мин начнётся со снятия тревоги.`,
  ].join("\n");
}

/** Comment when the alert resolved: the task now waits out the hold. */
export function renderAlertRecoveryResolvedComment(
  alert: AlertRecoveryAlert,
  resolvedAt: Date,
  runbook: AlertRecoveryRunbook,
  settings: AlertRecoverySettings,
): string {
  const dueAt = new Date(resolvedAt.getTime() + settings.holdMinutes * 60 * 1000);
  return [
    `Тревога снята (${alert.happenedAt}) — задача переходит в ожидание автозакрытия.`,
    "",
    ...alertFacts(alert),
    "",
    `Если тревога продержится снятой до ${dueAt.toISOString()} (${settings.holdMinutes} мин), задача закроется сама.`,
    `Проверьте метрику: ${runbook.metric}`,
    "Если тревога вернётся раньше — автозакрытие отменится, задача останется открытой.",
  ].join("\n");
}

/** Comment when the alert fired again while the task waited to close. */
export function renderAlertRecoveryCancelCloseComment(alert: AlertRecoveryAlert): string {
  return [
    `Тревога сработала снова (${alert.happenedAt}) до истечения окна удержания — автозакрытие отменено, задача остаётся открытой.`,
    "",
    ...alertFacts(alert),
  ].join("\n");
}

/** Comment when a repeat lands in the task that had already closed. */
export function renderAlertRecoveryReopenComment(
  alert: AlertRecoveryAlert,
  previousClosedAt: string | null,
  runbook: AlertRecoveryRunbook,
  ownerRole: string,
  settings: AlertRecoverySettings,
): string {
  return [
    `Тревога сработала снова (${alert.happenedAt}) в пределах окна повтора (${settings.recurrenceWindowMinutes} мин после автозакрытия${
      previousClosedAt ? ` ${previousClosedAt}` : ""
    }) — это та же задача, новая не открывается.`,
    "",
    ...alertFacts(alert),
    "",
    renderAlertRecoverySection(runbook, ownerRole),
  ].join("\n");
}

/** Comment of the automatic close. */
export function renderAlertRecoveryClosedComment(
  record: Pick<AlertRecoveryRecord, "resolvedAt" | "firstFiredAt" | "firedCount">,
  settings: AlertRecoverySettings,
  now: Date,
): string {
  return [
    `Автозакрытие: тревога снята ${record.resolvedAt} и продержалась снятой ${settings.holdMinutes} мин (срабатываний: ${record.firedCount}), задача закрыта автоматически.`,
    "",
    `Повторное срабатывание в течение ${settings.recurrenceWindowMinutes} мин вернётся в эту же задачу; позже — откроет новую.`,
    `Время закрытия: ${now.toISOString()}`,
  ].join("\n");
}

/**
 * The decision for one alert event. `record` is the stored state of the task of
 * that alert, or null when the alert has no task yet.
 */
export function planAlertRecoveryEvent(input: {
  alert: AlertRecoveryAlert;
  record: AlertRecoveryRecord | null;
  settings: AlertRecoverySettings;
  now: Date;
}): AlertRecoveryPlan {
  const { alert, record, settings, now } = input;
  const nowIso = now.toISOString();
  const identity = alertRecoveryIdentity(alert);
  const runbook = selectAlertRecoveryRunbook(alert.trigger);
  const ownerRole = resolveAlertRecoveryOwnerRole(alert.trigger, runbook, settings);
  const firing = alert.status === "firing";
  const base = {
    companyId: alert.companyId,
    identity,
    source: alert.source,
    trigger: alert.trigger.trim(),
    runbookKey: runbook.key,
    ownerRole,
  };

  // No task yet: a firing alert opens one, a resolve on its own means nothing.
  if (!record) {
    return {
      kind: firing ? "create" : "ignore",
      identity,
      runbook,
      ownerRole,
      issueId: null,
      resolvedAt: null,
      record: firing
        ? {
            ...base,
            issueId: "",
            issueIdentifier: null,
            state: "open",
            firedCount: 1,
            firstFiredAt: alert.happenedAt,
            lastFiredAt: alert.happenedAt,
            resolvedAt: null,
            closedAt: null,
          }
        : null,
    };
  }

  const carried = {
    ...record,
    ...base,
    firedCount: Math.max(record.firedCount, 1),
  };

  if (firing) {
    // The alert is up again: same task, no matter which state it was in.
    const kind: AlertRecoveryPlanKind =
      record.state === "open" ? "join" : record.state === "awaiting-close" ? "cancel-close" : isAlertRecoveryRecurrence(record, now, settings.recurrenceWindowMinutes) ? "reopen" : "create";
    if (kind === "create") {
      return {
        kind,
        identity,
        runbook,
        ownerRole,
        issueId: null,
        resolvedAt: null,
        record: {
          ...base,
          issueId: "",
          issueIdentifier: null,
          state: "open",
          firedCount: 1,
          firstFiredAt: alert.happenedAt,
          lastFiredAt: alert.happenedAt,
          resolvedAt: null,
          closedAt: null,
        },
      };
    }
    return {
      kind,
      identity,
      runbook,
      ownerRole,
      issueId: record.issueId,
      resolvedAt: null,
      record: {
        ...carried,
        state: "open",
        firedCount: record.firedCount + 1,
        lastFiredAt: alert.happenedAt,
        resolvedAt: null,
        closedAt: null,
      },
    };
  }

  // Resolved. While the alert is already closed, or already waiting, the hold
  // keeps counting from the first resolution: a repeated resolve event must not
  // push the automatic close away.
  if (record.state === "open") {
    return {
      kind: "await-close",
      identity,
      runbook,
      ownerRole,
      issueId: record.issueId,
      resolvedAt: nowIso,
      record: { ...carried, state: "awaiting-close", resolvedAt: nowIso, closedAt: null },
    };
  }
  return {
    kind: "ignore",
    identity,
    runbook,
    ownerRole,
    issueId: record.issueId,
    resolvedAt: record.resolvedAt,
    record: carried,
  };
}

/** Records whose task waited out the hold: the sweep closes exactly these. */
export function dueAlertRecoveryRecords(
  records: readonly AlertRecoveryRecord[],
  now: Date,
  settings: AlertRecoverySettings,
): AlertRecoveryRecord[] {
  return records.filter((record) => isAlertRecoveryCloseDue(record, now, settings.holdMinutes));
}

/** Re-exported so the service and the tests share one hold default. */
export const ALERT_RECOVERY_FALLBACK_HOLD_MINUTES = ALERT_RECOVERY_HOLD_MINUTES_DEFAULT;
export const ALERT_RECOVERY_FALLBACK_WINDOW_MINUTES = ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT;