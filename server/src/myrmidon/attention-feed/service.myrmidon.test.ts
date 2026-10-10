import { describe, expect, it, vi } from "vitest";
import {
  ATTENTION_FEED_BOUNDS,
  ATTENTION_FEED_UPDATED_ACTION,
  ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
  ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
} from "@paperclipai/shared";
import { attentionFeedService } from "./service.js";

// SETTINGS-UI C-4: the service behind GET/PATCH /api/myrmidon/attention-feed.
// Two traps of this area: a PATCH must write only the keys the operator sent
// (so the other window keeps its row), and every change must be audited for
// every company — same contract the other instance-settings services follow.

const ACTOR = {
  actorType: "user" as const,
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

function harness(input: { general?: Record<string, unknown>; writeDelayMs?: number } = {}) {
  let general: Record<string, unknown> = { ...(input.general ?? {}) };
  const writes: Array<Record<string, unknown>> = [];
  const updateGeneral = vi.fn(async (patch: Record<string, unknown>) => {
    writes.push(patch);
    if (input.writeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, input.writeDelayMs));
    }
    general = { ...general, ...patch };
    return general;
  });
  const logActivity = vi.fn(async (..._args: unknown[]) => undefined);
  const service = attentionFeedService({
    settings: {
      getGeneral: (async () => general) as never,
      updateGeneral: updateGeneral as never,
    },
    listCompanyIds: async () => ["company-a", "company-b"],
    logActivity: logActivity as never,
  });
  return { service, writes, logActivity, readGeneral: () => general };
}

describe("attention feed settings service", () => {
  it("reports the windows in force, their source and their bounds", async () => {
    const { service } = harness({ general: { attentionFailedRunHorizonDays: 14 } });
    const view = await service.read();
    expect(view.settings).toEqual({
      failedRunHorizonDays: 14,
      feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
    });
    expect(view.sources).toEqual({
      failedRunHorizonDays: "settings",
      feedCacheTtlSeconds: "default",
    });
    expect(view.bounds).toEqual(ATTENTION_FEED_BOUNDS);
  });

  it("falls back to the defaults on an empty row and reports it as such", async () => {
    const { service } = harness();
    const view = await service.read();
    expect(view.settings.failedRunHorizonDays).toBe(ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS);
    expect(view.settings.feedCacheTtlSeconds).toBe(ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS);
    expect(view.sources).toEqual({
      failedRunHorizonDays: "default",
      feedCacheTtlSeconds: "default",
    });
  });

  it("writes only the key the patch carried and audits the change for every company", async () => {
    const { service, writes, logActivity, readGeneral } = harness();
    const view = await service.update({ failedRunHorizonDays: 3 }, ACTOR);

    expect(writes).toEqual([{ attentionFailedRunHorizonDays: 3 }]);
    expect(readGeneral()).toEqual({ attentionFailedRunHorizonDays: 3 });
    expect(view.settings).toEqual({
      failedRunHorizonDays: 3,
      feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
    });
    expect(view.sources.failedRunHorizonDays).toBe("settings");

    expect(logActivity).toHaveBeenCalledTimes(2);
    const entries = logActivity.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(entries.map((entry) => entry.companyId)).toEqual(["company-a", "company-b"]);
    for (const entry of entries) {
      expect(entry.action).toBe(ATTENTION_FEED_UPDATED_ACTION);
      expect(entry.entityType).toBe("instance_settings");
      expect(entry.entityId).toBe("attention-feed");
      expect(entry.actorId).toBe("user-1");
      expect(entry.details).toEqual({
        previous: {
          failedRunHorizonDays: ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
          feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
        },
        next: {
          failedRunHorizonDays: 3,
          feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
        },
        changedKeys: ["failedRunHorizonDays"],
      });
    }
  });

  it("keeps a saved window the patch did not mention out of the write", async () => {
    const { service, writes } = harness({
      general: { attentionFailedRunHorizonDays: 30, attentionFeedCacheTtlSeconds: 10 },
    });
    const view = await service.update({ feedCacheTtlSeconds: 90 }, ACTOR);

    expect(writes).toEqual([{ attentionFeedCacheTtlSeconds: 90 }]);
    expect(view.settings).toEqual({ failedRunHorizonDays: 30, feedCacheTtlSeconds: 90 });
  });

  it("audits a repeated save as a no-op write of the same value", async () => {
    const { service, writes, logActivity } = harness({
      general: { attentionFailedRunHorizonDays: 3 },
    });
    await service.update({ failedRunHorizonDays: 3 }, ACTOR);
    expect(writes).toEqual([{ attentionFailedRunHorizonDays: 3 }]);
    const details = (logActivity.mock.calls[0][0] as { details: { changedKeys: string[] } }).details;
    expect(details.changedKeys).toEqual([]);
  });

  it("serializes overlapping PATCHes so the last one sees the row the first wrote", async () => {
    const { service, writes, readGeneral } = harness({
      general: { attentionFeedCacheTtlSeconds: 45 },
      writeDelayMs: 10,
    });
    const [first, second] = await Promise.all([
      service.update({ failedRunHorizonDays: 5 }, ACTOR),
      service.update({ feedCacheTtlSeconds: 0 }, ACTOR),
    ]);
    expect(writes).toEqual([
      { attentionFailedRunHorizonDays: 5 },
      { attentionFeedCacheTtlSeconds: 0 },
    ]);
    expect(first.settings.failedRunHorizonDays).toBe(5);
    // The second PATCH read the row the first one had already written.
    expect(second.settings).toEqual({ failedRunHorizonDays: 5, feedCacheTtlSeconds: 0 });
    expect(readGeneral()).toEqual({
      attentionFeedCacheTtlSeconds: 0,
      attentionFailedRunHorizonDays: 5,
    });
  });
});