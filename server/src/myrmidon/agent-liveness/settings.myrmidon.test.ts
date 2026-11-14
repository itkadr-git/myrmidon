import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  DEFAULT_AGENT_LIVENESS_SETTINGS,
  AGENT_LIVENESS_CACHE_TTL_MS,
  clearAgentLivenessSettingsCache,
  resolveAgentLivenessSettings,
} from "./settings.js";
import { applySettingsChanged } from "../settings-appliers/index.js";

function stubDb(general: Record<string, unknown> = {}) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: () => Promise.resolve([
              {
                id: "row-1",
                singletonKey: "default",
                general,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          }),
        }),
      }),
    }),
  } as unknown as Db;
  return db;
}

describe("server resolveAgentLivenessSettings", () => {
  beforeEach(() => {
    clearAgentLivenessSettingsCache();
  });

  it("returns defaults without DB access (no db provided)", async () => {
    const settings = await resolveAgentLivenessSettings("company-1");
    expect(settings).toEqual(DEFAULT_AGENT_LIVENESS_SETTINGS);
    expect(settings.enabled).toBe(false);
  });

  it("returns stored settings from DB when db is provided", async () => {
    const db = stubDb({
      agentLiveness: {
        enabled: true,
        engineerQueueThreshold: 12,
        probeIntervalSec: 45,
      },
    });

    const settings = await resolveAgentLivenessSettings("company-1", { db });
    expect(settings.enabled).toBe(true);
    expect(settings.engineerQueueThreshold).toBe(12);
    expect(settings.probeIntervalSec).toBe(45);
    // Keys omitted from stored patch keep defaults
    expect(settings.reviewerQueueThreshold).toBe(DEFAULT_AGENT_LIVENESS_SETTINGS.reviewerQueueThreshold);
    expect(settings.journalRetentionDays).toBe(DEFAULT_AGENT_LIVENESS_SETTINGS.journalRetentionDays);
  });

  it("caches resolved settings per companyId within TTL", async () => {
    let callCount = 0;
    const db = {
      select: () => {
        callCount++;
        return {
          from: () => ({
            where: () => ({
              limit: () => ({
                for: () => Promise.resolve([
                  {
                    id: "row-1",
                    singletonKey: "default",
                    general: { agentLiveness: { enabled: true, engineerQueueThreshold: 10 } },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              }),
            }),
          }),
        };
      },
    } as unknown as Db;

    const baseTime = 1_000_000;
    const first = await resolveAgentLivenessSettings("company-1", { db, now: baseTime });
    expect(first.engineerQueueThreshold).toBe(10);
    expect(callCount).toBe(1);

    // Second call within TTL returns cached result without DB query
    const second = await resolveAgentLivenessSettings("company-1", { db, now: baseTime + 10_000 });
    expect(second).toBe(first);
    expect(callCount).toBe(1);

    // Call after TTL expires queries DB again
    const third = await resolveAgentLivenessSettings("company-1", {
      db,
      now: baseTime + AGENT_LIVENESS_CACHE_TTL_MS + 100,
    });
    expect(third.engineerQueueThreshold).toBe(10);
    expect(callCount).toBe(2);
  });

  it("invalidates cache when applySettingsChanged is triggered with agentLiveness", async () => {
    let callCount = 0;
    const db = {
      select: () => {
        callCount++;
        return {
          from: () => ({
            where: () => ({
              limit: () => ({
                for: () => Promise.resolve([
                  {
                    id: "row-1",
                    singletonKey: "default",
                    general: { agentLiveness: { enabled: true } },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                ]),
              }),
            }),
          }),
        };
      },
    } as unknown as Db;

    await resolveAgentLivenessSettings("company-1", { db });
    expect(callCount).toBe(1);

    // Cache hit
    await resolveAgentLivenessSettings("company-1", { db });
    expect(callCount).toBe(1);

    // Notify applier
    const applyAgentLiveness = vi.fn(async () => {});
    await applySettingsChanged({ changedKeys: ["agentLiveness"] }, { db, applyAgentLiveness });
    expect(applyAgentLiveness).toHaveBeenCalledTimes(1);

    // Cache was invalidated -> queries DB again
    await resolveAgentLivenessSettings("company-1", { db });
    expect(callCount).toBe(2);
  });
});
