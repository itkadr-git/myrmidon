// server/src/myrmidon/bot-containers/site-agent-security-harness.myrmidon.test.ts
//
// myrmidon(1.6.6 T10-A): Vitest regression test suite for site-agent security harness.
// Covers the matrix of 12 negative scenarios:
//  1. Missing client certificate
//  2. Foreign / untrusted CA
//  3. Expired client certificate
//  4. Unknown / unallowed image
//  5. Tag without sha256 digest
//  6. Arbitrary mount & path traversal
//  7. Arbitrary environment variable injection
//  8. Malformed profile path and secret mode
//  9. Secret marker leak prevention (mode 0600, absent from status/logs)
// 10. Read-only rootfs & CapDrop ALL enforcement
// 11. User UID 10001 enforcement
// 12. Prohibition of site->core credentials

import { describe, expect, it } from "vitest";
import {
  runSecurityRegressionHarness,
  validateContainerEnv,
  validateImageReference,
  validateNoSiteToCoreCredentials,
  validateProfileFiles,
} from "./site-agent-security-harness.js";
import { validateExtraMounts } from "./template.js";

describe("myrmidon(1.6.6 T10-A) site-agent security regression harness", () => {
  it("executes the full security regression harness across all 12 negative scenarios", async () => {
    const report = await runSecurityRegressionHarness();

    expect(report.totalScenarios).toBeGreaterThanOrEqual(10);
    expect(report.failedScenarios).toBe(0);
    expect(report.allPassed).toBe(true);

    const scenarioIds = report.scenarios.map((s) => s.id);
    expect(scenarioIds).toContain("NEG-01-MTLS-NO-CERT");
    expect(scenarioIds).toContain("NEG-02-MTLS-FOREIGN-CA");
    expect(scenarioIds).toContain("NEG-03-MTLS-EXPIRED-CERT");
    expect(scenarioIds).toContain("NEG-04-ALLOWLIST-UNKNOWN-IMAGE");
    expect(scenarioIds).toContain("NEG-05-ALLOWLIST-TAG-WITHOUT-DIGEST");
    expect(scenarioIds).toContain("NEG-06-MOUNTS-PATH-TRAVERSAL");
    expect(scenarioIds).toContain("NEG-07-ENV-ARBITRARY-INJECTION");
    expect(scenarioIds).toContain("NEG-08-PROFILE-MALFORMED-PATH-MODE");
    expect(scenarioIds).toContain("NEG-09-SECRET-MARKER-LEAK-PREVENTION");
    expect(scenarioIds).toContain("NEG-10-TEMPLATE-RO-ROOTFS-CAPDROP");
    expect(scenarioIds).toContain("NEG-11-TEMPLATE-UID-10001");
    expect(scenarioIds).toContain("NEG-12-DIRECTIONALITY-NO-CORE-CREDS");

    expect(report.productionGaps.length).toBeGreaterThan(0);
    for (const gap of report.productionGaps) {
      expect(typeof gap).toBe("string");
    }
  }, 45_000);

  describe("mTLS and Allowlist unit validators", () => {
    const allowlist = ["ghcr.io/itkadr-git/*@sha256:*"];

    it("rejects images with mutable tags lacking sha256 digest", () => {
      const res = validateImageReference("ghcr.io/itkadr-git/myrmidon-hermes:latest", allowlist);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/tag_without_digest_forbidden/);
    });

    it("rejects unknown images even with valid sha256 digest", () => {
      const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const res = validateImageReference(`docker.io/untrusted/agent@${digest}`, allowlist);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/image_not_in_allowlist/);
    });

    it("accepts allowed image with valid sha256 digest", () => {
      const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const res = validateImageReference(`ghcr.io/itkadr-git/myrmidon-hermes@${digest}`, allowlist);
      expect(res.valid).toBe(true);
    });

    it("rejects extra mounts with path traversal or unlisted source", () => {
      const allowedSources = ["/srv/devbuild-ssh"];

      expect(() =>
        validateExtraMounts(
          [
            {
              source: "/etc/shadow",
              containerPath: "/opt/shadow",
              readOnly: true,
            },
          ],
          allowedSources,
        ),
      ).toThrow(/is not listed in MYRMIDON_BOT_MOUNT_SOURCES/);

      expect(() =>
        validateExtraMounts(
          [
            {
              source: "/srv/devbuild-ssh/../secret",
              containerPath: "/opt/escape",
              readOnly: true,
            },
          ],
          allowedSources,
        ),
      ).toThrow(/has a "\.\." path segment/);
    });

    it("rejects arbitrary environment variable injection", () => {
      const res = validateContainerEnv({
        MYRMIDON_BOT_SCOPE_SUBDIR: "valid-bot",
        INJECTED_DANGEROUS_VAR: "malicious_payload",
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/arbitrary_env_rejected/);
    });

    it("enforces mode 0600 and clean paths on secret profile files", () => {
      const traversalProfile = [
        {
          path: "hermes/../escape.txt",
          content: "evil\n",
          mode: 0o644,
          secret: false,
        },
      ];
      expect(validateProfileFiles(traversalProfile).valid).toBe(false);

      const badModeSecretProfile = [
        {
          path: "hermes/.env",
          content: "KEY=1\n",
          mode: 0o644, // Must be 0600
          secret: true,
        },
      ];
      const badModeRes = validateProfileFiles(badModeSecretProfile);
      expect(badModeRes.valid).toBe(false);
      expect(badModeRes.reason).toMatch(/must have mode 0600/);

      const validProfile = [
        {
          path: "hermes/.env",
          content: "KEY=1\n",
          mode: 0o600,
          secret: true,
        },
        {
          path: "hermes/config.yaml",
          content: "cfg: true\n",
          mode: 0o644,
          secret: false,
        },
      ];
      expect(validateProfileFiles(validProfile).valid).toBe(true);
    });

    it("rejects reverse credentials from site to core board", () => {
      const configWithCoreKey = {
        listen: "10.10.0.110:8444",
        boardApiKey: "pcp_secret_key",
      };
      const check = validateNoSiteToCoreCredentials(configWithCoreKey);
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/forbidden_reverse_credential/);
    });
  });
});
