// myrmidon(1.7 AUTO-UPDATE-SETTINGS B): the update policy screen over the real
// routes with a fake store, the same harness the deploy jobs routes use.
//
// Pins: reads need board access, writes need instance admin, an agent token is
// refused; the screen reports where every value came from; the window is
// rendered as open/closed at the current clock; an approval needs a real
// digest, cannot be approved twice for a started release and cannot be
// withdrawn once it started a job; every write leaves an audit row.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { logActivity } from "../../services/index.js";
import { autoUpdateRoutes } from "./auto-update-routes.js";
import { defaultAutoUpdateSettings, type AutoUpdateSettings } from "./auto-update.js";
import type { DeployJob, DeployJobDocument } from "./domain.js";

// The factory is hoisted above the module body, so the id is inlined here.
vi.mock("../../services/index.js", () => ({
  instanceSettingsService: () => ({ listCompanyIds: async () => ["22222222-2222-4222-8222-222222222222"] }),
  logActivity: vi.fn(async () => ({})),
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
// A Wednesday, midday UTC — see the window cases below.
const NOW = new Date("2026-10-07T12:00:00.000Z");
const WEDNESDAY = 3;
const GOOD = `sha256:${"b".repeat(64)}`;

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function harness(seed: Partial<AutoUpdateSettings> = {}, jobs: DeployJobDocument["jobs"] = []) {
  const doc: AutoUpdateSettings = { ...defaultAutoUpdateSettings(), ...seed };
  const store = {
    readAutoUpdate: async () => structuredClone(doc),
    mutateAutoUpdate: async <T>(change: (current: AutoUpdateSettings) => { next: AutoUpdateSettings | null; result: T }) => {
      const { next, result } = change(doc);
      if (next) Object.assign(doc, next);
      return { doc, result, changed: next !== null };
    },
  };
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(
      "/api",
      autoUpdateRoutes(store as unknown as Db, () => NOW, async () => ({ version: 1, jobs, history: [] })),
    );
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor, doc };
}

const URL = "/api/myrmidon/auto-update";

beforeEach(() => {
  vi.mocked(logActivity).mockClear();
  // The route resolves the policy against the process env; a forced override in
  // the environment would make the "resolved equals stored" assertions lie.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("MYRMIDON_DEPLOY_UPDATE_")) delete process.env[name];
  }
});

describe("update policy routes", () => {
  it("lets a board member read the policy, its sources and the window", async () => {
    const h = harness();
    const res = await request(h.app).get(URL).expect(200);
    expect(res.body.stored).toEqual(defaultAutoUpdateSettings());
    expect(res.body.settings).toEqual(defaultAutoUpdateSettings());
    // No days means no window: an instance that never set one deploys whenever
    // the operator clicks (this is what keeps the default behaviour of the board).
    expect(res.body.window.open).toBe(true);
    expect(res.body.start.allowed).toBe(false);
    expect(res.body.overridden).toEqual([]);
    expect(Object.keys(res.body.sources).length).toBeGreaterThan(0);
  });

  it("refuses an agent token on read and on write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ mode: "manual" }).expect(403);
    await request(h.withActor(agentActor)).post(`${URL}/approvals`).send({ tag: "myr-v1.7.0", digest: GOOD }).expect(403);
  });

  it("lets a member read but only an instance admin write", async () => {
    const h = harness();
    await request(h.withActor(member)).patch(URL).send({ mode: "manual" }).expect(403);
    const res = await request(h.withActor(admin))
      .patch(URL)
      .send({
        mode: "auto_release",
        window: { days: [WEDNESDAY], fromMinute: 60, toMinute: 180 },
        canary: { enabled: true, sharePercent: 25, minBots: 1, maxBots: 3, healthSettleSec: 120 },
      })
      .expect(200);
    expect(res.body.stored.mode).toBe("auto_release");
    expect(res.body.stored.window).toEqual({ days: [WEDNESDAY], fromMinute: 60, toMinute: 180 });
    expect(res.body.stored.canary.sharePercent).toBe(25);
    expect(res.body.sources.mode).toBe("ui");
    expect(vi.mocked(logActivity)).toHaveBeenCalledTimes(1);
  });

  it("renders the window as closed outside the hours and says when it opens", async () => {
    const h = harness({ window: { days: [WEDNESDAY], fromMinute: 60, toMinute: 180 } });
    const closed = await request(h.app).get(URL).expect(200);
    expect(closed.body.window.open).toBe(false);
    expect(closed.body.window.opensAt).toEqual(expect.any(String));

    const inside = harness({ window: { days: [WEDNESDAY], fromMinute: 12 * 60, toMinute: 13 * 60 } });
    const open = await request(inside.app).get(URL).expect(200);
    expect(open.body.window.open).toBe(true);
  });

  it("refuses a patch that is not a known shape", async () => {
    const h = harness();
    await request(h.withActor(admin)).patch(URL).send({ mode: "whenever" }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ window: { days: [1], fromMinute: 1440, toMinute: 10 } }).expect(400);
    await request(h.withActor(admin)).patch(URL).send({ unknownKey: true }).expect(400);
  });

  it("approves a release on a verified digest and remembers who did it", async () => {
    const h = harness({ mode: "auto_release", window: { days: [WEDNESDAY], fromMinute: 0, toMinute: 1439 } });
    const res = await request(h.withActor(admin))
      .post(`${URL}/approvals`)
      .send({ tag: "myr-v1.7.0", digest: GOOD, version: "1.7.0" })
      .expect(201);
    expect(res.body.stored.approvals).toHaveLength(1);
    expect(res.body.stored.approvals[0]).toMatchObject({
      tag: "myr-v1.7.0",
      digest: GOOD,
      version: "1.7.0",
      jobId: null,
      approvedBy: { actorType: "user", actorId: "user-b" },
    });
    // Inside the window an approved release is what the scheduler would start.
    expect(res.body.start.allowed).toBe(true);
    expect(res.body.start.candidate.tag).toBe("myr-v1.7.0");
  });

  it("refuses an approval without a real digest", async () => {
    const h = harness();
    await request(h.withActor(admin)).post(`${URL}/approvals`).send({ tag: "myr-v1.7.0", digest: "latest" }).expect(400);
  });

  it("withdraws an approval that has not started, and refuses one whose deploy is running", async () => {
    const running = "11111111-2222-4333-8444-555555555555";
    const spent = "11111111-2222-4333-8444-666666666666";
    const approval = (tag: string, jobId: string | null) => ({
      tag,
      digest: GOOD,
      version: null,
      approvedBy: { actorType: "board", actorId: "user-a" },
      approvedAt: NOW.toISOString(),
      jobId,
    });
    const h = harness(
      {
        approvals: [approval("myr-v1.6.9", null), approval("myr-v1.6.8", running), approval("myr-v1.6.7", spent)],
      },
      // The first job is still switching the board, the second one is over.
      [{ id: running, status: "waiting_window" }, { id: spent, status: "canary_failed" }] as DeployJob[],
    );
    const res = await request(h.withActor(admin)).delete(`${URL}/approvals/myr-v1.6.9`).expect(200);
    expect(res.body.stored.approvals.map((entry: { tag: string }) => entry.tag)).toEqual(["myr-v1.6.8", "myr-v1.6.7"]);

    // A deploy that is running is the job's business; a refused one may be
    // withdrawn so the operator can approve a fixed digest.
    await request(h.withActor(admin)).delete(`${URL}/approvals/myr-v1.6.8`).expect(409);
    const retried = await request(h.withActor(admin)).delete(`${URL}/approvals/myr-v1.6.7`).expect(200);
    expect(retried.body.stored.approvals.map((entry: { tag: string }) => entry.tag)).toEqual(["myr-v1.6.8"]);
    await request(h.withActor(admin)).delete(`${URL}/approvals/myr-v1.5.0`).expect(404);
  });

  it("refuses to approve a tag again once it started a deploy", async () => {
    const h = harness({
      approvals: [
        {
          tag: "myr-v1.7.0",
          digest: GOOD,
          version: null,
          approvedBy: { actorType: "board", actorId: "user-a" },
          approvedAt: NOW.toISOString(),
          jobId: "11111111-2222-4333-8444-555555555555",
        },
      ],
    });
    await request(h.withActor(admin)).post(`${URL}/approvals`).send({ tag: "myr-v1.7.0", digest: GOOD }).expect(409);
  });
});