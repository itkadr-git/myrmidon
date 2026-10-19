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

// Adapter boundary: production integration remains a separate gap.
describe("T3 contract adapter harness", () => {
  it("compiles a hostless profile for local compatibility", () => {
    expect(compileT3Profile(testT3SiteProfile({ host: null })).host).toBeNull();
  });
  it("requires an explicit host for remote operation", () => {
    expect(() => requireRemoteHost(testT3SiteProfile({ host: null }))).toThrow("Remote site host is required");
  });
  it("preserves site-specific profile endpoints and paths", () => {
    const p = testT3SiteProfile();
    expect([p.hindsightUrl, p.llmBaseUrl, p.boardExtraHost, p.volumeRoot, p.network, p.mcpEndpoints]).toEqual([
      "http://t3-a.example.test:4318", "https://llm.example.test/v1", "board.internal.example.test",
      "/srv/paperclip/t3-a", "paperclip-t3-a", ["https://mcp.example.test/a"],
    ]);
  });
  it("changes profile hash when model changes", () => {
    expect(t3ProfileHash(testT3SiteProfile())).not.toBe(t3ProfileHash(testT3SiteProfile({ model: "other-model" })));
  });
  it("changes profile hash when fixture key reference changes without containing a secret", () => {
    const p = testT3SiteProfile();
    expect(p.apiKeyRef).toBe("fixture-key-t3-a");
    expect(t3ProfileHash(p)).not.toBe(t3ProfileHash(testT3SiteProfile({ apiKeyRef: "fixture-key-t3-b" })));
  });
  it("changes profile hash when MCP endpoint changes", () => {
    expect(t3ProfileHash(testT3SiteProfile())).not.toBe(t3ProfileHash(testT3SiteProfile({ mcpEndpoints: ["https://mcp.example.test/b"] })));
  });
  it("routes to the configured remote host and dedicated gateway port", () => {
    expect(gatewayTarget(testT3SiteProfile())).toEqual({ siteId: "t3-a", url: "http://t3-a.example.test:4317" });
    expect(gatewayTarget(testT3SiteProfile({ gatewayPort: 4320 })).url).toBe("http://t3-a.example.test:4320");
  });
  it("validates digest-pinned images and rejects latest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(requireDigest(digest)).toBe(digest);
    expect(() => requireDigest("latest")).toThrow("sha256 digest");
  });
  it("detects digest and resource-limit drift independently", () => {
    const state = { profileHash: "p", imageDigest: `sha256:${"a".repeat(64)}`, limits: { cpu: "2", memory: "4g" } };
    expect(hasT3Drift(state, { ...state })).toBe(false);
    expect(hasT3Drift(state, { ...state, imageDigest: `sha256:${"b".repeat(64)}` })).toBe(true);
    expect(hasT3Drift(state, { ...state, limits: { cpu: "1", memory: "4g" } })).toBe(true);
  });
  it("rejects an invalid fixture port (negative sensitivity check)", () => {
    expect(() => compileT3Profile(testT3SiteProfile({ gatewayPort: 70000 }))).toThrow("valid");
  });
});
