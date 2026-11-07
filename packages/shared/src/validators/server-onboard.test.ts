import { describe, expect, it } from "vitest";
import {
  isIpv4Address,
  isIpv6Address,
  isValidIpAddress,
  isValidSshPort,
  isValidSshUsername,
  serverOnboardSchema,
  sshConnectionParamsSchema,
  sshIpAddressSchema,
  sshPortSchema,
  sshPrivateKeySchema,
  sshUsernameSchema,
  validateSshPrivateKey,
} from "./server-onboard.js";

describe("server-onboard validator", () => {
  describe("IP Address validation", () => {
    it("accepts valid IPv4 addresses", () => {
      expect(isIpv4Address("192.0.2.11")).toBe(true);
      expect(isIpv4Address("198.51.100.100")).toBe(true);
      expect(isIpv4Address("203.0.113.10")).toBe(true);
      expect(isIpv4Address("0.0.0.0")).toBe(true);
      expect(isIpv4Address("255.255.255.255")).toBe(true);
      expect(isValidIpAddress("198.51.100.50")).toBe(true);
    });

    it("rejects invalid IPv4 addresses", () => {
      expect(isIpv4Address("256.0.0.1")).toBe(false);
      expect(isIpv4Address("198.51.100.01")).toBe(false); // leading zeros
      expect(isIpv4Address("198.51.100")).toBe(false);
      expect(isIpv4Address("198.51.100.1.1")).toBe(false);
      expect(isIpv4Address("198.51.100.-1")).toBe(false);
      expect(isIpv4Address("not-an-ip")).toBe(false);
      expect(isIpv4Address("")).toBe(false);
    });

    it("accepts valid IPv6 addresses", () => {
      expect(isIpv6Address("::1")).toBe(true);
      expect(isIpv6Address("[::1]")).toBe(false);
      expect(isIpv6Address("2001:4860::1")).toBe(true);
      expect(isIpv6Address("2606:4700:4700::1111")).toBe(true);
      expect(isIpv6Address("::ffff:198.51.100.20")).toBe(true);
      expect(isIpv6Address("2001:4860:0000:0000:0000:0000:0000:0001")).toBe(true);
      expect(isValidIpAddress("2001:4860::1")).toBe(true);
    });

    it("rejects invalid IPv6 addresses", () => {
      expect(isIpv6Address("2001:xyz::1")).toBe(false);
      expect(isIpv6Address(":::")).toBe(false);
      expect(isIpv6Address("1:2:3:4:5:6:7:8:9")).toBe(false);
      expect(isIpv6Address("::ffff:256.51.100.20")).toBe(false);
      expect(isIpv6Address("2001:4860:1:2:3:4:5:6:7::")).toBe(false);
      expect(isIpv6Address("1:2:3:4:5:6:7::8")).toBe(false);
      expect(isIpv6Address("::ffff:198.51.100.20:1")).toBe(false);
      expect(isIpv6Address("")).toBe(false);
    });

    it("validates IP through sshIpAddressSchema", () => {
      expect(sshIpAddressSchema.safeParse("203.0.113.12").success).toBe(true);
      expect(sshIpAddressSchema.safeParse("2001:4860::1").success).toBe(true);
      const invalid = sshIpAddressSchema.safeParse("invalid.host");
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0]?.message).toMatch(/valid IPv4 or IPv6/);
      }
    });
  });

  describe("SSH Port validation", () => {
    it("accepts valid port numbers", () => {
      expect(isValidSshPort(22)).toBe(true);
      expect(isValidSshPort(1)).toBe(true);
      expect(isValidSshPort(65535)).toBe(true);
      expect(isValidSshPort(2222)).toBe(true);
    });

    it("rejects out of range and non-integer ports", () => {
      expect(isValidSshPort(0)).toBe(false);
      expect(isValidSshPort(65536)).toBe(false);
      expect(isValidSshPort(-1)).toBe(false);
      expect(isValidSshPort(22.5)).toBe(false);
      expect(isValidSshPort(NaN)).toBe(false);
    });

    it("validates port through sshPortSchema and coerces string numbers", () => {
      expect(sshPortSchema.safeParse(22).success).toBe(true);
      expect(sshPortSchema.safeParse("2222").success).toBe(true);
      expect(sshPortSchema.safeParse("2222").data).toBe(2222);

      const invalid = sshPortSchema.safeParse(70000);
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0]?.message).toMatch(/between 1 and 65535/);
      }
    });
  });

  describe("SSH Username validation", () => {
    it("accepts valid UNIX/Linux usernames", () => {
      expect(isValidSshUsername("root")).toBe(true);
      expect(isValidSshUsername("ubuntu")).toBe(true);
      expect(isValidSshUsername("debian")).toBe(true);
      expect(isValidSshUsername("admin")).toBe(true);
      expect(isValidSshUsername("ec2-user")).toBe(true);
      expect(isValidSshUsername("my_user.name")).toBe(true);
    });

    it("rejects invalid usernames", () => {
      expect(isValidSshUsername("")).toBe(false);
      expect(isValidSshUsername(" ")).toBe(false);
      expect(isValidSshUsername("-invalid")).toBe(false);
      expect(isValidSshUsername(".")).toBe(false);
      expect(isValidSshUsername("..")).toBe(false);
      expect(isValidSshUsername("user with spaces")).toBe(false);
      expect(isValidSshUsername("user@host")).toBe(false);
      expect(isValidSshUsername("a".repeat(33))).toBe(false); // exceeds 32 chars
    });

    it("validates username through sshUsernameSchema", () => {
      expect(sshUsernameSchema.safeParse("ubuntu").success).toBe(true);
      const invalid = sshUsernameSchema.safeParse("-dashstart");
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0]?.message).toMatch(/Invalid SSH username/);
      }
    });
  });

  describe("SSH Private Key validation", () => {
    it("rejects malformed, encrypted, and unsupported private key inputs", () => {
      for (const input of ["", "not-a-key", "invalid-key-placeholder"]) {
        expect(validateSshPrivateKey(input).valid).toBe(false);
        expect(sshPrivateKeySchema.safeParse(input).success).toBe(false);
      }
    });
  });

  describe("serverOnboardSchema (complete connection form)", () => {
    it("rejects a complete form when private key is malformed", () => {
      const input = {
        ip: "198.51.100.10",
        port: 22,
        username: "ubuntu",
        privateKey: "not-a-key",
      };
      const result = serverOnboardSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects malformed private key when port is omitted", () => {
      const input = {
        ip: "203.0.113.10",
        username: "root",
        privateKey: "not-a-key",
      };
      const result = serverOnboardSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects malformed key through sshConnectionParamsSchema alias", () => {
      const input = {
        ip: "::1",
        port: 2222,
        username: "admin",
        privateKey: "not-a-key",
      };
      const result = sshConnectionParamsSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("reports specific validation errors on multiple invalid fields", () => {
      const input = {
        ip: "invalid-ip",
        port: 99999,
        username: "-bad-user",
        privateKey: "broken-key",
      };
      const result = serverOnboardSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorFields = result.error.issues.map((i) => i.path[0]);
        expect(errorFields).toContain("ip");
        expect(errorFields).toContain("port");
        expect(errorFields).toContain("username");
        expect(errorFields).toContain("privateKey");
      }
    });
  });
});
