import { afterEach, describe, expect, it } from "vitest";
import {
  INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
  allowsInsecureRemoteHttp,
  isBotContainerHostname,
  isFleetHostPlacement,
  isLoopbackHostname,
  isRemotePlainHttp,
  isSitePrivateNetwork,
  resetFleetSiteSecurityForTests,
  setActiveFleetSites,
  setFleetSiteSecurityResolver,
  type FleetSiteSecurityTarget,
} from "./transport-security.js";

describe("transport-security", () => {
  afterEach(() => {
    resetFleetSiteSecurityForTests();
  });

  it("trusts bot container hostnames for plain http", () => {
    expect(isBotContainerHostname("myrmidon-bot-agent-a")).toBe(true);
    expect(isBotContainerHostname("myrmidon-bot-test-123")).toBe(true);
    expect(isBotContainerHostname("myrmidon-bot-agent-a.evil.com")).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://myrmidon-bot-agent-a:8642"), {})).toBe(true);
  });

  it("identifies loopback vs remote plain http correctly", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isRemotePlainHttp(new URL("http://127.0.0.1:8642"))).toBe(false);
    expect(isRemotePlainHttp(new URL("http://192.0.2.110:18701"))).toBe(true);
  });

  // myrmidon(OPE-10200): plain HTTP only to the gateway of an active registered private fleet site
  describe("fleet site plain http policy (OPE-10200)", () => {
    const configWithFleetHost = { container: { host: "myr-vm1" } };
    const sitePrivate: FleetSiteSecurityTarget = {
      name: "myr-vm1",
      url: "http://192.0.2.110:9100",
      status: "active",
      profile: { privateNetwork: true },
    };
    const siteNoFlag: FleetSiteSecurityTarget = {
      name: "myr-vm1",
      url: "http://192.0.2.110:9100",
      status: "active",
      profile: {},
    };

    it("1. карточка с host=myr-vm1, apiBaseUrl на чужой хост → отказ", () => {
      // apiBaseUrl points to another host, not the registered fleet site host
      const foreignUrl = new URL("http://192.0.2.200:18701");
      expect(allowsInsecureRemoteHttp(foreignUrl, configWithFleetHost, [sitePrivate])).toBe(false);

      const foreignHostUrl = new URL("http://other-datacenter.internal:18701");
      expect(allowsInsecureRemoteHttp(foreignHostUrl, configWithFleetHost, [sitePrivate])).toBe(false);
    });

    it("2. apiBaseUrl на хост площадки без флага приватной сети → отказ", () => {
      // Host matches, but site profile has no privateNetwork/tunnel flag (defaults to false)
      const siteGatewayUrl = new URL("http://192.0.2.110:18701");
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteNoFlag])).toBe(false);

      const siteExplicitFalse: FleetSiteSecurityTarget = {
        name: "myr-vm1",
        url: "http://192.0.2.110:9100",
        status: "active",
        profile: { privateNetwork: false, tunnel: false },
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteExplicitFalse])).toBe(false);
    });

    it("3. с флагом → разрешено (privateNetwork, tunnel, private_network)", () => {
      const siteGatewayUrl = new URL("http://192.0.2.110:18701");

      // with privateNetwork flag
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [sitePrivate])).toBe(true);

      // with tunnel flag
      const siteTunnel: FleetSiteSecurityTarget = {
        name: "myr-vm1",
        url: "http://192.0.2.110:9100",
        status: "active",
        profile: { tunnel: true },
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteTunnel])).toBe(true);

      // with private_network flag
      const siteSnakeCase: FleetSiteSecurityTarget = {
        name: "myr-vm1",
        url: "http://192.0.2.110:9100",
        status: "active",
        profile: { private_network: true },
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteSnakeCase])).toBe(true);
    });

    it("4. карточка без host → поведение прежнее", () => {
      const remoteUrl = new URL("http://192.0.2.110:18701");

      const configLocal = { container: { host: "local" } };
      expect(isFleetHostPlacement(configLocal)).toBe(false);
      expect(allowsInsecureRemoteHttp(remoteUrl, configLocal, [sitePrivate])).toBe(false);

      const configNoHost = { container: {} };
      expect(isFleetHostPlacement(configNoHost)).toBe(false);
      expect(allowsInsecureRemoteHttp(remoteUrl, configNoHost, [sitePrivate])).toBe(false);

      const configEmpty = {};
      expect(isFleetHostPlacement(configEmpty)).toBe(false);
      expect(allowsInsecureRemoteHttp(remoteUrl, configEmpty, [sitePrivate])).toBe(false);

      // Bot container hostname is still trusted without fleet site
      expect(allowsInsecureRemoteHttp(new URL("http://myrmidon-bot-agent-a:8642"), configNoHost)).toBe(true);

      // Dev escape hatch is still trusted
      expect(
        allowsInsecureRemoteHttp(remoteUrl, {
          ...configNoHost,
          [INSECURE_REMOTE_HTTP_ESCAPE_HATCH]: true,
        }),
      ).toBe(true);
    });

    it("rejects non-active fleet sites even with private network flag", () => {
      const siteGatewayUrl = new URL("http://192.0.2.110:18701");

      const siteDraining: FleetSiteSecurityTarget = {
        name: "myr-vm1",
        url: "http://192.0.2.110:9100",
        status: "draining",
        profile: { privateNetwork: true },
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteDraining])).toBe(false);

      const siteDisabled: FleetSiteSecurityTarget = {
        name: "myr-vm1",
        url: "http://192.0.2.110:9100",
        status: "disabled",
        profile: { privateNetwork: true },
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost, [siteDisabled])).toBe(false);
    });

    it("supports resolution via setActiveFleetSites and setFleetSiteSecurityResolver", () => {
      const siteGatewayUrl = new URL("http://192.0.2.110:18701");

      // Before registering: rejected
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost)).toBe(false);

      // Via setActiveFleetSites:
      setActiveFleetSites([sitePrivate]);
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost)).toBe(true);

      // Reset
      resetFleetSiteSecurityForTests();
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost)).toBe(false);

      // Via setFleetSiteSecurityResolver:
      setFleetSiteSecurityResolver((name) => (name === "myr-vm1" ? sitePrivate : null));
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithFleetHost)).toBe(true);
    });

    it("supports fleetSites / fleetSite embedded directly in adapter config", () => {
      const siteGatewayUrl = new URL("http://192.0.2.110:18701");
      const configWithEmbeddedSites = {
        container: { host: "myr-vm1" },
        fleetSites: [sitePrivate],
      };
      expect(allowsInsecureRemoteHttp(siteGatewayUrl, configWithEmbeddedSites)).toBe(true);
    });

    it("isSitePrivateNetwork correctly validates profile flags", () => {
      expect(isSitePrivateNetwork(undefined)).toBe(false);
      expect(isSitePrivateNetwork(null)).toBe(false);
      expect(isSitePrivateNetwork({})).toBe(false);
      expect(isSitePrivateNetwork({ privateNetwork: false })).toBe(false);
      expect(isSitePrivateNetwork({ privateNetwork: true })).toBe(true);
      expect(isSitePrivateNetwork({ tunnel: true })).toBe(true);
      expect(isSitePrivateNetwork({ private_network: true })).toBe(true);
    });
  });
});
