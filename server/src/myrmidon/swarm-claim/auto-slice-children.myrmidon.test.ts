import { describe, expect, it } from "vitest";
import { AUTO_SLICE_TITLE } from "./auto-slice-policy.js";
import {
  AUTO_SLICE_CHILD_NEEDS_RELEASE_LABEL,
  assertAutoSliceChildHasReleaseLabel,
  moveAutoSliceChildrenToEpic,
  planAutoSliceChildren,
} from "./auto-slice-children.js";

const one = `Нарежьте.\n\nОткрытые эпики:\n- [OPE-100](/issues/OPE-100) Эпик`;
const two = `${one}\n- [OPE-101](/issues/OPE-101) Другой`;

describe("myrmidon(1.6.9 AUTO-SLICE-DEDUPE) children of a slicing task", () => {
  it("a task under AUTO-SLICE without a release label is refused with 422", () => {
    expect(() => assertAutoSliceChildHasReleaseLabel({ parentTitle: AUTO_SLICE_TITLE, labelNames: ["bug"] }))
      .toThrowError(expect.objectContaining({ status: 422, details: { code: AUTO_SLICE_CHILD_NEEDS_RELEASE_LABEL } }));
  });
  it("a task under AUTO-SLICE with a release label passes", () => {
    expect(() => assertAutoSliceChildHasReleaseLabel({ parentTitle: AUTO_SLICE_TITLE, labelNames: ["1.6.9"] })).not.toThrow();
  });
  it("a task under another parent needs no release label", () => {
    expect(() => assertAutoSliceChildHasReleaseLabel({ parentTitle: "Epic", labelNames: [] })).not.toThrow();
  });
  it("one epic in the description is the move target", () => {
    expect(planAutoSliceChildren(one)).toEqual({ kind: "move", epicIdentifier: "OPE-100" });
  });
  it("several epics or none leave the children where they are", () => {
    expect(planAutoSliceChildren(two)).toMatchObject({ kind: "leave", reason: "several_epics" });
    expect(planAutoSliceChildren("без списка")).toMatchObject({ kind: "leave", reason: "no_epics" });
  });
  it("closing moves open children to the single epic and writes activity", async () => {
    const calls: string[] = [];
    let step = 0;
    const tx = {
      select: () => ({ from: () => ({ where: () => {
        step += 1;
        const rows = step === 1 ? [{ id: "child" }] : [{ id: "epic-id" }];
        return Object.assign(Promise.resolve(rows), { limit: async () => rows });
      } }) }),
      update: () => ({ set: (patch: any) => ({ where: async () => { calls.push(`update:${patch.parentId}`); } }) }),
      insert: () => ({ values: async (v: any) => { calls.push(`activity:${v.action}`); } }),
    };
    await moveAutoSliceChildrenToEpic(tx, { id: "s", companyId: "c", title: AUTO_SLICE_TITLE, description: one });
    expect(calls).toEqual(["update:epic-id", "activity:issue.auto_slice_children_moved"]);
  });
  it("closing with several epics leaves children and writes activity", async () => {
    const calls: string[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [{ id: "child" }] }) }),
      update: () => ({ set: () => ({ where: async () => { calls.push("update"); } }) }),
      insert: () => ({ values: async (v: any) => { calls.push(`activity:${v.action}`); } }),
    };
    await moveAutoSliceChildrenToEpic(tx, { id: "s", companyId: "c", title: AUTO_SLICE_TITLE, description: two });
    expect(calls).toEqual(["activity:issue.auto_slice_children_left"]);
  });
});
