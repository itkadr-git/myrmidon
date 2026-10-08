// server/src/myrmidon/agent-exchange/wiring.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): binds the discussion-room routes to the
// database, the model providers, the documents service and the instance
// settings. Kept apart from routes.ts/engine.ts so both stay testable with
// plain fakes; this file is the only one that knows about `Db`, the secrets
// service and the real HTTP fetch.
//
// The model port speaks the OpenAI-compatible chat-completions shape against
// the provider's own base URL with the provider's key from the company secret
// store — the same approach cto-chat/plan-generator takes. Key values are
// resolved per call and never reach a log line or a response.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { modelProviders, type Db } from "@paperclipai/db";
import { DEFAULT_AGENT_EXCHANGE_SETTINGS, MODEL_PROVIDER_DEFAULT_BASE_URLS } from "@paperclipai/shared";
import { documentService, secretService } from "../../services/index.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { agentExchangeRoutes } from "./routes.js";
import { agentExchangeStore } from "./store.js";
import type {
  AgentExchangeModelPort,
  AgentExchangeModelCallInput,
  AgentExchangeModelCallResult,
  AgentExchangeSummarySink,
} from "./engine.js";

/** The chat-completions URL of a provider (the cto-chat rule: /v1 aware). */
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** The text of an OpenAI-style message content (a string, or text parts). */
function readChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return "";
}

/** The model port backed by the company model providers and secret store. */
export function createAgentExchangeModelPort(db: Db, companyId: string): AgentExchangeModelPort {
  const secrets = secretService(db);
  return {
    async call(input: AgentExchangeModelCallInput): Promise<AgentExchangeModelCallResult> {
      const provider = await db
        .select({
          id: modelProviders.id,
          type: modelProviders.type,
          baseUrl: modelProviders.baseUrl,
          credentialSecretName: modelProviders.credentialSecretName,
        })
        .from(modelProviders)
        .where(eq(modelProviders.id, input.providerId))
        .then((rows) => rows[0] ?? null);
      if (!provider) throw new Error(`provider_not_found:${input.providerId}`);
      const baseUrl =
        provider.baseUrl ??
        MODEL_PROVIDER_DEFAULT_BASE_URLS[provider.type as keyof typeof MODEL_PROVIDER_DEFAULT_BASE_URLS] ??
        null;
      if (!baseUrl) throw new Error(`provider_no_base_url:${provider.type}`);
      if (!provider.credentialSecretName) throw new Error(`provider_no_key:${provider.id}`);
      const secretRow = await secrets.getByName(companyId, provider.credentialSecretName);
      const apiKey = secretRow ? await secrets.resolveSecretValue(companyId, secretRow.id, "latest") : null;
      if (!apiKey) throw new Error(`provider_key_unreadable:${provider.id}`);

      const response = await fetch(chatCompletionsUrl(baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: input.model, temperature: 0, messages: input.messages }),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (!response.ok) throw new Error(`provider_http_${response.status}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = readChatText(payload.choices?.[0]?.message?.content);
      if (content.trim().length === 0) throw new Error("provider_empty_answer");
      return {
        content,
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      };
    },
    // The price catalog ships with the litellm-costs module of part B; part A
    // records "unknown price" as 0 and reports the tokens (the summary states
    // the tokens, so a zero cost is read as "price unknown", not "free").
    async prices() {
      return { promptPriceUsdPerMillion: null, completionPriceUsdPerMillion: null };
    },
  };
}

/** The summary sink: the issue document `exchange:<roomId>`. */
export function createAgentExchangeSummarySink(db: Db): AgentExchangeSummarySink {
  const documents = documentService(db);
  return {
    async putSummary(input) {
      const key = `exchange:${input.roomId}`;
      await documents.upsertIssueDocument({
        issueId: input.issueId,
        key,
        title: input.title,
        format: "markdown",
        body: input.body,
        changeSummary: input.changeSummary,
      });
      return key;
    },
  };
}

export function myrmidonAgentExchangeRoutes(db: Db): Router {
  return agentExchangeRoutes({
    db,
    store: agentExchangeStore(db),
    engineDeps: (companyId, resolved) => ({
      store: agentExchangeStore(db),
      models: createAgentExchangeModelPort(db, companyId),
      summaries: createAgentExchangeSummarySink(db),
      settings: resolved.settings,
    }),
    updateSettings: async (patch) => {
      const svc = instanceSettingsService(db);
      // The stored blob is the full settings object (or absent); the PATCH
      // body is partial, so the merge fills the untouched keys from the
      // stored value or the defaults.
      const stored = (await svc.getGeneral()).agentExchange;
      const base = stored ?? { ...DEFAULT_AGENT_EXCHANGE_SETTINGS };
      const merged = { ...base, ...patch };
      await svc.updateGeneral({ agentExchange: merged });
    },
  });
}
