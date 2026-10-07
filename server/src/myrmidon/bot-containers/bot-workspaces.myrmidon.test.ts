// myrmidon(1.6.5-BOT-DISK-H4a): GET /api/myrmidon/bots/me/workspaces (contract C3).
//
// The route runs over the real service with an in-memory store, so the
// lifecycle table, the actor rule, the contract schema and the repository
// choice are exercised without a database.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { wsDesiredStateSchema } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { botWorkspacePressureFromPartition } from "./bot-workspaces-pressure.js";
import { botWorkspacesRoutes } from "./bot-workspaces-routes.js";
import {
  botWorkspacesService,
  repoNameFromUrl,
  type BotWorkspacesStore,
  type WorkspaceIssueRow,
  type WorkspacePrProductRow,
} from "./bot-workspaces-service.js";
import { prStateOf, workspaceStateOf } from "./workspace-state.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BOT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-06T14:06:00Z");
const URL = "/api/myrmidon/bots/me/workspaces";

const botActor = { type: "agent", source: "agent_key", agentId: BOT_ID, companyId: COMPANY_ID, keyId: "key-a" };
const boardActor = { type: "board", source: "session", userId: "u", isInstanceAdmin: true, companyIds: [COMPANY_ID] };

function issue(over: Partial<WorkspaceIssueRow> & { identifier: string }): WorkspaceIssueRow {
  return {
    id: `id-${over.identifier}`,
    status: "in_progress",
    assigneeAgentId: BOT_ID,
    projectId: null,
    hiddenAt: null,
    startedAt: new Date("2026-10-06T14:00:00Z"),
    completedAt: null,
    cancelledAt: null,
    updatedAt: new Date("2026-10-06T14:00:00Z"),
    ...over,
  };
}

function pr(issueId: string, over: Partial<WorkspacePrProductRow> = {}): WorkspacePrProductRow {
  return {
    issueId,
    status: "open",
    url: null,
    metadata: null,
    updatedAt: new Date("2026-10-06T13:40:00Z"),
    ...over,
  };
}

