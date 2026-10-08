// server/src/myrmidon/voice-meeting-protocol/labeled.ts
//
// myrmidon(1.6.5 VOICE-STT B): the labeled transcript — the input of the
// meeting protocol.
//
// Two shapes arrive here and mean the same thing:
//
//   - the transcript block the intake writes into a task comment
//     («Говорящий 2 [3:10]: реплика», optionally closed by the diarization
//     marker line «Говорящие не размечены: <код>»);
//   - the STT core's own segments (speaker, startMs, endMs, text).
//
// Both fold into one line-per-utterance list, so the protocol is built from a
// single input type and the two producers cannot drift apart.
//
// Nothing here invents a speaker: a line without a label stays unlabeled and
// the protocol reports that the recording was not separated into voices. The
// marker line is recognized so the protocol can repeat it instead of quietly
// dropping it.

export interface LabeledUtterance {
  /** The provider's label ("1", "2", ...) or null when the line carries none. */
  speaker: string | null;
  /** Position on the recording in ms; null for a line without a timestamp. */
  atMs: number | null;
  text: string;
}

/** «Говорящий 2 [3:10]: текст» — the line the intake renders. */
const LABELED_LINE = /^(?:Говорящий|Speaker)\s+([^\s[\]]+)\s+\[(\d{1,4}):([0-5]\d)\]:\s*(.*)$/;

/** «[3:10]: текст» — a segment without a speaker keeps its timestamp only. */
const TIMED_LINE = /^\[(\d{1,4}):([0-5]\d)\]:\s*(.*)$/;

/** «Говорящие не размечены: <код>» — the explicit diarization marker. */
const DIARIZATION_MARKER_LINE = /^Говорящие не размечены:\s*(.+)$/;

/** `m:ss` (minutes are not capped at 59; long recordings keep counting). */
export function formatStamp(atMs: number | null): string {
  if (atMs === null) return "";
  const total = Math.max(0, Math.trunc(atMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** One utterance rendered the way the intake renders it. */
export function formatLabeledLine(utterance: LabeledUtterance): string {
  const text = utterance.text.trim();
  const stamp = formatStamp(utterance.atMs);
  const speaker = utterance.speaker?.trim();
  if (speaker && stamp) return `Говорящий ${speaker} [${stamp}]: ${text}`;
  if (speaker) return `Говорящий ${speaker}: ${text}`;
  if (stamp) return `[${stamp}]: ${text}`;
  return text;
}

export interface ParsedTranscript {
  utterances: LabeledUtterance[];
  /** The marker line, when the transcript carries one; null otherwise. */
  diarizationMarker: string | null;
}

/** Parses a labeled transcript block into utterances, line by line. */
export function parseLabeledTranscript(text: string): ParsedTranscript {
  const utterances: LabeledUtterance[] = [];
  let diarizationMarker: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const marker = DIARIZATION_MARKER_LINE.exec(line);
    if (marker) {
      diarizationMarker = marker[1]!.trim();
      continue;
    }
    const labeled = LABELED_LINE.exec(line);
    if (labeled) {
      const body = labeled[4]!.trim();
      if (!body) continue;
      utterances.push({
        speaker: labeled[1]!,
        atMs: Number(labeled[2]) * 60_000 + Number(labeled[3]) * 1000,
        text: body,
      });
      continue;
    }
    const timed = TIMED_LINE.exec(line);
    if (timed) {
      const body = timed[3]!.trim();
      if (!body) continue;
      utterances.push({
        speaker: null,
        atMs: Number(timed[1]) * 60_000 + Number(timed[2]) * 1000,
        text: body,
      });
      continue;
    }
    utterances.push({ speaker: null, atMs: null, text: line });
  }
  return { utterances, diarizationMarker };
}

/** The core's segments as utterances (the other producer's shape). */
export function utterancesFromSegments(
  segments: ReadonlyArray<{ speaker?: string; startMs: number; endMs: number; text: string }>,
): LabeledUtterance[] {
  const utterances: LabeledUtterance[] = [];
  for (const segment of segments) {
    const body = segment.text.trim();
    if (!body) continue;
    const speaker = segment.speaker?.trim();
    utterances.push({
      speaker: speaker ? speaker : null,
      atMs: Number.isFinite(segment.startMs) ? segment.startMs : null,
      text: body,
    });
  }
  return utterances;
}