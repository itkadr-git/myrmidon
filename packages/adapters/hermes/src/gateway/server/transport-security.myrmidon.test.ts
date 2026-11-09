// myrmidon(fleet-site audit): the plain-http decision for a bot gateway on a remote site.
//
// Plain http to a non-loopback host is allowed through the site path only when the site record,
// not the card, says so: the site is active and marked private, the site address and the target
// are private IP literals, the target is the site's host, and the target port is inside the
// gateway port range of the site record.

import { afterEach, describe, expect, it } from "vitest";
import {
  INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
  allowsInsecureRemoteHttp,
  isFleetSitePlainHttpAllowed,
  isPrivateAddressHostname,
  resetFleetSiteSecurityForTests,
  resolveFleetSiteTarget,
  setActiveFleetSites,
  type FleetSiteSecurityTarget,
} from "./transport-security.js";

// The same table is in server/src/myrmidon/bot-containers/private-address.myrmidon.test.ts:
// the two copies of the rule must agree.
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

const RANGE = { gatewayPortStart: 18700, gatewayPortEnd: 18799 };

function site(over: Partial<FleetSiteSecurityTarget> = {}): FleetSiteSecurityTarget {
  return {
    name: "site-a",
    url: "https://10.0.0.110:9100",
    status: "active",
    profile: { privateNetwork: true, ...RANGE },
    ...over,
  };
}

const card = { container: { host: "site-a" } };

describe("isPrivateAddressHostname", () => {
  for (const [host, expected] of PRIVATE_VECTORS) {
    it(`${JSON.stringify(host)} is ${expected ? "private" : "not private"}`, () => {
      expect(isPrivateAddressHostname(host)).toBe(expected);
    });
  }

  it("agrees with what the URL parser makes of a host", () => {
    // WHATWG URL turns these into canonical dotted form before the rule sees them.
    expect(isPrivateAddressHostname(new URL("http://10.1:18701").hostname)).toBe(true); // 10.0.0.1
    expect(isPrivateAddressHostname(new URL("http://0x0a000001:18701").hostname)).toBe(true); // 10.0.0.1
    expect(isPrivateAddressHostname(new URL("http://010.0.0.1:18701").hostname)).toBe(false); // 8.0.0.1
    expect(isPrivateAddressHostname(new URL("http://10.0.0.5@evil.example:18701").hostname)).toBe(false);
  });
});

