// server/src/myrmidon/voice-meeting-protocol/protocol.myrmidon.test.ts
//
// myrmidon(1.6.5 VOICE-STT B): the meeting protocol assembled from a LABELED
// transcript — participants, decisions, action items — and the explicit
// marker when the recording was not separated into voices.

import { describe, expect, it } from "vitest";
import { buildMeetingProtocol, classifyUtterance, MAX_PROTOCOL_POINTS, renderMeetingProtocol } from "./protocol.js";
import { formatLabeledLine, formatStamp, parseLabeledTranscript } from "./labeled.js";

const TWO_SPEAKERS = [
  "Говорящий 1 [0:05]: коллеги, начинаем встречу по релизу",
  "Говорящий 2 [0:12]: у меня вопрос по срокам",
  "Говорящий 1 [0:30]: решили выпустить релиз в пятницу",
  "Говорящий 2 [0:48]: я подготовлю заметки к выкату",
  "Говорящий 1 [1:20]: спасибо всем, встреча окончена",
].join("\n");

describe("a transcript with two speakers", () => {
  it("names both participants and counts their utterances", () => {
    const protocol = buildMeetingProtocol({ text: TWO_SPEAKERS, title: "релиз 1.6.5" });
    expect(protocol.participants.map((participant) => [participant.speaker, participant.label, participant.utterances])).toEqual([
      ["1", "Говорящий 1", 3],
      ["2", "Говорящий 2", 2],
    ]);
    expect(protocol.labeled).toBe(true);
    expect(protocol.utterances).toBe(5);
  });

  it("picks the decision with its speaker and timestamp", () => {
    const protocol = buildMeetingProtocol({ text: TWO_SPEAKERS });
    expect(protocol.decisions).toHaveLength(1);
    expect(protocol.decisions[0]).toMatchObject({
      speaker: "1",
      label: "Говорящий 1",
      atMs: 30_000,
      text: "решили выпустить релиз в пятницу",
    });
  });

  it("picks the action item with its speaker and timestamp", () => {
    const protocol = buildMeetingProtocol({ text: TWO_SPEAKERS });
    expect(protocol.actionItems).toHaveLength(1);
    expect(protocol.actionItems[0]).toMatchObject({
      speaker: "2",
      label: "Говорящий 2",
      atMs: 48_000,
      text: "я подготовлю заметки к выкату",
    });
  });

  it("renders the document the work bot posts", () => {
    const rendered = renderMeetingProtocol(buildMeetingProtocol({ text: TWO_SPEAKERS, title: "релиз 1.6.5" }));
    expect(rendered).toContain("# Протокол встречи: релиз 1.6.5");
    expect(rendered).toContain("## Участники (2)");
    expect(rendered).toContain("- Говорящий 1 — реплик: 3, первая реплика 0:05");
    expect(rendered).toContain("## Решения (1)");
    expect(rendered).toContain("- [0:30] Говорящий 1: решили выпустить релиз в пятницу");
    expect(rendered).toContain("## Задачи (1)");
    expect(rendered).toContain("- [0:48] Говорящий 2: я подготовлю заметки к выкату");
  });

  it("builds the same protocol from the core's segments", () => {
    const protocol = buildMeetingProtocol({
      segments: [
        { speaker: "1", startMs: 0, endMs: 1000, text: "решили выпустить релиз в пятницу" },
        { speaker: "2", startMs: 1000, endMs: 2000, text: "я подготовлю заметки к выкату" },
      ],
    });
    expect(protocol.participants.map((participant) => participant.speaker)).toEqual(["1", "2"]);
    expect(protocol.decisions).toHaveLength(1);
    expect(protocol.actionItems).toHaveLength(1);
  });
});

