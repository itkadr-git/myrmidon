// myrmidon(1.6.6 CORPUS E): pure helpers of the "Knowledge corpus" screen.
// No React, no network. The bounds mirror the settings contract the server half
// of the module owns (the `corpus` block of instance settings) and validates
// again on save.
import {
  CORPUS_MAX_DOCUMENTS_MAX,
  CORPUS_MAX_DOCUMENTS_MIN,
  CORPUS_MAX_UPLOAD_MB_MAX,
  CORPUS_MAX_UPLOAD_MB_MIN,
  CORPUS_SEARCH_TOP_K_MAX,
  CORPUS_SEARCH_TOP_K_MIN,
  type CorpusDocumentStatus,
  type CorpusSettings,
} from "./corpusApi";

/** Case-insensitive dataset name: 1..64 characters after trimming. */
export const CORPUS_DATASET_NAME_MAX = 64;

/**
 * Address of the parsing service: empty (parsing not configured) or an absolute
 * `http`/`https` URL. Mirrors the server-side check so the form refuses what
 * the request would reject anyway.
 */
export const CORPUS_PARSING_URL_PATTERN = /^https?:\/\/[^\s/]+(\/[^\s]*)?$/;

/** Parse stages still on their way; the list polls while any document holds one. */
export const CORPUS_POLL_INTERVAL_MS = 4000;

export type IntParse = { ok: true; value: number } | { ok: false };

/** A whole number in [min, max]; anything else is rejected. */
export function parseBoundedInt(text: string, min: number, max: number): IntParse {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

export function parsingBaseUrlValid(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || CORPUS_PARSING_URL_PATTERN.test(trimmed);
}

export function datasetNameValid(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= CORPUS_DATASET_NAME_MAX;
}

/** All editable fields as text, so a half-typed number stays visible. */
export interface CorpusSettingsDraft {
  enabled: boolean;
  parsingServiceBaseUrl: string;
  embedderModel: string;
  maxUploadMb: string;
  maxDocuments: string;
  searchTopK: string;
}

export function draftFromSettings(settings: CorpusSettings): CorpusSettingsDraft {
  return {
    enabled: settings.enabled,
    parsingServiceBaseUrl: settings.parsingServiceBaseUrl,
    embedderModel: settings.embedderModel,
    maxUploadMb: String(settings.limits.maxUploadMb),
    maxDocuments: String(settings.limits.maxDocumentsPerDataset),
    searchTopK: String(settings.limits.searchTopK),
  };
}

/** True while every visible field of the draft holds an acceptable value. */
export function draftValid(draft: CorpusSettingsDraft): boolean {
  return (
    parsingBaseUrlValid(draft.parsingServiceBaseUrl) &&
    draft.embedderModel.trim().length > 0 &&
    parseBoundedInt(draft.maxUploadMb, CORPUS_MAX_UPLOAD_MB_MIN, CORPUS_MAX_UPLOAD_MB_MAX).ok &&
    parseBoundedInt(draft.maxDocuments, CORPUS_MAX_DOCUMENTS_MIN, CORPUS_MAX_DOCUMENTS_MAX).ok &&
    parseBoundedInt(draft.searchTopK, CORPUS_SEARCH_TOP_K_MIN, CORPUS_SEARCH_TOP_K_MAX).ok
  );
}

/**
 * The settings object a draft saves, or null while any field is invalid.
 *
 * The PUT is full-object: copy the loaded settings and replace only the fields
 * this screen owns, so keys added later (by the module or another screen)
 * survive the round-trip untouched.
 */
export function settingsFromDraft(
  draft: CorpusSettingsDraft,
  base: CorpusSettings | null | undefined,
): CorpusSettings | null {
  if (!draftValid(draft)) return null;
  const maxUploadMb = parseBoundedInt(draft.maxUploadMb, CORPUS_MAX_UPLOAD_MB_MIN, CORPUS_MAX_UPLOAD_MB_MAX);
  const maxDocuments = parseBoundedInt(draft.maxDocuments, CORPUS_MAX_DOCUMENTS_MIN, CORPUS_MAX_DOCUMENTS_MAX);
  const searchTopK = parseBoundedInt(draft.searchTopK, CORPUS_SEARCH_TOP_K_MIN, CORPUS_SEARCH_TOP_K_MAX);
  if (!maxUploadMb.ok || !maxDocuments.ok || !searchTopK.ok) return null;

  return {
    ...(base ?? {}),
    enabled: draft.enabled,
    parsingServiceBaseUrl: draft.parsingServiceBaseUrl.trim(),
    embedderModel: draft.embedderModel.trim(),
    limits: {
      ...(base?.limits ?? {}),
      maxUploadMb: maxUploadMb.value,
      maxDocumentsPerDataset: maxDocuments.value,
      searchTopK: searchTopK.value,
    },
  };
}

/** Translation key of a parse status. */
export function statusLabelKey(status: CorpusDocumentStatus): string {
  return `corpus.documents.status.${status}`;
}

/** `ready` and `failed` do not change on their own. */
export function isTerminalStatus(status: CorpusDocumentStatus): boolean {
  return status === "ready" || status === "failed";
}

/** A byte count split into a number and a unit key, so locales pick the unit. */
export function formatBytes(bytes: number): { value: string; unitKey: string } {
  if (bytes >= 1024 * 1024) {
    return { value: (bytes / (1024 * 1024)).toFixed(1), unitKey: "corpus.units.mb" };
  }
  if (bytes >= 1024) {
    return { value: String(Math.round(bytes / 1024)), unitKey: "corpus.units.kb" };
  }
  return { value: String(bytes), unitKey: "corpus.units.bytes" };
}

/** Timestamp of the last document change, in the runtime locale. */
export function timestampText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

/**
 * Anchor of a document row: a search hit links to the entry of the document
 * inside the list that is already on screen, so a hit opens its source without
 * a separate viewer.
 */
export function documentAnchorId(documentId: string): string {
  return `corpus-document-${documentId}`;
}

export function documentAnchorHref(documentId: string): string {
  return `#${documentAnchorId(documentId)}`;
}

/** Score of a hit, trimmed to three decimals (the fused rank is a ratio). */
export function scoreText(score: number): string {
  return score.toFixed(3);
}