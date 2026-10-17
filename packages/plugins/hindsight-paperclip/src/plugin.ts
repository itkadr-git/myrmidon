import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PaperclipPlugin, ScopeKey } from "@paperclipai/plugin-sdk";
import { formatMemories, HindsightClient, type FetchLike } from "./client.js";
import { resolveBank } from "./bank.js";

export type { FetchLike };

/**
 * Fork of the upstream hindsight memory plugin worker.
 *
 * Differences from upstream 0.3.0, all in service of memory isolation:
 *
 * - Bank routing is per agent and closed by default. `deriveBankId`'s old
 *   modes (static shared bank, `paperclip::<company>::<agent>` derived id)
 *   are gone: an agent resolves through its card's
 *   `adapterConfig.hindsight.bankId` or the configuration's
 *   `bankByAgentId` map, and an unresolved agent writes and reads nothing.
 * - One resolution function (`resolveBank`) is used by all four paths:
 *   `issue.comment.created` retention, `agent.run.started` recall, and the
 *   `hindsight_recall` / `hindsight_retain` tools.
 * - Retain metadata carries `agentName` (the agent card's name), so memory
 *   can be classified by author without touching the board's database.
 * - Retention is per run, not per comment: an agent's comments wait in
 *   run-scoped plugin state and one consolidated digest per bank is retained
 *   on `agent.run.finished`. A comment that belongs to no run — a human's, or
 *   an event that carries no run id — is retained immediately, as before.
 * - Run-start recall is conditional (`recallOnRunStart`): `new-issue` (the
 *   default) recalls once per ticket an agent picks up, `always` keeps the
 *   per-run recall of the fork, `never` turns run-start recall off.
 *
 * The client transport is injectable for tests (`createHindsightPlugin({
 *   fetchImpl })`); the worker entrypoint builds the plugin with the default.
 */

export interface HindsightPluginConfig {
  hindsightApiUrl: string;
  hindsightApiKeyRef?: string;
  recallBudget?: string;
  autoRetain?: boolean;
  recallOnRunStart?: string;
  bankByAgentId?: Record<string, string>;
  enabledAgentIds?: string[];
}

const CLOSED_AGENT_RETAIN_MESSAGE = "Retain skipped — agent not mapped to a bank";
const CLOSED_AGENT_RECALL_MESSAGE = "Recall skipped — agent not mapped to a bank";

/** Run-scoped state key holding the comments a run buffered for its digest. */
const RETAIN_BUFFER_STATE_KEY = "retain-buffer";
/** Agent-scoped state key naming the last issue this agent recalled. */
const LAST_RECALL_ISSUE_STATE_KEY = "hindsight-last-recall-issue";

/** A comment shorter than this does not earn a line in a run digest. */
const MIN_DIGEST_BODY_LENGTH = 200;

/**
 * Board machinery rather than agent output: milestone blocks, status
 * transitions, wake notices and review verdicts. Deliberately conservative —
 * only shapes the board itself writes are named here, everything else is kept.
 */
const SYSTEM_COMMENT_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s/,
  /status changed/i,
  /\bwakeup\b/i,
  /^review:\s/im,
];

/** The three `recallOnRunStart` modes. */
export type RecallOnRunStartMode = "always" | "new-issue" | "never";

/** An absent or unknown mode reads as the default (`new-issue`). */
export function normalizeRecallMode(value: unknown): RecallOnRunStartMode {
  if (value === "always" || value === "never") return value;
  return "new-issue";
}

/** One comment of a run, waiting in run-scoped state for the run to finish. */
interface RetainBufferEntry {
  commentId: string;
  agentId: string;
  agentName: string | null;
  issueId: string;
  body: string;
  createdAt: string;
}

/** Read a buffer out of plugin state, tolerating any other stored shape. */
function readRetainBufferValue(value: unknown): RetainBufferEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RetainBufferEntry => {
    if (entry === null || typeof entry !== "object") return false;
    const candidate = entry as Partial<RetainBufferEntry>;
    return typeof candidate.commentId === "string"
      && typeof candidate.agentId === "string"
      && typeof candidate.issueId === "string"
      && typeof candidate.body === "string";
  });
}

/**
 * The digest-worthy comments of a buffer, in buffered order: duplicates by
 * comment id collapse to one, and short or system comments are dropped.
 */
function digestEntries(buffer: RetainBufferEntry[]): RetainBufferEntry[] {
  const seen = new Set<string>();
  const kept: RetainBufferEntry[] = [];
  for (const entry of buffer) {
    if (seen.has(entry.commentId)) continue;
    seen.add(entry.commentId);
    if (entry.body.trim().length < MIN_DIGEST_BODY_LENGTH) continue;
    if (SYSTEM_COMMENT_PATTERNS.some((pattern) => pattern.test(entry.body))) continue;
    kept.push(entry);
  }
  return kept;
}

