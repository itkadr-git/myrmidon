// ui/src/ui2/screens/knowledge/regulationsModel.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the pure view model behind the ui2
// "Regulations" screen (Знания → Регламенты в Автономии).
//
// The regulations themselves are owned by the autonomy module
// (`GET /api/myrmidon/autonomy` → `regulations[]`); this screen only groups
// them BY CASTE, names WHO HAS TO APPROVE each one (`approver_kind` — the
// field the knowledge facade adds in K-3) and derives the buttons from that
// kind. A `draft` needs its approver's agreement: when the approver is a
// person, the button is live for the human reading the screen; when the
// approver is the agent itself, the human can only ask for the approval
// (never approve on the agent's behalf). Everything is data-in → data-out and
// pinned by unit tests.

import type { KnowledgeApproverKind } from "./knowledgeModel";

export type RegulationApproverKind = KnowledgeApproverKind;

/** The `approver_kind` vocabulary of the epic, plus the tolerated spellings. */
export const REGULATION_APPROVER_KINDS: readonly RegulationApproverKind[] = [
  "agent",
  "operator",
  "owner",
];

/** The subset of the autonomy regulation DTO this screen renders. */
export interface RegulationLike {
  id: string;
  role: string;
  title: string;
  status: string;
  revision: number;
  bodyMarkdown?: string;
  supersededBy?: string | null;
  wikiPageId?: string | null;
  reviewDueAt?: string | null;
  /** `approver_kind` (K-3 facade) or its camelCase twin; unknown values fall back. */
  approverKind?: unknown;
  approver_kind?: unknown;
  revisions?: Array<{ revision: number; title?: string; at?: string; by?: string }>;
}

/** A regulation plus the approver kind resolved for display. */
export interface RegulationRow {
  regulation: RegulationLike;
  approverKind: RegulationApproverKind;
}

/** One caste section of the list. */
export interface RegulationCasteGroup {
  role: string;
  label: string;
  rows: RegulationRow[];
  /** Drafts first inside the group — they are the ones waiting on a person. */
  pendingApprovals: number;
}

export function normalizeRegulationApproverKind(value: unknown): RegulationApproverKind {
  if (typeof value !== "string") return "operator";
  switch (value.trim().toLowerCase()) {
    case "a":
    case "agent":
      return "agent";
    case "o":
    case "operator":
      return "operator";
    case "owner":
    case "board":
    case "human":
      return "owner";
    default:
      return "operator";
  }
}

/** Read `approver_kind` off a regulation, tolerating both spellings. */
export function readRegulationApproverKind(regulation: RegulationLike): RegulationApproverKind {
  const raw = regulation.approverKind ?? regulation.approver_kind;
  return normalizeRegulationApproverKind(raw);
}

/**
 * Group the list by caste (role). Order inside a group: drafts first (they wait
 * on an approver), then approved, then superseded; alphabetical inside a tier.
 * Groups sort by their label.
 */
export function groupRegulationsByCaste(
  regulations: readonly RegulationLike[],
  labels: Record<string, string> = {},
): RegulationCasteGroup[] {
  const groups = new Map<string, RegulationCasteGroup>();
  const tier = (status: string): number => {
    switch ((status ?? "").toLowerCase()) {
      case "draft":
        return 0;
      case "approved":
        return 1;
      default:
        return 2;
    }
  };
  for (const regulation of regulations) {
    const role = regulation.role ?? "";
    let group = groups.get(role);
    if (!group) {
      group = { role, label: labels[role] ?? role, rows: [], pendingApprovals: 0 };
      groups.set(role, group);
    }
    group.rows.push({ regulation, approverKind: readRegulationApproverKind(regulation) });
    if (tier(regulation.status) === 0) group.pendingApprovals += 1;
  }
  for (const group of groups.values()) {
    group.rows.sort(
      (left, right) =>
        tier(left.regulation.status) - tier(right.regulation.status) ||
        left.regulation.title.localeCompare(right.regulation.title, "ru") ||
        right.regulation.revision - left.regulation.revision,
    );
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

export function regulationStatusTone(status: string): "ok" | "warning" | "muted" {
  switch ((status ?? "").toLowerCase()) {
    case "approved":
      return "ok";
    case "draft":
    case "in_review":
      return "warning";
    default:
      return "muted";
  }
}

/** Catalog key for "who has to approve this". */
export function regulationApproverLabelKey(kind: RegulationApproverKind): string {
  switch (kind) {
    case "agent":
      return "ui2.regulations.approver.agent";
    case "operator":
      return "ui2.regulations.approver.operator";
    case "owner":
      return "ui2.regulations.approver.owner";
  }
}

/** Who is looking at the screen. The K-4 screen is the human (board) surface. */
export type RegulationActor = "human" | "agent";

export type RegulationActionKey = "approve" | "requestApproval" | "rollback" | "openInKnowledge";

export interface RegulationAction {
  key: RegulationActionKey;
  enabled: boolean;
  approverKind: RegulationApproverKind;
  /** Catalog key under `ui2.regulations.action.*` explaining the state. */
  reasonKey: string;
}

/** A person may approve a regulation the operator/owner carries — never the agent's. */
export function canActorApprove(kind: RegulationApproverKind, actor: RegulationActor): boolean {
  if (actor === "agent") return kind === "agent";
  return kind === "operator" || kind === "owner";
}

/** The revision a rollback would restore (the previous one), or null. */
export function regulationRollbackRevision(regulation: RegulationLike): number | null {
  const revision = regulation.revision;
  if (!Number.isInteger(revision) || revision <= 1) return null;
  return revision - 1;
}

/** Company-relative knowledge page of a regulation, when the wiki pointer exists. */
export function regulationKnowledgeLink(wikiPageId: string | null | undefined): string | null {
  const ref = (wikiPageId ?? "").trim();
  if (!ref) return null;
  return ref.startsWith("/") ? ref : `/knowledge/${ref}`;
}

/**
 * The buttons of one regulation row, derived purely from its status, revision
 * and `approver_kind` — this is the K-4 acceptance point "кнопки по
 * approver_kind".
 */
export function regulationActions(
  regulation: RegulationLike,
  actor: RegulationActor = "human",
): RegulationAction[] {
  const approverKind = readRegulationApproverKind(regulation);
  const status = (regulation.status ?? "").toLowerCase();
  const actions: RegulationAction[] = [];

  if (status === "draft") {
    if (canActorApprove(approverKind, actor)) {
      actions.push({
        key: "approve",
        enabled: true,
        approverKind,
        reasonKey: "ui2.regulations.action.approve",
      });
    } else {
      actions.push({
        key: "requestApproval",
        enabled: true,
        approverKind,
        reasonKey: "ui2.regulations.action.requestApproval",
      });
    }
  }

  if (regulationRollbackRevision(regulation) !== null && !regulation.supersededBy) {
    actions.push({
      key: "rollback",
      enabled: canActorApprove(approverKind, actor),
      approverKind,
      reasonKey: canActorApprove(approverKind, actor)
        ? "ui2.regulations.action.rollback"
        : "ui2.regulations.action.rollbackNeedsApproval",
    });
  }

  if (regulationKnowledgeLink(regulation.wikiPageId)) {
    actions.push({
      key: "openInKnowledge",
      enabled: true,
      approverKind,
      reasonKey: "ui2.regulations.action.openInKnowledge",
    });
  }

  return actions;
}

/** Drafts across every caste — the screen header counter. */
export function countPendingRegulations(regulations: readonly RegulationLike[]): number {
  return regulations.filter((regulation) => (regulation.status ?? "").toLowerCase() === "draft")
    .length;
}