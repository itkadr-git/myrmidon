import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLitellmConfigClient } from "./config-client.js";
import type { HttpError } from "../../errors.js";
import type { KnownModelInfo } from "@myrmidon/shared";

// The gateway is the only source of truth for the fallback topology: every
// read and write below goes to LiteLLM over HTTP, and the client has no
// database to fall back on.
describe("myrmidon(OPE-9855) LiteLLM config client", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
  });

  const client = createLitellmConfigClient({
    litellmBaseUrl: "http://litellm-test:4000",
    litellmAdminKey: "«redacted:sk-…»",
  });

  async function failure(promise: Promise<unknown>): Promise<HttpError> {
    try {
      await promise;
    } catch (err) {
      return err as HttpError;
    }
    throw new Error("expected the call to fail");
  }

  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  function catalogOf(rows: KnownModelInfo[]) {
    return new Map(rows.map((row) => [row.modelName, row]));
  }

  describe("reading the live topology", () => {
    it("reads router_settings.fallbacks from the live router values", async () => {
      fetchMock.mockResolvedValueOnce(
        okJson({
          current_values: { fallbacks: [{ "gpt-4o": ["claude-3-5-sonnet", "gemini-pro"] }] },
          fields: [{ field_name: "fallbacks", field_value: [{ stale: ["copy"] }] }],
        }),
      );

      const chains = await client.readFallbackTopology();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("http://litellm-test:4000/router/settings", {
        headers: {
          Authorization: "Bearer «redacted:sk-…»",
        },
      });
      expect(chains).toEqual([{ model: "gpt-4o", targets: ["claude-3-5-sonnet", "gemini-pro"] }]);
    });

    it("reads the field list when the gateway answers no current values", async () => {
      fetchMock.mockResolvedValueOnce(
        okJson({ fields: [{ field_name: "fallbacks", field_value: [{ "gpt-4o": ["gemini-pro"] }] }] }),
      );
      expect(await client.readFallbackTopology()).toEqual([{ model: "gpt-4o", targets: ["gemini-pro"] }]);
    });

    it("answers an empty list when the gateway has no fallbacks", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ current_values: { fallbacks: null }, fields: [] }));
      expect(await client.readFallbackTopology()).toEqual([]);
    });

    it("refuses a topology shape it cannot read instead of reading it as empty", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ current_values: { fallbacks: { not: "a list" } } }));
      const err = await failure(client.readFallbackTopology());
      expect(err.status).toBe(422);
      expect(err.details).toMatchObject({ code: "litellm_fallbacks_malformed" });
    });

    it("throws when gateway /router/settings returns HTTP error", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
      await expect(client.readFallbackTopology()).rejects.toThrow("LiteLLM /router/settings answered 502");
    });

    it("answers 503 with the missing settings when no gateway address is configured", async () => {
      const noGateway = createLitellmConfigClient({ litellmBaseUrl: null, litellmAdminKey: "admin-key" });
      const err = await failure(noGateway.readFallbackTopology());
      expect(err.status).toBe(503);
      expect(err.details).toMatchObject({
        code: "litellm_gateway_not_configured",
        enabled: false,
        missing: ["MYRMIDON_LITELLM_BASE_URL"],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("writing the topology", () => {
    it("sends the whole list to /config/update and to nowhere else", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ message: "Config updated successfully" }));

      const catalog = catalogOf([
        { modelName: "gpt-4o", provider: "openai" },
        { modelName: "claude-3-5-sonnet", provider: "anthropic" },
        { modelName: "gemini-pro", provider: "google" },
      ]);

      const res = await client.updateFallbackTopology(
        [
          { model: "gpt-4o", targets: ["claude-3-5-sonnet"] },
          { model: "claude-3-5-sonnet", targets: ["gemini-pro"] },
        ],
        catalog,
      );
      expect(res).toEqual({ ok: true, warnings: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://litellm-test:4000/config/update",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer «redacted:sk-…»",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            router_settings: {
              fallbacks: [{ "gpt-4o": ["claude-3-5-sonnet"] }, { "claude-3-5-sonnet": ["gemini-pro"] }],
            },
          }),
        }),
      );
    });

    it("allows a fallback inside one provider and says so in a warning", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ message: "Config updated successfully" }));
      const catalog = catalogOf([
        { modelName: "zai-glm-5.3", provider: "hosted_vllm", inputCostPerToken: 0.0000014, outputCostPerToken: 0.0000044 },
        { modelName: "zai-glm-5.3-flash", provider: "hosted_vllm", inputCostPerToken: 0.00000015, outputCostPerToken: 0.0000005 },
      ]);

      const res = await client.updateFallbackTopology([{ model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] }], catalog);

      expect(res.ok).toBe(true);
      expect(res.warnings.join(" ")).toMatch(/same provider \(hosted_vllm\)/);
      expect(res.warnings.join(" ")).toMatch(/inside one provider/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows a chain whose providers the catalog does not know, with a warning", async () => {
      fetchMock.mockResolvedValueOnce(okJson({}));
      const catalog = catalogOf([
        { modelName: "primary", provider: null },
        { modelName: "backup", provider: "anthropic" },
      ]);

      const res = await client.updateFallbackTopology([{ model: "primary", targets: ["backup"] }], catalog);

      expect(res.ok).toBe(true);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(/provider is not known for primary/);
    });

    it("rejects an empty fallback group before writing to the gateway", async () => {
      const catalog = catalogOf([{ modelName: "primary", provider: "openai" }]);
      await expect(client.updateFallbackTopology([{ model: "primary", targets: [] }], catalog)).rejects.toThrow(
        /no fallback targets/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to update when unknown model groups are used", async () => {
      const catalog = catalogOf([
        { modelName: "gpt-4o", provider: "openai" },
        { modelName: "claude-3-5-sonnet", provider: "anthropic" },
      ]);

      const err = await failure(
        client.updateFallbackTopology([{ model: "gpt-4o", targets: ["unknown-future-model"] }], catalog),
      );
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/unknown model groups/i);
      expect(err.message).toContain("unknown-future-model");
      expect(err.details).toMatchObject({ code: "litellm_unknown_model_groups", unknownGroups: ["unknown-future-model"] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to update when catalog is empty/unavailable and non-empty chains are provided", async () => {
      // Empty catalog: any model in chains must be rejected as unknown
      await expect(
        client.updateFallbackTopology([{ model: "any-model", targets: ["any-target"] }], new Map()),
      ).rejects.toThrow(/unknown model groups/i);

      // Undefined catalog: also treated as empty catalog, rejecting unknown groups
      await expect(
        client.updateFallbackTopology([{ model: "any-model", targets: ["any-target"] }], undefined),
      ).rejects.toThrow(/unknown model groups/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to update when a free channel comes after a paid channel", async () => {
      const catalog = catalogOf([
        { modelName: "gpt-4o", provider: "openai", cost: 0.03 },
        { modelName: "paid-backup", provider: "anthropic", cost: 0.01 },
        { modelName: "free-backup", provider: "google", isFree: true },
      ]);

      const err = await failure(
        client.updateFallbackTopology([{ model: "gpt-4o", targets: ["paid-backup", "free-backup"] }], catalog),
      );
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/free channels must precede/i);
      expect(err.details).toMatchObject({ code: "litellm_invalid_fallback_order" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to update when a cheaper channel comes after a dearer one", async () => {
      const catalog = catalogOf([
        { modelName: "gpt-4o", provider: "openai", cost: 0.03 },
        { modelName: "dear-backup", provider: "anthropic", cost: 0.02 },
        { modelName: "cheap-backup", provider: "google", cost: 0.001 },
      ]);

      await expect(
        client.updateFallbackTopology([{ model: "gpt-4o", targets: ["dear-backup", "cheap-backup"] }], catalog),
      ).rejects.toThrow(/cheaper channel/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still refuses the order when a same-provider warning comes first in the chain", async () => {
      const catalog = catalogOf([
        { modelName: "gpt-4o", provider: "openai", cost: 0.03 },
        { modelName: "paid-same", provider: "openai", cost: 0.01 },
        { modelName: "free-backup", provider: "google", isFree: true },
      ]);

      await expect(
        client.updateFallbackTopology([{ model: "gpt-4o", targets: ["paid-same", "free-backup"] }], catalog),
      ).rejects.toThrow(/free channels must precede/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to update when a chain introduces a cycle", async () => {
      await expect(
        client.updateFallbackTopology([
          { model: "model-a", targets: ["model-b"] },
          { model: "model-b", targets: ["model-a"] },
        ]),
      ).rejects.toThrow(/loops/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("carries the gateway's own reason when it refuses the write", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ error: "router_settings key 'fallbacks' is set in the config file and cannot be changed here." }),
      });
      const catalog = catalogOf([
        { modelName: "a", provider: "p1" },
        { modelName: "b", provider: "p2" },
      ]);

      const err = await failure(client.updateFallbackTopology([{ model: "a", targets: ["b"] }], catalog));
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/LiteLLM \/config\/update answered 400/);
      expect(err.message).toMatch(/set in the config file/);
      expect(err.details).toMatchObject({ code: "litellm_request_failed", status: 400 });
    });

    it("reports an unreachable gateway without echoing the admin key", async () => {
      fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED while sending Bearer secret-admin-value"));
      const catalog = catalogOf([
        { modelName: "a", provider: "p1" },
        { modelName: "b", provider: "p2" },
      ]);

      const err = await failure(client.updateFallbackTopology([{ model: "a", targets: ["b"] }], catalog));
      expect(err.status).toBe(422);
      expect(err.details).toMatchObject({ code: "litellm_connection_failed" });
      expect(err.message).not.toContain("secret-admin-value");
    });

    it("answers 503 and writes nothing when the admin key has no value", async () => {
      const noKey = createLitellmConfigClient({ litellmBaseUrl: "http://litellm-test:4000", litellmAdminKey: null });
      const catalog = catalogOf([
        { modelName: "a", provider: "p1" },
        { modelName: "b", provider: "p2" },
      ]);

      const err = await failure(noKey.updateFallbackTopology([{ model: "a", targets: ["b"] }], catalog));
      expect(err.status).toBe(503);
      expect(err.details).toMatchObject({
        code: "litellm_gateway_not_configured",
        missing: ["MYRMIDON_LITELLM_ADMIN_KEY_SECRET"],
      });
      expect(err.message).toContain("MYRMIDON_LITELLM_ADMIN_KEY_SECRET");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
