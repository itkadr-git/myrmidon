import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { logActivity } from "../../services/index.js";
import { scentMetrics } from "./metrics.js";
import type { ScentQueuePorts } from "./queue.js";

export interface ScentHealthResult {
  lastSuccessAt: string | null;
  successRateHour: number | null;
  hourlySuccessRate: number | null;
  attemptsLastHour: number;
  successesLastHour: number;
  alarm: boolean;
}

export async function checkScentHealth(
  db: Db,
  companyId: string,
  ports?: ScentQueuePorts,
): Promise<ScentHealthResult> {
  let lastSuccessDate: Date | null = null;
  let attemptsLastHour = 0;
  let successesLastHour = 0;

  if (ports?.getHourlyStats) {
    const stats = await ports.getHourlyStats(db, companyId);
    lastSuccessDate = stats.lastSuccessAt;
    attemptsLastHour = stats.attemptsLastHour;
    successesLastHour = stats.successesLastHour;
  } else {
    try {
      const statsResult = await db.execute(sql`
        select
          (
            select max(created_at)
            from activity_log
            where company_id = ${companyId}
              and action in ('issue.scent_classified', 'agent.scent_classified')
              and details->>'ok' = 'true'
          ) as last_success_at,
          count(*)::int as attempts_hour,
          count(*) filter (where details->>'ok' = 'true')::int as successes_hour
        from activity_log
        where company_id = ${companyId}
          and action in ('issue.scent_classified', 'agent.scent_classified')
          and created_at > now() - interval '1 hour'
      `);
      const row = (statsResult as unknown as Array<{
        last_success_at?: string | Date | null;
        attempts_hour?: number | string;
        successes_hour?: number | string;
      }>)?.[0];
      if (row) {
        lastSuccessDate = row.last_success_at ? new Date(row.last_success_at) : null;
        attemptsLastHour = Number(row.attempts_hour ?? 0);
        successesLastHour = Number(row.successes_hour ?? 0);
      }
    } catch {
      // In unit tests with stub DB without activity_log table, keep default zeros
    }
  }

  const successRateHour =
    attemptsLastHour > 0
      ? Math.round((successesLastHour / attemptsLastHour) * 1000) / 1000
      : null;

  const alarm = attemptsLastHour >= 10 && successesLastHour === 0;
  scentMetrics.setAlarm(alarm);

  if (alarm) {
    try {
      const seen = await db.execute(sql`
        select count(*)::int as n
        from activity_log
        where action = 'swarm.scent_classifier_dead'
          and company_id = ${companyId}
          and created_at > now() - interval '1 hour'
      `);
      const recent = Number((seen as unknown as Array<{ n: number }>)[0]?.n ?? 0);
      if (recent === 0) {
        await (ports?.logActivity ?? logActivity)(db, {
          companyId,
          actorType: "system",
          actorId: "system",
          action: "swarm.scent_classifier_dead",
          entityType: "company",
          entityId: companyId,
          details: {
            attemptsLastHour,
            successesLastHour,
            lastSuccessAt: lastSuccessDate ? lastSuccessDate.toISOString() : null,
            alarm: true,
            reason: "10+ attempts and 0 successes in the last hour",
          },
        }).catch(() => undefined);
      }
    } catch {
      // ignore logging failures
    }
  }

  return {
    lastSuccessAt: lastSuccessDate ? lastSuccessDate.toISOString() : null,
    successRateHour,
    hourlySuccessRate: successRateHour,
    attemptsLastHour,
    successesLastHour,
    alarm,
  };
}
