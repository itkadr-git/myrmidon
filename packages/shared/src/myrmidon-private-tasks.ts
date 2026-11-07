import { z } from "zod";

// 1.7 (PRIVATE-TASKS): the issue privacy flag. Only board actors can set or
// change it; agent API keys receive 403. Full ACL/sharing lands in 1.8.

export const issuePrivacyFlagSchema = z.boolean();

export const issuePrivacyWriteContract = {
  field: "isPrivate",
  actorAllowed: "board",
  agentError: "issue_write_private_flag_rejected",
} as const;

export type IssuePrivacyWriteContract =
  typeof issuePrivacyWriteContract;
