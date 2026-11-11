// server/src/myrmidon/litellm-costs/key-budgets.ts
//
// myrmidon(OPE-11776): the cap and the spend of every bot's gateway key, in
// the board. It replaces the host scripts that scanned the gateway's
// LiteLLM_SpendLogs table (litellm-budget-to-zabbix and its kin).
//
// Where each number comes from
//  - the cap and the cumulative spend of a key: the gateway, ONE `/key/list`
//    read (a page per 100 keys) with the accounting key the cost sweep already
//    uses. A bot's key is matched by its sha256 — the hash the gateway stores
//    and the spend ledger carries — so the gateway is never asked about a raw
//    key and the key list is read once, not once per agent;
//  - spend over the last 24 h / 7 days: the board's own ledger
//    (litellm_cost_events) through the shared, cached, time-bounded read of
//    litellm-keys/key-spend.ts — no scan of the gateway's spend log;
//  - which agents have a key: the bot cards, resolved the way the cost sweep
//    resolves them (bot-keys.ts: the card's own secret_ref binding first, the
//    shared company secret otherwise).
//
// What it feeds
//  - the report the LLM module shows (GET .../litellm/key-usage);
//  - the attention signals (>= 80% of a cap, exhausted, an anomalous day);
//  - the cap-utilization gauge of the authenticated /metrics scrape, which
//    reads memory only — a scrape never reaches the gateway.
//
// The cost sweep's tick refreshes the report every BUDGET_SIGNAL_INTERVAL_MS
// (startup.ts), so the signals exist without anyone opening a page. The report
// is cached for KEY_USAGE_REPORT_TTL_MS and shared by concurrent readers.
// Nothing here carries a key value or a key hash out of this module.

import { eq } from "drizzle-orm";
import { agents, type Db } from "@myrmidon/db";
import { readAgentSpendWindows, type AgentSpendWindow } from "../litellm-keys/key-spend.js";
import {
  LITELLM_NEAR_CAP_PERCENT,
  litellmBudgetSignalsForKey,
  recordLitellmBudgetSignals,
  recordLitellmKeyBudgetGauges,
  type LitellmBudgetAttentionSignal,
  type LitellmKeyBudgetGauge,
} from "./attention.js";
import {
  gatewayKeyHash,
  type GatewayKeyBudgetRow,
  type LitellmCostSettings,
  type LitellmGatewayClient,
} from "./litellm-costs.js";

export type KeyCapStatus = "ok" | "near_cap" | "exhausted" | "unknown";

/** One agent's key: its cap, what the gateway says it spent, and the ledger spend. */
export interface KeyUsageRow {
  agentId: string;
  agentName: string | null;
  /** The key's cap in USD; null when it has none, or the gateway could not be read. */
  capUsd: number | null;
  /** Gateway spend in USD since the key's last budget reset; null when unknown. */
  gatewaySpendUsd: number | null;
  /** Gateway spend as a percentage of the cap; null without both numbers. */
  utilizationPercent: number | null;
  status: KeyCapStatus;
  /** Ledger spend over the last 24 h / 7 days, in cents; null when the ledger could not be read. */
  dailyCents: number | null;
  weeklyCents: number | null;
  /** Ledger rows of the last 7 days that cost $0 — a route without a price. */
  zeroCostEvents: number | null;
}

export interface KeyUsageReport {
  generatedAt: string;
  /** false: the gateway's key list could not be read — no caps, no cap signals. */
  gatewayAvailable: boolean;
  /** false: the ledger could not be read — no 24 h / 7 d numbers. */
  ledgerAvailable: boolean;
  rows: KeyUsageRow[];
}

export interface KeyBudgetDeps {
  db: Db;
  settings: LitellmCostSettings;
  readGatewayKey(companyId: string, secretName: string): Promise<string | null>;
  /** Bot keys of the company (agentId + key value). The values stay in this process. */
  listBotKeys(companyId: string): Promise<Array<{ agentId: string; keyValue: string }>>;
  client(baseUrl: string, keyValue: string): LitellmGatewayClient;
  /** Overrides the ledger read (tests). */
  readSpendWindows?(): Promise<AgentSpendWindow[]>;
  now(): Date;
  log?: { warn(fields: object, message: string): void };
}

/** How long the report is reused by readers. The sweep tick refreshes it on its own cadence. */
export const KEY_USAGE_REPORT_TTL_MS = 5 * 60_000;

export function keyCapStatus(percent: number | null): KeyCapStatus {
  if (percent == null) return "unknown";
  if (percent >= 100) return "exhausted";
  return percent >= LITELLM_NEAR_CAP_PERCENT ? "near_cap" : "ok";
}

async function readGatewayBudgets(
  deps: KeyBudgetDeps,
  companyId: string,
): Promise<Map<string, GatewayKeyBudgetRow> | null> {
  const { baseUrl, keySecret } = deps.settings;
  if (!baseUrl || !keySecret) return null;
  const accountingKey = await deps.readGatewayKey(companyId, keySecret);
  if (!accountingKey) return null;
  const client = deps.client(baseUrl, accountingKey);
  if (!client.listKeyBudgets) return null;
  const rows = await client.listKeyBudgets();
  return new Map(rows.map((row) => [row.tokenHash, row]));
}