function harness(data: {
  issues?: WorkspaceIssueRow[];
  products?: WorkspacePrProductRow[];
  repos?: Record<string, string>;
  settings?: unknown;
  pressure?: Parameters<typeof botWorkspacesService>[0]["readPressure"];
}) {
  const calls = { listIssues: 0, listPrProducts: 0, listProjectRepoUrls: 0 };
  const store: BotWorkspacesStore = {
    listIssues: async () => (calls.listIssues++, data.issues ?? []),
    listPrProducts: async ({ issueIds }) => (
      calls.listPrProducts++, (data.products ?? []).filter((p) => issueIds.includes(p.issueId))
    ),
    listProjectRepoUrls: async () => (calls.listProjectRepoUrls++, new Map(Object.entries(data.repos ?? {}))),
    readBotDiskSettings: async () => data.settings ?? {},
  };
  const service = botWorkspacesService({ store, now: () => NOW, readPressure: data.pressure });
  const app = (actor: unknown) => {
    const a = express();
    a.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    a.use("/api", botWorkspacesRoutes(service));
    a.use(errorHandler);
    return a;
  };
  return { app, calls };
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract", name), "utf8"));

describe("workspaceStateOf: task status -> state", () => {
  const base = { assigneeAgentId: BOT_ID, botAgentId: BOT_ID };
  const table: Array<[string, string, "active" | "closing"]> = [
    ["backlog", "backlog", "active"],
    ["todo", "todo", "active"],
    ["in_progress", "in_progress", "active"],
    ["blocked", "blocked", "active"],
    ["in_review", "in_review", "active"],
    ["done", "done", "closing"],
    ["cancelled", "cancelled", "closing"],
  ];
  for (const [label, status, state] of table) {
    it(`${label} -> ${state}`, () => {
      expect(workspaceStateOf({ ...base, status }, []).state).toBe(state);
    });
  }

  it("hidden (archived) task -> closing", () => {
    expect(workspaceStateOf({ ...base, status: "in_progress", hidden: true }, [])).toMatchObject({
      state: "closing",
      reason: "hidden",
    });
  });

  it("reassigned or unassigned -> closing", () => {
    expect(workspaceStateOf({ ...base, status: "in_progress", assigneeAgentId: OTHER_BOT_ID }, []).reason).toBe(
      "reassigned",
    );
    expect(workspaceStateOf({ ...base, status: "in_progress", assigneeAgentId: null }, []).state).toBe("closing");
  });

  it("merged PR -> closing even while the task is still in review", () => {
    expect(workspaceStateOf({ ...base, status: "in_review" }, [{ state: "merged" }])).toEqual({
      state: "closing",
      prState: "merged",
      reason: "pr_merged",
    });
  });

  it("an open PR next to a merged one keeps the copy active", () => {
    expect(workspaceStateOf({ ...base, status: "in_review" }, [{ state: "merged" }, { state: "draft" }])).toEqual({
      state: "active",
      prState: "open",
    });
  });

  it("closed-unmerged PR does not close the copy", () => {
    expect(workspaceStateOf({ ...base, status: "in_progress" }, [{ state: "closed" }])).toEqual({
      state: "active",
      prState: "closed",
    });
  });

  it("prStateOf ignores unknown and superseded products", () => {
    expect(prStateOf([])).toBe("none");
    expect(prStateOf([{ state: "unknown" }, { state: "superseded" }])).toBe("none");
  });
});

describe("GET /api/myrmidon/bots/me/workspaces", () => {
  it("refuses a board actor and a bot without company with 403, anonymous with 401", async () => {
    const { app } = harness({});
    expect((await request(app(boardActor)).get(URL)).status).toBe(403);
    expect((await request(app({ type: "agent", source: "agent_key", agentId: BOT_ID })).get(URL)).status).toBe(403);
    expect((await request(app({ type: "none", source: "none" })).get(URL)).status).toBe(401);
  });

  it("a task that moved to done is closing in one request, with the done time as since", async () => {
    const done = issue({
      identifier: "ABC-99",
      status: "done",
      completedAt: new Date("2026-10-06T13:55:00Z"),
      updatedAt: new Date("2026-10-06T13:56:00Z"),
    });
    const { app, calls } = harness({ issues: [done] });
    const res = await request(app(botActor)).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toEqual([
      {
        key: "ABC-99",
        state: "closing",
        since: "2026-10-06T13:55:00.000Z",
        prState: "none",
        branch: "bot/ABC-99",
      },
    ]);
    // One pass over the store, no per-task queries.
    expect(calls).toEqual({ listIssues: 1, listPrProducts: 1, listProjectRepoUrls: 0 });
  });

  it("merged PR -> closing with the merge time; open PR -> active", async () => {
    const merged = issue({ identifier: "ABC-5", status: "in_review" });
    const open = issue({ identifier: "ABC-6", status: "in_review" });
    const { app } = harness({
      issues: [merged, open],
      products: [
        pr(merged.id, { status: "merged", updatedAt: new Date("2026-10-06T13:40:00Z") }),
        pr(open.id, { status: "open" }),
      ],
    });
    const res = await request(app(botActor)).get(URL);
    const byKey = Object.fromEntries(res.body.workspaces.map((w: { key: string }) => [w.key, w]));
    expect(byKey["ABC-5"]).toMatchObject({ state: "closing", prState: "merged", since: "2026-10-06T13:40:00.000Z" });
    expect(byKey["ABC-6"]).toMatchObject({ state: "active", prState: "open" });
  });

  it("a task reassigned away from the bot is closing", async () => {
    const lost = issue({ identifier: "ABC-7", assigneeAgentId: OTHER_BOT_ID });
    const { app } = harness({ issues: [lost] });
    const res = await request(app(botActor)).get(URL);
    expect(res.body.workspaces[0]).toMatchObject({ key: "ABC-7", state: "closing" });
  });

  it("takes the repository from the project, otherwise from the latest PR", async () => {
    const withProject = issue({ identifier: "ABC-1", projectId: "p1" });
    const viaPr = issue({ identifier: "ABC-2" });
    const viaPrUrl = issue({ identifier: "ABC-3" });
    const nowhere = issue({ identifier: "ABC-4" });
    const { app } = harness({
      issues: [withProject, viaPr, viaPrUrl, nowhere],
      repos: { p1: "https://github.com/acme/widgets.git" },
      products: [
        // the project wins over the PR of the same task
        pr(withProject.id, { metadata: { repo: "other/ignored", number: 3 } }),
        pr(viaPr.id, { metadata: { repo: "acme/gadgets", number: 9 } }),
        pr(viaPrUrl.id, { url: "https://github.com/acme/gizmos/pull/12" }),
      ],
    });
    const res = await request(app(botActor)).get(URL);
    const repos = Object.fromEntries(res.body.workspaces.map((w: { key: string; repo?: string }) => [w.key, w.repo]));
    expect(repos).toEqual({
      "ABC-1": "acme/widgets",
      "ABC-2": "acme/gadgets",
      "ABC-3": "acme/gizmos",
      "ABC-4": undefined,
    });
  });

  it("falls back to general.botDisk.defaultRepo after the project and the PR; none set keeps it absent", async () => {
    const withProject = issue({ identifier: "ABC-1", projectId: "p1" });
    const viaPr = issue({ identifier: "ABC-2" });
    const nowhere = issue({ identifier: "ABC-4" });
    const data = {
      issues: [withProject, viaPr, nowhere],
      repos: { p1: "https://github.com/acme/widgets.git" },
      products: [pr(viaPr.id, { metadata: { repo: "acme/gadgets", number: 9 } })],
    };
    const repoMap = (body: { workspaces: Array<{ key: string; repo?: string }> }) =>
      Object.fromEntries(body.workspaces.map((w) => [w.key, w.repo]));

    const withDefault = harness({ ...data, settings: { defaultRepo: "itkadr-git/myrmidon" } });
    const res = await request(withDefault.app(botActor)).get(URL);
    expect(repoMap(res.body)).toEqual({
      "ABC-1": "acme/widgets",
      "ABC-2": "acme/gadgets",
      "ABC-4": "itkadr-git/myrmidon",
    });

    // an invalid stored value reads as absent
    const invalid = harness({ ...data, settings: { defaultRepo: "not a repo" } });
    const res2 = await request(invalid.app(botActor)).get(URL);
    expect(repoMap(res2.body)["ABC-4"]).toBeUndefined();
  });

  it("skips tasks without a valid issue key", async () => {
    const { app } = harness({ issues: [{ ...issue({ identifier: "ABC-1" }), identifier: null }] });
    const res = await request(app(botActor)).get(URL);
    expect(res.body.workspaces).toEqual([]);
  });

  it("pressure is none without a dockergate snapshot, and passes the snapshot through when present", async () => {
    const none = await request(harness({}).app(botActor)).get(URL);
    expect(none.body.pressure).toEqual({ quotaPercent: null, partitionPercent: 0, level: "none" });

    const snap = { quotaPercent: 93.5, partitionPercent: 88, level: "soft" as const };
    const withSnap = await request(harness({ pressure: async () => snap }).app(botActor)).get(URL);
    expect(withSnap.body.pressure).toEqual(snap);

    const broken = await request(
      harness({
        pressure: async () => {
          throw new Error("dockergate down");
        },
      }).app(botActor),
    ).get(URL);
    expect(broken.body.pressure.level).toBe("none");
  });

  it("grace comes from general.botDisk, with the contract defaults otherwise", async () => {
    const dflt = await request(harness({}).app(botActor)).get(URL);
    expect(dflt.body.grace).toEqual({ closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 });
    const custom = await request(
      harness({ settings: { graceClosingMinutes: 10, scratchTtlHours: 2 } }).app(botActor),
    ).get(URL);
    expect(custom.body.grace).toEqual({ closingMinutes: 10, scratchTtlHours: 2, orphanHours: 24 });
  });

  it("the answer passes the C3 schema and has the shape of the contract fixture", async () => {
    const a = issue({ identifier: "ABC-101", projectId: "p1", status: "in_progress" });
    const b = issue({ identifier: "ABC-99", status: "in_review" });
    const { app } = harness({
      issues: [a, b],
      repos: { p1: "git@github.com:acme/widgets.git" },
      products: [pr(a.id), pr(b.id, { status: "merged", metadata: { repo: "acme/widgets", number: 1 } })],
    });
    const res = await request(app(botActor)).get(URL);
    expect(wsDesiredStateSchema.safeParse(res.body).success).toBe(true);
    // Same keys as the fixture, no extra fields (the contract is fixed).
    const fx = fixture("desired-state.json");
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(fx).sort());
    expect(Object.keys(res.body.workspaces[0]).sort()).toEqual(Object.keys(fx.workspaces[0]).sort());
    expect(wsDesiredStateSchema.safeParse(fx).success).toBe(true);
  });
});

