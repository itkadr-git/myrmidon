// packages/shared/src/myrmidon-tool-complaints.ts
//
// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228/OPE-12229): the shared contract of the
// agent tool-complaint channel. An agent (bearer agent API key) files a
// complaint about a tool; the board lists the per-company feed with
// lifecycle statuses and triage actions. Company-scoped: complaints never cross companies.

import { z } from "zod";

/** The severity of a tool complaint. */
export const TOOL_COMPLAINT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ToolComplaintSeverity = (typeof TOOL_COMPLAINT_SEVERITIES)[number];

/** The lifecycle status of a tool complaint. */
export const TOOL_COMPLAINT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type ToolComplaintStatus = (typeof TOOL_COMPLAINT_STATUSES)[number];

/** Maximum lengths of the complaint text fields. */
export const TOOL_COMPLAINT_TOOL_MAX_CHARS = 200;
export const TOOL_COMPLAINT_ISSUE_MAX_CHARS = 4000;

/**
 * POST /api/myrmidon/tool-complaints — an agent files a complaint about a
 * tool. `runId` is optional context (the heartbeat run the complaint was
 * filed from).
 */
export const toolComplaintCreateSchema = z
  .object({
    tool: z.string().trim().min(1).max(TOOL_COMPLAINT_TOOL_MAX_CHARS),
    issue: z.string().trim().min(1).max(TOOL_COMPLAINT_ISSUE_MAX_CHARS),
    severity: z.enum(TOOL_COMPLAINT_SEVERITIES),
    runId: z.string().uuid().optional(),
  })
  .strict();
export type ToolComplaintCreate = z.infer<typeof toolComplaintCreateSchema>;

/**
 * PATCH /api/myrmidon/tool-complaints/:id — update complaint status or disable tool.
 */
export const toolComplaintUpdateSchema = z
  .object({
    status: z.enum(TOOL_COMPLAINT_STATUSES).optional(),
    disableTool: z.boolean().optional(),
  })
  .strict();
export type ToolComplaintUpdate = z.infer<typeof toolComplaintUpdateSchema>;

/** The API shape of one tool complaint returned by GET. */
export interface ToolComplaint {
  id: string;
  companyId: string;
  agentId: string;
  tool: string;
  issue: string;
  severity: ToolComplaintSeverity;
  runId: string | null;
  status: ToolComplaintStatus;
  createdAt: string;
  updatedAt: string;
}

/** Threshold warning for a tool with N open complaints. */
export interface ToolComplaintThresholdWarning {
  tool: string;
  openCount: number;
  threshold: number;
  warning: boolean;
}

export interface ToolComplaintsFeedResponse {
  complaints: ToolComplaint[];
  thresholdWarnings: ToolComplaintThresholdWarning[];
}

/** The activity-log action stamped when an agent files a complaint. */
export const TOOL_COMPLAINT_CREATED_ACTION = "tool_complaint.created";
export const TOOL_COMPLAINT_UPDATED_ACTION = "tool_complaint.updated";
export const TOOL_COMPLAINT_TOOL_DISABLED_ACTION = "tool_complaint.tool_disabled";