describe("plain http to a registered site: host, port and address", () => {
  afterEach(() => {
    resetFleetSiteSecurityForTests();
  });

  it("allows the site's host on a port inside its gateway range", () => {
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:18701"), card, [site()])).toBe(true);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:18700"), card, [site()])).toBe(true);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:18799"), card, [site()])).toBe(true);
  });

  it("refuses a port outside the range, including the site-agent's own port and the default port", () => {
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:18699"), card, [site()])).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:18800"), card, [site()])).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:9100"), card, [site()])).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:5432"), card, [site()])).toBe(false);
    // http without a port is port 80
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110"), card, [site()])).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:80"), card, [site()])).toBe(false);
  });

  it("refuses another host of the same network", () => {
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.111:18701"), card, [site()])).toBe(false);
  });

  it("a site record without a usable port range allows no plain-http port", () => {
    const url = new URL("http://10.0.0.110:18701");
    expect(allowsInsecureRemoteHttp(url, card, [site({ profile: { privateNetwork: true } })])).toBe(false);
    expect(allowsInsecureRemoteHttp(url, card, [site({ profile: { privateNetwork: true, gatewayPortStart: 18700 } })])).toBe(false);
    expect(
      allowsInsecureRemoteHttp(url, card, [site({ profile: { privateNetwork: true, gatewayPortStart: 18799, gatewayPortEnd: 18700 } })]),
    ).toBe(false);
    expect(
      allowsInsecureRemoteHttp(url, card, [
        site({ profile: { privateNetwork: true, gatewayPortStart: "18700", gatewayPortEnd: "18799" } as never }),
      ]),
    ).toBe(false);
    expect(
      allowsInsecureRemoteHttp(url, card, [site({ profile: { privateNetwork: true, gatewayPortStart: 0, gatewayPortEnd: 70000 } })]),
    ).toBe(false);
    expect(
      allowsInsecureRemoteHttp(url, card, [site({ profile: { privateNetwork: true, gatewayPortStart: 18700.5, gatewayPortEnd: 18799 } })]),
    ).toBe(false);
  });

  it("the private flag does not open a public address, a DNS name or a link-local address", () => {
    for (const host of ["8.8.8.8", "192.0.2.110", "169.254.10.10", "fleetd.example.test", "10.0.0.110.evil.example"]) {
      const target = site({ url: `https://${host}:9100` });
      expect(allowsInsecureRemoteHttp(new URL(`http://${host}:18701`), card, [target])).toBe(false);
    }
  });

  it("a private site address does not open a target that only looks like it", () => {
    // userinfo trick: the host of this URL is the public one
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110@8.8.8.8:18701"), card, [site()])).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110.evil.example:18701"), card, [site()])).toBe(false);
  });

  it("accepts the other private ranges (172.16/12, 192.168/16, 100.64/10) and loopback", () => {
    for (const host of ["172.20.1.5", "192.168.7.7", "100.100.1.1", "127.0.0.1"]) {
      const target = site({ url: `https://${host}:9100` });
      // loopback is never "remote", but the site gate must still agree with it
      expect(isFleetSitePlainHttpAllowed(new URL(`http://${host}:18701`), target)).toBe(true);
    }
  });

  it("keeps the status and flag rules", () => {
    const url = new URL("http://10.0.0.110:18701");
    expect(allowsInsecureRemoteHttp(url, card, [site({ status: "draining" })])).toBe(false);
    expect(allowsInsecureRemoteHttp(url, card, [site({ status: "disabled" })])).toBe(false);
    expect(allowsInsecureRemoteHttp(url, card, [site({ profile: { ...RANGE } })])).toBe(false);
    expect(allowsInsecureRemoteHttp(url, card, [site({ profile: { tunnel: true, ...RANGE } })])).toBe(true);
    expect(allowsInsecureRemoteHttp(url, card, [site({ profile: { private_network: true, ...RANGE } })])).toBe(true);
  });

  it("a site address that is not a URL allows nothing", () => {
    expect(isFleetSitePlainHttpAllowed(new URL("http://10.0.0.110:18701"), site({ url: "not a url" }))).toBe(false);
    expect(isFleetSitePlainHttpAllowed(new URL("http://10.0.0.110:18701"), null)).toBe(false);
    expect(isFleetSitePlainHttpAllowed(new URL("http://10.0.0.110:18701"), undefined)).toBe(false);
  });

  it("the escape hatch and the bot-container host names are not changed by the site rules", () => {
    expect(allowsInsecureRemoteHttp(new URL("http://8.8.8.8:1"), { [INSECURE_REMOTE_HTTP_ESCAPE_HATCH]: true })).toBe(true);
    expect(allowsInsecureRemoteHttp(new URL("http://myrmidon-bot-abc:8642"), {})).toBe(true);
  });
});

describe("the site registry is the only source of the site", () => {
  afterEach(() => {
    resetFleetSiteSecurityForTests();
  });

  it("does not read fleetSite / fleetSites from the card", () => {
    const own = site();
    expect(resolveFleetSiteTarget("site-a", { fleetSite: own })).toBeNull();
    expect(resolveFleetSiteTarget("site-a", { fleetSites: [own] })).toBeNull();
  });

  it("a card cannot override the registry's record with its own", () => {
    // The registry says: not private. The card says: private, on a wider range.
    setActiveFleetSites([site({ profile: { ...RANGE } })]);
    const lying = site({ profile: { privateNetwork: true, gatewayPortStart: 1, gatewayPortEnd: 65535 } });
    const url = new URL("http://10.0.0.110:18701");
    expect(allowsInsecureRemoteHttp(url, { ...card, fleetSite: lying, fleetSites: [lying] })).toBe(false);
    // and the registry's own record decides in the allowed case too
    setActiveFleetSites([site()]);
    expect(allowsInsecureRemoteHttp(url, { ...card, fleetSite: { ...lying, status: "disabled" } })).toBe(true);
    expect(allowsInsecureRemoteHttp(new URL("http://10.0.0.110:22"), { ...card, fleetSite: lying })).toBe(false);
  });

  it("still resolves from the active sites and from options given in code", () => {
    const own = site();
    setActiveFleetSites([own]);
    expect(resolveFleetSiteTarget("site-a", {})).toBe(own);
    resetFleetSiteSecurityForTests();
    expect(resolveFleetSiteTarget("site-a", {}, [own])).toBe(own);
    expect(resolveFleetSiteTarget("site-a", {}, () => own)).toBe(own);
  });
});
