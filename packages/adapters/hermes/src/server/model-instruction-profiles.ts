/**
 * Model-specific instruction profiles for Hermes Agent runtime (1.6.6 DEVEFF / OPE-10097).
 *
 * Provides specialized behavioral directives tailored to LLM families
 * (GLM, GPT, Claude, and Fallback) to prevent common failure modes:
 *  - GLM: JSON formatting errors, hallucinated tool outputs, infinite loops on patch failures.
 *  - GPT: Excessive multi-turn planning without tool execution, token-heavy argument echoes.
 *  - Claude: Diff fidelity, patch context anchoring, scratchpad discipline.
 *  - Fallback: Core engineering hygiene, absolute paths, verify before edit, and stop conditions.
 */

export type ModelFamily = "glm" | "gpt" | "claude" | "fallback";

export interface ModelInstructionProfile {
  family: ModelFamily;
  name: string;
  description: string;
  directives: string[];
}

/**
 * Common baseline directives applicable to all models or when model family is unknown.
 */
export const COMMON_FALLBACK_DIRECTIVES: readonly string[] = [
  "Operational hygiene: Always construct and use absolute file paths for file operations.",
  "Verify before modify: Read existing file content and surrounding context before editing; never guess at line contents.",
  "Tool execution priority: Never stop with a plan or summary when actionable tasks remain; execute tools immediately.",
  "Non-interactive CLI: Always supply non-interactive flags (-y, --yes, --non-interactive) to prevent process hangs.",
  "Anti-loop & Stop rule: Never repeat an identical failing tool call. If a command or patch fails, analyze the error and alter your parameters or strategy immediately.",
  "Mandatory artifact delivery: Conclude heartbeats with concrete deliverables (commit, PR, branch, work product) or a clear blocker.",
];

/**
 * GLM family instruction directives (Zhipu AI / DashScope GLM-4, GLM-5).
 * Addresses JSON parameter escaping, step-by-step tool execution, and error recovery.
 */
export const GLM_DIRECTIVES: readonly string[] = [
  "Strict JSON parameters: Ensure tool arguments are well-formed JSON without unescaped newlines or raw markdown code fences inside argument values.",
  "Tool error recovery: If a patch, read, or shell command fails, read the error message carefully. Do NOT retry the exact same call. Adjust parameters, offsets, or switch from fuzzy patch to full write_file.",
  "Immediate execution: Avoid long introductory commentary before tool calls. Issue the tool call directly, then review the output.",
  "Language & Identifier consistency: Follow bilingual instructions (Russian/English) while strictly keeping code, variable names, git commits, and tool arguments in exact required format.",
];

/**
 * GPT family instruction directives (OpenAI GPT-4o, GPT-5, o1, o3, Copilot).
 * Addresses over-planning, redundant context echoes, and fast self-correction.
 */
export const GPT_DIRECTIVES: readonly string[] = [
  "Direct action over planning: Formulate at most 1-2 sentences of orientation before executing tools. Do not output multi-paragraph plans when tools are available to make progress.",
  "Lean tool payloads: Do not echo large file contents or huge data structures into tool parameters when targeted searches or offsets suffice.",
  "Exit code verification: Inspect command exit codes immediately; stop sequences if a prerequisite command fails.",
];

/**
 * Claude family instruction directives (Anthropic Claude 3.5, 3.7 Sonnet, Opus).
 * Addresses diff context anchoring, scratchpad separation, and sub-agent discipline.
 */
export const CLAUDE_DIRECTIVES: readonly string[] = [
  "Patch context anchoring: Provide 5-8 lines of unique surrounding context for patch operations. If patch reports multiple matches, expand context or read and rewrite the file completely.",
  "Scratchpad discipline: Keep internal reasoning in scratchpad/thinking blocks separate from operator-facing comments and status reports.",
  "Rigorous verification: Run verification commands (build/test/lint checks) and confirm actual tool output before claiming completion.",
];

/**
 * Detect the model family from model name and optional provider hint.
 */
export function detectModelFamily(model?: string, provider?: string): ModelFamily {
  const modelLower = (model ?? "").toLowerCase().trim();
  const providerLower = (provider ?? "").toLowerCase().trim();

  // Strip provider prefixes like "anthropic/claude-sonnet-4" or "dashscope/glm-5.3"
  const bareModel = modelLower.includes("/")
    ? modelLower.split("/").pop()!
    : modelLower;

  // GLM family
  if (
    bareModel.startsWith("glm") ||
    bareModel.includes("chatglm") ||
    providerLower === "zai" ||
    providerLower.includes("dashscope") ||
    providerLower.includes("zhipu")
  ) {
    return "glm";
  }

  // GPT family (OpenAI / Copilot)
  if (
    bareModel.startsWith("gpt") ||
    bareModel.startsWith("o1") ||
    bareModel.startsWith("o3") ||
    bareModel.startsWith("o4") ||
    providerLower === "openai" ||
    providerLower === "copilot"
  ) {
    return "gpt";
  }

  // Claude family (Anthropic)
  if (
    bareModel.startsWith("claude") ||
    bareModel.includes("sonnet") ||
    bareModel.includes("opus") ||
    bareModel.includes("haiku") ||
    providerLower === "anthropic"
  ) {
    return "claude";
  }

  return "fallback";
}

/**
 * Retrieve the complete instruction profile for a model and provider.
 */
export function getModelInstructionProfile(
  model?: string,
  provider?: string,
): ModelInstructionProfile {
  const family = detectModelFamily(model, provider);

  switch (family) {
    case "glm":
      return {
        family: "glm",
        name: "GLM Family Instruction Profile",
        description: "Optimized for Zhipu AI / DashScope GLM models with strict JSON arguments and anti-loop error recovery.",
        directives: [...COMMON_FALLBACK_DIRECTIVES, ...GLM_DIRECTIVES],
      };
    case "gpt":
      return {
        family: "gpt",
        name: "GPT Family Instruction Profile",
        description: "Optimized for OpenAI / Copilot GPT models emphasizing rapid transition to tool action and concise payloads.",
        directives: [...COMMON_FALLBACK_DIRECTIVES, ...GPT_DIRECTIVES],
      };
    case "claude":
      return {
        family: "claude",
        name: "Claude Family Instruction Profile",
        description: "Optimized for Anthropic Claude models with patch context anchoring and scratchpad discipline.",
        directives: [...COMMON_FALLBACK_DIRECTIVES, ...CLAUDE_DIRECTIVES],
      };
    case "fallback":
    default:
      return {
        family: "fallback",
        name: "Common Fallback Instruction Profile",
        description: "Universal engineering instructions enforcing path safety, verification before edits, and stop rules.",
        directives: [...COMMON_FALLBACK_DIRECTIVES],
      };
  }
}

/**
 * Render the model instruction profile as a markdown section for prompt injection.
 */
export function renderModelInstructionSection(
  model?: string,
  provider?: string,
): string {
  const profile = getModelInstructionProfile(model, provider);
  const lines: string[] = [
    `# Model Operational Directives (${profile.name})`,
    `Family: ${profile.family} (model: ${model || "default"})`,
    "",
    ...profile.directives.map((d) => `- ${d}`),
  ];
  return lines.join("\\n");
}
