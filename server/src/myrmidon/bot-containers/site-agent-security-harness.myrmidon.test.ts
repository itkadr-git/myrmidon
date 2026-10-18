// server/src/myrmidon/bot-containers/site-agent-security-harness.myrmidon.test.ts
//
// myrmidon(1.6.6 T10-A): Vitest regression test suite for site-agent security harness.
// Covers the matrix of 10 negative scenarios:
//  1. Missing client certificate
//  2. Foreign / untrusted CA
//  3. Expired client certificate
//  4. Unknown / unallowed image
//  5. Tag without sha256 digest
//  6. Arbitrary mount & path traversal
//  7. Arbitrary environment variable injection
//  8. Malformed profile path and secret mode
//  9. Secret marker leak prevention (mode 0600, absent from status/logs)
// 10. Prohibition of site->core credentials

import { describe, expect, it } from "vitest";
import {
  runSecurityRegressionHarness,
  validateContainerEnv,
  validateImageReference,
  validateNoSiteToCoreCredentials,
  validateProfileFiles,
  validateRuntimeTemplate,
} from "./site-agent-security-harness.js";
import { resolveAllowedScratchDir } from "./site-agent-pki.js";
import { validateExtraMounts } from "./template.js";

describe("myrmidon(1.6.6 T10-A) site-agent security regression harness", () => {
  it("executes the full security regression harness across all 10 negative scenarios", async () => {
    const report = await runSecurityRegressionHarness();

    expect(report.totalScenarios).toBe(10);
    expect(report.failedScenarios).toBe(0);
    expect(report.allPassed).toBe(true);

    const scenarioIds = report.scenarios.map((s) => s.id);
    expect(scenarioIds).toEqual([
      "NEG-01-MTLS-NO-CERT",
      "NEG-02-MTLS-FOREIGN-CA",
      "NEG-03-MTLS-EXPIRED-CERT",
      "NEG-04-ALLOWLIST-UNKNOWN-IMAGE",
      "NEG-05-ALLOWLIST-TAG-WITHOUT-DIGEST",
      "NEG-06-MOUNTS-PATH-TRAVERSAL",
      "NEG-07-ENV-ARBITRARY-INJECTION",
      "NEG-08-PROFILE-MALFORMED-PATH-MODE",
      "NEG-09-SECRET-MARKER-LEAK-PREVENTION",
      "NEG-10-DIRECTIONALITY-NO-CORE-CREDS",
    ]);

    expect(report.productionGaps.length).toBeGreaterThan(0);
    const gap3 = report.productionGaps.find((g) => g.startsWith("GAP-3"));
    expect(gap3).toBeDefined();
    expect(gap3).toMatch(/runtime template enforcement/);
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
        listen: "127.0.0.1:8444",
        boardApiKey: "reverse-sample-key",
      };
      const check = validateNoSiteToCoreCredentials(configWithCoreKey);
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/forbidden_reverse_credential/);
    });

    it("enforces fixed runtime template specification (ro-rootfs, cap-drop ALL, non-root uid 10001)", () => {
      // Rejects writable rootfs
      const roCheck = validateRuntimeTemplate({ readonlyRootfs: false });
      expect(roCheck.valid).toBe(false);
      expect(roCheck.reason).toMatch(/readonly_rootfs_required/);

      // Rejects omitted CapDrop ALL
      const capCheck = validateRuntimeTemplate({ capDrop: [] });
      expect(capCheck.valid).toBe(false);
      expect(capCheck.reason).toMatch(/cap_drop_all_required/);

      // Rejects privileged container
      const privCheck = validateRuntimeTemplate({ privileged: true });
      expect(privCheck.valid).toBe(false);
      expect(privCheck.reason).toMatch(/privileged_mode_forbidden/);

      // Rejects root UID 0
      const rootCheck = validateRuntimeTemplate({ user: "0:0" });
      expect(rootCheck.valid).toBe(false);
      expect(rootCheck.reason).toMatch(/non_root_uid_required/);

      // Accepts compliant template
      const validCheck = validateRuntimeTemplate({
        readonlyRootfs: true,
        capDrop: ["ALL"],
        privileged: false,
        user: "10001:10001",
      });
      expect(validCheck.valid).toBe(true);
    });

    it("fails with clear error when no allowed scratch directory is configured (prohibiting os.tmpdir fallback)", () => {
      const origScratch = process.env.PAPERCLIP_SCRATCH_DIR;
      const origRunScratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
      const origHome = process.env.HOME;
      try {
        delete process.env.PAPERCLIP_SCRATCH_DIR;
        delete process.env.PAPERCLIP_RUN_SCRATCH_DIR;
        delete process.env.HOME;
        expect(() => resolveAllowedScratchDir()).toThrow(/Ephemeral test PKI requires an allowed scratch directory/);
      } finally {
        if (origScratch) process.env.PAPERCLIP_SCRATCH_DIR = origScratch;
        if (origRunScratch) process.env.PAPERCLIP_RUN_SCRATCH_DIR = origRunScratch;
        if (origHome) process.env.HOME = origHome;
      }
    });
  });
});
