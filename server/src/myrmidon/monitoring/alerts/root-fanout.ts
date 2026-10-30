import { companies, instanceSettings, issues, type Db } from "@myrmidon/db";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "../../../middleware/logger.js";
import { BLOCKED_GRAPH_QUERY_LIMIT, loadBlockedGraph } from "../../../services/blocker-graph/load-edges.js";
import { computeRootFanout } from "../../../services/blocker-graph/root-fanout.js";
import { evaluateRootFanoutAlerts } from "../../../services/blocker-graph/evaluate-alert.js";
import { blockerRootFanoutAlertLimitFromSettings } from "../../../services/blocker-graph/fanout-limit.js";
import type { NormalizedAlert } from "./domain.js";
import { createAlertService, type AlertOutcome } from "./service.js";
import { dbAssigneeResolver, vendorIssuePorts } from "./routes.js";
import { createDbAlertSettingsStore } from "./settings.js";
import { ALERT_DEDUP_GENERAL_KEY, createDbAlertDedupStore, type DedupEntry } from "./store.js";

export const ROOT_FANOUT_ALERT = "blocker_root_fanout_exceeded";
const keyPrefix = `${ROOT_FANOUT_ALERT}:`;

export function createRootFanoutAlertCollector(db: Db, loadGraph = loadBlockedGraph) {
  return async function collect(companyId: string): Promise<AlertOutcome[]> {
    return db.transaction(async (tx) => {
      // Serialize the whole read/create/register sequence, not only the registry write.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ROOT_FANOUT_ALERT}, 0))`);
      const runner = tx as unknown as Db;
      await tx.insert(instanceSettings).values({ singletonKey: "default", general: {} }).onConflictDoNothing();
      const [settingsRow] = await tx.select({ general: instanceSettings.general })
        .from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).for("update");
      const limit = blockerRootFanoutAlertLimitFromSettings(settingsRow?.general);
      const graph = await loadGraph(runner, companyId);
      const roots = computeRootFanout(graph.edges);
      const firing = evaluateRootFanoutAlerts(roots, limit);
      const rootRows = firing.length === 0 ? [] : await tx
        .select({ id: issues.id, identifier: issues.identifier }).from(issues)
        .where(inArray(issues.id, firing.map((root) => root.rootIssueId)));
      const identifiers = new Map(rootRows.map((row) => [row.id, row.identifier ?? row.id]));
      const current = new Set(firing.map((root) => `${keyPrefix}${root.rootIssueId}`));
      const registry = (settingsRow?.general?.[ALERT_DEDUP_GENERAL_KEY] ?? {}) as Record<string, DedupEntry>;
      // A bounded snapshot cannot prove that a previously firing root recovered.
      const recovering = graph.edges.length >= BLOCKED_GRAPH_QUERY_LIMIT ? [] : Object.values(registry).filter((entry) =>
        entry.companyId === companyId && entry.issueStatus === "open"
        && entry.id.startsWith(`alertmanager:${keyPrefix}`)
        && !current.has(entry.id.slice("alertmanager:".length)));
      const service = createAlertService({
        store: createDbAlertDedupStore(runner),
        issues: vendorIssuePorts(runner),
        assigneeResolver: dbAssigneeResolver(runner),
      });
      const routes = await createDbAlertSettingsStore(runner).get(companyId);
      const outcomes: AlertOutcome[] = [];
      for (const root of firing) {
        const key = `${keyPrefix}${root.rootIssueId}`;
        const existing = registry[`alertmanager:${key}`];
        if (existing?.companyId === companyId && existing.issueStatus === "open") {
          outcomes.push({ identity: existing.id, action: "ignore", issueId: existing.issueId, issueIdentifier: existing.issueIdentifier });
          continue;
        }
        outcomes.push(await service.handleAlert(companyId, alert(key,
          `${ROOT_FANOUT_ALERT}: ${identifiers.get(root.rootIssueId) ?? root.rootIssueId} holds ${root.dependentCount} tasks (limit ${limit})`,
          root.rootIssueId, false), "medium", routes));
      }
      for (const entry of recovering) {
        const key = entry.id.slice("alertmanager:".length);
        outcomes.push(await service.handleAlert(companyId, alert(key,
          `${ROOT_FANOUT_ALERT}: root ${key.slice(keyPrefix.length)} recovered`,
          key.slice(keyPrefix.length), true), "medium", routes));
      }
      return outcomes;
    });
  };
}

function alert(key: string, title: string, rootIssueId: string, resolved: boolean): NormalizedAlert {
  return {
    source: "alertmanager", key, title, severity: "warning", hosts: [], resolved,
    resolvedAt: resolved ? new Date().toISOString() : null, startedAt: null,
    severityCode: null, labels: { alertname: ROOT_FANOUT_ALERT, rootIssueId },
    url: null,
  };
}

export function startRootFanoutAlertSweep(db: Db): () => void {
  const collect = createRootFanoutAlertCollector(db);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const company of await db.select({ id: companies.id }).from(companies)) {
        try { await collect(company.id); }
        catch (err) { logger.warn({ err, companyId: company.id }, "root fan-out alert collection failed"); }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick().catch((err) => logger.warn({ err }, "root fan-out alert sweep failed")); }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
