import { describe, expect, it } from "vitest";
import { AUTO_SLICE_DEDUPE_STATUSES, autoSliceBlocksNext } from "./auto-slice-policy.js";

describe("myrmidon(1.6.9 AUTO-SLICE-DEDUPE) existing slicing task and the next slice", () => {
  it("a slicing task in blocked does not stop a new one", () => {
    expect(autoSliceBlocksNext("blocked")).toBe(false);
  });
  it("a slicing task in in_review does not stop a new one", () => {
    expect(autoSliceBlocksNext("in_review")).toBe(false);
  });
  it("a slicing task in in_progress stops a new one", () => {
    expect(autoSliceBlocksNext("in_progress")).toBe(true);
  });
  it("a slicing task in todo stops a new one", () => {
    expect(autoSliceBlocksNext("todo")).toBe(true);
  });
  it("the dedupe set is exactly backlog, todo, in_progress", () => {
    expect([...AUTO_SLICE_DEDUPE_STATUSES]).toEqual(["backlog", "todo", "in_progress"]);
  });
});