describe("repoNameFromUrl", () => {
  it.each([
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://x-access-token@github.com/acme/widgets.git", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets/pull/4", "acme/widgets"],
    ["https://gitlab.example.com/acme/widgets", undefined],
    [null, undefined],
  ])("%s -> %s", (url, expected) => {
    expect(repoNameFromUrl(url as string | null)).toBe(expected);
  });
});

describe("botWorkspacePressureFromPartition (BOT-DISK-H Д5)", () => {
  const settings = { partitionThresholdPercent: 85, partitionRefuseOpenPercent: 90, partitionCriticalPercent: 95 };
  const state = (usedPercent: number) => ({
    partition: { mount: "/", usedBytes: 0, totalBytes: 0, freeBytes: 0, usedPercent, at: "2026-10-07T08:00:00.000Z" },
    settings,
  });

  it.each([
    [84, "none"],
    [85, "soft"],
    [89, "soft"],
    [90, "hard"],
    [97, "hard"],
  ] as const)("at %i%% the level is %s, with no quota percent", (percent, level) => {
    expect(botWorkspacePressureFromPartition(state(percent))).toEqual({
      quotaPercent: null,
      partitionPercent: percent,
      level,
    });
  });

  it("an unmeasured partition is no data", () => {
    expect(botWorkspacePressureFromPartition({ partition: null, settings: null })).toBeNull();
  });

  it("89% reaches the desired state as soft", async () => {
    const res = await request(
      harness({ pressure: async () => botWorkspacePressureFromPartition(state(89)) }).app(botActor),
    ).get(URL);
    expect(res.body.pressure).toEqual({ quotaPercent: null, partitionPercent: 89, level: "soft" });
  });
});
