// server/src/myrmidon/voice-meeting-protocol/routes.myrmidon.test.ts
//
// myrmidon(1.6.5 VOICE-STT B): the endpoint the work bot calls with a labeled
// transcript (`POST /api/myrmidon/companies/:companyId/voice-meeting-protocol`).
//
// Pins the transport contract: company access for the board AND for an agent
// of the same company (that is how the work bot reads its own meeting), a
// refusal for another company's agent, and a strict body.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonVoiceMeetingProtocolRoutes } from "./index.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};

const agent = {
  type: "agent",
  source: "api_key",
  agentId: "agent-work",
  companyId: COMPANY_ID,
};

const OTHER_COMPANY_AGENT = {
  type: "agent",
  source: "api_key",
  agentId: "agent-work",
  companyId: "99999999-9999-4999-8999-999999999999",
};

const TRANSCRIPT = [
  "Говорящий 1 [0:05]: коллеги, начинаем",
  "Говорящий 2 [0:12]: я подготовлю заметки к выкату",
  "Говорящий 1 [0:30]: решили выпустить релиз в пятницу",
].join("\n");

function withActor(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", myrmidonVoiceMeetingProtocolRoutes());
  app.use(errorHandler);
  return app;
}

const URL = `/api/myrmidon/companies/${COMPANY_ID}/voice-meeting-protocol`;

describe("voice-meeting-protocol endpoint", () => {
  it("answers the protocol built from a labeled transcript", async () => {
    const res = await request(withActor(member)).post(URL).send({ text: TRANSCRIPT, title: "релиз" }).expect(200);
    expect(res.body.title).toBe("релиз");
    expect(res.body.labeled).toBe(true);
    expect(res.body.participants.map((participant: { speaker: string }) => participant.speaker)).toEqual(["1", "2"]);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.actionItems).toHaveLength(1);
    expect(res.body.protocol).toContain("# Протокол встречи: релиз");
    expect(res.body.protocol).toContain("## Задачи (1)");
  });

  it("lets an agent of the same company build the protocol (the work bot's path)", async () => {
    const res = await request(withActor(agent)).post(URL).send({ text: TRANSCRIPT }).expect(200);
    expect(res.body.utterances).toBe(3);
  });

  it("refuses an agent of another company", async () => {
    await request(withActor(OTHER_COMPANY_AGENT)).post(URL).send({ text: TRANSCRIPT }).expect(403);
  });

  it("carries the explicit marker of an unlabeled transcript", async () => {
    const res = await request(withActor(member))
      .post(URL)
      .send({ text: "Говорящие не размечены: diarization_no_speakers\nрешили выпустить релиз" })
      .expect(200);
    expect(res.body.labeled).toBe(false);
    expect(res.body.diarizationMarker).toBe("diarization_no_speakers");
    expect(res.body.participants).toEqual([]);
    expect(res.body.protocol).toContain("Участники не размечены: diarization_no_speakers");
  });

  it("rejects an empty transcript", async () => {
    await request(withActor(member)).post(URL).send({ text: "" }).expect(400);
  });

  it("rejects an unknown field", async () => {
    await request(withActor(member)).post(URL).send({ text: TRANSCRIPT, frobnicate: true }).expect(400);
  });
});