// GET /api/myrmidon/companies/:companyId/foraging/passes
// (myrmidon 1.6.3-FORAGING-IDLE-GATE, UI half): the pass history route —
// company access applies, and the limit is clamped to the journal cap.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { FORAGING_PASS_JOURNAL_LIMIT, type ForagingPassJournalEntry } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { foragingPassRoutes } from "./pass-routes.js";
import type { ForagingPassJournalService } from "./pass-journal.js";

const pass: ForagingPassJournalEntry = {
  at: "2026-10-04T12:00:00.000Z",
  companyId: "company-a",
  sourcesRead: 1,
  findings: 0,
  candidates: 0,
  errors: 0,
  stoppedByBudget: false,
  skippedReason: "no_idle_agent",
  skipped: [{ role: "engineer", reason: "no_idle_agent" }],
};

function fakeJournal(entries: ForagingPassJournalEntry[] = [pass]) {
  const read = vi.fn(async () => entries);
  const journal: ForagingPassJournalService = {
    read,
    record: vi.fn(async () => {}),
  };
  return { journal, read };
}

const boardActor = { type: "board", userId: "user-1", source: "session", companyIds: ["company-a"] };
const agentActor = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" };

const base = "/api/myrmidon/companies/company-a/foraging/passes";

function appFor(actor: unknown, journal = fakeJournal().journal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", foragingPassRoutes({} as Db, journal));
  app.use(errorHandler);
  return app;
}

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half) pass history route", () => {
  it("answers the pass history to a company member, with the skip reason", async () => {
    const res = await request(appFor(boardActor)).get(base).expect(200);
    expect(res.body).toMatchObject({
      passes: [
        {
          at: "2026-10-04T12:00:00.000Z",
          companyId: "company-a",
          skippedReason: "no_idle_agent",
          skipped: [{ role: "engineer", reason: "no_idle_agent" }],
        },
      ],
    });
  });

  it("refuses an agent of another company", async () => {
    const res = await request(appFor({ ...agentActor, companyId: "company-b" })).get(base).expect(403);
    expect(JSON.stringify(res.body)).toMatch(/another company/i);
  });

  it("asks the journal for the requested limit", async () => {
    const { journal, read } = fakeJournal();
    await request(appFor(boardActor, journal)).get(`${base}?limit=5`).expect(200);
    expect(read).toHaveBeenCalledWith("company-a", 5);
  });

  it("clamps the limit to the journal cap and defaults it", async () => {
    const { journal, read } = fakeJournal();
    const app = appFor(boardActor, journal);
    await request(app).get(`${base}?limit=100000`).expect(200);
    expect(read).toHaveBeenCalledWith("company-a", FORAGING_PASS_JOURNAL_LIMIT);
    await request(app).get(base).expect(200);
    expect(read).toHaveBeenCalledWith("company-a", FORAGING_PASS_JOURNAL_LIMIT);
  });
});