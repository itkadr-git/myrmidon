// myrmidon(1.7-ACTIVE-CHANNEL): the owner active-channel routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink) and a fake db that answers the activity reads, so validation,
// permissions, the audit record and the channel decision are all exercised
// without a database.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { OWNER_ACTIVE_THRESHOLD_ENV } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { ownerActiveChannelRoutes } from "./routes.js";
import {
  OWNER_ACTIVE_CHANNEL_ACTION,
  ownerActiveChannelService,
  type OwnerActiveChannelServiceDeps,
} from "./service.js";
import { invalidateOwnerActiveChannelSettingsCache } from "./settings.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  /** ISO stamps per channel for the fake activity table. */
  activity?: Record<string, string | null>;
  /** When set, the fake activity rows belong to this user id only. */
  activityUser?: string;
}

function harness(options: HarnessOptions = {}) {
  const current = { stored: options.stored as unknown };
  const audits: Array<Record<string, unknown>> = [];
  const deps: Partial<OwnerActiveChannelServiceDeps> = {
    getGeneral: async () => ({ ownerActiveChannel: current.stored }),
    updateGeneral: async (patch) => {
      current.stored = patch.ownerActiveChannel;
      return {};
    },
    listCompanyIds: async () => [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    env: options.env ?? {},
  };

  // The activity read is injected (the service takes it as a dep): stamps
  // answer only for their owner id, so unknown users read as empty.
  deps.readActivity = async (userId) => {
    const owner = options.activityUser ?? member.userId;
    const activity = userId === owner ? options.activity ?? {} : {};
    return {
      web: (activity.web as string | null | undefined) ?? null,
      telegram: (activity.telegram as string | null | undefined) ?? null,
    };
  };
  const db = {} as unknown as Db;

  const service = ownerActiveChannelService(db, deps);

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", ownerActiveChannelRoutes(db, service));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, audits, current };
}

const URL = "/api/myrmidon/owner/active-channel";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("myrmidon(1.7-ACTIVE-CHANNEL) routes: GET the active channel", () => {
  it("answers telegram when the freshest touch is a Telegram message", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { app } = harness({
      stored: { thresholdMin: 120 },
      activity: { web: minutesAgo(90), telegram: minutesAgo(1) },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.channel).toBe("telegram");
    expect(res.body.thresholdMin).toBe(120);
    expect(res.body.thresholdSource).toBe("settings");
    expect(res.body.lastActiveAt.telegram).toBeTruthy();
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("null when every channel is older than the threshold", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { app } = harness({
      stored: { thresholdMin: 5 },
      activity: { web: minutesAgo(60), telegram: minutesAgo(30) },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.channel).toBeNull();
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("the environment value is a forced override with its source shown", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { app } = harness({
      stored: { thresholdMin: 120 },
      env: { [OWNER_ACTIVE_THRESHOLD_ENV]: "15" },
      activity: { web: minutesAgo(10), telegram: null },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toMatchObject({ channel: "web", thresholdMin: 15, thresholdSource: "env" });
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("an outsider board member is refused; a member reads their own status", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { withActor } = harness({ activity: { web: null, telegram: null } });
    await request(withActor(outsider)).get(URL).expect(403);
    await request(withActor(member)).get(URL).expect(200);
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("?userId needs instance admin; an unknown user answers with empty touches", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { withActor } = harness({
      activity: { web: minutesAgo(2), telegram: null },
      activityUser: "user-z",
    });
    await request(withActor(member)).get(`${URL}?userId=user-z`).expect(403);
    const adminApp = withActor(admin);
    const ok = await request(adminApp).get(`${URL}?userId=user-z`).expect(200);
    expect(ok.body.channel).toBe("web");
    const empty = await request(adminApp).get(`${URL}?userId=ghost`).expect(200);
    expect(empty.body.channel).toBeNull();
    expect(empty.body.lastActiveAt).toEqual({ web: null, telegram: null });
    invalidateOwnerActiveChannelSettingsCache();
  });
});

describe("myrmidon(1.7-ACTIVE-CHANNEL) routes: PATCH the threshold", () => {
  it("instance admin saves the threshold; a plain member cannot", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { app, withActor, audits, current } = harness({ stored: { thresholdMin: 120 } });
    await request(app).patch(URL).send({ thresholdMin: 30 }).expect(403);

    const res = await request(withActor(admin)).patch(URL).send({ thresholdMin: 30 }).expect(200);
    expect(res.body).toEqual({ thresholdMin: 30, thresholdSource: "settings" });
    expect(current.stored).toEqual({ thresholdMin: 30 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: OWNER_ACTIVE_CHANNEL_ACTION,
      companyId: COMPANY_ID,
      entityType: "instance_settings",
    });
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("the saved threshold applies to the very next read without a restart", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { withActor } = harness({
      stored: { thresholdMin: 120 },
      activity: { web: minutesAgo(60), telegram: null },
      activityUser: admin.userId,
    });
    const adminApp = withActor(admin);
    const before = await request(adminApp).get(URL).expect(200);
    expect(before.body.channel).toBe("web");
    await request(adminApp).patch(URL).send({ thresholdMin: 30 }).expect(200);
    const after = await request(adminApp).get(URL).expect(200);
    expect(after.body.channel).toBeNull();
    expect(after.body.thresholdMin).toBe(30);
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("a body outside the bounds is rejected with 400", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const { withActor } = harness();
    const adminApp = withActor(admin);
    await request(adminApp).patch(URL).send({ thresholdMin: 2 }).expect(400);
    await request(adminApp).patch(URL).send({ thresholdMin: 99999 }).expect(400);
    await request(adminApp).patch(URL).send({ unknown: 1 }).expect(400);
    invalidateOwnerActiveChannelSettingsCache();
  });
});
