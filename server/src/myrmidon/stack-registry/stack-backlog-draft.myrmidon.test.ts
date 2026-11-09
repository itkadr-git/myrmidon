// Stack registry (SUA, STACK-UPDATES-B) tests: the pure backlog-draft decision.
// No database, no network: the document is built from the seed and the open
// components are injected, so every acceptance case is a plain table check.

import { describe, expect, it } from "vitest";
import { decideStackBacklogDrafts, STACK_BACKLOG_LAG_DEFAULT } from "./backlog-draft.js";
import { seedStackDocument, type StackDocument, type StackUpstreamState } from "./domain.js";

function upstream(overrides: Partial<StackUpstreamState> = {}): StackUpstreamState {
  return {
    checkedAt: "2026-11-07T03:00:00.000Z",
    latest: "3.2.0",
    latestPublishedAt: "2026-11-06T00:00:00Z",
    firstSeenAt: "2026-11-06T03:00:00.000Z",
    previousLatest: "3.1.0",
    behindBy: 2,
    notes: null,
    error: null,
    ...overrides,
  };
}

/** Seed document with an upstream state attached to the named components. */
function documentWithUpstream(states: Record<string, StackUpstreamState>): StackDocument {
  const doc = seedStackDocument();
  return {
    ...doc,
    components: doc.components.map((component) =>
      states[component.name]
        ? { ...component, upstreamState: states[component.name]! }
        : component,
    ),
  };
}

describe("stack backlog drafts", () => {
  it("drafts one task for a component lagging by the default threshold", () => {
    const doc = documentWithUpstream({ langfuse: upstream({ behindBy: 2 }) });

    const drafts = decideStackBacklogDrafts(doc);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.component).toBe("langfuse");
    expect(drafts[0]!.title).toBe("langfuse 3.2.0");
    expect(drafts[0]!.summary).toContain("3.2.0");
    expect(drafts[0]!.summary).toContain("2 release(s) ahead");
  });

  it("keeps the default threshold at two releases", () => {
    expect(STACK_BACKLOG_LAG_DEFAULT).toBe(2);

    const below = documentWithUpstream({ langfuse: upstream({ behindBy: 1 }) });
    expect(decideStackBacklogDrafts(below)).toHaveLength(0);

    const at = documentWithUpstream({ langfuse: upstream({ behindBy: 2 }) });
    expect(decideStackBacklogDrafts(at)).toHaveLength(1);
  });

  it("honours an explicit threshold from the caller", () => {
    const doc = documentWithUpstream({ langfuse: upstream({ behindBy: 2 }) });

    expect(decideStackBacklogDrafts(doc, { lagThreshold: 3 })).toHaveLength(0);
    expect(decideStackBacklogDrafts(doc, { lagThreshold: 2 })).toHaveLength(1);
  });

  it("skips a component that already has an open task (no duplicate)", () => {
    const doc = documentWithUpstream({ langfuse: upstream({ behindBy: 2 }) });

    const first = decideStackBacklogDrafts(doc, { openComponents: [] });
    expect(first).toHaveLength(1);

    const second = decideStackBacklogDrafts(doc, { openComponents: ["langfuse"] });
    expect(second).toHaveLength(0);
  });

  it("does not draft after the security note is gone and the lag is gone", () => {
    const before = documentWithUpstream({
      langfuse: upstream({
        behindBy: 1,
        notes: { lines: ["3.2.0 - security fix"], truncated: false, hasSecurity: true },
      }),
    });
    expect(decideStackBacklogDrafts(before)).toHaveLength(1);

    const after = documentWithUpstream({
      langfuse: upstream({
        behindBy: 0,
        notes: { lines: ["3.2.0 - routine cleanup"], truncated: false, hasSecurity: false },
      }),
    });
    expect(decideStackBacklogDrafts(after)).toHaveLength(0);
  });

  it("drafts on a security note even without lag", () => {
    const doc = documentWithUpstream({
      langfuse: upstream({
        behindBy: 0,
        notes: { lines: ["3.2.0 - CVE-2026-12345 fixed"], truncated: false, hasSecurity: true },
      }),
    });

    const drafts = decideStackBacklogDrafts(doc);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.component).toBe("langfuse");
    expect(drafts[0]!.summary).toContain("security note");
    expect(drafts[0]!.summary).toContain("CVE-2026-12345");
  });

  it("ignores components without an upstream state and keeps name order", () => {
    const doc = documentWithUpstream({
      langfuse: upstream({ behindBy: 3 }),
      clickhouse: upstream({ behindBy: 2 }),
    });
    const names = decideStackBacklogDrafts(doc).map((draft) => draft.component);

    expect(names).toEqual(["clickhouse", "langfuse"]);
    expect(decideStackBacklogDrafts(seedStackDocument())).toHaveLength(0);
  });
});
