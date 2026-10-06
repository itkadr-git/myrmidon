// myrmidon(X8c): /status — a short, secret-free summary of this Telegram
// chat: agent, model/reasoning source, session state, whether a reply is
// running, last reply's usage, and whether the web conversation is shared
// into this chat's context (X8d).
// myrmidon(1.7-TG-LOCALE): every label renders from the locale catalogs in
// the chat owner's language; values (model names, levels, URLs, numbers)
// keep whatever the server stores.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, heartbeatRuns } from "@paperclipai/db";
import { safeChatTaskUrl } from "../../../services/chat-task-url.js";
import { issueService } from "../../../services/issues.js";
import { readCrossChannelSettings } from "../settings.js";
import { t, type BridgeLocale } from "../locales/index.js";
import type { BridgedCommandContext } from "./context.js";
import {
  THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES,
  describeEffectiveChatValue,
  readOverrideAdapterConfig,
  sourceLabelFor,
} from "./models.js";

export interface BuildChatStatusReplyInput {
  db: Db;
  companyId: string;
  agentId: string;
  boardUserId: string;
  publicBaseUrl: string | null;
  context: BridgedCommandContext;
  /** myrmidon(1.7-TG-LOCALE): the chat owner's resolved locale. */
  locale: BridgeLocale;
}

export async function buildChatStatusReply(input: BuildChatStatusReplyInput): Promise<string> {
  const { db, companyId, agentId, boardUserId, publicBaseUrl, context, locale } = input;
  const lines: string[] = [t(locale, "status.header", { agent: context.agent.name })];

  const boardUrl = safeChatTaskUrl(publicBaseUrl, context.issue.id);
  if (boardUrl) lines.push(t(locale, "status.board", { url: boardUrl }));

  const overrideAdapterConfig = readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides);
  const model = describeEffectiveChatValue(overrideAdapterConfig, context.agent.adapterConfig, "model");
  const modelSource = sourceLabelFor(model.source, locale);
  lines.push(t(locale, "status.model", { value: model.value ?? modelSource, source: modelSource }));
  if (THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(context.agent.adapterType)) {
    const reasoning = describeEffectiveChatValue(overrideAdapterConfig, context.agent.adapterConfig, "effort");
    const reasoningSource = sourceLabelFor(reasoning.source, locale);
    lines.push(
      t(locale, "status.reasoning", {
        value: reasoning.value ?? reasoningSource,
        source: reasoningSource,
      }),
    );
  }

  const hasModelSession = await hasAgentTaskSession(db, companyId, agentId, context.issue.id);
  lines.push(
    t(locale, "status.session", {
      number: context.issue.conversationSessionGeneration + 1,
      state: hasModelSession ? t(locale, "status.sessionActive") : t(locale, "status.sessionPending"),
    }),
  );

  lines.push(await describeCurrentTurn(db, companyId, agentId, context.issue.id, locale));

  const usageLine = formatUsageLine(
    await findLastSucceededRunUsage(db, companyId, agentId, context.issue.id),
    locale,
  );
  if (usageLine) lines.push(usageLine);

  const crossChannel = readCrossChannelSettings();
  if (crossChannel.messages > 0) {
    const webConversation = await issueService(db).getConversation(companyId, agentId, boardUserId);
    lines.push(
      t(locale, "status.webChat", {
        state: webConversation
          ? t(locale, "status.webChat.shared", { number: crossChannel.messages })
          : t(locale, "status.webChat.none"),
      }),
    );
  } else {
    lines.push(t(locale, "status.webChat", { state: t(locale, "status.webChat.off") }));
  }

  return lines.join("\n");
}

async function hasAgentTaskSession(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentTaskSessions.id })
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, companyId),
        eq(agentTaskSessions.agentId, agentId),
        eq(agentTaskSessions.taskKey, issueId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function describeCurrentTurn(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
  locale: BridgeLocale,
): Promise<string> {
  const [run] = await db
    .select({
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  if (!run) return t(locale, "status.nowIdle");
  if (run.status === "queued") return t(locale, "status.nowQueued");
  return t(locale, "status.nowReplying", { time: formatUtcTime(run.startedAt ?? run.createdAt) });
}

function formatUtcTime(value: Date | string | null): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

async function findLastSucceededRunUsage(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<Record<string, unknown> | null> {
  const [run] = await db
    .select({ usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "succeeded"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  return (run?.usageJson as Record<string, unknown> | null) ?? null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Mirrors heartbeat.ts:5337 (readRawUsageTotals) for the two fields /status needs, plus cost. */
function formatUsageLine(
  usageJson: Record<string, unknown> | null,
  locale: BridgeLocale,
): string | null {
  if (!usageJson) return null;
  const inputTokens = firstFiniteNumber(usageJson.rawInputTokens, usageJson.inputTokens);
  const outputTokens = firstFiniteNumber(usageJson.rawOutputTokens, usageJson.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  const cost = firstFiniteNumber(usageJson.costUsd, usageJson.cacheAdjustedCostUsd);
  const costText = cost !== null && cost > 0 ? `, $${cost.toFixed(2)}` : "";
  return t(locale, "status.usage", {
    input: inputTokens ?? 0,
    output: outputTokens ?? 0,
    cost: costText,
  });
}
