// myrmidon(1.6.1 OPE-3983): unit tests for the internal-path event reasonRefs
// and the sweep-side recovery-liveness reader. The reader is tested against a
// scripted select chain: the module only ever runs one bounded read, so the
// fake pins that shape and every liveness decision.

import { describe, expect, it } from "vitest";
import {
  STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX,
  createRecoveryLivenessEventReader,
  recoveryLivenessDescriptor,
  recoveryLivenessEventKey,
  recoveryLivenessIssueId,
} from "./event-keys.js";

const ISSUE_ID = "6f1c9b2a-4d5e-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Minimal stand-in for the drizzle chain the reader builds. */
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
});