describe("a transcript without speaker labels", () => {
  const UNLABELED = [
    "привет коллеги, обсудим релиз",
    "Говорящие не размечены: diarization_no_speakers",
    "решили выпустить релиз в пятницу",
  ].join("\n");

  it("reports the recording as unlabeled instead of inventing a speaker", () => {
    const protocol = buildMeetingProtocol({ text: UNLABELED });
    expect(protocol.labeled).toBe(false);
    expect(protocol.participants).toEqual([]);
    expect(protocol.diarizationMarker).toBe("diarization_no_speakers");
  });

  it("repeats the marker in the document and throws no author in", () => {
    const rendered = renderMeetingProtocol(buildMeetingProtocol({ text: UNLABELED }));
    expect(rendered).toContain("Участники не размечены: diarization_no_speakers");
    expect(rendered).toContain("_Текст не разделён по говорящим");
    expect(rendered).not.toContain("## Участники");
    // The decision is still extracted — from text that names no author, and
    // without inventing one.
    expect(rendered).toContain("- решили выпустить релиз в пятницу");
    expect(rendered).not.toContain("Говорящий");
  });

  it("carries the core's report reason when the transcript has no marker line", () => {
    const protocol = buildMeetingProtocol({
      text: "привет коллеги",
      diarization: { requested: true, applied: false, speakers: 0, reason: "diarization_no_speakers" },
    });
    expect(renderMeetingProtocol(protocol)).toContain("Участники не размечены: diarization_no_speakers");
  });
});

describe("the empty lists and the caps are stated, never silent", () => {
  it("says the lists are empty in words", () => {
    const rendered = renderMeetingProtocol(buildMeetingProtocol({ text: "Говорящий 1 [0:01]: привет" }));
    expect(rendered).toContain("## Решения (0)");
    expect(rendered).toContain("## Задачи (0)");
    expect(rendered.match(/- не найдены в тексте/g)).toHaveLength(2);
  });

  it("does not repeat the same point twice", () => {
    const protocol = buildMeetingProtocol({
      text: [
        "Говорящий 1 [0:01]: решили выпустить релиз в пятницу",
        "Говорящий 1 [0:02]: решили выпустить релиз в пятницу",
      ].join("\n"),
    });
    expect(protocol.decisions).toHaveLength(1);
  });

  it("caps each list and says it did", () => {
    const lines = Array.from({ length: MAX_PROTOCOL_POINTS + 5 }, (_, index) =>
      `Говорящий 1 [0:${String(index % 60).padStart(2, "0")}]: решили пункт ${index}`,
    );
    const protocol = buildMeetingProtocol({ text: lines.join("\n") });
    expect(protocol.decisions).toHaveLength(MAX_PROTOCOL_POINTS);
    expect(protocol.capped).toBe(true);
    expect(renderMeetingProtocol(protocol)).toContain("_Список сокращён");
  });
});

describe("classification", () => {
  it("prefers a leading marker over a cue anywhere", () => {
    expect(classifyUtterance("Задача: подготовить выкат, решили состав")).toBe("action");
    expect(classifyUtterance("Решение: переносим выкат")).toBe("decision");
  });

  it("reads English cues too", () => {
    expect(classifyUtterance("we agreed to ship on Friday")).toBe("decision");
    expect(classifyUtterance("I will prepare the notes")).toBe("action");
    expect(classifyUtterance("thanks everyone")).toBe(null);
  });
});

describe("the labeled transcript helpers", () => {
  it("formats a line and a stamp the way the intake renders them", () => {
    expect(formatLabeledLine({ speaker: "2", atMs: 65_000, text: "вторая" })).toBe("Говорящий 2 [1:05]: вторая");
    expect(formatLabeledLine({ speaker: null, atMs: 1_000, text: "без автора" })).toBe("[0:01]: без автора");
    expect(formatLabeledLine({ speaker: "1", atMs: null, text: "без времени" })).toBe("Говорящий 1: без времени");
    expect(formatStamp(null)).toBe("");
  });

  it("parses the rendered block back into utterances", () => {
    const parsed = parseLabeledTranscript(TWO_SPEAKERS);
    expect(parsed.utterances).toHaveLength(5);
    expect(parsed.utterances[0]).toEqual({ speaker: "1", atMs: 5_000, text: "коллеги, начинаем встречу по релизу" });
    expect(parsed.diarizationMarker).toBeNull();
    expect(parseLabeledTranscript("Говорящий 1 [0:01]: привет").utterances).toHaveLength(1);
  });
});