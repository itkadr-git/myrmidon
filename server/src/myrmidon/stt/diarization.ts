// server/src/myrmidon/stt/diarization.ts
//
// myrmidon(1.6.5 VOICE-STT B): the diarization outcome of one recognition,
// reported as a value instead of being left to silence.
//
// The whole point of this file is the explicit marker: "the provider was
// asked for speaker labels and the answer carried none" is a DIFFERENT fact
// from "nobody asked", and both are different from "one speaker spoke". A
// caller (the Telegram intake, the meeting-protocol flow) that cannot tell
// them apart renders an unlabeled transcript as if it were a single-speaker
// recording. So every call answers a report with a stable reason code.
//
// Nothing here inspects audio or invents a label: it only counts the labels
// the provider returned. Speakers are never renumbered here — the merge already
// assigned recording-global numbers.

import type { SttDiarizationReport, SttSegment } from "./types.js";

/**
 * Counts the distinct speaker labels the segments carry and names why they
 * are missing, if they are.
 *
 * `requested` is the contour's own setting (`MYRMIDON_STT_DIARIZATION` or the
 * company's stored switch), not a guess from the answer: a provider that
 * returns labels without being asked still counts as applied, and a requested
 * call that returns none is `diarization_no_speakers` — the explicit marker.
 */
export function summarizeDiarization(
  segments: ReadonlyArray<Pick<SttSegment, "speaker">> | undefined,
  requested: boolean,
): SttDiarizationReport {
  const labels = new Set<string>();
  for (const segment of segments ?? []) {
    const label = segment.speaker?.trim();
    if (label) labels.add(label);
  }
  const speakers = labels.size;
  if (speakers > 0) {
    return { requested, applied: true, speakers, reason: null };
  }
  return {
    requested,
    applied: false,
    speakers: 0,
    reason: requested ? "diarization_no_speakers" : "diarization_disabled",
  };
}

/**
 * True when the caller asked for speaker labels and did not get them — the
 * condition the intake renders as an explicit marker line and the meeting
 * protocol reports as an unlabeled transcript.
 */
export function diarizationMissing(report: SttDiarizationReport | undefined): boolean {
  return Boolean(report?.requested) && !report?.applied;
}