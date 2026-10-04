// server/src/myrmidon/evals/judge-priority.ts
//
// Handle priority ordering for eval judges.

/** List of available judge models with their priority order */
export interface JudgePriorityConfig {
  /** Ordered list of judge models to try, in priority order */
  judgeModels: string[];
}

/** Get the primary judge model based on priority configuration */
export function getPrimaryJudgeModel(config: JudgePriorityConfig): string {
  return config.judgeModels[0] || "qwen-plus-free"; // fallback to default
}

/** Get all judge models in priority order */
export function getAllJudgeModels(config: JudgePriorityConfig): string[] {
  return config.judgeModels.length > 0 ? config.judgeModels : ["qwen-plus-free"];
}