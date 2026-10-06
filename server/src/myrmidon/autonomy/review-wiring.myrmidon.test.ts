// myrmidon(1.6-AUTONOMY): the wiring guard.
//
// The exactly-once rule is behaviour-tested in `action-execution.myrmidon.test.ts`
// and end-to-end in `action-decision.db.myrmidon.test.ts`. This file guards the
// two seams those tests cannot reach on their own:
//
//   1. the approval path replays a held action (without it the executor is dead
//      code and "after approval the target agent is paused" silently stops being
//      true — exactly the defect a reviewer caught);
//   2. the card approval entry decides OUR hold instead of pushing it down the
//      tool conveyor, which would cancel a request it cannot verify against a
//      gateway signature.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const reviewSource = read("../../services/tool-action-review.ts");
const gatewaySource = read("../../services/tool-gateway.ts");

describe("myrmidon(1.6-AUTONOMY) review wiring", () => {
  it("replays a held autonomy action from the approval path", () => {
    // Marked as ours, so the file's own reviewers see why it changed.
    expect(reviewSource).toContain("myrmidon(1.6-AUTONOMY)");
    // Runs the replay, with the real executors.
    expect(reviewSource).toContain("replayHeldAutonomyAction({");
    expect(reviewSource).toContain("autonomyActionExecutors(db)");
    // Only on an approval that leaves the request approved (a first approval or
    // the recovery sweep), never on a rejection and never on a settled row.
    expect(reviewSource).toContain('input.decision === "approved" &&');
    expect(reviewSource).toContain('result.status === "approved"');
  });
});

describe("myrmidon(1.6-AUTONOMY) card approval wiring", () => {
  it("decides a held autonomy action from the card approval entry", () => {
    // The card's approval entry, from its signature to the next method.
    const approve = gatewaySource.slice(
      gatewaySource.indexOf("async approveActionRequest("),
      gatewaySource.indexOf("async declineActionRequest("),
    );
    expect(approve).toContain("myrmidon(1.6-AUTONOMY)");
    expect(approve).toContain("isAutonomyToolName(invocation.toolName)");
    expect(approve).toContain("decideHeldAutonomyAction({");
    // The branch is taken before the signed-arguments conveyor, which cannot
    // carry a hold (it would refuse to verify it and cancel the request).
    expect(approve.indexOf("decideHeldAutonomyAction({")).toBeLessThan(
      approve.indexOf("readSignedToolArgumentsPayload({"),
    );
  });
});