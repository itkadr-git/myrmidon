import { eq, and } from 'drizzle-orm';
import { agentWakeupRequests, type Db } from '@paperclipai/db';

/**
 * Сервис для обработки повторной отправки отбитых побудок агентов (WAKE-STALL-ROOT A)
 *
 * Отбитая побудка с причиной `execution_reconciliation_required` не терминальна:
 * после завершения сверки исполнения она возвращается в очередь один раз.
 * Основная логика inline в postgres.ts (в точке установки статуса `skipped`);
 * этот сервис — интерфейс для ручного/диагностического вызова и тестов.
 */
export class ResurrectionService {
  /**
   * Обработка отбитых побудок после завершения сверки исполнения
   * @param db Database handle
   * @param agentId ID агента, для которого завершена сверка
   */
  static async handleResurrections(db: Db, agentId: string): Promise<number> {
    // Найти все отбитые побудки для этого агента с причиной execution_reconciliation_required
    const skippedWakeups = await db.select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, 'skipped'),
        eq(agentWakeupRequests.error, 'execution_reconciliation_required')
      ));

    let resurrected = 0;
    for (const wakeup of skippedWakeups) {
      const payload = (wakeup.payload ?? {}) as Record<string, unknown>;
      const evidence = (payload.evidence ?? {}) as Record<string, unknown>;
      const automaticRecovery = (evidence.automaticRecovery ?? {}) as Record<string, unknown>;

      // Пропустить, если это закрытое восстановление с replay=blocked
      if (automaticRecovery.replay === 'blocked') {
        continue;
      }

      // Ограничение: не более 1 повтора на побудку
      if ((wakeup.resurrectionCount ?? 0) >= 1) {
        continue;
      }

      // Создать новую побудку с тем же контекстом
      await db.insert(agentWakeupRequests)
        .values({
          id: crypto.randomUUID(),
          companyId: wakeup.companyId,
          agentId: wakeup.agentId,
          source: wakeup.source,
          triggerDetail: wakeup.triggerDetail,
          reason: 'resurrection_execution_reconciliation_required',
          payload: wakeup.payload,
          status: 'pending',
          requestedByActorType: wakeup.requestedByActorType,
          requestedByActorId: wakeup.requestedByActorId,
          idempotencyKey: `${wakeup.idempotencyKey ?? wakeup.id}:resurrection:${crypto.randomUUID()}`,
          resurrectionCount: (wakeup.resurrectionCount ?? 0) + 1,
        });
      resurrected += 1;
    }
    return resurrected;
  }
}
