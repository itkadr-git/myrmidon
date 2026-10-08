// server/src/myrmidon/voice-meeting-protocol/index.ts
//
// myrmidon(1.6.5 VOICE-STT B): the meeting protocol of the voice track — the
// function the work bot builds a protocol with, and the endpoint it calls.
//
//   POST /api/myrmidon/companies/:companyId/voice-meeting-protocol
//     body:   { text: string, title?: string }
//             `text` is the labeled transcript block (the shape the Telegram
//             intake writes into a task comment: «Говорящий 2 [3:10]: …», plus
//             the marker line when the provider returned no labels);
//     answer: { protocol, title, utterances, labeled, participants,
//               decisions, actionItems, diarizationMarker, diarization, capped }
//             `protocol` is the ready markdown document.
//
// Company access: a board actor, or an agent of the same company — the work
// bot runs as an agent of its company and reads the transcript from its own
// task. The endpoint is read-only: it computes from the text it is given,
// stores nothing, journals nothing, and never echoes a secret (no key travels
// through this path at all).

import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import {
  buildMeetingProtocol,
  renderMeetingProtocol,
  type MeetingProtocol,
} from "./protocol.js";

export {
  buildMeetingProtocol,
  classifyUtterance,
  protocolFromUtterances,
  renderMeetingProtocol,
  DEFAULT_PROTOCOL_TITLE,
  MAX_PROTOCOL_POINTS,
} from "./protocol.js";
export {
  formatLabeledLine,
  formatStamp,
  parseLabeledTranscript,
  utterancesFromSegments,
} from "./labeled.js";
export type {
  MeetingDiarization,
  MeetingParticipant,
  MeetingPoint,
  MeetingProtocol,
  MeetingProtocolInput,
} from "./protocol.js";
export type { LabeledUtterance, ParsedTranscript } from "./labeled.js";

/** Ceiling on one transcript body: a 20-minute meeting is far below it. */
export const MAX_PROTOCOL_TRANSCRIPT_CHARS = 400_000;

const buildSchema = z
  .object({
    text: z.string().min(1).max(MAX_PROTOCOL_TRANSCRIPT_CHARS),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

/** The endpoint's answer shape: the document plus the facts it was built from. */
export function voiceMeetingProtocolView(protocol: MeetingProtocol) {
  return {
    protocol: renderMeetingProtocol(protocol),
    title: protocol.title,
    utterances: protocol.utterances,
    labeled: protocol.labeled,
    participants: protocol.participants,
    decisions: protocol.decisions,
    actionItems: protocol.actionItems,
    diarizationMarker: protocol.diarizationMarker,
    diarization: protocol.diarization,
    capped: protocol.capped,
  };
}

export function myrmidonVoiceMeetingProtocolRoutes() {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/voice-meeting-protocol";

  router.post(base, validate(buildSchema), (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as z.infer<typeof buildSchema>;
    const protocol = buildMeetingProtocol({
      text: body.text,
      ...(body.title === undefined ? {} : { title: body.title }),
    });
    res.json(voiceMeetingProtocolView(protocol));
  });

  return router;
}