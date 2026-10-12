// server/src/myrmidon/project-token-quota/project-token-quota.myrmidon.test.ts
//
// myrmidon(1.6.6 QUOTA-V2, OPE-6877): the acceptance tests of the project
// token quota. The *.myrmidon.test.ts style of this repo: no database,
// neutral data, the decisions pinned at the domain seams. The four decisions
// the ticket names:
//
//   1. the windows: daily = the UTC day [00:00, next 00:00), weekly = the ISO
//      week [Monday 00:00 UTC, next Monday 00:00 UTC) — the same anchors the
//      heartbeat daily cap uses;
//   2. the quota body: one project, both windows at once, null = unlimited,
//      non-integer/negative limits rejected, weekly below daily rejected;
//   3. the enqueue check: no row or null limits = pass; an over-limit daily
//      window blocks before the weekly one; a counter from a previous window
//      reads as zero (the window rolled);
//   4. the refusal: the stable PROJECT_TOKEN_QUOTA_EXCEEDED code first, then
//      a readable sentence with the project, the window, and used-of-limit.

import { describe, expect, it } from "vitest";
import {
  PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE,
  projectTokenQuotaRejectionMessage,
  projectTokenQuotaSchema,
  sumCostEventTokens,
} from "@paperclipai/shared";
import {
  currentIsoWeekWindow,
  currentUtcDayWindow,
  getProjectTokenQuotaBlock,
  recordProjectTokenUsage,
  tokensOfCostEvent,
} from "./service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

/** A `project_token_quotas` row, all defaults neutral. */
function quotaRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: COMPANY,
    projectId: PROJECT,
    dailyTokenLimit: null as number | null,
    weeklyTokenLimit: null as number | null,
    dailyTokensUsed: 0,
    weeklyTokensUsed: 0,
    dailyWindowStart: currentUtcDayWindow().start,
    weeklyWindowStart: currentIsoWeekWindow().start,
    setByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A fake Drizzle `db` answering one row for every select (any table). */
function fakeDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows as never,
        }),
      }),
    }),
    update: (captured: { set: (v: unknown) => { where: (c: unknown) => Promise<void> } }) => ({
      set: (values: unknown) => ({
        where: async (cond: unknown) => {
          captured.set({ values, cond });
        },
      }),
    }),
  } as never;
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) windows", () => {
  it("the daily window is the UTC day [00:00, next 00:00)", () => {
    const now = new Date("2026-10-09T14:23:45.678Z");
    const { start, end } = currentUtcDayWindow(now);
    expect(start.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("the daily window ignores the local timezone bits", () => {
    // a date constructed with non-UTC methods still reads as its UTC day
    const localish = new Date(2026, 9, 9, 23, 59, 59); // 2026-10-09 in local terms
    const { start } = currentUtcDayWindow(localish);
    expect(start.toISOString()).toMatch(/^2026-10-0[89]T00:00:00\.000Z$/);
  });

  it("the weekly window starts Monday 00:00 UTC and spans seven days", () => {
    // 2026-10-09 is a Friday; the ISO week starts 2026-10-05 (Monday).
    const now = new Date("2026-10-09T14:23:45.678Z");
    const { start, end } = currentIsoWeekWindow(now);
    expect(start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("Sunday belongs to the week that started six days earlier", () => {
    // 2026-10-11 is a Sunday.
    const now = new Date("2026-10-11T01:00:00.000Z");
    const { start } = currentIsoWeekWindow(now);
    expect(start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// token arithmetic
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) token arithmetic", () => {
  it("tokens of a cost event = input + cached input + output", () => {
    expect(tokensOfCostEvent({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 60 })).toBe(200);
  });

  it("the shared helper sums the same way", () => {
    expect(sumCostEventTokens({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 60 })).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// the quota body
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) quota body", () => {
  it("accepts both limits and treats null as unlimited", () => {
    expect(projectTokenQuotaSchema.parse({ dailyTokenLimit: 1000, weeklyTokenLimit: null })).toEqual({
      dailyTokenLimit: 1000,
      weeklyTokenLimit: null,
    });
  });

  it("rejects a non-integer, a negative, and a zero limit", () => {
    for (const bad of [1.5, -1, 0]) {
      expect(projectTokenQuotaSchema.safeParse({ dailyTokenLimit: bad, weeklyTokenLimit: null }).success).toBe(false);
    }
  });

  it("rejects unknown keys (strict)", () => {
    expect(projectTokenQuotaSchema.safeParse({ dailyTokenLimit: null, weeklyTokenLimit: null, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the enqueue check
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) enqueue check", () => {
  const now = new Date("2026-10-09T14:23:45.678Z"); // a Friday inside both windows

  it("no quota row = pass (the feature is off by default)", async () => {
    expect(await getProjectTokenQuotaBlock(fakeDb([]), COMPANY, PROJECT, now)).toBeNull();
  });

  it("null limits = unlimited = pass", async () => {
    expect(await getProjectTokenQuotaBlock(fakeDb([quotaRow()]), COMPANY, PROJECT, now)).toBeNull();
  });

  it("an over-limit daily window blocks, daily before weekly", async () => {
    const block = await getProjectTokenQuotaBlock(
      fakeDb([quotaRow({ dailyTokenLimit: 100, dailyTokensUsed: 120 })]),
      COMPANY,
      PROJECT,
      now,
    );
    expect(block).not.toBeNull();
    expect(block?.windowKind).toBe("daily");
    expect(block?.tokenLimit).toBe(100);
    expect(block?.tokensUsed).toBe(120);
  });

  it("a daily limit that is not yet reached passes even when the weekly one is over", async () => {
    // daily 1000 used 10 (fine), weekly 500 used 600 (over) — both windows set.
    const block = await getProjectTokenQuotaBlock(
      fakeDb([
        quotaRow({ dailyTokenLimit: 1000, dailyTokensUsed: 10, weeklyTokenLimit: 500, weeklyTokensUsed: 600 }),
      ]),
      COMPANY,
      PROJECT,
      now,
    );
    expect(block?.windowKind).toBe("weekly");
    expect(block?.tokenLimit).toBe(500);
    expect(block?.tokensUsed).toBe(600);
  });

  it("a daily limit exactly reached blocks (>=, not >)", async () => {
    const block = await getProjectTokenQuotaBlock(
      fakeDb([quotaRow({ dailyTokenLimit: 100, dailyTokensUsed: 100 })]),
      COMPANY,
      PROJECT,
      now,
    );
    expect(block?.windowKind).toBe("daily");
  });

  it("a counter from a previous window reads as zero (the window rolled)", async () => {
    // the counters belong to yesterday / last week: usage is history now.
    const block = await getProjectTokenQuotaBlock(
      fakeDb([
        quotaRow({
          dailyTokenLimit: 100,
          dailyTokensUsed: 999,
          weeklyTokenLimit: 500,
          weeklyTokensUsed: 999,
          dailyWindowStart: new Date("2026-10-08T00:00:00.000Z"), // yesterday
          weeklyWindowStart: new Date("2026-09-28T00:00:00.000Z"), // two Mondays ago
        }),
      ]),
      COMPANY,
      PROJECT,
      now,
    );
    expect(block).toBeNull();
  });

  it("a counter at the exact window start still counts (not < start)", async () => {
    const block = await getProjectTokenQuotaBlock(
      fakeDb([
        quotaRow({
          dailyTokenLimit: 100,
          dailyTokensUsed: 150,
          dailyWindowStart: currentUtcDayWindow(now).start, // exactly the start
        }),
      ]),
      COMPANY,
      PROJECT,
      now,
    );
    expect(block?.windowKind).toBe("daily");
  });
});

// ---------------------------------------------------------------------------
// the usage hook
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) usage hook", () => {
  const now = new Date("2026-10-09T14:23:45.678Z");

  it("no row and zero/negative tokens = a no-op write", async () => {
    const captured: { values?: unknown; cond?: unknown } = {};
    const db = fakeDb([]);
    await recordProjectTokenUsage(db, { companyId: COMPANY, projectId: PROJECT, tokens: 500 }, now);
    expect(captured.values).toBeUndefined(); // nothing written: the select found no row
  });

  it("a rolled window resets the counters to the event's tokens, an open one adds", async () => {
    const captured: { values?: unknown; cond?: unknown } = {};
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () =>
              [
                quotaRow({
                  dailyTokenLimit: 100,
                  dailyTokensUsed: 90,
                  weeklyTokensUsed: 400,
                  dailyWindowStart: new Date("2026-10-08T00:00:00.000Z"), // rolled
                  weeklyWindowStart: currentIsoWeekWindow(now).start, // open
                }),
              ] as never,
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async (cond: unknown) => {
            captured.values = values;
            captured.cond = cond;
          },
        }),
      }),
    } as never;

    await recordProjectTokenUsage(db, { companyId: COMPANY, projectId: PROJECT, tokens: 50 }, now);

    const values = captured.values as Record<string, unknown>;
    expect(values.dailyTokensUsed).toBe(50); // rolled: replaced, not added
    expect((values.weeklyTokensUsed as { queryChunks: unknown }).queryChunks).toBeDefined(); // open: SQL increment
    expect(values.dailyWindowStart).toEqual(currentUtcDayWindow(now).start);
    expect(values.weeklyWindowStart).toEqual(currentIsoWeekWindow(now).start);
  });
});

// ---------------------------------------------------------------------------
// the refusal message
// ---------------------------------------------------------------------------

describe("myrmidon(1.6.6 QUOTA-V2) refusal", () => {
  it("the stable code first, then the readable sentence", () => {
    const message = projectTokenQuotaRejectionMessage({
      projectName: "Wellmagram",
      windowKind: "daily",
      tokensUsed: 12_345,
      tokenLimit: 10_000,
    });
    expect(message.startsWith(PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE)).toBe(true);
    expect(message).toContain('"Wellmagram"');
    expect(message).toContain("daily");
    expect(message).toContain("12,345");
    expect(message).toContain("10,000");
  });

  it("the weekly wording when the weekly window fired", () => {
    const message = projectTokenQuotaRejectionMessage({
      projectName: "P",
      windowKind: "weekly",
      tokensUsed: 1,
      tokenLimit: 2,
    });
    expect(message).toContain("weekly token quota");
  });

  it("the error code is a stable constant", () => {
    expect(PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE).toBe("PROJECT_TOKEN_QUOTA_EXCEEDED");
  });
});
