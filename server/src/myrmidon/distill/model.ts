// server/src/myrmidon/distill/model.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the free-model call of the distiller.
// The transport is the same OpenAI-compatible chat-completions shape the
// debate gateway uses (server/src/myrmidon/debates/gateway.ts) but owned by
// this module so the pass works without the debates plugin. The call is a
// port: the pass never imports HTTP — tests inject a fake, the startup wires
// the real gateway. Token usage is returned with the answer; budgets are
// signals carried by the caller.

import type { DistillClass } from "./domain.js";

export interface DistillModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DistillModelAnswer {
  text: string;
  usage: DistillModelUsage;
}

/** One model call: system + user, returns text + usage. */
export type DistillModelCall = (systemPrompt: string, userPrompt: string) => Promise<DistillModelAnswer>;

/** A very rough token estimate (chars/4) — used only when the gateway omits usage. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface DistillGatewayDeps {
  fetch: typeof globalThis.fetch;
  apiKey: string;
  /** Base URL of the free-model gateway, e.g. https://gateway/v1 */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

/** The gateway call behind the `DistillModelCall` port. Never logs the key or bodies. */
export function createDistillGatewayCall(deps: DistillGatewayDeps): DistillModelCall {
  const url = chatCompletionsUrl(deps.baseUrl);
  const timeoutMs = deps.timeoutMs ?? 25 * 60 * 1000; // below the 30-min pass budget
  return async (systemPrompt, userPrompt) => {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({
          model: deps.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`the distill gateway call failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new Error(`the distill gateway answered ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("the distill gateway returned no text");
    }
    const rawPrompt = body.usage?.prompt_tokens;
    const rawCompletion = body.usage?.completion_tokens;
    const inputTokens =
      typeof rawPrompt === "number" && Number.isFinite(rawPrompt) && rawPrompt >= 0
        ? rawPrompt
        : estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    const outputTokens =
      typeof rawCompletion === "number" && Number.isFinite(rawCompletion) && rawCompletion >= 0
        ? rawCompletion
        : estimateTokens(content);
    return { text: content, usage: { inputTokens, outputTokens } };
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/** Parsed proposal item from one model answer. */
export interface DistillModelProposal {
  class: DistillClass;
  body: string;
  rationale: string | null;
  section: string;
  slug: string | null;
  /** Task identifiers cited as evidence (must exist in the window material). */
  evidence: string[];
}

export const DISTILL_SYSTEM_PROMPT = [
  "You are the colony's knowledge distiller.",
  "You receive tasks closed in the last period (title, description, final comments, documents).",
  "Produce KNOWLEDGE PROPOSALS, not pages. A proposal is one claim with 1-10 citing tasks as evidence.",
  "Never write one line per task; merge the tasks that prove the same claim.",
  "Classify every proposal: architecture_change | decision | runbook_step | release_note |",
  "glossary_term | regulation_candidate (a rule repeated in >= 2 cases or said by the owner) |",
  "skill_candidate | noise.",
  "Mark as noise everything that is routine bookkeeping, status chatter, or duplicates of known text.",
  "Proposals about the `life` private contour (projects named with a life segment) are forbidden for",
  "common sections; drop them as noise instead of proposing.",
  'Answer ONLY a JSON array: [{"class":"...","body":"...","rationale":"...",',
  '"section":"glossary|releases|how-made|general","slug":"existing-slug-or-null",',
  '"evidence":["OPE-123", ...]}]. Max 15 entries.',
].join("\n");

export function buildDistillUserPrompt(tasks: Array<{ identifier: string; title: string; description: string | null; finalComments: string[]; documents: Array<{ key: string; title: string | null }> ; projectName: string | null }>): string {
  const lines: string[] = ["Closed tasks:", ""];
  for (const task of tasks) {
    lines.push(`## ${task.identifier} — ${task.title}${task.projectName ? ` [project: ${task.projectName}]` : ""}`);
    if (task.description) lines.push(task.description);
    for (const comment of task.finalComments) lines.push(`> ${comment}`);
    if (task.documents.length) lines.push(`docs: ${task.documents.map((d) => d.key).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Parse the model answer; malformed entries are dropped silently (they are noise by definition). */
export function parseDistillAnswer(text: string): DistillModelProposal[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DistillModelProposal[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.body !== "string" || !item.body.trim()) continue;
    if (typeof item.class !== "string") continue;
    if (!Array.isArray(item.evidence)) continue;
    out.push({
      class: item.class as DistillClass,
      // Suggestion bodies are single-line (the store asserts it); newlines collapse.
      body: item.body.replace(/\s*\n\s*/g, " ").trim(),
      rationale: typeof item.rationale === "string" ? item.rationale.replace(/\s*\n\s*/g, " ").trim() : null,
      section: typeof item.section === "string" ? item.section : "general",
      slug: typeof item.slug === "string" && item.slug ? item.slug : null,
      evidence: item.evidence.filter((e): e is string => typeof e === "string"),
    });
  }
  return out;
}
