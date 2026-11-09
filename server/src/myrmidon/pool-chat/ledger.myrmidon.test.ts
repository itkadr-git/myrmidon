import { describe, expect, it } from "vitest";
import { applyLedgerEvent, startLedger } from "./ledger.js";

describe("pool-chat ledger state machine", () => {
  it("settles success once and rejects a second provider outcome", () => {
    const dispatching = applyLedgerEvent(startLedger(3), { type: "dispatch_started" });
    const succeeded = applyLedgerEvent(dispatching, { type: "provider_succeeded", settledUnits: 2 });

    expect(succeeded).toMatchObject({
      requestState: "succeeded",
      attemptNo: 1,
      attemptState: "sent",
      settledUnits: 2,
    });
    expect(() => applyLedgerEvent(succeeded, { type: "provider_succeeded", settledUnits: 2 }))
      .toThrow("settlement_not_allowed");
  });

  it("keeps a possibly-sent request uncertain and does not permit automatic retry", () => {
    const dispatching = applyLedgerEvent(startLedger(1), { type: "dispatch_started" });
    const uncertain = applyLedgerEvent(dispatching, { type: "send_uncertain" });

    expect(uncertain).toMatchObject({ requestState: "uncertain", attemptState: "uncertain" });
    expect(() => applyLedgerEvent(uncertain, { type: "retry_provable_no_send" }))
      .toThrow("retry_requires_provable_no_send");
  });

  it("allows a retry only after a provider failure proves no send", () => {
    const initial = applyLedgerEvent(startLedger(2), { type: "dispatch_started" });
    const failed = applyLedgerEvent(initial, { type: "provider_failed", settledUnits: 0 });
    const retried = applyLedgerEvent(failed, { type: "retry_provable_no_send" });

    expect(retried).toMatchObject({ requestState: "dispatching", attemptNo: 2, attemptState: "dispatching" });
  });
});
