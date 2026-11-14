import { requiresEngineer } from "../swarm-claim/requires-engineer.js";

export function hasLargeSizeLabel(labels: readonly string[] | null | undefined): boolean {
  return (labels ?? []).some((label) => {
    const normalized = label.trim().toLowerCase();
    return normalized === "size:m" || normalized === "size:l";
  });
}

export function isLargeEngineeringTask(input: {
  labels?: readonly string[] | null;
  assigneeAgentRole?: string | null;
  casteKey?: string | null;
}): boolean {
  if (!hasLargeSizeLabel(input.labels)) return false;
  return input.assigneeAgentRole?.trim().toLowerCase() === "engineer" ||
    requiresEngineer({ labels: input.labels, casteKey: input.casteKey });
}
