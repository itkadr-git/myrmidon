// myrmidon(fleet-site audit): the private-address rule of the fleet site settings.
// The adapter has a copy of the rule (transport-security.ts); its test carries the same table.

import { describe, expect, it } from "vitest";
import { hostnameOfUrl, isPrivateAddressHostname, isPrivateUrl } from "./private-address.js";

const PRIVATE_VECTORS: Array<[string, boolean]> = [
  ["10.0.0.1", true],
  ["10.255.255.255", true],
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["172.15.255.255", false],
  ["172.32.0.1", false],
  ["192.168.1.1", true],
  ["192.169.0.1", false],
  ["100.64.0.1", true],
  ["100.127.255.255", true],
  ["100.63.255.255", false],
  ["100.128.0.1", false],
  ["127.0.0.1", true],
  ["127.1.2.3", true],
  ["localhost", true],
  ["LOCALHOST", true],
  ["[::1]", true],
  ["::1", true],
  ["8.8.8.8", false],
  ["11.0.0.1", false],
  ["169.254.1.1", false],
  ["192.0.2.10", false],
  ["0.0.0.0", false],
  ["10.0.0.256", false],
  ["10.0.0", false],
  ["10.0.0.1.5", false],
  ["010.0.0.1", false],
  ["10.00.0.1", false],
  ["10.0.0.1.evil.example", false],
  ["evil.example", false],
  ["fleetd.internal", false],
  ["site-host", false],
  ["[fd00::1]", false],
  ["[2001:db8::1]", false],
  ["", false],
];

describe("isPrivateAddressHostname", () => {
  for (const [host, expected] of PRIVATE_VECTORS) {
    it(`${JSON.stringify(host)} is ${expected ? "private" : "not private"}`, () => {
      expect(isPrivateAddressHostname(host)).toBe(expected);
    });
  }
});

describe("isPrivateUrl", () => {
  it("looks at the host the URL parser finds", () => {
    expect(isPrivateUrl("https://10.0.0.5:9100")).toBe(true);
    expect(isPrivateUrl("http://10.1:9100")).toBe(true); // 10.0.0.1
    expect(isPrivateUrl("http://010.0.0.1:9100")).toBe(false); // 8.0.0.1
    expect(isPrivateUrl("http://10.0.0.5@evil.example:9100")).toBe(false);
    expect(isPrivateUrl("http://[::1]:9100")).toBe(true);
    expect(isPrivateUrl("https://fleetd.example.test:9100")).toBe(false);
    expect(isPrivateUrl("10.0.0.5:9100")).toBe(false);
    expect(isPrivateUrl("")).toBe(false);
  });

  it("hostnameOfUrl is null for text that is not an absolute URL", () => {
    expect(hostnameOfUrl("not a url")).toBeNull();
    expect(hostnameOfUrl("https://10.0.0.5:9100/x")).toBe("10.0.0.5");
  });
});
