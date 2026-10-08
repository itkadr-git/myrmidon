// packages/shared/src/myrmidon-corpus.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the settings and wire contract of the corpus
// module — the company knowledge base built on the `packages/corpus` ports
// (CorpusStore / SearchIndex / WorkQueue / BlobStore, parts A and B).
//
// Settings precedence follows CONVENTIONS.md §8 and the canonical shape of
// `myrmidon-runtime-limits.ts`: the environment variable is the default of an
// instance that never saved the block, `instance_settings.general.corpus` is
// the truth once an operator saves it through `PATCH
// /api/myrmidon/corpus/settings`, and every key has a built-in default for an
// instance that has neither. `resolveCorpusSettings` reports the source of
// every value, so the settings page shows where a number came from.
//
// The module is OFF by default. A fleet that never turns it on behaves exactly
// as before: the settings route still answers (so the page can say why), every
// data route answers 503 with `corpus_disabled`, and the parse sweep is a no-op
// that never touches a port. A typo in the environment never enables it: only
// the explicit truthy values below do (the fail-safe side is OFF).
//
// The wire shapes in the second half are THIS part's contract — what the routes
// return, what the UI (part E) and the MCP tools (part D) read. The records of
// the ports are mapped onto them at the service boundary, so a field named
// differently inside `packages/corpus` never leaks into the API.

import { z } from "zod";

/** The keys of the stored `instance_settings.general.corpus` block. */
export const CORPUS_SETTINGS_KEYS = [
  "enabled",
  "parserBaseUrl",
  "parserTimeoutMs",
  "embedderModel",
  "embedderDimensions",
  "embedderBaseUrl",
  "maxDocumentBytes",
  "maxDocumentsPerDataset",
  "parseConcurrency",
  "maxParseAttempts",
  "searchTopK",
] as const;

export type CorpusSettingsKey = (typeof CORPUS_SETTINGS_KEYS)[number];

/** Where an effective value came from: the stored block, the environment, the default. */
export type CorpusSettingSource = "stored" | "env" | "default";

export type CorpusSettingSources = Record<CorpusSettingsKey, CorpusSettingSource>;

/**
 * The effective settings of the corpus module.
 *
 * `parserBaseUrl` / `embedderBaseUrl` are `null` when the value is not
 * configured. An empty URL is "not configured here" and falls back to the
 * environment (the same rule the agent-memory card uses for its address), so
 * the settings page never has to guess whether an operator cleared a field or
 * never touched it.
 */
export interface CorpusSettings {
  /** Master switch of the module. Off: routes answer 503, the sweep is a no-op. */
  enabled: boolean;
  /** Base URL of the document-parse service (PDF/scan → text over HTTP). */
  parserBaseUrl: string | null;
  /** Per-request timeout of the parse service, milliseconds. */
  parserTimeoutMs: number;
  /** Embedding model the search index asks the LLM gateway for. */
  embedderModel: string;
  /** Dimensions of that model, part of the index schema. */
  embedderDimensions: number;
  /** Base URL of the embedding gateway; `null` = the board's own gateway. */
  embedderBaseUrl: string | null;
  /** Largest document the upload route accepts, bytes. */
  maxDocumentBytes: number;
  /** Largest number of documents one dataset may hold. */
  maxDocumentsPerDataset: number;
  /** Documents a single parse pass takes from the queue. */
  parseConcurrency: number;
  /** Attempts a document gets before it settles `failed`. */
  maxParseAttempts: number;
  /** Default number of hits a search returns when the request asks for none. */
  searchTopK: number;
}

/** Environment variables behind the same keys (CONVENTIONS.md §8: env = default). */
export const CORPUS_SETTINGS_ENV: Record<CorpusSettingsKey, string> = {
  enabled: "MYRMIDON_CORPUS_ENABLED",
  parserBaseUrl: "MYRMIDON_CORPUS_PARSER_BASE_URL",
  parserTimeoutMs: "MYRMIDON_CORPUS_PARSER_TIMEOUT_MS",
  embedderModel: "MYRMIDON_CORPUS_EMBEDDER_MODEL",
  embedderDimensions: "MYRMIDON_CORPUS_EMBEDDER_DIMENSIONS",
  embedderBaseUrl: "MYRMIDON_CORPUS_EMBEDDER_BASE_URL",
  maxDocumentBytes: "MYRMIDON_CORPUS_MAX_DOCUMENT_BYTES",
  maxDocumentsPerDataset: "MYRMIDON_CORPUS_MAX_DOCUMENTS_PER_DATASET",
  parseConcurrency: "MYRMIDON_CORPUS_PARSE_CONCURRENCY",
  maxParseAttempts: "MYRMIDON_CORPUS_MAX_PARSE_ATTEMPTS",
  searchTopK: "MYRMIDON_CORPUS_SEARCH_TOP_K",
};

