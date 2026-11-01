// myrmidon(1.7 KNOWLEDGE-2.0 L-13): public surface for the git record.

export {
  SKILL_GIT_ENABLED_ENV,
  SKILL_GIT_PUSH_ENV,
  SKILL_GIT_REPOSITORY_ENV,
  SKILL_GIT_WEBHOOK_SECRET_ENV,
  assertSkillGitEntry,
  normalizeSkillFilePath,
  skillContentHash,
  skillGitDriftReason,
  skillGitEnabled,
  skillGitRelativePath,
} from "./domain.js";
export type { GitSkillEntry, GitSkillFile } from "./domain.js";
export { configuredGitSkillRecord, createGitSkillRecordPort } from "./port.js";
export { skillGitRecordRoutes } from "./routes.js";