/** Group entries by the agent whose bank owns them, keeping the input order. */
function groupByBankAgent(entries: RetainBufferEntry[]): Map<string, RetainBufferEntry[]> {
  const groups = new Map<string, RetainBufferEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.agentId);
    if (group) group.push(entry);
    else groups.set(entry.agentId, [entry]);
  }
  return groups;
}

/** One bank's digest document: a header and a numbered list of comments. */
function buildDigestDocument(runId: string, entries: RetainBufferEntry[]): string {
  const lines = entries.map((entry, index) =>
    `${index + 1}. ${entry.agentName ?? entry.agentId} (${entry.issueId}): ${entry.body.trim()}`);
  return [`Run ${runId} digest`, "", ...lines].join("\n");
}

/** Stable hindsight document id of a run's digest. */
function runDigestDocumentId(runId: string): string {
  return `${runId}-digest`;
}

interface PluginDeps {
  fetchImpl?: FetchLike;
}

async function getConfig(ctx: { config: { get(companyId?: string): Promise<Record<string, unknown>> } }, companyId?: string) {
  return (await ctx.config.get(companyId)) as HindsightPluginConfig & Record<string, unknown>;
}

function isAgentEnabled(config: HindsightPluginConfig, agentId: string | null | undefined): boolean {
  const allowlist = config.enabledAgentIds;
  if (!allowlist || allowlist.length === 0) return true;
  return !!agentId && allowlist.includes(agentId);
}

