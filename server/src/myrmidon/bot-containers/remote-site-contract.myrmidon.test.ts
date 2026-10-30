// server/src/myrmidon/bot-containers/remote-site-contract.myrmidon.test.ts

import { describe, expect, it } from "vitest";
import {
  RemoteSiteContractError,
  checkEnrolledLimits,
  checkImageAllowlist,
  formatRemoteSiteError,
  isPinnedImageDigest,
  parseRemoteSiteError,
  parseRemoteSiteHealthResponse,
  parseRemoteSiteLeaseClaimResponse,
  validateRemoteSiteBotStatus,
  validateRemoteSiteLeaseClaimRequest,
} from "./remote-site-contract.js";

const VALID_DIGEST =
  "ghcr.io/itkadr-git/myrmidon-bot@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("myrmidon(1.6.6-REMOTE-SITES) image digest pinning", () => {
  it("accepts valid sha256 digests", () => {
    expect(isPinnedImageDigest(VALID_DIGEST)).toBe(true);
    expect(
      isPinnedImageDigest("registry.example.com:5000/repo/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
  });

  it("rejects tag-only references and latest", () => {
    expect(isPinnedImageDigest("ghcr.io/itkadr-git/myrmidon-bot:latest")).toBe(false);
    expect(isPinnedImageDigest("ghcr.io/itkadr-git/myrmidon-bot:v1.6.6")).toBe(false);
    expect(isPinnedImageDigest("myrmidon-bot")).toBe(false);
  });

  it("rejects truncated or malformed hashes", () => {
    expect(isPinnedImageDigest("repo/app@sha256:short")).toBe(false);
    expect(isPinnedImageDigest("repo/app@md5:0123456789abcdef0123456789abcdef")).toBe(false);
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) image allowlist checks", () => {
  const ALLOWLIST = [
    "ghcr.io/itkadr-git/myrmidon-bot@sha256:*",
    "ghcr.io/itkadr-git/canary@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ];

  it("permits matching pinned images", () => {
    expect(checkImageAllowlist(VALID_DIGEST, ALLOWLIST)).toBe(true);
  });

  it("rejects unlisted images and empty allowlists", () => {
    expect(
      checkImageAllowlist(
        "docker.io/untrusted/bot@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ALLOWLIST,
      ),
    ).toBe(false);
    expect(checkImageAllowlist(VALID_DIGEST, [])).toBe(false);
  });

  it("rejects non-pinned images even if pattern matches", () => {
    expect(checkImageAllowlist("ghcr.io/itkadr-git/myrmidon-bot:latest", ["*"])).toBe(false);
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) enrolled limits enforcement", () => {
  const ENROLLED = {
    maxMemoryMb: 2048,
    maxCpus: 2,
    maxPids: 512,
  };

  it("accepts specifications within quota", () => {
    expect(checkEnrolledLimits({ memoryMb: 1024, cpus: 1, pidsLimit: 256 }, ENROLLED)).toEqual({ ok: true });
    expect(checkEnrolledLimits({ memoryMb: 2048, cpus: 2, pidsLimit: 512 }, ENROLLED)).toEqual({ ok: true });
  });

  it("reports violations when limits exceed enrollment", () => {
    expect(checkEnrolledLimits({ memoryMb: 4096, cpus: 1, pidsLimit: 256 }, ENROLLED)).toEqual({
      ok: false,
      violation: "limit_exceeds_memory_enrollment",
    });
    expect(checkEnrolledLimits({ memoryMb: 1024, cpus: 4, pidsLimit: 256 }, ENROLLED)).toEqual({
      ok: false,
      violation: "limit_exceeds_cpu_enrollment",
    });
    expect(checkEnrolledLimits({ memoryMb: 1024, cpus: 1, pidsLimit: 1024 }, ENROLLED)).toEqual({
      ok: false,
      violation: "limit_exceeds_pids_enrollment",
    });
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) site health response parser", () => {
  const VALID_HEALTH = {
    siteId: "myr-vm1",
    epoch: 12,
    status: "healthy",
    capacity: {
      cpuCores: 16,
      memoryMb: 65536,
      diskGb: 500,
    },
    allocated: {
      cpuCores: 4,
      memoryMb: 16384,
      pids: 512,
      containersCount: 4,
    },
    egressCheck: {
      ok: true,
      timestamp: "2026-10-17T16:00:00Z",
    },
    activeLeases: [
      {
        executionId: "exec-1",
        botKey: "work-qa",
        leaseEpoch: 12,
        expiresAt: "2026-10-17T16:05:00Z",
      },
    ],
    version: "1.6.6-rc.2",
  };

  it("parses full valid health response", () => {
    const res = parseRemoteSiteHealthResponse(VALID_HEALTH);
    expect(res.siteId).toBe("myr-vm1");
    expect(res.epoch).toBe(12);
    expect(res.status).toBe("healthy");
    expect(res.capacity).toEqual({ cpuCores: 16, memoryMb: 65536, diskGb: 500 });
    expect(res.allocated?.containersCount).toBe(4);
    expect(res.egressCheck?.ok).toBe(true);
    expect(res.activeLeases?.length).toBe(1);
    expect(res.version).toBe("1.6.6-rc.2");
  });

  it("accepts minimal health without optional blocks", () => {
    const minimal = {
      siteId: "myr-vm1",
      epoch: 1,
      status: "degraded",
      capacity: { cpuCores: 8, memoryMb: 32768, diskGb: 200 },
    };
    const res = parseRemoteSiteHealthResponse(minimal);
    expect(res.status).toBe("degraded");
    expect(res.allocated).toBeUndefined();
    expect(res.activeLeases).toBeUndefined();
  });

  it("rejects missing siteId, invalid epoch, or unknown status", () => {
    expect(() => parseRemoteSiteHealthResponse({})).toThrow(RemoteSiteContractError);
    expect(() => parseRemoteSiteHealthResponse({ ...VALID_HEALTH, siteId: "" })).toThrow(/missing_site_id/);
    expect(() => parseRemoteSiteHealthResponse({ ...VALID_HEALTH, epoch: -1 })).toThrow(/invalid_epoch/);
    expect(() => parseRemoteSiteHealthResponse({ ...VALID_HEALTH, status: "crashed" })).toThrow(/invalid_site_status/);
  });

  it("rejects malformed capacity", () => {
    expect(() => parseRemoteSiteHealthResponse({ ...VALID_HEALTH, capacity: null })).toThrow(/missing_capacity/);
    expect(() => parseRemoteSiteHealthResponse({ ...VALID_HEALTH, capacity: { cpuCores: -1, memoryMb: 10, diskGb: 10 } })).toThrow(
      /invalid_capacity_values/,
    );
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) lease claim validation and parsing", () => {
  it("validates valid lease claim request", () => {
    const req = validateRemoteSiteLeaseClaimRequest({
      executionId: "exec-99",
      botKey: "work-qa",
      leaseEpoch: 5,
      ttlSec: 60,
    });
    expect(req).toEqual({
      executionId: "exec-99",
      botKey: "work-qa",
      leaseEpoch: 5,
      ttlSec: 60,
    });
  });

  it("rejects invalid lease claim requests", () => {
    expect(() => validateRemoteSiteLeaseClaimRequest({ executionId: "", botKey: "b", leaseEpoch: 1, ttlSec: 60 })).toThrow(
      /missing_execution_id/,
    );
    expect(() => validateRemoteSiteLeaseClaimRequest({ executionId: "e", botKey: "-bad-", leaseEpoch: 1, ttlSec: 60 })).toThrow(
      /invalid_bot_key/,
    );
    expect(() => validateRemoteSiteLeaseClaimRequest({ executionId: "e", botKey: "b", leaseEpoch: 0, ttlSec: 60 })).toThrow(
      /invalid_lease_epoch/,
    );
    expect(() => validateRemoteSiteLeaseClaimRequest({ executionId: "e", botKey: "b", leaseEpoch: 1, ttlSec: 0 })).toThrow(
      /invalid_ttl/,
    );
  });

  it("parses lease claim response", () => {
    expect(
      parseRemoteSiteLeaseClaimResponse({
        acquired: true,
        leaseEpoch: 5,
        expiresAt: "2026-10-17T17:00:00Z",
        fenced: false,
      }),
    ).toEqual({
      acquired: true,
      leaseEpoch: 5,
      expiresAt: "2026-10-17T17:00:00Z",
      fenced: false,
    });

    expect(
      parseRemoteSiteLeaseClaimResponse({
        acquired: false,
        leaseEpoch: 4,
        expiresAt: "",
        fenced: true,
        reason: "site_fenced",
      }),
    ).toEqual({
      acquired: false,
      leaseEpoch: 4,
      expiresAt: "",
      fenced: true,
      reason: "site_fenced",
    });
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) bot status validation", () => {
  it("validates status carrying gatewayPort", () => {
    const status = validateRemoteSiteBotStatus({
      botKey: "work-finansist",
      state: "running",
      image: VALID_DIGEST,
      gatewayPort: 18642,
      restartHash: "rh1",
      filesHash: "fh1",
    });
    expect(status.botKey).toBe("work-finansist");
    expect(status.state).toBe("running");
    expect(status.gatewayPort).toBe(18642);
  });

  it("rejects invalid gateway port or state", () => {
    expect(() =>
      validateRemoteSiteBotStatus({
        botKey: "work-finansist",
        state: "running",
        gatewayPort: 99999,
      }),
    ).toThrow(/invalid_gateway_port/);

    expect(() =>
      validateRemoteSiteBotStatus({
        botKey: "work-finansist",
        state: "bogus_state",
      }),
    ).toThrow(/invalid_state/);
  });
});

describe("myrmidon(1.6.6-REMOTE-SITES) error discipline", () => {
  it("formats canonical error without internal details", () => {
    expect(formatRemoteSiteError(403, "limit_exceeds_enrollment")).toBe("403 limit_exceeds_enrollment\n");
    expect(formatRemoteSiteError(409, "lease_conflict / epoch mismatch")).toBe("409 lease_conflict___epoch_mismatch\n");
  });

  it("parses error string safely", () => {
    expect(parseRemoteSiteError(403, "limit_exceeds_enrollment\n")).toEqual({
      status: 403,
      reason: "limit_exceeds_enrollment",
    });
    expect(parseRemoteSiteError(500, "")).toEqual({
      status: 500,
      reason: "unknown_site_error",
    });
  });
});