/** The value of every key for an instance that has neither the row nor the variable. */
export const DEFAULT_CORPUS_SETTINGS: CorpusSettings = {
  enabled: false,
  parserBaseUrl: null,
  parserTimeoutMs: 60_000,
  embedderModel: "text-embedding-v4",
  embedderDimensions: 1024,
  embedderBaseUrl: null,
  maxDocumentBytes: 25 * 1024 * 1024,
  maxDocumentsPerDataset: 1_000,
  parseConcurrency: 2,
  maxParseAttempts: 3,
  searchTopK: 5,
};

/** Bounds of every numeric key, shared by the stored reader and the PATCH validator. */
export const CORPUS_SETTINGS_BOUNDS: Record<
  "parserTimeoutMs" | "embedderDimensions" | "maxDocumentBytes" | "maxDocumentsPerDataset" | "parseConcurrency" | "maxParseAttempts" | "searchTopK",
  { min: number; max: number }
> = {
  parserTimeoutMs: { min: 1_000, max: 600_000 },
  embedderDimensions: { min: 1, max: 8_192 },
  maxDocumentBytes: { min: 1, max: 1024 * 1024 * 1024 },
  maxDocumentsPerDataset: { min: 1, max: 100_000 },
  parseConcurrency: { min: 1, max: 16 },
  maxParseAttempts: { min: 1, max: 10 },
  searchTopK: { min: 1, max: 50 },
};

/** Longest accepted URL/text of the module. */
export const CORPUS_SETTING_TEXT_MAX = 500;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** True when the value is the explicit "on" spelling; anything else is not "on". */
function isExplicitTrue(value: string): boolean {
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * A boolean from a stored or environment value, or `undefined` when the value
 * says nothing usable. Unrecognized text reads as `undefined` (the caller's
 * fallback), never as `true`: a typo must not switch the module on.
 */
export function readCorpusBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (TRUE_VALUES.has(trimmed)) return true;
  if (FALSE_VALUES.has(trimmed)) return false;
  return undefined;
}

/** An integer inside the key's bounds, or `undefined` when it is absent or out of range. */
export function readCorpusInt(value: unknown, key: keyof typeof CORPUS_SETTINGS_BOUNDS): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed)) return undefined;
  const { min, max } = CORPUS_SETTINGS_BOUNDS[key];
  return parsed >= min && parsed <= max ? parsed : undefined;
}

/**
 * A trimmed non-empty http(s) URL, `null` for a value that is explicitly empty
 * ("not configured here"), `undefined` when the value is absent or unusable —
 * the caller then falls back to the next source. The three-way result is what
 * makes the precedence rule above work.
 */
export function readCorpusUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

/** A trimmed non-empty string, or `undefined` for everything else. */
export function readCorpusText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, CORPUS_SETTING_TEXT_MAX) : undefined;
}

/**
 * The stored shape. Deliberately lenient: every value is `unknown` and the
 * readers above decide what is usable, so a row written by an older release
 * (or by hand) never fails the whole `general` block and every blob `strip()`s
 * away is not lost (CONVENTIONS.md §11, the same rule as `myrmidon-bot-disk.ts`).
 */
export const storedCorpusSettingsSchema = z
  .object({
    enabled: z.unknown().optional(),
    parserBaseUrl: z.unknown().optional(),
    parserTimeoutMs: z.unknown().optional(),
    embedderModel: z.unknown().optional(),
    embedderDimensions: z.unknown().optional(),
    embedderBaseUrl: z.unknown().optional(),
    maxDocumentBytes: z.unknown().optional(),
    maxDocumentsPerDataset: z.unknown().optional(),
    parseConcurrency: z.unknown().optional(),
    maxParseAttempts: z.unknown().optional(),
    searchTopK: z.unknown().optional(),
  })
  .catchall(z.unknown());

