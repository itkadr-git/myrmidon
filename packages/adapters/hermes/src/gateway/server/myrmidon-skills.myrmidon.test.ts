import { describe, expect, it } from "vitest";
import { listGatewaySkills, syncGatewaySkills } from "./myrmidon-skills.js";

const ctx = (config: Record<string, unknown>) => ({
  agentId: "a1",
  companyId: "c1",
  adapterType: "hermes_gateway",
  config,
});
const runtime = [{ key: "company/kie-models", runtimeName: "kie-models", source: "/nonexistent/kie-models" }];

describe("hermes_gateway skills snapshot", () => {
  it("is supported and ephemeral, with the desired company skill configured", async () => {
    const snap = await listGatewaySkills(
      ctx({ paperclipRuntimeSkills: runtime, paperclipSkillSync: { desiredSkills: ["company/kie-models"] } }),
    );
    expect(snap.supported).toBe(true);
    expect(snap.mode).toBe("ephemeral");
    expect(snap.desiredSkills).toEqual(["company/kie-models"]);
    expect(snap.entries.find((e) => e.key === "company/kie-models")?.desired).toBe(true);
  });
  it("lists an undesired skill as available", async () => {
    const snap = await syncGatewaySkills(ctx({ paperclipRuntimeSkills: runtime }), []);
    expect(snap.supported).toBe(true);
    expect(snap.entries[0]?.state).toBe("available");
  });
  it("flags a desired skill with no runtime entry as missing", async () => {
    const snap = await listGatewaySkills(
      ctx({ paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: ["ghost"] } }),
    );
    expect(snap.entries[0]?.state).toBe("missing");
    expect(snap.warnings.length).toBe(1);
  });
});
