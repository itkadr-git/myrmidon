// server/src/myrmidon/monitoring/links/alert.ts
//
// myrmidon(1.6.6 MONITORING E): the task text of the "a link went blind"
// alarm. Pure string building, so the wording a human reads at 03:00 is
// covered by tests instead of by hope.

import type { IssuePriority } from "@paperclipai/shared";
import {
  monitoringLinkAlertIdempotencyKey,
  type MonitoringLinkAlertVerdict,
  type MonitoringLinkHealth,
} from "./health.js";

export interface MonitoringLinkAlertTask {
  title: string;
  description: string;
  priority: IssuePriority;
  status: "todo";
  assigneeAgentId?: string;
  idempotencyKey: string;
  originKind: "manual";
}

const VERDICT_TITLES: Record<MonitoringLinkAlertVerdict, string> = {
  key_revoked: "сервисный ключ звена отозван",
  key_expired: "сервисный ключ звена протух",
  no_pulse: "звено не шлёт пульс",
};

const VERDICT_ACTIONS: Record<MonitoringLinkAlertVerdict, string> = {
  key_revoked:
    "Ключ отозван, поэтому звено получает 401 на каждом обращении. Выдайте звену новый ключ со скоупом `monitoring_link` (минимальные права: создать/обновить задачу) и обновите ключ в конфиге звена.",
  key_expired:
    "Срок ключа истёк, поэтому звено получает 401 на каждом обращении — ровно та слепота, что была в инциденте 02–06.10. Выдайте новый ключ со скоупом `monitoring_link` и обновите его в конфиге звена.",
  no_pulse:
    "Звено не обращалось к доске дольше порога. Проверьте сам процесс звена (агрегатор, вебхук, сборщик), его доступ к доске и то, что оно шлёт пульс POST /api/myrmidon/companies/{companyId}/monitoring/links/pulse.",
};

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

export function buildMonitoringLinkAlertTask(
  health: MonitoringLinkHealth,
  options: { assigneeAgentId?: string | null; now: Date },
): MonitoringLinkAlertTask {
  const verdict = health.verdict as MonitoringLinkAlertVerdict;
  const pulse = health.lastPulseAt
    ? `${health.lastPulseAt} (${formatAge(health.pulseAgeSec)} назад)`
    : `пульса не было ни разу, ключ выдан ${formatAge(health.pulseAgeSec)} назад`;

  const description = [
    `Тревога High: связующее звено \`${health.linkKey}\` ослепло.`,
    "",
    `- Звено: \`${health.linkKey}\` (ключ доски \`${health.keyName}\`)`,
    `- Причина: **${VERDICT_TITLES[verdict]}**`,
    `- Состояние ключа: \`${health.keyState}\``,
    `- Последний пульс: ${pulse}`,
    `- Порог пульса: ${health.staleAfterSec} с`,
    "",
    `**Что делать.** ${VERDICT_ACTIONS[verdict]}`,
    "",
    "Пока звено молчит, его наблюдаемая поверхность слепа: ни одна его тревога не доедет до доски. " +
      "Задача закроется сама, когда звено снова начнёт пульсовать (или когда ему выдадут живой ключ).",
    "",
    `_Автозадача наблюдения доски, ${options.now.toISOString()}. Правится вручную только в части закрытия: следующий проход подтвердит состояние сам._`,
  ].join("\n");

  return {
    title: `[observability] ${health.linkKey}: ${VERDICT_TITLES[verdict]}`,
    description,
    // High, not critical: the link is blind, but the board itself is up and
    // the alarm reaches a human through the board channel that still works.
    priority: "high",
    status: "todo",
    ...(options.assigneeAgentId ? { assigneeAgentId: options.assigneeAgentId } : {}),
    idempotencyKey: monitoringLinkAlertIdempotencyKey(health.keyId, verdict),
    originKind: "manual",
  };
}

export function recoveryComment(health: MonitoringLinkHealth, now: Date): string {
  return [
    `Звено \`${health.linkKey}\` снова на связи — тревога снята автоматически.`,
    "",
    `- Состояние ключа: \`${health.keyState}\``,
    `- Пульс: ${health.lastPulseAt ?? "нет"} (возраст ${health.pulseAgeSec} с)`,
    "",
    `_Автозакрытие наблюдения доски, ${now.toISOString()}._`,
  ].join("\n");
}