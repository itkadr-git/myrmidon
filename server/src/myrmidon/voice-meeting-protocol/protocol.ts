// server/src/myrmidon/voice-meeting-protocol/protocol.ts
//
// myrmidon(1.6.5 VOICE-STT B): the meeting protocol built from a labeled
// transcript — participants, decisions, action items.
//
// This is a deterministic pass over the recognized text, not a model call: the
// work bot gets the same protocol from the same recording every time, a test
// can pin it, and nothing leaves the instance. The model-side narrative
// (naming the participants behind «Говорящий 1», polishing the wording) stays
// with the work bot's own skill — this function only assembles the facts the
// transcript carries.
//
// Classification order for one utterance (first match wins, documented so the
// result is predictable):
//
//   1. a line-leading decision marker («Решение:», «Decision:») — decision;
//   2. a line-leading task marker («Задача:», «Todo», «Action item») — task;
//   3. an action cue anywhere («я сделаю», «I will …», «нужно …») — task;
//   4. a decision cue anywhere («решили», «договорились», «we agreed») —
//      decision.
//
// A line that matches none is a plain utterance: it still counts towards its
// speaker but is not reported as a decision or a task. Nothing is summarized
// away, and an empty result says so explicitly ("не найдены"), never by
// omission.

import {
  formatStamp,
  parseLabeledTranscript,
  utterancesFromSegments,
  type LabeledUtterance,
} from "./labeled.js";