export function createHindsightPlugin(deps: PluginDeps = {}): PaperclipPlugin {
  return definePlugin({
    async setup(ctx) {
      ctx.logger.info("Hindsight memory plugin starting (per-agent bank routing)");

      const makeClient = async (config: HindsightPluginConfig) => {
        let token: string | undefined;
        if (config.hindsightApiKeyRef) {
          const resolved = await ctx.secrets.resolve(config.hindsightApiKeyRef);
          token = resolved ?? undefined;
        }
        return new HindsightClient(config.hindsightApiUrl, token, deps.fetchImpl);
      };

      const resolveForAgent = async (agentId: string, companyId: string) => {
        const config = await getConfig(ctx, companyId);
        return resolveBank({
          agentId,
          companyId,
          getAgent: (id, company) => ctx.agents.get(id, company),
          config,
        });
      };

      const runStateKey = (scopeId: string, stateKey: string): ScopeKey => ({ scopeKind: "run", scopeId, stateKey });

      ctx.events.on("agent.run.started", async (event) => {
        const payload = (event.payload ?? {}) as { agentId?: string | null; runId?: string | null; issueId?: string | null };
        const agentId = payload.agentId;
        const runId = payload.runId;
        const issueId = payload.issueId;
        const companyId = event.companyId;
        if (!agentId || !companyId) return;
        const config = await getConfig(ctx, companyId);
        if (!isAgentEnabled(config, agentId)) return;
        if (!issueId) return;

        const recallMode = normalizeRecallMode(config.recallOnRunStart);
        if (recallMode === "never") {
          ctx.logger.debug("Run-start recall is off (recallOnRunStart=never)", { runId, agentId });
          return;
        }
        const lastRecallIssueKey: ScopeKey = {
          scopeKind: "agent",
          scopeId: agentId,
          stateKey: LAST_RECALL_ISSUE_STATE_KEY,
        };
        if (recallMode === "new-issue") {
          const lastRecalledIssueId = await ctx.state.get(lastRecallIssueKey);
          if (typeof lastRecalledIssueId === "string" && lastRecalledIssueId === issueId) {
            ctx.logger.debug("Run-start recall skipped — this agent already recalled this issue", {
              runId,
              agentId,
              issueId,
            });
            return;
          }
        }

        const resolution = await resolveForAgent(agentId, companyId);
        if (!resolution) {
          ctx.logger.warn(CLOSED_AGENT_RECALL_MESSAGE, { runId, agentId });
          return;
        }

        let issue: { title: string; description: string | null } | null = null;
        try {
          issue = await ctx.issues.get(issueId, companyId);
        } catch (err) {
          ctx.logger.warn("Failed to fetch issue for recall", { runId, issueId, error: String(err) });
          return;
        }
        if (!issue) return;
        const query = [issue.title, issue.description].filter(Boolean).join("\n");
        if (!query.trim()) return;

        try {
          const client = await makeClient(config);
          const response = await client.recall(resolution.bankId, query, config.recallBudget ?? "mid");
          // The marker names the last issue this agent recalled, so the next
          // run of the same ticket can skip the search (recallOnRunStart=new-issue).
          try {
            await ctx.state.set(lastRecallIssueKey, issueId);
          } catch (err) {
            ctx.logger.warn("Failed to record the last recalled issue", { runId, agentId, error: String(err) });
          }
          const memories = formatMemories(response.results ?? []);
          if (memories) {
            await ctx.state.set(
              { scopeKind: "run", scopeId: runId ?? "", stateKey: "recalled-memories" },
              memories,
            );
            ctx.logger.info("Recalled memories for run", {
              runId,
              bankId: resolution.bankId,
              count: response.results.length,
            });
          }
        } catch (err) {
          ctx.logger.warn("Failed to recall memories on run start", { runId, error: String(err) });
        }
      });

      ctx.events.on("issue.comment.created", async (event) => {
        const config = await getConfig(ctx, event.companyId);
        if (config.autoRetain === false) return;
        const companyId = event.companyId;
        const issueId = event.entityId;
        const payload = (event.payload ?? {}) as { commentId?: string; agentId?: string | null; runId?: string | null; bodySnippet?: string };
        const commentId = payload.commentId;
        const payloadAgentId = payload.agentId ?? null;
        const runId = payload.runId ?? null;
        if (!issueId || !companyId || !commentId) return;

        let body = "";
        try {
          const comments = await ctx.issues.listComments(issueId, companyId);
          const match = comments.find((comment) => comment.id === commentId);
          if (match && typeof match.body === "string") body = match.body;
        } catch (err) {
          if (typeof payload.bodySnippet === "string") {
            body = payload.bodySnippet;
          } else {
            ctx.logger.warn("Failed to fetch comment body", { commentId, error: String(err) });
            return;
          }
        }
        if (!body.trim()) return;

        // A human comment retains into the ticket assignee's bank (the
        // upstream behavior, now routed through the same resolution).
        let bankAgentId = payloadAgentId;
        if (!bankAgentId) {
          try {
            const issue = await ctx.issues.get(issueId, companyId);
            bankAgentId = issue?.assigneeAgentId ?? null;
          } catch {
            bankAgentId = null;
          }
        }
        if (!bankAgentId) {
          ctx.logger.info("Skipping retain — no agent attribution available", { commentId, issueId });
          return;
        }
        if (!isAgentEnabled(config, bankAgentId)) {
          ctx.logger.debug("Skipping retain — agent not in enabled list", { commentId, agentId: bankAgentId });
          return;
        }

        const resolution = await resolveForAgent(bankAgentId, companyId);
        if (!resolution) {
          ctx.logger.warn(CLOSED_AGENT_RETAIN_MESSAGE, { commentId, agentId: bankAgentId });
          return;
        }

        // Retention is per run: an agent's comment waits in run-scoped state
        // and is retained as part of its run's digest. A comment that belongs
        // to no run — a human's, or an event without a run id — is new input
        // for whatever run picks the ticket up next, so it goes in right away.
        if (payloadAgentId && runId) {
          const buffer = readRetainBufferValue(await ctx.state.get(runStateKey(runId, RETAIN_BUFFER_STATE_KEY)));
          buffer.push({
            commentId,
            agentId: bankAgentId,
            agentName: resolution.agentName,
            issueId,
            body,
            createdAt: event.occurredAt ?? new Date().toISOString(),
          });
          await ctx.state.set(runStateKey(runId, RETAIN_BUFFER_STATE_KEY), buffer);
          ctx.logger.debug("Buffered a comment for the run digest", {
            commentId,
            runId,
            bankId: resolution.bankId,
          });
          return;
        }

        try {
          const client = await makeClient(config);
          await client.retain(resolution.bankId, body, commentId, {
            agentId: bankAgentId,
            agentName: resolution.agentName,
            companyId,
            issueId,
            commentId,
          });
          ctx.logger.info("Retained comment to memory", { commentId, bankId: resolution.bankId });
        } catch (err) {
          ctx.logger.warn("Failed to retain comment", { commentId, error: String(err) });
        }
      });

      ctx.events.on("agent.run.finished", async (event) => {
        const payload = (event.payload ?? {}) as { agentId?: string | null; runId?: string | null };
        const runId = payload.runId;
        const companyId = event.companyId;
        if (!runId || !companyId) {
          ctx.logger.debug("agent.run.finished without a run id — nothing to flush", { agentId: payload.agentId });
          return;
        }
        const config = await getConfig(ctx, companyId);
        const bufferKey = runStateKey(runId, RETAIN_BUFFER_STATE_KEY);
        const buffer = readRetainBufferValue(await ctx.state.get(bufferKey));
        if (buffer.length === 0) {
          ctx.logger.debug("Run finished with an empty retain buffer", { runId, agentId: payload.agentId });
          return;
        }

        if (config.autoRetain === false) {
          await ctx.state.delete(bufferKey);
          ctx.logger.debug("Run digest dropped — comment retention is off", { runId });
          return;
        }

        const entries = digestEntries(buffer);
        if (entries.length === 0) {
          await ctx.state.delete(bufferKey);
          ctx.logger.debug("Run digest empty after filtering", { runId, buffered: buffer.length });
          return;
        }

        // One document per bank: the comments of a run are grouped by the agent
        // whose bank owns them, so a cast or a shared ticket still lands where
        // its author's memory lives.
        for (const [bankAgentId, group] of groupByBankAgent(entries)) {
          try {
            if (!isAgentEnabled(config, bankAgentId)) continue;
            const resolution = await resolveForAgent(bankAgentId, companyId);
            if (!resolution) {
              ctx.logger.warn(CLOSED_AGENT_RETAIN_MESSAGE, { runId, agentId: bankAgentId });
              continue;
            }
            const client = await makeClient(config);
            await client.retain(resolution.bankId, buildDigestDocument(runId, group), runDigestDocumentId(runId), {
              kind: "run-digest",
              runId,
              agentIds: [bankAgentId],
              issueIds: [...new Set(group.map((entry) => entry.issueId))],
              companyId,
              commentCount: group.length,
            });
            ctx.logger.info("Retained the run digest", {
              runId,
              bankId: resolution.bankId,
              comments: group.length,
            });
          } catch (err) {
            ctx.logger.warn("Failed to retain the run digest", {
              runId,
              agentId: bankAgentId,
              error: String(err),
            });
          }
        }

        await ctx.state.delete(bufferKey);
      });

      ctx.tools.register(
        "hindsight_recall",
        {
          displayName: "Recall from Memory",
          description: "Search Hindsight long-term memory for context relevant to a query.",
          parametersSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", description: "What to search for" },
            },
          },
        },
        async (params, runCtx) => {
          const { query } = (params ?? {}) as { query?: string };
          const config = await getConfig(ctx, runCtx.companyId);
          if (!isAgentEnabled(config, runCtx.agentId)) {
            return { content: "No memories available for this agent." };
          }
          const resolution = await resolveForAgent(runCtx.agentId, runCtx.companyId);
          if (!resolution) {
            return { content: "No memories available for this agent." };
          }
          const cached = await ctx.state.get({
            scopeKind: "run",
            scopeId: runCtx.runId,
            stateKey: "recalled-memories",
          });
          if (cached && typeof cached === "string") {
            return { content: cached };
          }
          try {
            const client = await makeClient(config);
            const response = await client.recall(resolution.bankId, query ?? "", config.recallBudget ?? "mid");
            const memories = formatMemories(response.results ?? []);
            return { content: memories || "No relevant memories found." };
          } catch (err) {
            return { content: `Memory recall failed: ${String(err)}` };
          }
        },
      );

      ctx.tools.register(
        "hindsight_retain",
        {
          displayName: "Save to Memory",
          description: "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
          parametersSchema: {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string", description: "The content to store in memory" },
            },
          },
        },
        async (params, runCtx) => {
          const { content } = (params ?? {}) as { content?: string };
          const config = await getConfig(ctx, runCtx.companyId);
          if (!isAgentEnabled(config, runCtx.agentId)) {
            return { content: CLOSED_AGENT_RETAIN_MESSAGE };
          }
          const resolution = await resolveForAgent(runCtx.agentId, runCtx.companyId);
          if (!resolution) {
            return { content: CLOSED_AGENT_RETAIN_MESSAGE };
          }
          try {
            const client = await makeClient(config);
            await client.retain(resolution.bankId, content ?? "", undefined, {
              agentId: runCtx.agentId,
              agentName: resolution.agentName,
              companyId: runCtx.companyId,
              runId: runCtx.runId,
            });
            return { content: "Memory saved." };
          } catch (err) {
            return { content: `Failed to save memory: ${String(err)}` };
          }
        },
      );

      ctx.logger.info("Hindsight memory plugin ready");
    },

    async onHealth() {
      return { status: "ok" };
    },

    async onValidateConfig(config) {
      const c = config as HindsightPluginConfig & Record<string, unknown>;
      if (!c.hindsightApiUrl?.trim()) {
        return { ok: false, errors: ["hindsightApiUrl is required"] };
      }
      try {
        const client = new HindsightClient(c.hindsightApiUrl, undefined, deps.fetchImpl);
        const healthy = await client.health();
        if (!healthy) {
          return {
            ok: false,
            errors: [`Cannot reach Hindsight at ${c.hindsightApiUrl}`],
          };
        }
      } catch (err) {
        return { ok: false, errors: [`Connection failed: ${String(err)}`] };
      }
      return { ok: true };
    },
  });
}
