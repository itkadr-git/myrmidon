import { describe, expect, it } from "vitest";
import { buildEnrollBody, EMPTY_ENROLL_FORM, siteCertState, type EnrollFormValues } from "./remoteSites";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const valid: EnrollFormValues = {
  ...EMPTY_ENROLL_FORM,
  name: "myr-vm1",
  url: "https://192.0.2.10:9100/",
  tokenSecret: "fleetd-token",
  caCert: "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----",
  clientCertSecretKey: "fleetd-client",
  maxCpus: "8",
  maxMemoryMb: "32768",
  maxBots: "13",
};

describe("siteCertState", () => {
  it("tells expired, expiring soon, fine and unknown", () => {
    expect(siteCertState(new Date(NOW - 1).toISOString(), NOW)).toEqual({ state: "expired", days: 0 });
    expect(siteCertState(new Date(NOW + 3 * 86_400_000).toISOString(), NOW)).toEqual({ state: "soon", days: 3 });
    expect(siteCertState(new Date(NOW + 30 * 86_400_000).toISOString(), NOW)).toEqual({ state: "ok", days: 30 });
    expect(siteCertState(null, NOW).state).toBe("unknown");
    expect(siteCertState("not a date", NOW).state).toBe("unknown");
  });
});

describe("buildEnrollBody", () => {
  it("builds the body the enroll route takes and trims the address", () => {
    const result = buildEnrollBody(valid);
    expect(result).toEqual({
      ok: true,
      body: {
        name: "myr-vm1",
        url: "https://192.0.2.10:9100",
        tokenSecret: "fleetd-token",
        caCert: valid.caCert,
        clientCertSecretKey: "fleetd-client",
        capacity: { maxCpus: 8, maxMemoryMb: 32768, maxBots: 13 },
        gatewayPortStart: 18700,
        gatewayPortEnd: 18759,
      },
    });
  });

  it("leaves maxBots out when it is empty", () => {
    const result = buildEnrollBody({ ...valid, maxBots: "" });
    expect(result.ok && result.body.capacity).toEqual({ maxCpus: 8, maxMemoryMb: 32768 });
  });

  it("names the first field that is wrong", () => {
    expect(buildEnrollBody({ ...valid, name: "" })).toEqual({ ok: false, field: "name", problem: "required" });
    expect(buildEnrollBody({ ...valid, name: "Bad Name" })).toEqual({ ok: false, field: "name", problem: "name" });
    expect(buildEnrollBody({ ...valid, url: "http://x:1" })).toEqual({ ok: false, field: "url", problem: "url" });
    expect(buildEnrollBody({ ...valid, url: "https://x:1/v1" })).toEqual({ ok: false, field: "url", problem: "url" });
    expect(buildEnrollBody({ ...valid, caCert: " " })).toEqual({ ok: false, field: "caCert", problem: "required" });
    expect(buildEnrollBody({ ...valid, maxCpus: "0" })).toEqual({ ok: false, field: "maxCpus", problem: "number" });
    expect(buildEnrollBody({ ...valid, maxMemoryMb: "1.5" })).toEqual({ ok: false, field: "maxMemoryMb", problem: "number" });
    expect(buildEnrollBody({ ...valid, gatewayPortStart: "80" })).toEqual({ ok: false, field: "gatewayPortStart", problem: "number" });
    expect(buildEnrollBody({ ...valid, gatewayPortStart: "18760", gatewayPortEnd: "18700" })).toEqual({ ok: false, field: "gatewayPortEnd", problem: "ports" });
    expect(buildEnrollBody({ ...valid, maxBots: "61" })).toEqual({ ok: false, field: "gatewayPortEnd", problem: "ports" });
  });
});
