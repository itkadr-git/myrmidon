import type { IssueExecutionPolicy } from "./issue.js";

export interface ProjectDevelopmentProcess {
  enabled: boolean;
  executionPolicy: IssueExecutionPolicy;
  pipelineId?: string | null;
}
