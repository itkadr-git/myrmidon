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
