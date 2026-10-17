// myrmidon(1.6.5 OPE-6608): the claim API is mounted with the caste directory,
// so `POST …/swarm-claim/claim` honours `swarmEligible=false`.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ ports: null as null | { castes?: unknown } }));

vi.mock("./routes.js", () => ({
  swarmClaimRoutes: (_db: unknown, ports: { castes?: unknown }) => {
    captured.ports = ports;
    return {};
  },
}));

describe("swarmClaimApp wiring", () => {
  it("hands the caste directory port to the claim routes", async () => {
    const { swarmClaimApp } = await import("./index.js");
    const castes = async () => [];
    swarmClaimApp({
      db: {} as never,
      settings: { getGeneral: async () => ({}) as never, updateGeneral: async () => ({}) as never },
      castes,
    });
    expect(captured.ports?.castes).toBe(castes);
  });

  it("app.ts mounts the claim API with the real directory reader", () => {
    const source = readFileSync(new URL("../../app.ts", import.meta.url), "utf8");
    const mount = source.slice(source.indexOf("api.use(swarmClaimApp({"));
    const block = mount.slice(0, mount.indexOf("}));"));
    expect(block).toContain("castes: createCasteDirectoryReader(db)");
  });
});
