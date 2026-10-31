import { describe, expect, it } from "vitest";
import {
  allowsInsecureRemoteHttp,
  isBotContainerHostname,
  isFleetHostPlacement,
  isLoopbackHostname,
  isRemotePlainHttp,
} from "./transport-security.js";

describe("transport-security", () => {
  it("trusts bot container hostnames for plain http", () => {
    expect(isBotContainerHostname("myrmidon-bot-agent-a")).toBe(true);
    expect(isBotContainerHostname("myrmidon-bot-test-123")).toBe(true);
    expect(isBotContainerHostname("myrmidon-bot-agent-a.evil.com")).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://myrmidon-bot-agent-a:8642"), {})).toBe(true);
  });

  it("trusts fleet host placements for remote plain http", () => {
    const configWithFleetHost = { container: { host: "myr-vm1" } };
    expect(isFleetHostPlacement(configWithFleetHost)).toBe(true);
    expect(allowsInsecureRemoteHttp(new URL("http://192.0.2.110:18701"), configWithFleetHost)).toBe(true);

    const configLocal = { container: { host: "local" } };
    expect(isFleetHostPlacement(configLocal)).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://192.0.2.110:18701"), configLocal)).toBe(false);

    const configNoHost = { container: {} };
    expect(isFleetHostPlacement(configNoHost)).toBe(false);
    expect(allowsInsecureRemoteHttp(new URL("http://192.0.2.110:18701"), configNoHost)).toBe(false);
  });

  it("identifies loopback vs remote plain http correctly", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isRemotePlainHttp(new URL("http://127.0.0.1:8642"))).toBe(false);
    expect(isRemotePlainHttp(new URL("http://192.0.2.110:18701"))).toBe(true);
  });
});
