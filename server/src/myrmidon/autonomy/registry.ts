// myrmidon(1.6-AUTONOMY): the registry of action execution points.
//
// One readable answer to "where is this action class enforced?". Every entry
// names a real seam in this tree, and registry.myrmidon.test.ts reads that seam
// back out of the source, so the registry cannot drift into a wish list: delete
// the gate call from a connected route and the test goes red.
//
// A class the matrix already defines but no seam enforces here is listed in
// PENDING_ENFORCEMENT with its reason, never in the registry — the registry
// holds only points that exist on this tree.

import type { AutonomyActionClass } from "@paperclipai/shared";

/**
 * Classes the matrix holds but no route seam is expected to enforce:
 * `spend_above_threshold` is the budget seam (1.7), `other` is the catch-all.
 */
export const REGISTRY_EXEMPT_CLASSES: readonly AutonomyActionClass[] = [
  "other",
  "spend_above_threshold",
];

/** The gate function a seam calls for its class. */
export type AutonomyGateCall = "assertAllowed" | "decide";

export interface ActionExecutionPoint {
  actionClass: AutonomyActionClass;
  /** Route or tool, as the guide shows it. */
  location: string;
  description: string;
  /** Repo-relative file that holds the gate call. */
  source: string;
  /** Gate function the seam calls for this class. */
  call: AutonomyGateCall;
}

/**
 * Every place the matrix is enforced on this tree.
 *
 * The test reads `source` and matches `call(req, "<actionClass>")`, so a point
 * stays listed only while its seam keeps calling the gate.
 */
export const ACTION_EXECUTION_REGISTRY: readonly ActionExecutionPoint[] = [
  {
    actionClass: "delete",
    location: "DELETE /api/issues/:id and the five sibling DELETE routes",
    description:
      "Deletes an issue, a comment, an attachment, a work product, a watchdog or an approval",
    source: "server/src/routes/issues.ts",
    call: "assertAllowed",
  },
  {
    actionClass: "change_instructions",
    location:
      "PATCH /api/agents/:id/instructions-path, PATCH /api/agents/:id/instructions-bundle and DELETE /api/agents/:id/instructions-bundle/file",
    description: "Changes an agent's instructions path or bundle",
    source: "server/src/routes/agents.ts",
    call: "decide",
  },
  {
    actionClass: "change_instructions",
    location: "POST /api/agents/:id/instructions-revisions/:revisionId/rollback",
    description: "Rolls an agent's instructions back to a stored revision",
    source: "server/src/myrmidon/agent-instructions-revisions/index.ts",
    call: "decide",
  },
];

/**
 * Classes the matrix defines but this tree does not enforce yet, each with the
 * reason. The test fails when a class is neither enforced nor listed here, and
 * when a listed class gains a seam without moving into the registry.
 */
export const PENDING_ENFORCEMENT: Partial<Record<AutonomyActionClass, string>> = {
  pause_wake_agents:
    "Pause, resume and wake are not gated on this tree; the pause/wake seam ships on its own autonomy branch and moves here when it merges.",
  merge:
    "No route consults the merge verdict yet; the tool-gateway held-action path is the documented follow-up.",
  deploy: "No route consults the deploy verdict yet.",
  external_message: "No route consults the external-message verdict yet.",
};

/** Every execution point registered for one class. */
export function getExecutionPointsForAction(
  actionClass: AutonomyActionClass,
): ActionExecutionPoint[] {
  return ACTION_EXECUTION_REGISTRY.filter((point) => point.actionClass === actionClass);
}

/** The distinct action classes the registry enforces. */
export function getAllActionClassesWithExecutionPoints(): AutonomyActionClass[] {
  return [...new Set(ACTION_EXECUTION_REGISTRY.map((point) => point.actionClass))];
}