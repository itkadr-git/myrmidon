import { describe, expect, it } from "vitest";
import { agentMemorySettingsService } from "./settings-routes.js";

function makeService(initial: unknown, env: NodeJS.ProcessEnv = {}) {
  let stored = initial;
  const service = agentMemorySettingsService({
    getGeneral: async () => ({ agentMemory: stored }),
    updateGeneral: async (patch) => {
      stored = patch.agentMemory;
    },
    env,
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
    });
  });

  it("stores a patch and reports it as in force", async () => {
    const { service, getStored } = makeService(undefined, { MYRMIDON_BOT_HINDSIGHT_API_URL: "http://bots.invalid" });
    const view = await service.update({ apiUrl: "http://stored.invalid", keySecretName: "k" });
    expect(getStored()).toEqual({ apiUrl: "http://stored.invalid", keySecretName: "k" });
    expect(view.effective.apiUrl).toBe("http://stored.invalid");
    expect(view.effective.urlSource).toBe("setting");
    expect(view.effective.keySecretName).toBe("k");
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
});
