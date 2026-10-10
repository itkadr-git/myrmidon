// myrmidon(1.7-METRICS): the self-check probe (1.6.6 annex). The probe runs
// one scrape of every family and answers {ok, families_ok, families_failed,
// scrape_ms} — aggregate health only: no secret, no token and no per-family
// metric value ever leaves it. These tests pin the contract on a pure fake:
// a db that throws on every read must name every family in families_failed,
// and a healthy scrape must render the exposition text as part of the probe.

import { describe, expect, it } from "vitest";
import {
  METRIC_FAMILIES,
  collectMetricsParts,
  runMetricsSelfCheck,
} from "./metrics.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

const deps = {
  now: () => NOW,
  errorWindowSec: 3600,
  latencyWindowSec: 3600,
};

describe("metrics self-check probe", () => {
  it("names every family when every read fails — and never crashes", async () => {
    const failingDb = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as never;

    const result = await runMetricsSelfCheck({ ...deps, db: failingDb });
    expect(result.ok).toBe(false);
    // myrmidon_scrape_errors is the meta-counter of this very scrape — it is
    // never a DB read, so on a fully broken database it is the one family
    // the probe can still affirm. The eight board-process families
    // (1.6.5-PROCS-Q3 five process families, the event-loop utilization of
    // PROCS-0.1 as the sixth, the two PROCS-0.3A lane families as the seventh
    // and eighth) are likewise not DB reads — they survive a broken
    // database too. The chat-ingress counter of 1.6.6 CONNECTOR-IN is the
    // ninth: an in-process counter of the ingress seam, with no database
    // behind it.
    expect(result.families_ok).toBe(1 + 8 + 1);
    const expectedFailed = METRIC_FAMILIES.filter(
      (family) =>
        family !== "myrmidon_scrape_errors" &&
        !family.startsWith("myrmidon_board_") &&
        family !== "myrmidon_chat_ingress_total",
    ).sort();
    expect(result.families_failed.sort()).toEqual(expectedFailed);
    expect(result.checked_at).toBe(NOW.toISOString());
    expect(Number.isFinite(result.scrape_ms)).toBe(true);
  });

  it("the probe body carries no secrets or metric values", async () => {
    const failingDb = {
      select: () => {
        throw new Error("super-secret-connection-string leaked");
      },
    } as never;
    const result = await runMetricsSelfCheck({ ...deps, db: failingDb });
    const text = JSON.stringify(result);
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("connection");
    // Only the documented aggregate keys.
    expect(Object.keys(result).sort()).toEqual([
      "checked_at",
      "families_failed",
      "families_ok",
      "ok",
      "scrape_ms",
    ]);
  });

  it("collectMetricsParts reports per-family failures with family names", async () => {
    const failingDb = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as never;
    const collected = await collectMetricsParts({ ...deps, db: failingDb });
    expect(collected.errors.length).toBeGreaterThan(0);
    for (const entry of collected.errors) {
      for (const family of entry.split("|")) {
        expect(METRIC_FAMILIES).toContain(family as (typeof METRIC_FAMILIES)[number]);
      }
    }
    // The snapshot shape the endpoint renders is intact even on a broken read.
    expect(collected.fields.runsActive).toBe(0);
    expect(collected.fields.roleQueueTasks).toEqual([]);
  });
});
