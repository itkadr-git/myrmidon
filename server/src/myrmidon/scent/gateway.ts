// server/src/myrmidon/scent/gateway.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the ONE structured LiteLLM call of the
// classifier (design §2.4, §7.1 п.4a). A task (or an agent's capabilities
// text) goes in, a validated scent comes out — no retries, no fallbacks:
// the markup queue retries within its hour budget, and every caller treats a
// failure as a null scent.
//
// Strict JSON-schema response (additionalProperties:false on every object —
// providers reject `strict:true` schemas without it). The company caste
// directory is embedded in the prompt and the reply is validated against it
// key-wise: an unknown caste key is dropped, so a hallucinated caste can
// never land in `issues.scent` (design §9).

import type { IssueScent } from "@paperclipai/shared";
import { ISSUE_SCENT_MAX_TAGS, issueScentSchema } from "@paperclipai/shared";

export interface ScentGatewayDeps {
  fetch: typeof fetch;
  /** The resolved gateway key (the wiring reads the company secret). */
  apiKey: string;
  baseUrl: string;
}

export interface ClassifyIssueScentInput {
  model: string;
  casteKeys: string[];
  title: string;
  description: string | null;
  timeoutSec: number;
}

export interface ClassifyAgentScentInput {
  model: string;
  capabilities: string;
  timeoutSec: number;
}

export interface ScentClassificationResult {
  scent: IssueScent | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentScentClassificationResult {
  tags: string[];
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

// Strict structured outputs accept a closed subset of JSON schema: every
// object lists all its properties as `required` with `additionalProperties:
// false`, and range keywords (min/max, maxItems) are not part of the subset.
// So the caste map is spelled out per key of THIS company's directory (an
// open `additionalProperties: {type: number}` map is rejected by strict
// providers with a 400), and the 0..1 range and the tag cap are enforced
// after the call — `parseIssueScentContent` clamps and slices.
export function issueScentResponseFormat(casteKeys: readonly string[]) {
  return {
    type: "json_schema",
    json_schema: {
      name: "issue_scent",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["tags", "casteProbs", "complexity"],
        properties: {
          tags: { type: "array", items: { type: "string" } },
          casteProbs: {
            type: "object",
            additionalProperties: false,
            required: [...casteKeys],
            properties: Object.fromEntries(casteKeys.map((key) => [key, { type: "number" }])),
          },
          complexity: {
            type: "object",
            additionalProperties: false,
            required: ["coordination", "uncertainty", "consequences"],
            properties: {
              coordination: { type: "number" },
              uncertainty: { type: "number" },
              consequences: { type: "number" },
            },
          },
        },
      },
    },
  } as const;
}

const AGENT_SCENT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "agent_scent",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["tags"],
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

async function callChatCompletions(
  deps: ScentGatewayDeps,
  args: { model: string; system: string; user: string; timeoutSec: number; responseFormat: unknown },
): Promise<{ content: string; inputTokens: number | null; outputTokens: number | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  try {
    const response = await deps.fetch(`${deps.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The gateway key comes from the caller (company secret or test double),
        // never from process.env in this module.
        ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        response_format: args.responseFormat,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return null;
    return {
      content,
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    };
  } catch {
    // Timeout, DNS, a truncated body — all fold into "no classification";
    // the queue retries within its hour budget.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clamp01(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export function parseIssueScentContent(content: string, casteKeys: string[]): IssueScent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawComplexity = obj.complexity as Record<string, unknown> | null | undefined;
  if (!Array.isArray(obj.tags) || !obj.casteProbs || typeof obj.casteProbs !== "object") return null;
  if (!rawComplexity || typeof rawComplexity !== "object") return null;
  // The strict response schema carries no ranges (see issueScentResponseFormat),
  // so out-of-range numbers are clamped here rather than failing the whole reply.
  const coordination = clamp01(rawComplexity.coordination);
  const uncertainty = clamp01(rawComplexity.uncertainty);
  const consequences = clamp01(rawComplexity.consequences);
  if (coordination === null || uncertainty === null || consequences === null) return null;
  const allowed = new Set(casteKeys);
  const casteProbs: Record<string, number> = {};
  for (const [key, raw] of Object.entries(obj.casteProbs as Record<string, unknown>)) {
    const p = clamp01(raw);
    if (p !== null && allowed.has(key)) casteProbs[key] = p;
  }
  const tags = obj.tags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .slice(0, ISSUE_SCENT_MAX_TAGS);
  const scent = { tags, casteProbs, complexity: { coordination, uncertainty, consequences } };
  return issueScentSchema.safeParse(scent).success ? scent : null;
}

export function parseAgentScentContent(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const rawTags = (parsed as Record<string, unknown>).tags;
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .slice(0, ISSUE_SCENT_MAX_TAGS);
}

const ISSUE_SYSTEM_PROMPT = [
  "You classify one work task for a swarm of AI agents. Answer with JSON only.",
  "casteProbs: a probability per caste key from the provided company directory (0..1, they need not sum to 1).",
  "tags: up to 8 short lowercase topic tags (frontend, sql, tests, devops, ...).",
  "complexity: three probabilities (Jev's questions) — coordination (needs several agents), uncertainty (the goal or the path is unclear), consequences (a mistake is expensive).",
].join(" ");

const AGENT_SYSTEM_PROMPT = [
  "You distill an AI agent's role description into short lowercase topic tags (up to 8).",
  "Answer with JSON only: {\"tags\": [...]}.",
].join(" ");

export interface ScentGateway {
  classifyIssueScent(input: ClassifyIssueScentInput): Promise<ScentClassificationResult>;
  classifyAgentScent(input: ClassifyAgentScentInput): Promise<AgentScentClassificationResult>;
}

export async function classifyIssueScent(
  deps: ScentGatewayDeps,
  input: ClassifyIssueScentInput,
): Promise<ScentClassificationResult> {
  const user = [
    `Company caste directory: ${input.casteKeys.join(", ") || "(empty)"}`,
    "",
    `Task title: ${input.title}`,
    input.description ? `Task description:\n${input.description}` : "Task description: (none)",
  ].join("\n");
  const result = await callChatCompletions(deps, {
    model: input.model,
    system: ISSUE_SYSTEM_PROMPT,
    user,
    timeoutSec: input.timeoutSec,
    responseFormat: issueScentResponseFormat(input.casteKeys),
  });
  if (!result) {
    return { scent: null, model: input.model, inputTokens: null, outputTokens: null };
  }
  return {
    scent: parseIssueScentContent(result.content, input.casteKeys),
    model: input.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

export async function classifyAgentScent(
  deps: ScentGatewayDeps,
  input: ClassifyAgentScentInput,
): Promise<AgentScentClassificationResult> {
  const result = await callChatCompletions(deps, {
    model: input.model,
    system: AGENT_SYSTEM_PROMPT,
    user: `Agent role description:\n${input.capabilities}`,
    timeoutSec: input.timeoutSec,
    responseFormat: AGENT_SCENT_RESPONSE_FORMAT,
  });
  if (!result) {
    return { tags: [], model: input.model, inputTokens: null, outputTokens: null };
  }
  return {
    tags: parseAgentScentContent(result.content),
    model: input.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
