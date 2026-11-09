// Stack registry (STACK-WATCH-LIVE): owner signals for lagging or stale stack
// components. Two channels, both derived from the same card list:
//
//  1. A backlog task per lagging component (dedup by component name, so a
//     component that keeps lagging does not accumulate tasks). The task is
//     created through the ordinary issue service with an idempotency key,
//     the same producer pattern monitoring-links uses.
//  2. One line per lagging component for the daily Telegram digest, produced
//     by the telegram-notify digest job (which maps sourceKind stack_update
//     into its blocked section already).
//
// Pure decision logic lives here; the DB touch stays in check.ts / index.ts.

import type { Db } from "@myrmidon/db";
import { buildStackAttentionCards, stackUpstreamIsStale, type StackAttentionCard } from "./attention.js";
import type { StackDocument } from "./domain.js";

/** One dedup namespace for every stack-lag task, so re-checks never duplicate. */
export function stackLagTaskIdempotencyKey(component: string): string {
  return `stack-lag:${component}`;
}

export interface StackLagTask {
  title: string;
  description: string;
  priority: "high" | "medium";
  status: "todo";
  idempotencyKey: string;
  originKind: "manual";
}

/** Build the backlog task for one lagging component (pure; DB-free). */
export function buildStackLagTask(card: StackAttentionCard, now: Date): StackLagTask {
  const staleSuffix = card.staleSince
    ? `\n- Сверка не удаётся с ${card.staleSince}; данные могут быть устаревшими.`
    : "";
  const description = [
    `Компонент стека \`${card.component}\` отстаёт от апстрима.`,
    "",
    `- Локальная версия: ${card.ourVersion ?? "неизвестна"}`,
    `- Апстрим: ${card.latest} (отставание: ${card.behindBy ?? "неизвестно"})`,
    `- Серьёзность: ${card.severity === "high" ? "high (security-заметка в релизе)" : "medium"}${staleSuffix}`,
    "",
    "Задача создаётся автоматически сверкой релизов стека (STACK-WATCH-LIVE).",
    "Закрывается вручную после обновления компонента или пересмотра решения.",
    "",
    `_Автозадача сверки стека, ${now.toISOString()}. Дедуп по компоненту: повторная проверка не создаст вторую задачу._`,
  ].join("\n");
  return {
    title: `[stack] ${card.component}: отставание от ${card.latest}`,
    description,
    priority: card.severity === "high" ? "high" : "medium",
    status: "todo",
    idempotencyKey: stackLagTaskIdempotencyKey(card.component),
    originKind: "manual",
  };
}

/** One digest line for the Telegram daily digest (pure). */
export function buildStackDigestLine(card: StackAttentionCard): string {
  const lag = card.behindBy != null ? `отставание ${card.behindBy}` : "версия неизвестна";
  const stale = card.staleSince ? `, сверка не удалась с ${card.staleSince}` : "";
  return `- ${card.component}: ${lag} от ${card.latest}${stale}`;
}

/**
 * Cards that warrant a backlog task today: behind >= 1, or the upstream data
 * is stale (check failing for 24h+). Cards that are merely "new latest but we
 * are on it" (behindBy 0) do not create a task — nothing to do.
 */
export function cardsForLagTasks(doc: StackDocument, now: Date): StackAttentionCard[] {
  return buildStackAttentionCards(doc).filter((card) => {
    if (card.behindBy != null && card.behindBy >= 1) return true;
    if (card.severity === "high") return true;
    const upstream = doc.components.find((c) => c.name === card.component)?.upstreamState;
    if (upstream?.notes?.hasSecurity === true) return true;
    return upstream ? stackUpstreamIsStale(upstream, now) : false;
  });
}

/** All cards that surface a visible signal, for the digest (pure). */
export function cardsForDigest(doc: StackDocument, now: Date): string[] {
  return buildStackAttentionCards(doc)
    .filter((card) => {
      if (card.behindBy != null && card.behindBy >= 1) return true;
      if (card.severity === "high") return true;
      const upstream = doc.components.find((c) => c.name === card.component)?.upstreamState;
      if (upstream?.notes?.hasSecurity === true) return true;
      return upstream ? stackUpstreamIsStale(upstream, now) : false;
    })
    .map(buildStackDigestLine);
}

type IssueService = ReturnType<
  typeof import("../../services/issues.js")["issueService"]
>;

let servicesPromise: Promise<{ issueService: (db: Db) => IssueService }> | null = null;
function loadIssueService() {
  servicesPromise ??= import("../../services/issues.js").then((module) => ({
    issueService: module.issueService,
  }));
  return servicesPromise;
}

/**
 * Create (or dedup-skip) one backlog task per lagging component. Errors are
 * logged and swallowed: a failure here must never fail the release check.
 */
export async function fileStackLagTasks(
  db: Db,
  companyId: string,
  doc: StackDocument,
  now: Date,
  log?: { warn(fields: object, message: string): void },
  issueSvc?: { create: (cid: string, data: unknown) => Promise<unknown> },
): Promise<{ filed: number; skipped: number }> {
  const cards = cardsForLagTasks(doc, now);
  let filed = 0;
  let skipped = 0;
  for (const card of cards) {
    try {
      const svc = issueSvc ?? (await loadIssueService()).issueService(db);
      const task = buildStackLagTask(card, now);
      let wasDeduped = false;
      const created = (await svc.create(companyId, {
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        originKind: task.originKind,
        idempotencyKey: task.idempotencyKey,
        onDeduplicated: () => {
          wasDeduped = true;
        },
      } as never)) as { id: string; identifier?: string | null } | null;
      if (created && !wasDeduped) filed += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      log?.warn({ err, component: card.component }, "stack lag task create failed");
    }
  }
  return { filed, skipped };
}
