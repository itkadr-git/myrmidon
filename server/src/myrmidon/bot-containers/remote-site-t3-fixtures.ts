import type { FleetHostConfig } from "./fleetd-hosts.js";

/** Safe test-only T3 profile. Values are deliberately synthetic, including the secret reference. */
export const T3_A_FIXTURE: FleetHostConfig = {
  name: "t3-a",
  url: "http://t3-a.example.test:9100",
  tokenSecret: "fixture-fleet-token-ref",
  hindsightUrl: "http://hindsight.t3-a.example.test:8890",
  llmBaseUrl: "http://llm.t3-a.example.test:4000",
  mcpEndpoints: ["http://mcp.t3-a.example.test/sse"],
  boardExtraHost: "board.example.test",
  volumeRoot: "/srv/paperclip/t3-a",
  network: "paperclip-t3-a",
  imageAllowlist: ["ghcr.io/example/bot@sha256:*"],
};

export interface T3CompositeDriftInput {
  profileHash: string;
  imageDigest: string;
  limits: { memoryMb: number; cpus: number; pidsLimit: number };
}

/** Test-only contract adapter until the production reconciler owns this composite. */
export function t3CompositeDriftFields(expected: T3CompositeDriftInput, actual: T3CompositeDriftInput): string[] {
  const fields: string[] = [];
  if (expected.profileHash !== actual.profileHash) fields.push("profileHash");
  if (expected.imageDigest !== actual.imageDigest) fields.push("imageDigest");
  for (const key of ["memoryMb", "cpus", "pidsLimit"] as const) {
    if (expected.limits[key] !== actual.limits[key]) fields.push(`limits.${key}`);
  }
  return fields;
}
