import { describe, expect, it, vi } from "vitest";

import {
  StartupRefusalError,
  shouldReportStartupFailure,
  type StartupRefusalKind,
} from "../startup-refusals.ts";

const kinds: StartupRefusalKind[] = [
  "schema-not-yet-migrated",
  "schema-migration-pending",
  "database-contract-unmet",
];

const environments = [
  { name: "canonical", env: { MYRMIDON_CLOUD_API_ORIGIN: "https://canonical.example" }, report: false },
  { name: "legacy only", env: { PAPERCLIP_CLOUD_API_ORIGIN: "https://legacy.example" }, report: false },
  { name: "empty canonical overrides legacy", env: { MYRMIDON_CLOUD_API_ORIGIN: "", PAPERCLIP_CLOUD_API_ORIGIN: "https://legacy.example" }, report: true },
  { name: "whitespace canonical overrides legacy", env: { MYRMIDON_CLOUD_API_ORIGIN: " \t ", PAPERCLIP_CLOUD_API_ORIGIN: "https://legacy.example" }, report: true },
  { name: "conflicting nonempty values", env: { MYRMIDON_CLOUD_API_ORIGIN: "https://canonical.example", PAPERCLIP_CLOUD_API_ORIGIN: "https://legacy.example" }, report: false },
] as const;

describe("startup refusal cloud environment precedence", () => {
  for (const kind of kinds) {
    for (const { name, env, report } of environments) {
      it(`${kind}: ${name}`, () => {
        const frozenEnv = Object.freeze({ ...env });
        const original = { ...frozenEnv };
        const refusal = new StartupRefusalError(kind, "synthetic refusal");

        expect(shouldReportStartupFailure(refusal, frozenEnv)).toBe(report);
        expect(shouldReportStartupFailure(refusal, frozenEnv)).toBe(report);
        expect(shouldReportStartupFailure(refusal, {})).toBe(true);
        expect(shouldReportStartupFailure(new Error("synthetic failure"), frozenEnv)).toBe(true);
        expect(frozenEnv).toEqual(original);
      });
    }
  }

  it.each([
    ["Error", new Error("failure")],
    ["null", null],
    ["string", "failure"],
    ["lookalike", { name: "StartupRefusalError", kind: "database-contract-unmet" }],
  ])("reports a non-refusal %s in every environment", (_name, error) => {
    for (const { env } of environments) {
      expect(shouldReportStartupFailure(error, Object.freeze({ ...env }))).toBe(true);
    }
  });

  it("uses explicit environments independently of ambient process.env across calls", () => {
    const refusal = new StartupRefusalError("database-contract-unmet", "synthetic refusal");
    const unsupervised = Object.freeze({ MYRMIDON_CLOUD_API_ORIGIN: "", PAPERCLIP_CLOUD_API_ORIGIN: "https://legacy.example" });
    const supervised = Object.freeze({ MYRMIDON_CLOUD_API_ORIGIN: "https://canonical.example" });
    try {
      vi.stubEnv("MYRMIDON_CLOUD_API_ORIGIN", "https://ambient.example");
      vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "https://ambient-legacy.example");
      expect(shouldReportStartupFailure(refusal, unsupervised)).toBe(true);
      expect(shouldReportStartupFailure(refusal, supervised)).toBe(false);
      vi.stubEnv("MYRMIDON_CLOUD_API_ORIGIN", "");
      vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "");
      expect(shouldReportStartupFailure(refusal, supervised)).toBe(false);
      expect(shouldReportStartupFailure(refusal, unsupervised)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
