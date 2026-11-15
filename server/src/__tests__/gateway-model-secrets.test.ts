import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { listGatewayModels, resetGatewayModelsCacheForTests } from "../adapters/hermes-gateway-models.js";

const secrets = vi.hoisted(() => ({
  getByName: vi.fn(async (companyId: string, name: string) => ({ id: `${companyId}:${name}` })),
  resolveSecretValue: vi.fn(async (_companyId: string, id: string) => `value:${id}`),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => secrets }));
const db = {} as Db;

afterEach(() => {
  resetGatewayModelsCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("company-scoped live gateway catalog", () => {
  it.each(["MYRMIDON_LITELLM_KEY_SECRET", "MYRMIDON_LITELLM_ADMIN_KEY_SECRET"])(
    "resolves %s as a company secret name, never as a bearer value",
    async (setting) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "chatgpt-pool/gpt-6-astra" }] })));
      const models = await listGatewayModels({
        env: { MYRMIDON_LITELLM_BASE_URL: "http://gateway", [setting]: "catalog-key" },
        companyId: "company-a", db,
      });
      expect(models).toEqual([{ id: "chatgpt-pool/gpt-6-astra", label: "chatgpt-pool/gpt-6-astra" }]);
      expect(secrets.getByName).toHaveBeenCalledWith("company-a", "catalog-key");
      expect(fetchSpy).toHaveBeenCalledWith("http://gateway/v1/models", expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer value:company-a:catalog-key" }),
      }));
    },
  );

  it("does not share catalogs across companies and discovers a new model within 15 seconds", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ id: now === 0 ? "old-model" : "new-model" }] })),
    );
    const options = { env: { MYRMIDON_LITELLM_BASE_URL: "http://gateway", MYRMIDON_LITELLM_KEY_SECRET: "catalog-key" }, db };
    await listGatewayModels({ ...options, companyId: "company-a" });
    await listGatewayModels({ ...options, companyId: "company-b" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    now = 15_000;
    expect(await listGatewayModels({ ...options, companyId: "company-a" })).toEqual([{ id: "new-model", label: "new-model" }]);
  });
});
