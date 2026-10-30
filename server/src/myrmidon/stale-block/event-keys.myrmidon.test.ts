// myrmidon(1.6.1 OPE-3983, 1.6.6 OPE-9963): unit tests for the internal-path event reasonRefs
// and the sweep-side event readers (recovery-liveness, github, stranded-disposition).

import { describe, expect, it } from "vitest";
import {
  STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX,
  STALE_BLOCK_GITHUB_EVENT_PREFIX,
  STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX,
  isRegisteredEventKey,
  createRecoveryLivenessEventReader,
  createGithubEventReader,
  createStrandedDispositionEventReader,
  createDefaultEventReader,
  recoveryLivenessDescriptor,
  recoveryLivenessEventKey,
  recoveryLivenessIssueId,
  strandedDispositionIssueId,
} from "./event-keys.js";

const ISSUE_ID = "6f1c9b2a-4d5e-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Minimal stand-in for the drizzle chain the recovery reader builds. */
function fakeDb(rows: Array<{ status: string }>, seen?: { called: number }) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit(_n: number) {
                  seen && (seen.called += 1);
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as never;
}

describe("stale-block internal-path event keys", () => {
  it("round-trips the issue-scoped event key", () => {
    const key = recoveryLivenessEventKey(ISSUE_ID);
    expect(key).toBe(`${STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX}${ISSUE_ID}`);
    expect(recoveryLivenessIssueId(key)).toBe(ISSUE_ID);
  });

  it("reads non-liveness and malformed keys as not ours", () => {
    expect(recoveryLivenessIssueId("llm_wiki.maintainer_agent_available")).toBeNull();
    expect(recoveryLivenessIssueId(`${STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX}not-a-uuid`)).toBeNull();
    expect(recoveryLivenessIssueId(`${STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX}${ISSUE_ID}x`)).toBeNull();
  });

  it("identifies stranded disposition issue ids", () => {
    expect(strandedDispositionIssueId(`stranded.disposition:${ISSUE_ID}`)).toBe(ISSUE_ID);
    expect(strandedDispositionIssueId("stranded.disposition:not-a-uuid")).toBeNull();
    expect(strandedDispositionIssueId("recovery.liveness:123")).toBeNull();
  });

  it("identifies registered event key prefixes", () => {
    expect(isRegisteredEventKey(`recovery.liveness:${ISSUE_ID}`)).toBe(true);
    expect(isRegisteredEventKey("github:installation:123:restored")).toBe(true);
    expect(isRegisteredEventKey(`stranded.disposition:${ISSUE_ID}`)).toBe(true);
    expect(isRegisteredEventKey("custom.gate")).toBe(false);
    expect(isRegisteredEventKey("owner.decision")).toBe(false);
    expect(isRegisteredEventKey("ope-9963-approved")).toBe(false);
  });

  it("builds a part A descriptor with an event reasonRef", () => {
    const descriptor = recoveryLivenessDescriptor(ISSUE_ID, "Do the thing.");
    expect(descriptor).toEqual({
      owner: "board",
      action: "Do the thing.",
      reasonRef: { kind: "event", eventKey: recoveryLivenessEventKey(ISSUE_ID) },
    });
  });

  it("keeps a recovery-liveness block alive while an incident row is open", async () => {
    const reader = createRecoveryLivenessEventReader(fakeDb([{ status: "active" }]));
    expect(await reader(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(true);
    const escalated = createRecoveryLivenessEventReader(fakeDb([{ status: "escalated" }]));
    expect(await escalated(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(true);
  });

  it("judges a recovery-liveness block dead only from an explicitly closed incident", async () => {
    const resolved = createRecoveryLivenessEventReader(fakeDb([{ status: "resolved" }]));
    expect(await resolved(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(false);
    const cancelled = createRecoveryLivenessEventReader(fakeDb([{ status: "cancelled" }]));
    expect(await cancelled(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(false);
    const mixed = createRecoveryLivenessEventReader(
      fakeDb([{ status: "resolved" }, { status: "active" }]),
    );
    expect(await mixed(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(true);
  });

  it("treats a missing incident row as still set, never as dead", async () => {
    const reader = createRecoveryLivenessEventReader(fakeDb([]));
    expect(await reader(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID))).toBe(true);
  });

  it("answers foreign event keys as still set without touching the table", async () => {
    const seen = { called: 0 };
    const reader = createRecoveryLivenessEventReader(fakeDb([{ status: "resolved" }], seen));
    expect(await reader(OTHER_ID, "some.other.gate")).toBe(true);
    expect(seen.called).toBe(0);
  });

  it("OPE-9078: reads through the transaction handle when one is passed", async () => {
    const root = { called: 0 };
    const tx = { called: 0 };
    const reader = createRecoveryLivenessEventReader(fakeDb([{ status: "active" }], root));
    const txDb = fakeDb([{ status: "resolved" }], tx);
    expect(await reader(OTHER_ID, recoveryLivenessEventKey(ISSUE_ID), txDb)).toBe(false);
    expect(tx.called).toBe(1);
    expect(root.called).toBe(0);
  });
});

describe("createGithubEventReader", () => {
  function fakeGithubDb(options: {
    latestIssued?: Date | null;
    latestDenied?: Date | null;
  }) {
    return {
      select() {
        return {
          from() {
            return {
              where(clause: any) {
                // clause checking
                const isIssued = JSON.stringify(clause).includes("issued");
                const row = isIssued
                  ? options.latestIssued
                    ? [{ createdAt: options.latestIssued }]
                    : []
                  : options.latestDenied
                    ? [{ createdAt: options.latestDenied }]
                    : [];
                return {
                  orderBy() {
                    return {
                      limit(_n: number) {
                        return Promise.resolve(row);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as never;
  }

  it("unblocks (returns false) when issued is strictly newer than denied", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestDenied: new Date("2026-10-30T10:00:00.000Z"),
        latestIssued: new Date("2026-10-30T10:05:00.000Z"),
      }),
    );
    expect(await reader(OTHER_ID, "github:installation:123:restored")).toBe(false);
  });

  it("remains set (returns true) when denied is newer than issued", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestIssued: new Date("2026-10-30T10:00:00.000Z"),
        latestDenied: new Date("2026-10-30T10:05:00.000Z"),
      }),
    );
    expect(await reader(OTHER_ID, "github:installation:123:restored")).toBe(true);
  });

  it("unblocks (returns false) when issued exists and denied never occurred", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestIssued: new Date("2026-10-30T10:00:00.000Z"),
        latestDenied: null,
      }),
    );
    expect(await reader(OTHER_ID, "github:installation:123:restored")).toBe(false);
  });

  it("remains set (returns true) when only denied occurred", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestIssued: null,
        latestDenied: new Date("2026-10-30T10:00:00.000Z"),
      }),
    );
    expect(await reader(OTHER_ID, "github:installation:123:restored")).toBe(true);
  });

  it("remains set (returns true) when neither event occurred", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestIssued: null,
        latestDenied: null,
      }),
    );
    expect(await reader(OTHER_ID, "github:installation:123:restored")).toBe(true);
  });

  it("ignores non-github event keys", async () => {
    const reader = createGithubEventReader(
      fakeGithubDb({
        latestIssued: new Date("2026-10-30T10:00:00.000Z"),
        latestDenied: null,
      }),
    );
    expect(await reader(OTHER_ID, "other:key")).toBe(true);
  });
});

