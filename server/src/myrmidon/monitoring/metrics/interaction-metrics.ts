import type { Db } from "@myrmidon/db";
import { sql } from "drizzle-orm";

export const INTERACTION_METRIC_FAMILIES = [
  "interactions_pending_without_owner",
  "interactions_oldest_pending_age_seconds",
  "interaction_escalations_total",
  "interaction_timeout_escalated_ratio",
  "interaction_ack_latency_seconds",
] as const;

export const ACK_BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 86400] as const;

export interface InteractionMetricRow {
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  timeoutAt: Date | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  addresseeQueue: string | null;
  escalationLevel: number;
}
export interface EscalationMetricRow { level: number; count: number }
export interface InteractionMetricsReadPort {
  read(): Promise<{ interactions: InteractionMetricRow[]; escalations: EscalationMetricRow[] }>;
}
export interface InteractionMetricsSnapshot {
  pendingWithoutOwner: number;
  oldestPendingAgeSeconds: number;
  escalations: EscalationMetricRow[];
  timeoutEscalatedRatio: number;
  ack: { buckets: number[]; count: number; sum: number };
}

/** Read persisted I2 routing columns and the I3 journal in one consistent transaction.
 * Missing migrations throw: never turn an unavailable source into healthy zeroes.
 */
export function interactionMetricsReadPort(db: Db): InteractionMetricsReadPort {
  return {
    async read() {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const routingColCheck = await tx.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'issue_thread_interactions'
              AND column_name = 'timeout_at'
          ) AS has_routing
        `);
        const hasRouting = Boolean((routingColCheck as unknown as Array<{ has_routing: boolean }>)[0]?.has_routing);

        const interactions = hasRouting
          ? await tx.execute(sql`
              SELECT status, created_at, resolved_at, timeout_at, addressee_agent_id,
                addressee_user_id, addressee_queue, escalation_level
              FROM issue_thread_interactions
            `)
          : await tx.execute(sql`
              SELECT status, created_at, resolved_at,
                NULL::timestamptz AS timeout_at,
                addressee_agent_id, addressee_user_id,
                NULL::text AS addressee_queue,
                0::integer AS escalation_level
              FROM issue_thread_interactions
            `);
        const escalations = await tx.execute(sql`
          SELECT level, count(*)::integer AS count FROM interaction_escalations GROUP BY level ORDER BY level
        `);
        return {
          interactions: Array.from(interactions).map((row) => ({
            status: String(row.status), createdAt: new Date(String(row.created_at)),
            resolvedAt: row.resolved_at == null ? null : new Date(String(row.resolved_at)),
            timeoutAt: row.timeout_at == null ? null : new Date(String(row.timeout_at)),
            addresseeAgentId: row.addressee_agent_id == null ? null : String(row.addressee_agent_id),
            addresseeUserId: row.addressee_user_id == null ? null : String(row.addressee_user_id),
            addresseeQueue: row.addressee_queue == null ? null : String(row.addressee_queue),
            escalationLevel: Number(row.escalation_level ?? 0),
          })),
          escalations: Array.from(escalations).map((row) => ({ level: Number(row.level), count: Number(row.count) })),
        };
      }, { isolationLevel: "repeatable read" });
    },
  };
}

/** ACK means a completed answer/decision, not cancellation or supersession.
 * Ratio: overdue cards whose routing level advanced / all overdue cards.
 * Journal totals and ACK histogram cover retained rows, without a scrape window.
 */
export async function collectInteractionMetrics(port: InteractionMetricsReadPort, now: Date): Promise<InteractionMetricsSnapshot> {
  const { interactions, escalations } = await port.read();
  const pending = interactions.filter((row) => row.status === "pending");
  const overdue = interactions.filter((row) => row.timeoutAt != null && row.timeoutAt <= now
    && (row.resolvedAt == null || row.resolvedAt > row.timeoutAt));
  const latencies = interactions.filter((row) => ["answered", "accepted", "rejected"].includes(row.status)
    && row.resolvedAt != null && row.resolvedAt >= row.createdAt && row.resolvedAt <= now)
    .map((row) => (row.resolvedAt!.getTime() - row.createdAt.getTime()) / 1000);
  return {
    pendingWithoutOwner: pending.filter((row) => !row.addresseeAgentId && !row.addresseeUserId && !row.addresseeQueue).length,
    oldestPendingAgeSeconds: pending.reduce((max, row) => Math.max(max, (now.getTime() - row.createdAt.getTime()) / 1000), 0),
    escalations,
    timeoutEscalatedRatio: overdue.length === 0 ? 0 : overdue.filter((row) => row.escalationLevel > 0).length / overdue.length,
    ack: { buckets: ACK_BUCKETS.map((bound) => latencies.filter((value) => value <= bound).length), count: latencies.length, sum: latencies.reduce((sum, value) => sum + value, 0) },
  };
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderInteractionMetricBlocks(snapshot: InteractionMetricsSnapshot | null, role: string): string[] {
  const labels = `role="${escapeLabelValue(role)}"`;
  if (!snapshot) {
    return INTERACTION_METRIC_FAMILIES.map((name, i) =>
      `# HELP ${name} Interaction SLA metric (source unavailable).\n# TYPE ${name} ${i === 2 ? "counter" : i === 4 ? "histogram" : "gauge"}`,
    );
  }
  const blocks: string[] = [];
  function family(name: string, help: string, type: string, samples: string[]) {
    blocks.push(`# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${samples.join("\n")}`);
  }
  family(INTERACTION_METRIC_FAMILIES[0], "Pending cards without an agent, user or queue recipient.", "gauge", [`interactions_pending_without_owner{${labels}} ${snapshot.pendingWithoutOwner}`]);
  family(INTERACTION_METRIC_FAMILIES[1], "Age of the oldest pending card in seconds.", "gauge", [`interactions_oldest_pending_age_seconds{${labels}} ${snapshot.oldestPendingAgeSeconds}`]);
  family(INTERACTION_METRIC_FAMILIES[2], "Persisted escalation journal entries by level.", "counter", snapshot.escalations.map((row) => `interaction_escalations_total{${labels},level="${row.level}"} ${row.count}`));
  family(INTERACTION_METRIC_FAMILIES[3], "Fraction of overdue cards with an advanced escalation level.", "gauge", [`interaction_timeout_escalated_ratio{${labels}} ${snapshot.timeoutEscalatedRatio}`]);
  const name = INTERACTION_METRIC_FAMILIES[4];
  family(name, "Time from creation to answer or decision in seconds, over retained cards.", "histogram", [
    ...ACK_BUCKETS.map((bound, i) => `${name}_bucket{${labels},le="${bound}"} ${snapshot.ack.buckets[i]}`),
    `${name}_bucket{${labels},le="+Inf"} ${snapshot.ack.count}`,
    `${name}_sum{${labels}} ${snapshot.ack.sum}`, `${name}_count{${labels}} ${snapshot.ack.count}`,
  ]);
  return blocks;
}

export function renderInteractionMetrics(snapshot: InteractionMetricsSnapshot | null, role: string): string {
  return renderInteractionMetricBlocks(snapshot, role).join("\n\n") + "\n";
}