/** The PATCH body of `PATCH /api/myrmidon/corpus/settings` — strict, so a typo is a 400. */
export const patchCorpusSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    parserBaseUrl: z.string().trim().max(CORPUS_SETTING_TEXT_MAX).nullable().optional(),
    parserTimeoutMs: z.number().int().min(CORPUS_SETTINGS_BOUNDS.parserTimeoutMs.min).max(CORPUS_SETTINGS_BOUNDS.parserTimeoutMs.max).optional(),
    embedderModel: z.string().trim().min(1).max(CORPUS_SETTING_TEXT_MAX).optional(),
    embedderDimensions: z.number().int().min(CORPUS_SETTINGS_BOUNDS.embedderDimensions.min).max(CORPUS_SETTINGS_BOUNDS.embedderDimensions.max).optional(),
    embedderBaseUrl: z.string().trim().max(CORPUS_SETTING_TEXT_MAX).nullable().optional(),
    maxDocumentBytes: z.number().int().min(CORPUS_SETTINGS_BOUNDS.maxDocumentBytes.min).max(CORPUS_SETTINGS_BOUNDS.maxDocumentBytes.max).optional(),
    maxDocumentsPerDataset: z.number().int().min(CORPUS_SETTINGS_BOUNDS.maxDocumentsPerDataset.min).max(CORPUS_SETTINGS_BOUNDS.maxDocumentsPerDataset.max).optional(),
    parseConcurrency: z.number().int().min(CORPUS_SETTINGS_BOUNDS.parseConcurrency.min).max(CORPUS_SETTINGS_BOUNDS.parseConcurrency.max).optional(),
    maxParseAttempts: z.number().int().min(CORPUS_SETTINGS_BOUNDS.maxParseAttempts.min).max(CORPUS_SETTINGS_BOUNDS.maxParseAttempts.max).optional(),
    searchTopK: z.number().int().min(CORPUS_SETTINGS_BOUNDS.searchTopK.min).max(CORPUS_SETTINGS_BOUNDS.searchTopK.max).optional(),
  })
  .strict();

export type CorpusSettingsPatch = z.infer<typeof patchCorpusSettingsSchema>;

/** The settings as the API returns them: the values plus where each one came from. */
export interface ResolvedCorpusSettings {
  settings: CorpusSettings;
  sources: CorpusSettingSources;
  /** Convenience mirror of `settings.enabled` for the callers that only gate on it. */
  enabled: boolean;
}

/**
 * Merge a stored patch onto the settings in force. Only the keys present in the
 * patch move; a `null` URL clears the value (it then falls back to the
 * environment on the next read).
 */
