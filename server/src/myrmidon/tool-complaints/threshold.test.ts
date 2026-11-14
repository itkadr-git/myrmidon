// server/src/myrmidon/tool-complaints/threshold.test.ts
//
// myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the complaint threshold core.
// The rules the board promises (issue КРИТЕРИИ ПРИЁМКИ):
//   - N open complaints on ONE tool of one agent → exactly ONE warning;
//   - a resolved complaint never counts again (no re-trigger);
//   - below the threshold there is no warning (no auto-disable anywhere).

import { describe, expect, it } from "vitest";
import type { ToolComplaint } from "@myrmidon/shared";
import {
  TOOL_COMPLAINT_THRESHOLD,
  complaintThresholdWarnings,
} from "./threshold.js";

let seq = 0;

function complaint(overrides: Partial<ToolComplaint> = {}): ToolComplaint {
  seq += 1;
  return {
    id: `complaint-${seq}`,
    companyId: "company-a",
    agentId: "agent-a",
    tool: "github",
    issue: "tool failed",
    severity: "medium",
    runId: null,
    status: "open",
    createdAt: new Date(2026, 10, 12, 12, seq).toISOString(),
    updatedAt: new Date(2026, 10, 12, 12, seq).toISOString(),
    ...overrides,
  };
}

describe("complaintThresholdWarnings", () => {
  it("warns once when the threshold is reached on one tool", () => {
    const feed = [
      complaint({ id: "c1" }),
      complaint({ id: "c2" }),
      complaint({ id: "c3" }),
    ];
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      tool: "github",
      openCount: 3,
      threshold: TOOL_COMPLAINT_THRESHOLD,
      warning: true,
    });
  });

  it("does not warn below the threshold (no auto-disable)", () => {
    const feed = [complaint(), complaint()];
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      tool: "github",
      openCount: 2,
      threshold: TOOL_COMPLAINT_THRESHOLD,
      warning: false,
    });
  });

  it("resolved complaints do not count and never re-trigger a warning", () => {
    const feed = [
      complaint({ id: "c1", status: "resolved" }),
      complaint({ id: "c2", status: "resolved" }),
      complaint({ id: "c3", status: "resolved" }),
      complaint({ id: "c4", status: "resolved" }),
    ];
    expect(complaintThresholdWarnings(feed)).toEqual([]);
  });

  it("resolved complaints stop counting after a warning: 3 open + 1 resolved stays ONE warning at 3", () => {
    const feed = [
      complaint({ id: "c1" }),
      complaint({ id: "c2" }),
      complaint({ id: "c3" }),
      complaint({ id: "c4", status: "resolved" }),
    ];
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.openCount).toBe(3);
    expect(warnings[0]?.warning).toBe(true);
  });

  it("groups per tool and keeps acknowledged complaints counting", () => {
    const feed = [
      complaint({ id: "c1", tool: "github" }),
      complaint({ id: "c2", tool: "github", status: "acknowledged" }),
      complaint({ id: "c3", tool: "slack" }),
      complaint({ id: "c4", tool: "slack", status: "resolved" }),
      complaint({ id: "c5", tool: "slack", status: "resolved" }),
    ];
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings.map((warning) => warning.tool)).toEqual(["github", "slack"]);
    expect(warnings[0]).toMatchObject({ openCount: 2, warning: false });
    expect(warnings[1]).toMatchObject({ openCount: 1, warning: false });
  });

  it("produces one warning per tool even when many complaints pile up", () => {
    const feed = Array.from({ length: 10 }, (_, index) =>
      complaint({ id: `c${index}`, tool: "browser" }),
    );
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ tool: "browser", openCount: 10, warning: true });
  });

  it("orders warnings by count desc then name so the board card order is stable", () => {
    const feed = [
      complaint({ id: "c1", tool: "aaa", status: "open" }),
      complaint({ id: "c2", tool: "aaa", status: "open" }),
      complaint({ id: "c3", tool: "bbb" }),
      complaint({ id: "c4", tool: "bbb" }),
      complaint({ id: "c5", tool: "bbb" }),
    ];
    const warnings = complaintThresholdWarnings(feed);
    expect(warnings.map((warning) => warning.tool)).toEqual(["bbb", "aaa"]);
    expect(warnings[0]?.warning).toBe(true);
    expect(warnings[1]?.warning).toBe(false);
  });

  it("honours a custom threshold (the operator-facing knob stays injectable)", () => {
    const feed = [complaint(), complaint()];
    const warnings = complaintThresholdWarnings(feed, 2);
    expect(warnings[0]).toMatchObject({ openCount: 2, threshold: 2, warning: true });
  });
});
