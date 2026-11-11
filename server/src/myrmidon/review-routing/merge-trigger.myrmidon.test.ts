// myrmidon(OPE-11767): the announcement point of the board-side merge. An
// approval or a completed CI run only says where to look; the announcement
// never throws into, and never waits for, the code that made it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyBoardMergeTrigger, setBoardMergeTrigger } from "./merge-trigger.js";

afterEach(() => setBoardMergeTrigger(null));

describe("board merge trigger", () => {
  it("is a no-op without a listener", () => {
    expect(() => notifyBoardMergeTrigger({ companyId: "c", issueId: "i", source: "review_approved" })).not.toThrow();
  });

  it("hands the event to the one listener", () => {
    const listener = vi.fn(async () => undefined);
    setBoardMergeTrigger(listener);
    notifyBoardMergeTrigger({ companyId: "c", repository: "acme/widgets", number: 7, headSha: "abc1234", source: "ci_completed" });
    expect(listener).toHaveBeenCalledWith({
      companyId: "c",
      repository: "acme/widgets",
      number: 7,
      headSha: "abc1234",
      source: "ci_completed",
    });
  });

  it("a listener that throws or rejects never reaches the caller", async () => {
    setBoardMergeTrigger(() => {
      throw new Error("sync fault");
    });
    expect(() => notifyBoardMergeTrigger({ companyId: "c", issueId: "i", source: "review_approved" })).not.toThrow();

    setBoardMergeTrigger(async () => {
      throw new Error("async fault");
    });
    expect(() => notifyBoardMergeTrigger({ companyId: "c", issueId: "i", source: "review_approved" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("a removed listener stops receiving events", () => {
    const listener = vi.fn();
    setBoardMergeTrigger(listener);
    setBoardMergeTrigger(null);
    notifyBoardMergeTrigger({ companyId: "c", issueId: "i", source: "review_approved" });
    expect(listener).not.toHaveBeenCalled();
  });
});
