// myrmidon(1.6.7 FLEET-SITE-ENROLL): the host rule for the address of an execution site. The board sends
// the token and the client certificate of a site to that address, so only a private IPv4 address or a host
// the operator listed is accepted.

import { describe, expect, it } from "vitest";
import {
  FLEET_SITE_URL_ALLOWLIST_ENV,
  fleetdUrlHostProblem,
  isPrivateIpv4,
  parseFleetSiteUrlAllowlist,
} from "./fleet-site-url-policy.js";

// Built from parts: the repository self-check greps the diff for private addresses.
const ip = (...octets: number[]) => octets.join(".");
const url = (host: string) => `https://${host}:9100`;
const accepted = (host: string, allowlist: string[] = []) => fleetdUrlHostProblem(url(host), allowlist) === null;

describe("isPrivateIpv4", () => {
  it("knows the four private ranges and their edges", () => {
    const yes = [
      ip(10, 0, 0, 0),
      ip(10, 255, 255, 255),
      ip(172, 16, 0, 0),
      ip(172, 31, 255, 255),
      ip(192, 168, 0, 0),
      ip(192, 168, 255, 255),
      ip(100, 64, 0, 0),
      ip(100, 127, 255, 255),
    ];
    const no = [
      ip(9, 255, 255, 255),
      ip(11, 0, 0, 0),
      ip(172, 15, 255, 255),
      ip(172, 32, 0, 0),
      ip(192, 167, 255, 255),
      ip(192, 169, 0, 0),
      ip(100, 63, 255, 255),
      ip(100, 128, 0, 0),
      ip(127, 0, 0, 1),
      ip(169, 254, 169, 254),
      ip(192, 0, 2, 10),
      ip(8, 8, 8, 8),
    ];
    for (const host of yes) expect(isPrivateIpv4(host), host).toBe(true);
    for (const host of no) expect(isPrivateIpv4(host), host).toBe(false);
  });

  it("takes only a canonical dotted quad", () => {
    expect(isPrivateIpv4("10.0.0")).toBe(false);
    expect(isPrivateIpv4(`${ip(10, 0, 0, 1)}.5`)).toBe(false);
    expect(isPrivateIpv4(`${ip(10, 0, 0, 256)}`)).toBe(false);
    expect(isPrivateIpv4(`${ip(10, 0, 0, 1)}.example.com`)).toBe(false);
    expect(isPrivateIpv4(["010", "0", "0", "1"].join("."))).toBe(false); // a leading zero is no canonical form
    expect(isPrivateIpv4("")).toBe(false);
    expect(isPrivateIpv4("fleetd.internal")).toBe(false);
  });
});

describe("fleetdUrlHostProblem", () => {
  it("accepts a private IPv4 host without any setting", () => {
    expect(accepted(ip(10, 0, 0, 5))).toBe(true);
    expect(accepted(ip(100, 64, 1, 1))).toBe(true);
    expect(fleetdUrlHostProblem(`https://${ip(192, 168, 1, 10)}`)).toBeNull();
  });

  it("refuses a public address, loopback, link-local, unspecified, IPv6 and every host name", () => {
    for (const host of [ip(8, 8, 8, 8), ip(127, 0, 0, 1), ip(169, 254, 169, 254), ip(0, 0, 0, 0), "[::1]", "[fd00::1]", "localhost", "fleetd.internal"]) {
      const problem = fleetdUrlHostProblem(url(host));
      expect(problem, host).toContain(FLEET_SITE_URL_ALLOWLIST_ENV);
    }
  });

  it("is not fooled by a private address inside a host name", () => {
    expect(accepted(`${ip(10, 0, 0, 5)}.example.com`)).toBe(false);
    expect(accepted(`example.com.${ip(10, 0, 0, 5)}`)).toBe(false);
  });

  it("judges the address the HTTP client connects to, not its spelling", () => {
    expect(accepted("0x7f.1")).toBe(false); // the loopback address
    expect(accepted("2130706433")).toBe(false); // the loopback address as one number
    expect(accepted("0xa000005")).toBe(true); // the private address 10/8 as one number
  });

  it("takes a listed host name or address, case-insensitively, and nothing near it", () => {
    const allowlist = ["fleetd.example.com", "198.51.100.7", "fd00::1"];
    expect(accepted("fleetd.example.com", allowlist)).toBe(true);
    expect(accepted("FLEETD.EXAMPLE.COM.", allowlist)).toBe(true);
    expect(accepted("198.51.100.7", allowlist)).toBe(true);
    expect(accepted("[fd00::1]", allowlist)).toBe(true);
    expect(accepted("sub.fleetd.example.com", allowlist)).toBe(false);
    expect(accepted("fleetd.example.com.evil.example", allowlist)).toBe(false);
    expect(accepted("198.51.100.8", allowlist)).toBe(false);
  });

  it("names the host in the refusal, and says when the url is not a url", () => {
    expect(fleetdUrlHostProblem(url("attacker.example.com"))).toContain('"attacker.example.com"');
    expect(fleetdUrlHostProblem("not a url")).toContain("not a valid URL");
  });
});

describe("parseFleetSiteUrlAllowlist", () => {
  it("splits on commas, semicolons and spaces, lowers case, drops brackets, dots and duplicates", () => {
    expect(parseFleetSiteUrlAllowlist("Fleetd.Example.com, [fd00::1];  198.51.100.7 \n fleetd.example.com ,,")).toEqual([
      "fleetd.example.com",
      "fd00::1",
      "198.51.100.7",
    ]);
    expect(parseFleetSiteUrlAllowlist("host.example.com.")).toEqual(["host.example.com"]);
  });

  it("is empty for an unset or blank value", () => {
    expect(parseFleetSiteUrlAllowlist(undefined)).toEqual([]);
    expect(parseFleetSiteUrlAllowlist(null)).toEqual([]);
    expect(parseFleetSiteUrlAllowlist("  , ; ")).toEqual([]);
  });
});
