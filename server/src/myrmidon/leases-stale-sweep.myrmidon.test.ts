import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_LEASE_GRACE_MS,
  STALE_LEASE_SWEEP_PAGE_SIZE,
  STALE_LEASE_TEARDOWN_ATTEMPT_CAP,
  STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY,
  STALE_LEASE_TEARDOWN_CAP_ERROR_KIND,
  STALE_LEASE_TEARDOWN_CAP_FAILURE_REASON,
  readStaleLeaseGraceMs,
} from "./leases-stale-sweep.js";

describe("readStaleLeaseGraceMs", () => {
  it("defaults to 10 minutes", () => {
    expect(DEFAULT_STALE_LEASE_GRACE_MS).toBe(600_000);
    expect(readStaleLeaseGraceMs({})).toBe(600_000);
  });

  it("reads milliseconds and falls back on invalid values", () => {
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "60000" })).toBe(60_000);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "0" })).toBe(0);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "-1" })).toBe(600_000);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "10m" })).toBe(600_000);
  });

  it("caps a tick at 50 leases", () => {
    expect(STALE_LEASE_SWEEP_PAGE_SIZE).toBe(50);
  });
});

describe("stale lease teardown retry cap (OPE-12899)", () => {
  it("bounds teardown retries at three attempts", () => {
    expect(STALE_LEASE_TEARDOWN_ATTEMPT_CAP).toBe(3);
  });

  it("counts attempts in a dedicated lease metadata key", () => {
    expect(STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY).toBe("staleLeaseTeardownAttempts");
  });

  it("stamps the capped release and card evidence with constant kinds only", () => {
    expect(STALE_LEASE_TEARDOWN_CAP_FAILURE_REASON).toBe("stale_lease_teardown_cap");
    expect(STALE_LEASE_TEARDOWN_CAP_ERROR_KIND).toBe("lease_teardown_cap_reached");
  });
});
