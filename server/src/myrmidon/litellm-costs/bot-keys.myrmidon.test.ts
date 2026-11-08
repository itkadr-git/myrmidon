import { describe, expect, it } from "vitest";

import {
  readGatewayBotKeySettings,
  resolveGatewayBotKeys,
  type GatewayBotCard,
  type GatewayBotKeyPorts,
} from "./bot-keys.js";
import { botKeyIndex, collectRows, gatewayKeyHash, type SpendLogEntry } from "./litellm-costs.js";

// Neutral ids only (no real agents, keys or hosts).

const COMPANY = "company-1";
const KEY_ENV = "FLEET_LLM_API_KEY";
const SETTINGS = { keyEnv: KEY_ENV, keySecret: "fleet-llm-shared-key" };

function card(agentId: string, env: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): GatewayBotCard {
  return { agentId, adapterType: "hermes_gateway", adapterConfig: { ...(env ? { env } : {}), ...extra } };
}

function secretRef(secretId: string, version: number | "latest" = "latest") {
  return { type: "secret_ref", secretId, version };
}

/** Secrets by id (with versions) and by name; records every call. */
function fakePorts(
  byId: Record<string, Record<string, string>>,
  byName: Record<string, string> = {},
): GatewayBotKeyPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveSecretById(companyId, secretId, version) {
      calls.push(`id:${secretId}@${version}`);
      const versions = byId[secretId];
      const value = versions?.[String(version)];
      if (companyId !== COMPANY || value === undefined) throw new Error("Secret not found");
      return value;
    },
    async readSecretByName(companyId, name) {
      calls.push(`name:${name}`);
      return companyId === COMPANY ? (byName[name] ?? null) : null;
    },
  };
}

function entry(overrides: Partial<SpendLogEntry> = {}): SpendLogEntry {
  return {
    requestId: "req-1",
    apiKey: gatewayKeyHash("sk-test-key-agent-a"),
    spend: 0.02,
    promptTokens: 100,
    completionTokens: 50,
    startTime: "2026-09-30T10:05:00.000Z",
    model: "openai/example-model",
    provider: "openai",
    ...overrides,
  };
}