/** A participant as far as the transcript can name one: by its label. */
export interface MeetingParticipant {
  /** Provider label ("1", "2", ...). */
  speaker: string;
  /** How the protocol names it («Говорящий 1»). */
  label: string;
  utterances: number;
  words: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

export interface MeetingPoint {
  text: string;
  /** Provider label of the author, or null when the line carried none. */
  speaker: string | null;
  /** «Говорящий N» / «без разметки». */
  label: string;
  atMs: number | null;
}

export interface MeetingDiarization {
  requested: boolean;
  applied: boolean;
  speakers: number;
  reason: string | null;
}

export interface MeetingProtocol {
  title: string;
  participants: MeetingParticipant[];
  decisions: MeetingPoint[];
  actionItems: MeetingPoint[];
  /** Utterances the transcript carried. */
  utterances: number;
  /** True when at least one utterance carried a speaker label. */
  labeled: boolean;
  /** The marker line repeated from the transcript, when it carried one. */
  diarizationMarker: string | null;
  /** The core's report, when the caller supplied it. */
  diarization: MeetingDiarization | null;
  /** True when the point lists hit the cap (the transcript was longer). */
  capped: boolean;
}

/** Upper bound per point list: one huge recording cannot produce a novel. */
export const MAX_PROTOCOL_POINTS = 50;

/**
 * A word-bounded alternative list that works for Cyrillic too.
 *
 * `\b` is ASCII-only in JavaScript, so `\bрешили\b` never matches a Russian
 * word; the lookarounds exclude a neighbouring letter or digit explicitly.
 */
function cuePattern(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

const LEADING_DECISION: RegExp[] = [/^\s*(?:решение|итог|decision)\s*[:—-]/i];
const LEADING_ACTION: RegExp[] = [/^\s*(?:задача|задачи|действие|todo|action(?:\s+item)?)\s*[:—-]/i];

const DECISION_CUES: RegExp[] = [
  cuePattern("решили|постановили|договорились|согласовали|утвердили"),
  cuePattern("решено|принято"),
  cuePattern("we\\s+(?:decided|agreed|approved)"),
  cuePattern("agreed\\s+to|decided\\s+to|decision\\s+is"),
];

const ACTION_CUES: RegExp[] = [
  cuePattern("я\\s+(?:сделаю|подготовлю|напишу|отправлю|проверю|соберу|выясню|уточню)"),
  cuePattern("сделаю|подготовлю|напишу|отправлю|проверю|соберу|выясню|уточню"),
  cuePattern("нужно|надо"),
  cuePattern("i(?:'ll|\\s+will)"),
  cuePattern("follow[\\s-]?up|action\\s+item"),
];

type PointKind = "decision" | "action" | null;

/** Which list, if any, one utterance belongs to. */
export function classifyUtterance(text: string): PointKind {
  for (const pattern of LEADING_DECISION) if (pattern.test(text)) return "decision";
  for (const pattern of LEADING_ACTION) if (pattern.test(text)) return "action";
  for (const pattern of ACTION_CUES) if (pattern.test(text)) return "action";
  for (const pattern of DECISION_CUES) if (pattern.test(text)) return "decision";
  return null;
}

function labelOf(speaker: string | null): string {
  return speaker ? `Говорящий ${speaker}` : "без разметки";
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}
export interface MeetingProtocolInput {
  /** The labeled transcript block the intake renders into a task comment. */
  text?: string;
  /** Alternatively, the STT core's own segments. */
  segments?: ReadonlyArray<{ speaker?: string; startMs: number; endMs: number; text: string }>;
  title?: string;
  /** The core's diarization report, when the caller has it. */
  diarization?: MeetingDiarization | null;
}

/** Default document title; the caller may name the meeting instead. */
export const DEFAULT_PROTOCOL_TITLE = "запись встречи";

/** The same pass over already-parsed utterances (the two producers' common path). */
export function protocolFromUtterances(
  utterances: ReadonlyArray<LabeledUtterance>,
  options: { title?: string; diarizationMarker?: string | null; diarization?: MeetingDiarization | null } = {},
): MeetingProtocol {
  const participants = new Map<string, MeetingParticipant>();
  const decisions: MeetingPoint[] = [];
  const actionItems: MeetingPoint[] = [];
  const seen = new Set<string>();
  let capped = false;
  let labeled = false;

  for (const utterance of utterances) {
    const speaker = utterance.speaker?.trim() || null;
    if (speaker) labeled = true;
    if (speaker) {
      const existing = participants.get(speaker);
      if (existing) {
        existing.utterances += 1;
        existing.words += countWords(utterance.text);
        if (utterance.atMs !== null) {
          existing.lastAtMs = utterance.atMs;
          if (existing.firstAtMs === null) existing.firstAtMs = utterance.atMs;
        }
      } else {
        participants.set(speaker, {
          speaker,
          label: labelOf(speaker),
          utterances: 1,
          words: countWords(utterance.text),
          firstAtMs: utterance.atMs,
          lastAtMs: utterance.atMs,
        });
      }
    }
    const kind = classifyUtterance(utterance.text);
    if (!kind) continue;
    const key = `${kind}\u0000${speaker ?? ""}\u0000${utterance.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = kind === "decision" ? decisions : actionItems;
    if (target.length >= MAX_PROTOCOL_POINTS) {
      capped = true;
      continue;
    }
    target.push({
      text: utterance.text.trim(),
      speaker,
      label: labelOf(speaker),
      atMs: utterance.atMs,
    });
  }

  return {
    title: options.title?.trim() || DEFAULT_PROTOCOL_TITLE,
    participants: [...participants.values()],
    decisions,
    actionItems,
    utterances: utterances.length,
    labeled,
    diarizationMarker: options.diarizationMarker ?? null,
    diarization: options.diarization ?? null,
    capped,
  };
}

/** Builds the protocol from a labeled transcript block or from core segments. */
export function buildMeetingProtocol(input: MeetingProtocolInput): MeetingProtocol {
  if (input.text !== undefined) {
    const parsed = parseLabeledTranscript(input.text);
    return protocolFromUtterances(parsed.utterances, {
      title: input.title,
      diarizationMarker: parsed.diarizationMarker,
      diarization: input.diarization ?? null,
    });
  }
  const utterances = input.segments ? utterancesFromSegments(input.segments) : [];
  return protocolFromUtterances(utterances, {
    title: input.title,
    diarizationMarker: null,
    diarization: input.diarization ?? null,
  });
}

function pointLine(point: MeetingPoint): string {
  const stamp = point.atMs === null ? "" : `[${formatStamp(point.atMs)}] `;
  // myrmidon(1.6.5 VOICE-STT B): an author is named only when the transcript
  // named one — an unlabeled point is a bare bullet, not a fake «без автора».
  const author = point.speaker === null ? "" : `${point.label}: `;
  return `- ${stamp}${author}${point.text}`;
}

/**
 * The protocol as markdown for the work bot and the task thread. Every empty
 * list says so in words ("не найдены") and an unlabeled transcript carries the
 * explicit marker: an omission is never the message.
 */
export function renderMeetingProtocol(protocol: MeetingProtocol): string {
  const lines: string[] = [];
  lines.push(`# Протокол встречи: ${protocol.title}`, "");
  lines.push(`Реплик в записи: ${protocol.utterances}.`);
  if (!protocol.labeled) {
    const reason = protocol.diarizationMarker ?? protocol.diarization?.reason ?? "diarization_no_speakers";
    lines.push(
      "",
      `Участники не размечены: ${reason}`,
      "",
      "_Текст не разделён по говорящим: протокол собран без авторства реплик._",
    );
  } else {
    lines.push("", `## Участники (${protocol.participants.length})`, "");
    for (const participant of protocol.participants) {
      const first = participant.firstAtMs === null ? "" : `, первая реплика ${formatStamp(participant.firstAtMs)}`;
      lines.push(`- ${participant.label} — реплик: ${participant.utterances}${first}`);
    }
  }
  lines.push("", `## Решения (${protocol.decisions.length})`, "");
  if (protocol.decisions.length === 0) lines.push("- не найдены в тексте");
  else for (const decision of protocol.decisions) lines.push(pointLine(decision));
  lines.push("", `## Задачи (${protocol.actionItems.length})`, "");
  if (protocol.actionItems.length === 0) lines.push("- не найдены в тексте");
  else for (const action of protocol.actionItems) lines.push(pointLine(action));
  if (protocol.capped) {
    lines.push("", `_Список сокращён: показаны первые ${MAX_PROTOCOL_POINTS} пунктов каждого вида._`);
  }
  return lines.join("\n");
}
