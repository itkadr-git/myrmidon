import { describe, expect, it } from "vitest";
import {
  compileT3Profile,
  gatewayTarget,
  hasT3Drift,
  requireDigest,
  requireRemoteHost,
  t3ProfileHash,
  testT3SiteProfile,
} from "./remote-site-t3-contract.js";

describe("remote T3 site contract", () => {
  it("provides a deterministic fixture profile and hash", () => {
    const profile = testT3SiteProfile();
    expect(compileT3Profile(profile)).toEqual(profile);
    expect(t3ProfileHash(profile)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(t3ProfileHash(profile)).toBe(t3ProfileHash({ ...profile, mcpEndpoints: [...profile.mcpEndpoints] }));
  });

  it("keeps gateway targeting site-specific and refuses missing remote hosts", () => {
    const profile = testT3SiteProfile();
    expect(gatewayTarget(profile)).toEqual({ siteId: "t3-a", url: "http://t3-a.example.test:4317" });
    expect(() => requireRemoteHost(testT3SiteProfile({ host: null }))).toThrow("Remote site host is required");
  });

  it("requires immutable image digests and detects runtime drift", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(requireDigest(digest)).toBe(digest);
    expect(() => requireDigest("latest")).toThrow("sha256 digest");
    const state = { profileHash: "p", imageDigest: digest, limits: { cpu: "2", memory: "4g" } };
    expect(hasT3Drift(state, { ...state })).toBe(false);
    expect(hasT3Drift(state, { ...state, profileHash: "other" })).toBe(true);
    expect(hasT3Drift(state, { ...state, imageDigest: `sha256:${"b".repeat(64)}` })).toBe(true);
    expect(hasT3Drift(state, { ...state, limits: { cpu: "1", memory: "4g" } })).toBe(true);
  });
});
