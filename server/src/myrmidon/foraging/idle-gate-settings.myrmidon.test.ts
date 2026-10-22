// myrmidon(1.6.3-FORAGING-IDLE-GATE): the settings service — read, update
// and the audit entries. The service is the database half of "меняется в
// интерфейсе без перезапуска": every update writes the instance settings row
// the pass re-reads on every pass. Same shape as the swarm-claim settings
// tests (fake settings ports, no database).
import { describe, expect, it, vi } from "vitest";
import { FORAGING_IDLE_GATE_SETTINGS_KEY } from "@paperclipai/shared";
import {
  FORAGING_IDLE_GATE_ACTION,
  foragingIdleGateService,
  type ForagingIdleGateServiceDeps,
} from "./idle-gate-settings.js";

interface FakeGeneralStore {
  general: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
}

function fakeDeps(start: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const store: FakeGeneralStore = { general: { ...start }, updates: [] };
  const logActivity = vi.fn(async () => undefined);
  const deps: ForagingIdleGateServiceDeps = {
    getGeneral: async () => store.general,
    updateGeneral: async (patch) => {
      store.updates.push(patch as Record<string, unknown>);
      store.general = { ...store.general, ...(patch as Record<string, unknown>) };
      return store.general;
    },
    listCompanyIds: async () => ["company-a", "company-b"],
    logActivity,
    env,
  };
  const service = foragingIdleGateService(null as never, deps);
  return { service, store, logActivity, deps };
}

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) settings service", () => {
  it("reads the resolved toggle and its source from the row", async () => {
    const { service } = fakeDeps({ [FORAGING_IDLE_GATE_SETTINGS_KEY]: { enabled: false } });
    const view = await service.read();
    expect(view).toEqual({ enabled: false, source: "settings" });
  });

  it("reads the default (on) when nothing was ever stored", async () => {
    const { service } = fakeDeps();
    const view = await service.read();
    expect(view).toEqual({ enabled: true, source: "default" });
  });

  it("the env override wins when nothing is stored (source: env)", async () => {
    const { service } = fakeDeps({}, { MYRMIDON_FORAGING_IDLE_GATE_ENABLED: "0" });
    const view = await service.read();
    expect(view).toEqual({ enabled: false, source: "env" });
  });

  it("update writes the row under the canonical key and audits it per company", async () => {
    const { service, store, logActivity } = fakeDeps();
    const view = await service.update({ enabled: false }, {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
    });
    expect(view).toEqual({ enabled: false, source: "settings" });
    expect(store.general[FORAGING_IDLE_GATE_SETTINGS_KEY]).toEqual({ enabled: false });
    expect(store.updates).toHaveLength(1);
    expect(logActivity).toHaveBeenCalledTimes(2); // one audit row per company
    const firstAudit = (logActivity.mock.calls[0] as unknown[] | undefined)?.[0] ?? {};
    expect(firstAudit).toMatchObject({
      action: FORAGING_IDLE_GATE_ACTION,
      entityType: "instance_settings",
      entityId: FORAGING_IDLE_GATE_SETTINGS_KEY,
      details: { enabled: false },
    });
  });

  it("a settings read failure fails open (default, on)", async () => {
    const deps = {
      getGeneral: async () => {
        throw new Error("db down");
      },
      updateGeneral: async () => undefined,
      listCompanyIds: async () => [],
      logActivity: async () => undefined,
    };
    const service = foragingIdleGateService(null as never, deps);
    const view = await service.read();
    expect(view).toEqual({ enabled: true, source: "default" });
  });

  it("the toggle round-trips: update then read reflects it without a restart", async () => {
    const { service, store } = fakeDeps({ [FORAGING_IDLE_GATE_SETTINGS_KEY]: { enabled: true } });
    await service.update({ enabled: false }, {
      actorType: "user",
      actorId: "u",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
    });
    // The next read (the next pass) sees the stored value.
    expect(store.general[FORAGING_IDLE_GATE_SETTINGS_KEY]).toEqual({ enabled: false });
    expect(await service.read()).toEqual({ enabled: false, source: "settings" });
  });
});
