// ui/src/ui2/screens/knowledge/regulationsModel.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the acceptance criteria of the
// regulations screen — "список по кастам, «кто должен одобрить», кнопки по
// approver_kind". The screen renders whatever this model returns, so the
// approver matrix is pinned here instead of in a browser.

import { describe, expect, it } from "vitest";
import { ui2Messages } from "../../i18n/locales";
import {
  countPendingRegulations,
  groupRegulationsByCaste,
  normalizeRegulationApproverKind,
  readRegulationApproverKind,
  regulationActions,
  regulationApproverLabelKey,
  regulationKnowledgeLink,
  regulationRollbackRevision,
  regulationStatusTone,
  type RegulationLike,
} from "./regulationsModel";

function regulation(overrides: Partial<RegulationLike> = {}): RegulationLike {
  return {
    id: overrides.id ?? "reg-1",
    role: overrides.role ?? "engineer",
    title: overrides.title ?? "Regulation",
    status: overrides.status ?? "approved",
    revision: overrides.revision ?? 1,
    ...overrides,
  };
}

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) approver_kind", () => {
  it("reads the a / o marker in either spelling, falling back to the operator", () => {
    expect(normalizeRegulationApproverKind("A")).toBe("agent");
    expect(normalizeRegulationApproverKind("agent")).toBe("agent");
    expect(normalizeRegulationApproverKind("O")).toBe("operator");
    expect(normalizeRegulationApproverKind("owner")).toBe("owner");
    expect(normalizeRegulationApproverKind("board")).toBe("owner");
    expect(normalizeRegulationApproverKind("")).toBe("operator");
    expect(normalizeRegulationApproverKind(undefined)).toBe("operator");
    expect(normalizeRegulationApproverKind("something-new")).toBe("operator");

    expect(readRegulationApproverKind(regulation({ approverKind: "a" }))).toBe("agent");
    expect(readRegulationApproverKind(regulation({ approver_kind: "owner" }))).toBe("owner");
    // The camelCase twin wins when both are present.
    expect(
      readRegulationApproverKind(regulation({ approverKind: "o", approver_kind: "a" })),
    ).toBe("operator");
  });

  it("names who approves, in both catalogs", () => {
    for (const kind of ["agent", "operator", "owner"] as const) {
      const key = regulationApproverLabelKey(kind);
      expect(ui2Messages.en[key as keyof typeof ui2Messages.en]).toBeTruthy();
      expect(ui2Messages.ru[key as keyof typeof ui2Messages.ru]).toBeTruthy();
    }
    expect(regulationStatusTone("approved")).toBe("ok");
    expect(regulationStatusTone("draft")).toBe("warning");
    expect(regulationStatusTone("superseded")).toBe("muted");
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) castes", () => {
  it("groups by caste, drafts first, and counts the ones waiting on a person", () => {
    const groups = groupRegulationsByCaste(
      [
        regulation({ id: "1", role: "engineer", title: "B approved", status: "approved" }),
        regulation({ id: "2", role: "engineer", title: "A draft", status: "draft" }),
        regulation({ id: "3", role: "engineer", title: "C draft", status: "draft" }),
        regulation({ id: "4", role: "reviewer", title: "R", status: "approved" }),
      ],
      { engineer: "Инженер", reviewer: "Ревьюер" },
    );

    expect(groups.map((group) => group.label)).toEqual(["Инженер", "Ревьюер"]);
    const engineers = groups[0]!;
    expect(engineers.role).toBe("engineer");
    expect(engineers.rows.map((row) => row.regulation.title)).toEqual([
      "A draft",
      "C draft",
      "B approved",
    ]);
    expect(engineers.pendingApprovals).toBe(2);
  });

  it("falls back to the role name when no label is known", () => {
    const groups = groupRegulationsByCaste([regulation({ role: "archivist" })]);
    expect(groups[0]?.label).toBe("archivist");
    expect(countPendingRegulations([
      regulation({ status: "draft" }),
      regulation({ status: "approved" }),
      regulation({ status: "DRAFT" }),
    ])).toBe(2);
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) buttons by approver_kind", () => {
  it("offers a person the approve verb only when a person carries the regulation", () => {
    const operatorDraft = regulationActions(
      regulation({ status: "draft", approver_kind: "o" }),
      "human",
    );
    expect(operatorDraft.map((action) => action.key)).toEqual(["approve"]);
    expect(operatorDraft[0]?.enabled).toBe(true);

    const ownerDraft = regulationActions(
      regulation({ status: "draft", approverKind: "owner" }),
      "human",
    );
    expect(ownerDraft.map((action) => action.key)).toEqual(["approve"]);

    // The agent's own draft is not a human's to approve: the panel asks instead.
    const agentDraft = regulationActions(
      regulation({ status: "draft", approver_kind: "a" }),
      "human",
    );
    expect(agentDraft.map((action) => action.key)).toEqual(["requestApproval"]);
    expect(agentDraft[0]?.reasonKey).toBe("ui2.regulations.action.requestApproval");
  });

  it("gates the rollback verb on the carrier and hides it for a superseded row", () => {
    const carried = regulationActions(
      regulation({ status: "approved", revision: 3, approver_kind: "o", wikiPageId: "wiki/reg" }),
      "human",
    );
    expect(carried.map((action) => action.key)).toEqual(["rollback", "openInKnowledge"]);
    expect(carried[0]?.enabled).toBe(true);
    expect(carried[0]?.reasonKey).toBe("ui2.regulations.action.rollback");

    const agentCarried = regulationActions(
      regulation({ status: "approved", revision: 3, approver_kind: "a" }),
      "human",
    );
    expect(agentCarried[0]?.key).toBe("rollback");
    expect(agentCarried[0]?.enabled).toBe(false);
    expect(agentCarried[0]?.reasonKey).toBe("ui2.regulations.action.rollbackNeedsApproval");

    const superseded = regulationActions(
      regulation({ status: "superseded", revision: 3, supersededBy: "reg-2" }),
      "human",
    );
    expect(superseded.map((action) => action.key)).toEqual([]);

    // A first revision has nothing to roll back to.
    expect(regulationActions(regulation({ revision: 1 }), "human")).toEqual([]);
    expect(regulationRollbackRevision(regulation({ revision: 3 }))).toBe(2);
    expect(regulationRollbackRevision(regulation({ revision: 1 }))).toBeNull();
    expect(regulationRollbackRevision(regulation({ revision: 0 }))).toBeNull();
    expect(regulationRollbackRevision(regulation({ revision: 2.5 }))).toBeNull();
  });

  it("lets an agent actor act on an agent-carried regulation and links the wiki page", () => {
    const agentActs = regulationActions(
      regulation({ status: "draft", approver_kind: "a" }),
      "agent",
    );
    expect(agentActs.map((action) => action.key)).toEqual(["approve"]);

    const humanCarried = regulationActions(
      regulation({ status: "draft", approver_kind: "o" }),
      "agent",
    );
    expect(humanCarried.map((action) => action.key)).toEqual(["requestApproval"]);

    expect(regulationKnowledgeLink("wiki/reg")).toBe("/knowledge/wiki/reg");
    expect(regulationKnowledgeLink("/knowledge/decisions/adr-7")).toBe("/knowledge/decisions/adr-7");
    expect(regulationKnowledgeLink(null)).toBeNull();
    expect(regulationKnowledgeLink("  ")).toBeNull();
  });

  it("points every action key at both catalogs", () => {
    const keys = regulationActions(
      regulation({ status: "draft", revision: 3, approver_kind: "o", wikiPageId: "wiki/reg" }),
      "human",
    ).map((action) => action.reasonKey);
    expect(keys).toContain("ui2.regulations.action.openInKnowledge");
    for (const key of keys) {
      expect(ui2Messages.en[key as keyof typeof ui2Messages.en]).toBeTruthy();
      expect(ui2Messages.ru[key as keyof typeof ui2Messages.ru]).toBeTruthy();
    }
  });
});