describe("myrmidon(M2-A secret_ref) gateway bot keys", () => {
  it("resolves a card's secret_ref binding and attributes the spend row to that agent and run", async () => {
    const ports = fakePorts({ "secret-a": { latest: "sk-test-key-agent-a" } });
    const keys = await resolveGatewayBotKeys(COMPANY, [card("agent-a", { [KEY_ENV]: secretRef("secret-a") })], SETTINGS, ports);
    expect(keys).toEqual([{ agentId: "agent-a", keyValue: "sk-test-key-agent-a" }]);
    // The card's own binding wins: the shared secret is never read.
    expect(ports.calls).toEqual(["id:secret-a@latest"]);

    const { rows, skippedUnattributed } = collectRows([entry()], botKeyIndex(keys), [
      {
        runId: "run-1",
        agentId: "agent-a",
        issueId: "issue-1",
        startedAt: new Date("2026-09-30T10:00:00Z"),
        finishedAt: new Date("2026-09-30T10:10:00Z"),
      },
    ]);
    expect(skippedUnattributed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: "agent-a", heartbeatRunId: "run-1", issueId: "issue-1", costCents: 2 });
  });

  it("gives each bot its own key when every card binds its own secret", async () => {
    const ports = fakePorts({
      "secret-a": { latest: "sk-test-key-agent-a" },
      "secret-b": { "3": "sk-test-key-agent-b" },
    });
    const keys = await resolveGatewayBotKeys(
      COMPANY,
      [card("agent-a", { [KEY_ENV]: secretRef("secret-a") }), card("agent-b", { [KEY_ENV]: secretRef("secret-b", 3) })],
      SETTINGS,
      ports,
    );
    expect(keys).toEqual([
      { agentId: "agent-a", keyValue: "sk-test-key-agent-a" },
      { agentId: "agent-b", keyValue: "sk-test-key-agent-b" },
    ]);
    expect(ports.calls).toContain("id:secret-b@3");
  });

  it("still takes an inline value binding", async () => {
    const ports = fakePorts({});
    const keys = await resolveGatewayBotKeys(
      COMPANY,
      [card("agent-a", { [KEY_ENV]: { type: "plain", value: " sk-inline-a " } }), card("agent-b", { [KEY_ENV]: "sk-inline-b" })],
      SETTINGS,
      ports,
    );
    expect(keys).toEqual([
      { agentId: "agent-a", keyValue: "sk-inline-a" },
      { agentId: "agent-b", keyValue: "sk-inline-b" },
    ]);
    expect(ports.calls).toEqual([]);
  });

  it("skips a card whose secret_ref cannot be resolved instead of falling back to the shared key", async () => {
    const ports = fakePorts({}, { "fleet-llm-shared-key": "sk-shared" });
    const keys = await resolveGatewayBotKeys(
      COMPANY,
      [
        card("agent-missing", { [KEY_ENV]: secretRef("secret-gone") }),
        card("agent-bad-version", { [KEY_ENV]: secretRef("secret-a", 0 as unknown as number) }),
      ],
      SETTINGS,
      ports,
    );
    expect(keys).toEqual([]);
    expect(ports.calls).toEqual(["id:secret-gone@latest"]);

    const { rows, skippedUnattributed } = collectRows([entry({ apiKey: gatewayKeyHash("sk-shared") })], botKeyIndex(keys), []);
    expect(rows).toEqual([]);
    expect(skippedUnattributed).toBe(1);
  });

  it("falls back to the shared company secret, read once, for cards that bind no key", async () => {
    const ports = fakePorts({}, { "fleet-llm-shared-key": "sk-shared" });
    const keys = await resolveGatewayBotKeys(
      COMPANY,
      [card("agent-a", undefined), card("agent-b", { OTHER: "x" })],
      SETTINGS,
      ports,
    );
    expect(keys).toEqual([
      { agentId: "agent-a", keyValue: "sk-shared" },
      { agentId: "agent-b", keyValue: "sk-shared" },
    ]);
    expect(ports.calls).toEqual(["name:fleet-llm-shared-key"]);
  });

  it("skips cards that do not go through the gateway and every card without a key env name", async () => {
    const ports = fakePorts({ "secret-a": { latest: "sk-test-key-agent-a" } });
    const own = card("agent-own", { [KEY_ENV]: secretRef("secret-a") }, { provider: "openrouter" });
    const other: GatewayBotCard = { agentId: "agent-proc", adapterType: "process", adapterConfig: { env: { [KEY_ENV]: secretRef("secret-a") } } };
    expect(await resolveGatewayBotKeys(COMPANY, [own, other], SETTINGS, ports)).toEqual([]);
    expect(
      await resolveGatewayBotKeys(COMPANY, [card("agent-a", { [KEY_ENV]: secretRef("secret-a") })], { keyEnv: null, keySecret: null }, ports),
    ).toEqual([]);
    expect(ports.calls).toEqual([]);
  });

  it("reads the key env name and the shared secret name from the instance settings", () => {
    expect(readGatewayBotKeySettings({})).toEqual({ keyEnv: null, keySecret: null });
    expect(readGatewayBotKeySettings({ MYRMIDON_BOT_LLM_API_KEY_ENV: ` ${KEY_ENV} ` })).toEqual({ keyEnv: KEY_ENV, keySecret: KEY_ENV });
    expect(
      readGatewayBotKeySettings({ MYRMIDON_BOT_LLM_API_KEY_ENV: KEY_ENV, MYRMIDON_BOT_LLM_API_KEY_SECRET: "fleet-llm-shared-key" }),
    ).toEqual(SETTINGS);
  });
});
