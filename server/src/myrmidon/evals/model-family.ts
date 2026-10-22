// server/src/myrmidon/evals/model-family.ts
//
// myrmidon(1.6.5-EVALS-JUDGE-FAMILY): model-family detection and the judge
// candidate order.
//
// Agents in this fleet mostly run DashScope models (family `qwen`), and the
// judge's configured model is a qwen too — so the judge often scores "its
// own". This module maps a model id to its family (one extensible table) and
// orders the judge candidates so a different-family model judges first. When
// no cross-family candidate exists the run is still scored, but the result
// carries `sameFamily: true` so the board badge and the log can see the
// collision. A gateway error for one candidate falls through to the next one
// instead of aborting the run — see `createJudge` in `judge.ts`.

/** A family rule: a substring, or a token-anchored pattern for collision-prone names. */
type FamilyRule = readonly [string | RegExp, string];

/**
 * Extensible family table: a model id belongs to the family of the first
 * entry that matches the lower-cased id. Add new families by adding entries
 * above the fallback; order matters (more specific first).
 *
 * Short or collision-prone names use token-anchored regexes instead of bare
 * substrings: `o1`/`o3` must be whole tokens (`openai/o1`, `o3-mini`), not
 * letters inside a longer word; `yi` and `phi` likewise — a bare `phi` used
 * to match `dolphin` and a bare `yi` matched any id merely containing those
 * two letters in sequence.
 */
const MODEL_FAMILY_RULES: ReadonlyArray<FamilyRule> = [
  ["qwen", "qwen"],
  ["dashscope", "qwen"],
  ["gpt", "gpt"],
  [/(?:^|[/._-])o[134](?:[/._-]|$)/, "gpt"],
  ["openai", "gpt"],
  ["claude", "claude"],
  ["anthropic", "claude"],
  ["glm", "glm"],
  ["zhipu", "glm"],
  ["deepseek", "deepseek"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["gemini", "gemini"],
  ["llama", "llama"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  [/(?:^|[/._-])yi(?:[/._-]|$)/, "yi"],
  ["doubao", "doubao"],
  ["ernie", "ernie"],
  [/(?:^|[/._-])phi[3-9]?(?:[/._-]|$)/, "phi"],
  ["command-r", "command"],
];

function ruleMatches(needle: string | RegExp, normalizedId: string): boolean {
  return typeof needle === "string" ? normalizedId.includes(needle) : needle.test(normalizedId);
}

/** Family of a model id, or "unknown" when no rule matches. */
export function getModelFamily(modelId: string): string {
  const normalized = modelId.toLowerCase();
  for (const [needle, family] of MODEL_FAMILY_RULES) {
    if (ruleMatches(needle, normalized)) return family;
  }
  return "unknown";
}

/**
 * The free DashScope models this deployment's gateway serves, per the
 * operator's model listing (OPE-5450 review): the ids carry the `-free`
 * suffix, match the qwen family and are referenced by the evals contour
 * itself (`MYRMIDON_EVALS_MODEL` defaults to the head). The built-in judge
 * priority list may only name ids from this list — an id that is not here is
 * unverified and must not be a default; paid or third-family models judge
 * only when the operator lists them in `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS`.
 */
export const SERVED_FREE_GATEWAY_MODELS: readonly string[] = [
  "qwen-plus-free",
  "qwen-max-free",
  "qwen-turbo-free",
];

/**
 * Built-in judge priority list (head = top priority): only gateway-served
 * free models. With a Qwen agent every entry shares its family — the run is
 * still scored and flagged `sameFamily` until the operator lists a
 * cross-family judge.
 */
export const DEFAULT_JUDGE_PRIORITY_MODELS: readonly string[] = [...SERVED_FREE_GATEWAY_MODELS];

/** Whether a judge model shares the agent model's family (false without an agent model). */
export function isSameJudgeFamily(judgeModel: string, agentModel: string | undefined): boolean {
  if (!agentModel) return false;
  return getModelFamily(judgeModel) === getModelFamily(agentModel);
}

/**
 * Order judge candidates for one agent model: entries from a family other
 * than the agent's first (in priority order), then same-family entries, then
 * the configured fallback model (deduped). Without an agent model there is
 * nothing to differ from: judge with the configured model only — the
 * pre-1.6.3 behavior, so an unset run is never re-routed through other
 * candidates.
 */
export function judgeCandidateOrder(
  agentModel: string | undefined,
  candidates: readonly string[],
  fallbackModel: string,
): string[] {
  if (!agentModel) return [fallbackModel];
  const agentFamily = getModelFamily(agentModel);
  const cross = candidates.filter((m) => getModelFamily(m) !== agentFamily);
  const same = candidates.filter((m) => getModelFamily(m) === agentFamily);
  const ordered = [...cross, ...same];
  if (!ordered.includes(fallbackModel)) ordered.push(fallbackModel);
  return ordered;
}
