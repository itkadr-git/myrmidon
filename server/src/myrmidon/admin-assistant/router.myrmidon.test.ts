import { describe, expect, it } from "vitest";
import { resolveAdminAssistantAdapterConfig, routeAdminTask } from "./router.js";

describe("instance administrator model routing", () => {
  const routing = { routineModel: "cheap", complexModel: "strong", reserveModel: "backup" };

  it("uses the configured cheap model for routine work", () => {
    expect(routeAdminTask("routine", routing, ["cheap", "strong"])).toEqual({ model: "cheap", escalated: false });
  });

  it("falls back to the reserve model when the complex model is unavailable", () => {
    expect(routeAdminTask("complex", routing, ["backup"])).toEqual({ model: "backup", escalated: true });
  });

  it("falls back to the reserve model when the routine model is unavailable", () => {
    expect(routeAdminTask("routine", routing, ["backup"])).toEqual({ model: "backup", escalated: false });
  });

  it("rejects a route when LiteLLM does not expose any configured model", () => {
    expect(() => routeAdminTask("routine", routing, ["unrelated"])).toThrow(/No configured LiteLLM model/);
  });

  it("passes the owner-selected model into the runtime adapter config", () => {
    expect(resolveAdminAssistantAdapterConfig({
      adapterConfig: { adminAssistant: { routing } },
      metadata: { paperclipBuiltInAgent: { key: "admin-assistant" } },
      context: { taskClass: "complex" },
      availableModels: ["strong", "backup"],
    })).toMatchObject({ model: "strong" });
  });
});