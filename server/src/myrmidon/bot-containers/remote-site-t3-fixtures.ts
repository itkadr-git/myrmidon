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
