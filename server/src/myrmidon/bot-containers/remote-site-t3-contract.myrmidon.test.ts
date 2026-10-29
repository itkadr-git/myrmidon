import { describe, expect, it } from "vitest";
import { parseFleetHosts, type FleetHostConfig } from "./fleetd-hosts.js";
import { effectiveBotSettings, fleetGatewayApiBaseUrl } from "./fleetd-placement.js";
import { fleetRoutingDriver } from "./fleetd-routing.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import { compileHermesProfile, type HermesProfileInput } from "./profile-compiler.js";
import { buildCreateContainerRequestBody, templateDriftFields } from "./docker-driver.js";
import { isImageAllowed } from "./template.js";
import { planGatewayCardSync, createBotCardSync } from "./card-sync.js";
import { botContainerCardSaveProblem, botContainerImageSaveProblem } from "./agent-config.js";
import { compositeDriftFields } from "./drift.js";
import { botImageRolloutSettingsSchema, BOT_IMAGE_ROLLOUT_ENV } from "@myrmidon/shared";

import { T3_A_FIXTURE, t3CompositeDriftFields } from "./remote-site-t3-fixtures.js";
type Driver = BotContainerDriver & { calls: string[] };
function driver(name: string): Driver {
  const calls: string[] = [];
  const status: BotContainerStatus = { botKey: "fixture-bot", state: "running" };
  return Object.assign({
    async status(key: string) { calls.push(`${name}:status:${key}`); return { ...status, botKey: key }; }, async list() { calls.push(`${name}:list`); return [status]; },
    async templateDrift(spec: BotContainerSpec) { calls.push(`${name}:drift:${spec.botKey}`); return { drifted: false, fields: [] }; },
    async create(spec: BotContainerSpec) { calls.push(`${name}:create:${spec.botKey}`); }, async recreate(spec: BotContainerSpec) { calls.push(`${name}:recreate:${spec.botKey}`); },
    async writeProfile(key: string) { calls.push(`${name}:profile:${key}`); }, async start(key: string) { calls.push(`${name}:start:${key}`); },
    async restart(key: string) { calls.push(`${name}:restart:${key}`); }, async stop(key: string) { calls.push(`${name}:stop:${key}`); },
  }, { calls });
}
const container = (host?: string) => host ? { adapterConfig: { container: { host } } } : { adapterConfig: {} };
const profileInput: HermesProfileInput = {
  botKey: "fixture-bot", adapterConfig: { model: "fixture-model", provider: "openrouter" }, env: {}, skills: {}, instructions: "fixture",
  apiServerKey: "fixture-api-key", hindsight: { bankId: "fixture-bank", apiUrl: T3_A_FIXTURE.hindsightUrl },
  llm: { baseUrl: T3_A_FIXTURE.llmBaseUrl, apiKeyEnv: "FIXTURE_LLM_KEY" },
  mcpServers: [{ name: "fixture-mcp", url: "http://mcp.t3-a.example.test/sse" }], maxConcurrentRuns: 1,
  instanceDefaults: {}, paperclipApiUrl: "http://board.example.test", paperclipApiKey: "fixture-board-key",
};
const hostSettings = effectiveBotSettings({ hindsightUrl: "http://board-hindsight", llmBaseUrl: "http://board-llm", volumeRoot: "/board", network: "board-net", imageAllowlist: [], boardHost: "board.example.test" }, T3_A_FIXTURE);
const hostProfileInput: HermesProfileInput = {
  ...profileInput,
  hindsight: { ...profileInput.hindsight, apiUrl: hostSettings.hindsightUrl },
  llm: { ...profileInput.llm, baseUrl: hostSettings.llmBaseUrl },
  mcpServers: (hostSettings.mcpEndpoints ?? []).map((url, index) => ({ name: `t3-mcp-${index}`, url })),
};
describe("T3 regressions against production profile, placement, routing and drift helpers", () => {
  it("parses the synthetic T3 host fixture", () => {
    expect(parseFleetHosts(JSON.stringify([T3_A_FIXTURE])).get("t3-a")).toMatchObject({ name: "t3-a", url: T3_A_FIXTURE.url, llmBaseUrl: T3_A_FIXTURE.llmBaseUrl, mcpEndpoints: T3_A_FIXTURE.mcpEndpoints });
  });
  it("preserves no-host local compatibility", () => {
    const local = { hindsightUrl: "http://local-hindsight", llmBaseUrl: "http://local-llm", volumeRoot: "/local", network: "local-net", imageAllowlist: [], boardHost: "board-local" };
    expect(effectiveBotSettings(local, null)).toBe(local);
  });
  it("applies site overrides for service endpoints and host-local settings", () => expect(effectiveBotSettings({ hindsightUrl: "h", llmBaseUrl: "l", volumeRoot: "/v", network: "n", imageAllowlist: [], boardHost: "b" }, T3_A_FIXTURE)).toEqual({
    hindsightUrl: T3_A_FIXTURE.hindsightUrl, llmBaseUrl: T3_A_FIXTURE.llmBaseUrl, volumeRoot: T3_A_FIXTURE.volumeRoot,
    network: T3_A_FIXTURE.network, imageAllowlist: T3_A_FIXTURE.imageAllowlist, boardHost: T3_A_FIXTURE.boardExtraHost, mcpEndpoints: T3_A_FIXTURE.mcpEndpoints,
  }));
  it("fails explicit remote selection without silently using local", async () => {
    const local = driver("local"), routed = fleetRoutingDriver({ local, fleet: new Map() }, () => container("t3-missing"));
    await expect(routed.start("fixture-bot")).rejects.toThrow(/names no configured fleet host/); expect(local.calls).toEqual([]);
  });
  it("routes remote operations to the selected fleet host only", async () => {
    const local = driver("local"), remote = driver("t3-a"), routed = fleetRoutingDriver({ local, fleet: new Map([["t3-a", remote]]) }, () => container("t3-a"));
    await routed.start("fixture-bot"); expect(remote.calls).toEqual(["t3-a:start:fixture-bot"]); expect(local.calls).toEqual([]);
  });
  it("uses the site hostname with the allocated gateway port", () => expect(fleetGatewayApiBaseUrl(T3_A_FIXTURE.url, 18642)).toBe("http://t3-a.example.test:18642"));
  it("rejects missing and invalid gateway ports", () => {
    expect(() => fleetGatewayApiBaseUrl(T3_A_FIXTURE.url, undefined)).toThrow(/did not report/);
    expect(() => fleetGatewayApiBaseUrl(T3_A_FIXTURE.url, 70000)).toThrow(/invalid gateway port/);
  });
  it("changes compiled restart hash when the model changes", () => expect(compileHermesProfile(profileInput).restartHash).not.toBe(compileHermesProfile({ ...profileInput, adapterConfig: { ...profileInput.adapterConfig, model: "fixture-model-next" } }).restartHash));
  it("changes compiled restart hash when the key reference changes", () => expect(compileHermesProfile(profileInput).restartHash).not.toBe(compileHermesProfile({ ...profileInput, llm: { ...profileInput.llm, apiKeyEnv: "FIXTURE_LLM_KEY_NEXT" } }).restartHash));
  it("propagates host MCP endpoints into the production profile input and restart hash", () => {
    const changed = { ...hostProfileInput, mcpServers: [{ name: "t3-mcp-0", url: "http://mcp.t3-a.example.test/next" }] };
    expect(hostProfileInput.mcpServers).toEqual([{ name: "t3-mcp-0", url: T3_A_FIXTURE.mcpEndpoints?.[0] }]);
    expect(compileHermesProfile(hostProfileInput).restartHash).not.toBe(compileHermesProfile(changed).restartHash);
  });
  it("rejects latest image tags through the production image allowlist helper", () => {
    const imageAllowlist = T3_A_FIXTURE.imageAllowlist ?? [];
    expect(isImageAllowed("ghcr.io/example/bot:latest", imageAllowlist)).toBe(false);
    expect(isImageAllowed("ghcr.io/example/bot@sha256:abc123", imageAllowlist)).toBe(true);
  });
  it("detects image digest and resource-limit drift through Docker production helpers", () => {
    const volumeRoot = T3_A_FIXTURE.volumeRoot ?? "/srv/paperclip/t3-a";
    const network = T3_A_FIXTURE.network ?? "paperclip-t3-a";
    const body = buildCreateContainerRequestBody({ botKey: "fixture-bot", image: "ghcr.io/example/bot@sha256:aaa", memoryMb: 1024, cpus: 1, pidsLimit: 128, network }, { volumeRoot, network, allowlist: ["ghcr.io/example/bot@sha256:*"], mountSources: [], devbuild: { host: null, user: "", base: "" } });
    const inspect = (image: string, memory = body.HostConfig.Memory) => ({ Config: { Image: image }, HostConfig: { ...body.HostConfig, Memory: memory } });
    expect(templateDriftFields(inspect(body.Image), body)).toEqual([]);
    expect(templateDriftFields(inspect("ghcr.io/example/bot@sha256:bbb"), body).map((x) => x.field)).toContain("Config.Image");
    expect(templateDriftFields(inspect(body.Image, body.HostConfig.Memory + 1), body).map((x) => x.field)).toContain("HostConfig.Memory");
  });
  it("detects every composite drift component and is mutation-sensitive", () => {
    const expected = { profileHash: "profile-a", imageDigest: "sha256:a", limits: { memoryMb: 1024, cpus: 1, pidsLimit: 128 } };
    expect(t3CompositeDriftFields(expected, expected)).toEqual([]);
    expect(t3CompositeDriftFields(expected, { ...expected, profileHash: "profile-b" })).toEqual(["profileHash"]);
    expect(t3CompositeDriftFields(expected, { ...expected, imageDigest: "sha256:b" })).toEqual(["imageDigest"]);
    expect(t3CompositeDriftFields(expected, { ...expected, limits: { ...expected.limits, cpus: 2 } })).toEqual(["limits.cpus"]);

    const allMismatched = {
      profileHash: "profile-b",
      imageDigest: "sha256:b",
      limits: { memoryMb: 2048, cpus: 2, pidsLimit: 256 },
    };
    expect(compositeDriftFields(expected, allMismatched)).toEqual([
      "profileHash",
      "imageDigest",
      "limits.memoryMb",
      "limits.cpus",
      "limits.pidsLimit",
    ]);
    expect(compositeDriftFields(expected, expected)).toEqual([]);
  });

  it("rejects latest tag without digest on card save via botContainerCardSaveProblem", () => {
    const err = botContainerCardSaveProblem("hermes_gateway", {
      container: { enabled: true, image: "ghcr.io/example/bot:latest" },
    });
    expect(err).toMatch(/not pinned by digest/);
    expect(botContainerImageSaveProblem("ghcr.io/example/bot:latest")).toMatch(/not pinned by digest/);

    const validDigest = "ghcr.io/example/bot@sha256:" + "a".repeat(64);
    expect(botContainerCardSaveProblem("hermes_gateway", { container: { enabled: true, image: validDigest } })).toBeNull();
  });

  it("syncs card apiBaseUrl to fleetGatewayApiBaseUrl and handles gatewayPort", async () => {
    const plan = planGatewayCardSync(
      { apiBaseUrl: "http://old-local:18701" },
      {
        botKey: "fixture-bot",
        apiKeySecretId: "secret-1",
        apiKeyVersion: 1,
        fleetGatewayApiBaseUrl: "http://192.0.2.110:18642",
        gatewayPort: 18642,
      },
    );
    expect(plan.changedKeys).toContain("apiBaseUrl");
    expect(plan.adapterConfig.apiBaseUrl).toBe("http://192.0.2.110:18642");

    let savedConfig: Record<string, unknown> | null = null;
    const sync = createBotCardSync({
      loadAgent: async () => ({
        id: "agent-1",
        companyId: "company-1",
        name: "agent-1",
        adapterType: "hermes_gateway",
        adapterConfig: {
          container: { host: "t3-a" },
          apiBaseUrl: "http://old:18701",
        },
      }),
      ensureApiServerKey: async () => ({ value: "secret-val", secretId: "secret-1", version: 1 }),
      saveAdapterConfig: async (_agent, cfg) => {
        savedConfig = cfg;
      },
      fleetSiteUrl: async (_cid, host) => (host === "t3-a" ? T3_A_FIXTURE.url : null),
      status: async () => ({ gatewayPort: 18642 }),
    });

    const result = await sync("agent-1", "fixture-bot", 1);
    expect(result.changedKeys).toContain("apiBaseUrl");
    expect(savedConfig).toMatchObject({
      apiBaseUrl: "http://t3-a.example.test:18642",
    });
  });

  it("supports site filter in image rollout settings", () => {
    expect(botImageRolloutSettingsSchema.parse({ site: "myr-vm1" })).toEqual({ site: "myr-vm1" });
    expect(BOT_IMAGE_ROLLOUT_ENV.site).toBe("MYRMIDON_BOT_IMAGE_ROLLOUT_SITE");
  });
});