/**
 * Reads the gateway and the ledger once, builds the report and records the
 * attention signals and the metrics gauges. A read that fails degrades the
 * report (the flag says which) instead of failing it; the signals of a pass
 * that could not read the gateway are left as they were.
 */
export async function evaluateKeyBudgets(deps: KeyBudgetDeps, companyId: string): Promise<KeyUsageReport> {
  const now = deps.now();
  const botKeys = await deps.listBotKeys(companyId);
  const nameRows = await deps.db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const names = new Map(nameRows.map((row) => [row.id, row.name]));

  let spendByAgent: Map<string, AgentSpendWindow> | null = null;
  try {
    const windows = await (deps.readSpendWindows ? deps.readSpendWindows() : readAgentSpendWindows(deps.db, now));
    spendByAgent = new Map(windows.filter((spent) => spent.companyId === companyId).map((spent) => [spent.agentId, spent]));
  } catch (err) {
    deps.log?.warn({ err, companyId }, "LiteLLM ledger spend read failed; key usage has no 24 h / 7 d numbers");
  }

  let budgetByHash: Map<string, GatewayKeyBudgetRow> | null = null;
  try {
    budgetByHash = await readGatewayBudgets(deps, companyId);
  } catch (err) {
    deps.log?.warn({ err, companyId }, "LiteLLM key list read failed; key caps are unavailable");
  }

  const rows: KeyUsageRow[] = [];
  const signals: LitellmBudgetAttentionSignal[] = [];
  const gauges: LitellmKeyBudgetGauge[] = [];
  const activityAt = now.toISOString();
  const seen = new Set<string>();
  for (const botKey of botKeys) {
    if (seen.has(botKey.agentId)) continue;
    seen.add(botKey.agentId);
    const agentName = names.get(botKey.agentId) ?? null;
    const budget = budgetByHash?.get(gatewayKeyHash(botKey.keyValue)) ?? null;
    const capUsd = budget?.maxBudgetUsd ?? null;
    const gatewaySpendUsd = budget?.spendUsd ?? null;
    const utilizationPercent = capUsd != null && gatewaySpendUsd != null ? (gatewaySpendUsd / capUsd) * 100 : null;
    const spent = spendByAgent?.get(botKey.agentId);
    rows.push({
      agentId: botKey.agentId,
      agentName,
      capUsd,
      gatewaySpendUsd,
      utilizationPercent,
      status: keyCapStatus(utilizationPercent),
      dailyCents: spendByAgent ? (spent?.dailyCents ?? 0) : null,
      weeklyCents: spendByAgent ? (spent?.weeklyCents ?? 0) : null,
      zeroCostEvents: spendByAgent ? (spent?.zeroCostEvents ?? 0) : null,
    });
    if (budgetByHash) {
      signals.push(...litellmBudgetSignalsForKey({
        companyId,
        agentId: botKey.agentId,
        agentName,
        capCents: capUsd == null ? null : capUsd * 100,
        gatewaySpendCents: gatewaySpendUsd == null ? null : gatewaySpendUsd * 100,
        dailySpendCents: spent?.dailyCents ?? 0,
        weeklySpendCents: spent?.weeklyCents ?? 0,
        activityAt,
      }));
      if (utilizationPercent != null) gauges.push({ companyId, agentId: botKey.agentId, percent: utilizationPercent });
    }
  }
  if (budgetByHash) {
    recordLitellmBudgetSignals(companyId, signals);
    recordLitellmKeyBudgetGauges(companyId, gauges);
  }
  return {
    generatedAt: activityAt,
    gatewayAvailable: budgetByHash !== null,
    ledgerAvailable: spendByAgent !== null,
    rows,
  };
}

interface CachedReport {
  at: number;
  report: Promise<KeyUsageReport>;
}

const reports = new Map<string, CachedReport>();

/** Evaluates now and replaces the cached report (the sweep tick). A failed pass is not cached. */
export function refreshKeyUsageReport(deps: KeyBudgetDeps, companyId: string): Promise<KeyUsageReport> {
  const entry: CachedReport = { at: Date.now(), report: evaluateKeyBudgets(deps, companyId) };
  reports.set(companyId, entry);
  entry.report.catch(() => {
    if (reports.get(companyId) === entry) reports.delete(companyId);
  });
  return entry.report;
}

/** The cached report while it is fresh, else a new evaluation. Concurrent readers share one pass. */
export function readKeyUsageReport(deps: KeyBudgetDeps, companyId: string): Promise<KeyUsageReport> {
  const entry = reports.get(companyId);
  if (entry && Date.now() - entry.at < KEY_USAGE_REPORT_TTL_MS) return entry.report;
  return refreshKeyUsageReport(deps, companyId);
}

/** Forget every cached report: tests. */
export function resetKeyUsageReports(): void {
  reports.clear();
}
