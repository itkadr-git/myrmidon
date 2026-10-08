// server/src/myrmidon/stt/diarization.myrmidon.test.ts
//
// myrmidon(1.6.5 VOICE-STT B): the speaker-label path.
//
// The suite pins three things the ticket asks for:
//   - a recording with TWO voices comes back labeled by speakers (through the
//     service, over the LiteLLM/DashScope adapter and a fake gateway);
//   - the request carries the diarization switch exactly when the contour asks
//     for it — and not otherwise;
//   - a model that cannot separate voices produces the EXPLICIT marker
//     (`diarization_no_speakers`), never a silent single-voice transcript.

import { describe, expect, it, vi } from "vitest";
import { dashscopeTranscribe } from "./backend-dashscope.js";
import { diarizationMissing, summarizeDiarization } from "./diarization.js";
import { transcribeAudioWithMetadata } from "./service.js";
import {
  sttSettings,
  STT_BASE_URL_ENV,
  STT_DIARIZATION_ENV,
  STT_ENABLED_ENV,
  STT_KEY_SECRET_ENV,
  STT_MODEL_ENV,
} from "./settings.js";
import { buildOggOpus } from "./testbytes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const KEY_VALUE = "company-key-value";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function configuredEnv(diarization: boolean): NodeJS.ProcessEnv {
  return {
    [STT_ENABLED_ENV]: "1",
    [STT_BASE_URL_ENV]: "http://gateway.example.com",
    [STT_KEY_SECRET_ENV]: "stt-key",
    [STT_MODEL_ENV]: "stt-model",
    ...(diarization ? { [STT_DIARIZATION_ENV]: "1" } : {}),
  };
}

const INPUT = {
  companyId: COMPANY_ID,
  bytes: buildOggOpus(2),
  mimeType: "audio/ogg" as const,
};

/** Two voices, the shape a diarizing model on the gateway answers with. */
function twoSpeakerAnswer(): Response {
  return jsonResponse({
    text: "привет коллеги обсудим релиз",
    segments: [
      { start: 0, end: 2.5, text: "привет коллеги", speaker: 1 },
      { start: 2.5, end: 6, text: "обсудим релиз", speaker: 2 },
    ],
  });
}

describe("summarizeDiarization", () => {
  it("reports applied with the distinct speaker count", () => {
    expect(
      summarizeDiarization(
        [
          { speaker: "1" },
          { speaker: "2" },
          { speaker: "1" },
        ],
        true,
      ),
    ).toEqual({ requested: true, applied: true, speakers: 2, reason: null });
  });

  it("marks a requested-but-unlabeled answer explicitly", () => {
    const report = summarizeDiarization([{ speaker: undefined }, { speaker: "   " }], true);
    expect(report).toEqual({
      requested: true,
      applied: false,
      speakers: 0,
      reason: "diarization_no_speakers",
    });
    expect(diarizationMissing(report)).toBe(true);
  });

  it("marks an unrequested answer as disabled, not as a failure", () => {
    const report = summarizeDiarization([{ speaker: undefined }], false);
    expect(report).toEqual({
      requested: false,
      applied: false,
      speakers: 0,
      reason: "diarization_disabled",
    });
    expect(diarizationMissing(report)).toBe(false);
  });

  it("counts labels of an answer without segments as none", () => {
    expect(summarizeDiarization(undefined, true).reason).toBe("diarization_no_speakers");
  });
});

describe("the request carries the diarization switch exactly when asked", () => {
  it("sends diarization_enabled when the contour asks for labels", async () => {
    const bodies: FormData[] = [];
    const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
      bodies.push(init?.body as FormData);
      return twoSpeakerAnswer();
    });
    await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv(true)),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    });
    expect(bodies[0]!.get("diarization_enabled")).toBe("true");
  });

  it("leaves the request byte for byte when the contour is off", async () => {
    const bodies: FormData[] = [];
    const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
      bodies.push(init?.body as FormData);
      return twoSpeakerAnswer();
    });
    await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv(false)),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    });
    expect(bodies[0]!.has("diarization_enabled")).toBe(false);
  });
});

describe("two voices on one recording", () => {
  it("labels the segments and reports two speakers", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => twoSpeakerAnswer());
    const outcome = await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv(true)),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    });
    expect(outcome.result.segments!.map((segment) => segment.speaker)).toEqual(["1", "2"]);
    expect(outcome.result.diarization).toEqual({
      requested: true,
      applied: true,
      speakers: 2,
      reason: null,
    });
  });

  it("reads the DashScope spelling of a speaker label too", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        text: "первый второй",
        segments: [
          { start: 0, end: 1, text: "первый", speaker_id: 3 },
          { start: 1, end: 2, text: "второй", speaker_label: "spk_1" },
        ],
      }),
    );
    const transcription = await dashscopeTranscribe(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg", language: "auto", diarization: true },
      {
        fetch: fetchImpl,
        baseUrl: "http://gateway.example.com",
        apiKey: KEY_VALUE,
        model: "stt-model",
        timeoutMs: 1000,
      },
    );
    expect(transcription.segments!.map((segment) => segment.speaker)).toEqual(["3", "spk_1"]);
  });

  it("renumbers the provider's labels into recording-global ones", async () => {
    // The merge owns the numbering the transcript renders: a provider's own
    // values ("3", "spk_1") are one chunk's internal detail and never leak
    // into the answer a caller reads.
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        text: "первый второй",
        segments: [
          { start: 0, end: 1, text: "первый", speaker_id: 3 },
          { start: 1, end: 2, text: "второй", speaker_label: "spk_1" },
        ],
      }),
    );
    const outcome = await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv(true)),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    });
    expect(outcome.result.segments!.map((segment) => segment.speaker)).toEqual(["1", "2"]);
    expect(outcome.result.diarization).toEqual({ requested: true, applied: true, speakers: 2, reason: null });
  });

  it("marks a model that cannot separate voices instead of staying silent", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        text: "привет коллеги обсудим релиз",
        segments: [
          { start: 0, end: 2.5, text: "привет коллеги" },
          { start: 2.5, end: 6, text: "обсудим релиз" },
        ],
      }),
    );
    const outcome = await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv(true)),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    });
    expect(outcome.result.segments!.map((segment) => segment.speaker)).toEqual([undefined, undefined]);
    expect(outcome.result.diarization).toEqual({
      requested: true,
      applied: false,
      speakers: 0,
      reason: "diarization_no_speakers",
    });
  });
});