import { z } from "zod";

export interface BlockerDashboardPanel {
  id: "blocked_age" | "root_fanout" | "missing_fields" | "terminal";
  title: string;
  query: string;
  unit: "seconds" | "issues";
  threshold?: number;
  rootLink?: (root: string) => string;
}

export const BLOCKER_ROOT_FANOUT_LIMIT = 20;

export const BLOCKER_DASHBOARD_PANELS: readonly BlockerDashboardPanel[] = [
  { id: "blocked_age", title: "Blocked age", query: "blocked_age_seconds", unit: "seconds" },
  {
    id: "root_fanout",
    title: "Blocked dependents per terminal root (alert above 20)",
    query: "blocker_root_fanout",
    unit: "issues",
    threshold: BLOCKER_ROOT_FANOUT_LIMIT,
    rootLink: (root) => `/issues/${encodeURIComponent(root)}`,
  },
  { id: "missing_fields", title: "Missing blocker fields", query: "blocked_missing_fields_total", unit: "issues" },
  { id: "terminal", title: "Terminal roots holding blocked issues", query: "blocker_terminal_count", unit: "issues" },
] as const;

export interface BlockerRootFanout {
  rootIssueId: string;
  rootIdentifier: string;
  rootStatus: string;
  dependentCount: number;
  dependents: string[];
  oldestBlockedAt: string | null;
  hasMissingFields: boolean;
}

export interface BlockerGraphRootsResponse {
  roots: BlockerRootFanout[];
  limit: number;
  generatedAt: string;
}

export interface BlockerGraphMetrics {
  rootCount: number;
  dependentCount: number;
  rootsWithMissingFields: number;
}

export const DEFAULT_ROOT_FANOUT_LIMIT = 100;

export const blockerRootFanoutSchema = z.object({
  rootIssueId: z.string().min(1),
  rootIdentifier: z.string().min(1),
  rootStatus: z.string().min(1),
  dependentCount: z.number().int().nonnegative(),
  dependents: z.array(z.string().min(1)),
  oldestBlockedAt: z.string().datetime().nullable(),
  hasMissingFields: z.boolean(),
});

export const blockerGraphRootsResponseSchema = z.object({
  roots: z.array(blockerRootFanoutSchema),
  limit: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});
