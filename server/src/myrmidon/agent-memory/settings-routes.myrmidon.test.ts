import { describe, expect, it } from "vitest";
import { agentMemorySettingsService } from "./settings-routes.js";

function makeService(initial: unknown, env: NodeJS.ProcessEnv = {}, fetchImpl?: typeof fetch) {
  let stored = initial;
  const service = agentMemorySettingsService({
    getGeneral: async () => ({ agentMemory: stored }),
    updateGeneral: async (patch) => {
      stored = patch.agentMemory;
    },
    env,
    fetchImpl: fetchImpl as any,
  });
  return { service, getStored: () => stored };
}

describe("agentMemorySettingsService", () => {
  it("reports what is in force from the environment when nothing is stored", async () => {
    const { service } = makeService(undefined, { MYRMIDON_BOT_HINDSIGHT_API_URL: "http://bots.invalid" });
    const view = await service.read();
    expect(view.settings).toEqual({});
    expect(view.effective).toEqual({
      enabled: true,
      apiUrl: "http://bots.invalid",
      urlSource: "bot-env",
      keySecretName: null,
      accessMode: "all",
      enabledRoles: [],
      enabledAgentIds: [],
    });
  });

  it("stores a patch and reports it as in force", async () => {
    const { service, getStored } = makeService(undefined, { MYRMIDON_BOT_HINDSIGHT_API_URL: "http://bots.invalid" });
    const view = await service.update({
      apiUrl: "http://stored.invalid",
      keySecretName: "k",
      accessMode: "roles",
      enabledRoles: ["engineer", "lead"],
    });
    expect(getStored()).toEqual({
      apiUrl: "http://stored.invalid",
      keySecretName: "k",
      accessMode: "roles",
      enabledRoles: ["engineer", "lead"],
    });
    expect(view.effective.apiUrl).toBe("http://stored.invalid");
    expect(view.effective.urlSource).toBe("setting");
    expect(view.effective.keySecretName).toBe("k");
    expect(view.effective.accessMode).toBe("roles");
    expect(view.effective.enabledRoles).toEqual(["engineer", "lead"]);
  });

  it("null clears a field and leaves the others", async () => {
    const { service, getStored } = makeService({ enabled: false, apiUrl: "http://stored.invalid", keySecretName: "k" });
    await service.update({ keySecretName: null, enabled: null });
    expect(getStored()).toEqual({ apiUrl: "http://stored.invalid" });
  });

  it("ignores a damaged stored row", async () => {
    const { service } = makeService({ apiUrl: "ftp://nope", enabled: "yes" });
    expect((await service.read()).settings).toEqual({});
  });

  it("fetches banks, config, and performs recall probe via mock Hindsight", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string });
      if (url.endsWith("/v1/default/banks")) {
        return new Response(JSON.stringify({ banks: [{ id: "bank-1", name: "Bank One" }] }), { status: 200 });
      }
      if (url.endsWith("/v1/default/banks/bank-1/config")) {
        return new Response(JSON.stringify({ config: { retention_days: 30 } }), { status: 200 });
      }
      if (url.endsWith("/v1/default/banks/bank-1/stats")) {
        return new Response(JSON.stringify({ total_memories: 42, pending_consolidation: 3, failed_consolidation: 0 }), { status: 200 });
      }
      if (url.includes("/v1/default/banks/bank-1/operations")) {
        return new Response(JSON.stringify({ operations: [{ id: "op-1", operation_type: "consolidation", status: "pending" }] }), { status: 200 });
      }
      if (url.endsWith("/memories/recall")) {
        return new Response(JSON.stringify({ results: [{ text: "found note", score: 0.9 }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    const { service } = makeService({ apiUrl: "http://hindsight.test:8888" }, {}, mockFetch as any);

    const banks = await service.listBanks();
    expect(banks).toHaveLength(1);
    expect(banks[0]?.id).toBe("bank-1");

    const config = await service.getBankConfig("bank-1");
    expect(config.retention_days).toBe(30);

    const workload = await service.getWorkload("bank-1");
    expect(workload.consolidationQueue.pending).toBe(3);
    expect(workload.consolidationQueue.recentOperations).toHaveLength(1);

    const probe = await service.probeRecall("hello memory", "bank-1");
    expect(probe.success).toBe(true);
    expect(probe.resultsCount).toBe(1);
    expect(probe.results[0]?.text).toBe("found note");
  });
});