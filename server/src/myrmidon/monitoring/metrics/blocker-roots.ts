import type { Db } from "@myrmidon/db";
import { companies, instanceSettings } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { loadBlockedGraph } from "../../../services/blocker-graph/load-edges.js";
import { computeRootFanout } from "../../../services/blocker-graph/root-fanout.js";
import { blockerRootFanoutAlertLimitFromSettings } from "../../../services/blocker-graph/fanout-limit.js";

export const BLOCKER_METRICS_TOP_N = 10;
export interface BlockerRootMetrics {
  companies: Array<{
    companyId: string;
    roots: Array<{ root: string; fanout: number }>;
    terminalCount: number;
    rootsOverLimit: number;
  }>;
}

/** Keep labels bounded per company; aggregate gauges cover all terminal roots. */
export async function collectBlockerRootMetrics(
  db: Db,
  options: { topN?: number; fanoutLimit?: number } = {},
): Promise<BlockerRootMetrics> {
  const topN = options.topN ?? BLOCKER_METRICS_TOP_N;
  if (!Number.isInteger(topN) || topN < 0 || topN > 100) throw new Error("Invalid blocker metrics topN");
  const [settings] = await db.select({ general: instanceSettings.general })
    .from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const limit = options.fanoutLimit ?? blockerRootFanoutAlertLimitFromSettings(settings?.general);
  const result: BlockerRootMetrics = { companies: [] };
  for (const { id } of await db.select({ id: companies.id }).from(companies)) {
    const graph = await loadBlockedGraph(db, id);
    // The B3 port returns all open edges for chain traversal. Only blocked
    // dependents contribute to these gauges; cycles are not terminal roots.
    const blockedIds = new Set(graph.blockedIssues.filter((issue) => issue.status === "blocked").map((issue) => issue.id));
    const roots = computeRootFanout(graph.edges)
      .map((root) => ({ root: root.rootIssueId, fanout: root.dependents.filter((id) => blockedIds.has(id)).length }))
      .filter((root) => root.fanout > 0)
      .sort((a, b) => b.fanout - a.fanout || a.root.localeCompare(b.root));
    result.companies.push({
      companyId: id,
      roots: roots.slice(0, topN),
      terminalCount: roots.length,
      rootsOverLimit: roots.filter((root) => root.fanout > limit).length,
    });
  }
  return result;
}

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function renderBlockerRootMetrics(sample: BlockerRootMetrics): string {
  const families: Array<[string, string, string[]]> = [
    ["blocker_root_fanout", "Blocked dependents per terminal root, top ten per company.", sample.companies.flatMap((row) =>
      row.roots.map((root) => `blocker_root_fanout{company="${label(row.companyId)}",root="${label(root.root)}"} ${root.fanout}`))],
    ["blocker_terminal_count", "Terminal roots holding blocked issues per company.", sample.companies.map((row) =>
      `blocker_terminal_count{company="${label(row.companyId)}"} ${row.terminalCount}`)],
    ["blocker_roots_over_limit", "Terminal roots strictly above the configured fanout limit per company.", sample.companies.map((row) =>
      `blocker_roots_over_limit{company="${label(row.companyId)}"} ${row.rootsOverLimit}`)],
  ];
  return families.map(([name, help, rows]) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows].join("\n")).join("\n\n") + "\n";
}