describe("createStrandedDispositionEventReader", () => {
  function fakeStrandedDb(options: {
    issue?: { id: string; status: string; assigneeAgentId?: string | null } | null;
    agent?: { status: string } | null;
    activeRun?: { id: string } | null;
  }) {
    let callIndex = 0;
    return {
      select() {
        return {
          from(_table: any) {
            return {
              where(_clause: any) {
                return {
                  limit(_n: number) {
                    callIndex++;
                    if (callIndex === 1) {
                      return Promise.resolve(options.issue ? [options.issue] : []);
                    }
                    if (callIndex === 2) {
                      return Promise.resolve(options.agent ? [options.agent] : []);
                    }
                    return Promise.resolve(options.activeRun ? [options.activeRun] : []);
                  },
                };
              },
            };
          },
        };
      },
    } as never;
  }

  it("unblocks (returns false) when issue is no longer blocked (e.g. done or in_progress)", async () => {
    const reader = createStrandedDispositionEventReader(
      fakeStrandedDb({
        issue: { id: ISSUE_ID, status: "done", assigneeAgentId: "agent-1" },
      }),
    );
    expect(await reader(OTHER_ID, `stranded.disposition:${ISSUE_ID}`)).toBe(false);
  });

  it("unblocks (returns false) when issue has an active running agent heartbeat", async () => {
    const reader = createStrandedDispositionEventReader(
      fakeStrandedDb({
        issue: { id: ISSUE_ID, status: "blocked", assigneeAgentId: "agent-1" },
        agent: { status: "running" },
        activeRun: { id: "run-1" },
      }),
    );
    expect(await reader(OTHER_ID, `stranded.disposition:${ISSUE_ID}`)).toBe(false);
  });

  it("remains set (returns true) when issue is blocked and has no active run", async () => {
    const reader = createStrandedDispositionEventReader(
      fakeStrandedDb({
        issue: { id: ISSUE_ID, status: "blocked", assigneeAgentId: "agent-1" },
        agent: { status: "idle" },
        activeRun: null,
      }),
    );
    expect(await reader(OTHER_ID, `stranded.disposition:${ISSUE_ID}`)).toBe(true);
  });

  it("unblocks (returns false) when issue no longer exists", async () => {
    const reader = createStrandedDispositionEventReader(
      fakeStrandedDb({
        issue: null,
      }),
    );
    expect(await reader(OTHER_ID, `stranded.disposition:${ISSUE_ID}`)).toBe(false);
  });
});

describe("createDefaultEventReader", () => {
  it("dispatches to the appropriate reader based on prefix", async () => {
    // For unregistered prefix, immediately returns true
    const reader = createDefaultEventReader(fakeDb([]));
    expect(await reader(OTHER_ID, "unregistered:prefix")).toBe(true);
  });
});