export function mergeCorpusSettings(current: CorpusSettings, patch: CorpusSettingsPatch): CorpusSettings {
  const next: CorpusSettings = { ...current };
  for (const key of CORPUS_SETTINGS_KEYS) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** Keys of a patch that actually change the settings in force. */
export function changedCorpusSettingsKeys(
  before: CorpusSettings,
  after: CorpusSettings,
): CorpusSettingsKey[] {
  return CORPUS_SETTINGS_KEYS.filter((key) => (before[key] ?? null) !== (after[key] ?? null));
}

/**
 * The settings in force and the source of each value: the stored block, then
 * the environment variable, then the built-in default. An invalid stored value
 * is not a value at all — it falls through to the next source, and never takes
 * the module's data routes down.
 */
export function resolveCorpusSettings(input: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedCorpusSettings {
  const stored =
    input.stored && typeof input.stored === "object"
      ? (input.stored as Record<string, unknown>)
      : {};
  const env = input.env ?? {};
  const sources = {} as CorpusSettingSources;

  const pick = <T>(
    key: CorpusSettingsKey,
    readStored: (value: unknown) => T | null | undefined,
    readEnv: (value: string | undefined) => T | null | undefined,
    fallback: T,
  ): T => {
    const fromStored = readStored(stored[key]);
    if (fromStored !== undefined && fromStored !== null) {
      sources[key] = "stored";
      return fromStored;
    }
    if (fromStored === null) {
      // Explicitly cleared in the stored block: the value "is not configured
      // here", so the environment still speaks (the agent-memory rule).
      sources[key] = "stored";
    }
    const fromEnv = readEnv(env[CORPUS_SETTINGS_ENV[key]]);
    if (fromEnv !== undefined && fromEnv !== null) {
      sources[key] = "env";
      return fromEnv;
    }
    if (fromStored === null || fromEnv === null) {
      sources[key] = sources[key] ?? "default";
      return fallback;
    }
    sources[key] = "default";
    return fallback;
  };

  const settings: CorpusSettings = {
    enabled: pick("enabled", readCorpusBoolean, readCorpusBoolean, DEFAULT_CORPUS_SETTINGS.enabled),
    parserBaseUrl: pick(
      "parserBaseUrl",
      readCorpusUrl,
      (value) => (value === undefined ? undefined : readCorpusUrl(value) ?? null),
      DEFAULT_CORPUS_SETTINGS.parserBaseUrl,
    ),
    parserTimeoutMs: pick("parserTimeoutMs", (value) => readCorpusInt(value, "parserTimeoutMs"), (value) => readCorpusInt(value, "parserTimeoutMs"), DEFAULT_CORPUS_SETTINGS.parserTimeoutMs),
    embedderModel: pick("embedderModel", readCorpusText, readCorpusText, DEFAULT_CORPUS_SETTINGS.embedderModel),
    embedderDimensions: pick("embedderDimensions", (value) => readCorpusInt(value, "embedderDimensions"), (value) => readCorpusInt(value, "embedderDimensions"), DEFAULT_CORPUS_SETTINGS.embedderDimensions),
    embedderBaseUrl: pick(
      "embedderBaseUrl",
      readCorpusUrl,
      (value) => (value === undefined ? undefined : readCorpusUrl(value) ?? null),
      DEFAULT_CORPUS_SETTINGS.embedderBaseUrl,
    ),
    maxDocumentBytes: pick("maxDocumentBytes", (value) => readCorpusInt(value, "maxDocumentBytes"), (value) => readCorpusInt(value, "maxDocumentBytes"), DEFAULT_CORPUS_SETTINGS.maxDocumentBytes),
    maxDocumentsPerDataset: pick("maxDocumentsPerDataset", (value) => readCorpusInt(value, "maxDocumentsPerDataset"), (value) => readCorpusInt(value, "maxDocumentsPerDataset"), DEFAULT_CORPUS_SETTINGS.maxDocumentsPerDataset),
    parseConcurrency: pick("parseConcurrency", (value) => readCorpusInt(value, "parseConcurrency"), (value) => readCorpusInt(value, "parseConcurrency"), DEFAULT_CORPUS_SETTINGS.parseConcurrency),
    maxParseAttempts: pick("maxParseAttempts", (value) => readCorpusInt(value, "maxParseAttempts"), (value) => readCorpusInt(value, "maxParseAttempts"), DEFAULT_CORPUS_SETTINGS.maxParseAttempts),
    searchTopK: pick("searchTopK", (value) => readCorpusInt(value, "searchTopK"), (value) => readCorpusInt(value, "searchTopK"), DEFAULT_CORPUS_SETTINGS.searchTopK),
  };

  return { settings, sources, enabled: settings.enabled };
}

// ---------------------------------------------------------------------------
// Wire contract (part C owns it; part D's MCP tools and part E's screen read it)
// ---------------------------------------------------------------------------

/** Lifecycle of one uploaded document, as the routes report it. */
export const CORPUS_DOCUMENT_STATUSES = ["queued", "parsing", "ready", "failed"] as const;
export type CorpusDocumentStatus = (typeof CORPUS_DOCUMENT_STATUSES)[number];

/** State of the parse job behind a document. */
export const CORPUS_JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type CorpusParseJobState = (typeof CORPUS_JOB_STATES)[number];

/** Retrieval modes of `POST …/datasets/:datasetId/search`. */
export const CORPUS_SEARCH_MODES = ["hybrid", "vector", "fulltext"] as const;
export type CorpusSearchMode = (typeof CORPUS_SEARCH_MODES)[number];

/** Body of every corpus data route that is refused while the module is off. */
export const CORPUS_DISABLED_ERROR = "corpus_disabled";

export interface CorpusDataset {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** Documents of the dataset, by the store's count. */
  documentCount: number;
  readyCount: number;
  failedCount: number;
  /** Chunks the search index holds for the whole dataset. */
  chunkCount: number;
}

export interface CorpusDocument {
  id: string;
  companyId: string;
  datasetId: string;
  filename: string;
  mimeType: string | null;
  byteSize: number;
  status: CorpusDocumentStatus;
  /** Chunks indexed for this document; 0 until the parse pass finished. */
  chunkCount: number;
  /** Why the last attempt failed, or null. */
  error: string | null;
  /** Attempts used so far. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** When the document reached `ready`, else null. */
  parsedAt: string | null;
}

export interface CorpusParseJob {
  id: string;
  companyId: string;
  datasetId: string;
  documentId: string;
  state: CorpusParseJobState;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Whole-corpus counters of one company (`GET …/stats`). */
export interface CorpusStats {
  datasets: number;
  documents: number;
  ready: number;
  /** Documents queued or parsing — the parse pass still owes them work. */
  pending: number;
  failed: number;
  chunks: number;
  bytes: number;
}

export interface CorpusSearchHit {
  chunkId: string;
  documentId: string;
  datasetId: string;
  score: number;
  text: string;
  /** Structured fields the parse service attached to the chunk, if any. */
  metadata: Record<string, unknown>;
}

export interface CorpusSearchResponse {
  datasetId: string;
  query: string;
  mode: CorpusSearchMode;
  limit: number;
  hits: CorpusSearchHit[];
}

/** Body of `POST …/datasets`. */
export const createCorpusDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Body of `PATCH …/datasets/:datasetId`. At least one key must be present. */
export const updateCorpusDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((value: Record<string, unknown>) => Object.keys(value).length > 0, { message: "at least one field is required" });

/** Body of `POST …/datasets/:datasetId/search`. */
export const corpusSearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    limit: z.number().int().min(1).max(50).optional(),
    mode: z.enum(CORPUS_SEARCH_MODES).optional(),
  })
  .strict();

export type CreateCorpusDatasetInput = z.infer<typeof createCorpusDatasetSchema>;
export type UpdateCorpusDatasetInput = z.infer<typeof updateCorpusDatasetSchema>;
export type CorpusSearchInput = z.infer<typeof corpusSearchBodySchema>;

/** Route paths, so part D and part E do not hard-code strings. */
export const CORPUS_SETTINGS_PATH = "/api/myrmidon/corpus/settings";

export function corpusCompanyPrefix(companyId: string): string {
  return `/api/myrmidon/companies/${encodeURIComponent(companyId)}/corpus`;
}

/** `GET`/`POST …/datasets`. */
export function corpusDatasetsPath(companyId: string): string {
  return `${corpusCompanyPrefix(companyId)}/datasets`;
}

/** `GET`/`PATCH`/`DELETE …/datasets/:datasetId`. */
export function corpusDatasetPath(companyId: string, datasetId: string): string {
  return `${corpusDatasetsPath(companyId)}/${encodeURIComponent(datasetId)}`;
}

/** `GET`/`POST`/`DELETE …/datasets/:datasetId/documents`. */
export function corpusDocumentsPath(companyId: string, datasetId: string): string {
  return `${corpusDatasetPath(companyId, datasetId)}/documents`;
}

/** `GET`/`DELETE …/documents/:documentId` — the document id is unique in the corpus. */
export function corpusDocumentPath(companyId: string, documentId: string): string {
  return `${corpusCompanyPrefix(companyId)}/documents/${encodeURIComponent(documentId)}`;
}

/** `POST …/datasets/:datasetId/search`. */
export function corpusSearchPath(companyId: string, datasetId: string): string {
  return `${corpusDatasetPath(companyId, datasetId)}/search`;
}

/** `GET …/jobs/:jobId` — the parse job of an uploaded document. */
export function corpusJobPath(companyId: string, jobId: string): string {
  return `${corpusCompanyPrefix(companyId)}/jobs/${encodeURIComponent(jobId)}`;
}

/** `GET …/stats` — the corpus counters of one company. */
export function corpusStatsPath(companyId: string): string {
  return `${corpusCompanyPrefix(companyId)}/stats`;
}