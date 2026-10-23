export type PoolChatAttemptState = "dispatching" | "sent" | "failed" | "uncertain";

export type PoolChatLedger = {
  requestState: "queued" | "dispatching" | "succeeded" | "failed" | "uncertain";
  attemptNo: number;
  attemptState: PoolChatAttemptState;
  reservedUnits: number;
  settledUnits: number | null;
};

export type LedgerEvent =
  | { type: "dispatch_started" }
  | { type: "provider_succeeded"; settledUnits: number }
  | { type: "provider_failed"; settledUnits: number }
  | { type: "send_uncertain" }
  | { type: "retry_provable_no_send" };

export function startLedger(reservedUnits: number): PoolChatLedger {
  if (!Number.isSafeInteger(reservedUnits) || reservedUnits < 1) {
    throw new Error("reserved_units_invalid");
  }
  return {
    requestState: "queued",
    attemptNo: 0,
    attemptState: "failed",
    reservedUnits,
    settledUnits: null,
  };
}

export function applyLedgerEvent(state: PoolChatLedger, event: LedgerEvent): PoolChatLedger {
  if (event.type === "dispatch_started") {
    if (state.requestState !== "queued" && state.requestState !== "failed") {
      throw new Error("dispatch_not_allowed");
    }
    return {
      ...state,
      requestState: "dispatching",
      attemptNo: state.attemptNo + 1,
      attemptState: "dispatching",
      settledUnits: null,
    };
  }

  if (event.type === "send_uncertain") {
    if (state.requestState !== "dispatching" || state.attemptState !== "dispatching") {
      throw new Error("uncertain_send_not_allowed");
    }
    return { ...state, requestState: "uncertain", attemptState: "uncertain" };
  }

  if (event.type === "provider_succeeded") {
    if (state.requestState !== "dispatching" || state.attemptState !== "dispatching") {
      throw new Error("settlement_not_allowed");
    }
    assertSettledUnits(event.settledUnits, state.reservedUnits);
    return {
      ...state,
      requestState: "succeeded",
      attemptState: "sent",
      settledUnits: event.settledUnits,
    };
  }

  if (event.type === "provider_failed") {
    if (state.requestState !== "dispatching" || state.attemptState !== "dispatching") {
      throw new Error("failure_not_allowed");
    }
    assertSettledUnits(event.settledUnits, state.reservedUnits);
    return {
      ...state,
      requestState: "failed",
      attemptState: "failed",
      settledUnits: event.settledUnits,
    };
  }

  if (state.requestState !== "failed" || state.attemptState !== "failed") {
    throw new Error("retry_requires_provable_no_send");
  }
  return applyLedgerEvent(state, { type: "dispatch_started" });
}

function assertSettledUnits(settledUnits: number, reservedUnits: number): void {
  if (!Number.isSafeInteger(settledUnits) || settledUnits < 0 || settledUnits > reservedUnits) {
    throw new Error("settled_units_invalid");
  }
}
