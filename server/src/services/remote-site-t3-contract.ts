import { createHash } from "node:crypto";

export type T3SiteProfile = {
  siteId: string;
  host: string | null;
  gatewayPort: number;
  hindsightUrl: string;
  llmBaseUrl: string;
  boardExtraHost: string;
  volumeRoot: string;
  network: string;
  mcpEndpoints: readonly string[];
  model: string;
  apiKeyRef: string;
};

export type T3RuntimeState = {
  profileHash: string;
  imageDigest: string;
  limits: { cpu: string; memory: string };
};

export type T3GatewayTarget = { url: string; siteId: string };

export function testT3SiteProfile(overrides: Partial<T3SiteProfile> = {}): T3SiteProfile {
  return {
    siteId: "t3-a",
    host: "t3-a.example.test",
    gatewayPort: 4317,
    hindsightUrl: "http://t3-a.example.test:4318",
    llmBaseUrl: "https://llm.example.test/v1",
    boardExtraHost: "board.internal.example.test",
    volumeRoot: "/srv/paperclip/t3-a",
    network: "paperclip-t3-a",
    mcpEndpoints: ["https://mcp.example.test/a"],
    model: "test-model-t3-a",
    apiKeyRef: "fixture-key-t3-a",
    ...overrides,
  };
}

export function compileT3Profile(profile: T3SiteProfile): T3SiteProfile {
  if (!profile.host) return profile;
  if (!Number.isInteger(profile.gatewayPort) || profile.gatewayPort < 1 || profile.gatewayPort > 65535) {
    throw new Error("Remote gateway port must be valid");
  }
  return profile;
}

export function gatewayTarget(profile: T3SiteProfile): T3GatewayTarget {
  if (!profile.host) return { siteId: profile.siteId, url: `http://127.0.0.1:${profile.gatewayPort}` };
  return { siteId: profile.siteId, url: `http://${profile.host}:${profile.gatewayPort}` };
}

export function requireRemoteHost(profile: T3SiteProfile): string {
  if (!profile.host) throw new Error("Remote site host is required");
  return profile.host;
}

export function requireDigest(image: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Image must use a sha256 digest");
  return image;
}

export function t3ProfileHash(profile: T3SiteProfile): string {
  const canonical = JSON.stringify({
    siteId: profile.siteId,
    host: profile.host,
    gatewayPort: profile.gatewayPort,
    hindsightUrl: profile.hindsightUrl,
    llmBaseUrl: profile.llmBaseUrl,
    boardExtraHost: profile.boardExtraHost,
    volumeRoot: profile.volumeRoot,
    network: profile.network,
    mcpEndpoints: [...profile.mcpEndpoints],
    model: profile.model,
    apiKeyRef: profile.apiKeyRef,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function hasT3Drift(expected: T3RuntimeState, actual: T3RuntimeState): boolean {
  return expected.profileHash !== actual.profileHash || expected.imageDigest !== actual.imageDigest ||
    expected.limits.cpu !== actual.limits.cpu || expected.limits.memory !== actual.limits.memory;
}
