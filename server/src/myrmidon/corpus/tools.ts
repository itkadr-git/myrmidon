// server/src/myrmidon/corpus/tools.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the `corpus_*` tools a bot calls instead
// of the RAGFlow MCP facade.
//
// Four tools, one action each:
//
//   corpus_search          — find chunks by meaning, with a score and the
//                            document each chunk came from;
//   corpus_get_document    — read one document, whole or as its chunk list;
//   corpus_list_datasets   — what there is to search in;
//   corpus_list_documents  — what is in a dataset, and whether it is ready.
//
// Everything a tool knows about policy happens here and nowhere else: the
// argument schema, the accepted aliases, the top-k ceiling, the default top-k
// from the module settings, and the check that the module is on at all. The data
// side is the injected `CorpusMcpPort` (see `contract.ts`), so this file has no
// database, no HTTP and no RAGFlow in it and can be built and tested before
// parts A, B and C land.
//
// Argument compatibility with the RAGFlow facade is on purpose (OPE-6166 runs
// both paths on the same requests): `corpus_search` accepts `dataset_ids` and
// `similarity_threshold` beside `dataset` and `min_score`, and answers with the
// same three things a shadow run compares — the chunk text, its score and the
// document it came from.

import { z } from "zod";
import {
  MAX_CORPUS_QUERY_CHARS,
  type CorpusChunkHit,
  type CorpusDatasetSummary,
  type CorpusDocumentListPage,
  type CorpusDocumentView,
  type CorpusMcpPort,
  type CorpusModuleSettings,
  type CorpusSearchResult,
} from "./contract.js";

/** Tool names; fixed here and in the PR, because a bot's configuration names them. */
export const CORPUS_TOOL_NAMES = {
  search: "corpus_search",
  getDocument: "corpus_get_document",
  listDatasets: "corpus_list_datasets",
  listDocuments: "corpus_list_documents",
} as const;

export type CorpusToolName = (typeof CORPUS_TOOL_NAMES)[keyof typeof CORPUS_TOOL_NAMES];

/** Error codes of the corpus tools; the message is what a bot sees. */
export type CorpusErrorCode =
  | "corpus_disabled"
  | "corpus_unavailable"
  | "invalid_tool_input"
  | "dataset_not_found"
  | "document_not_found"
  | "query_failed";

/** A failure of the corpus path with a stable code. */
export class CorpusError extends Error {
  readonly code: CorpusErrorCode;

  constructor(code: CorpusErrorCode, message: string) {
    super(message);
    this.name = "CorpusError";
    this.code = code;
  }
}

/** The first issue of a failed parse, as a sentence a bot can act on. */
function invalidInput(tool: string, error: z.ZodError): CorpusError {
  const issue = error.issues[0];
  const where = issue?.path.join(".") || "arguments";
  return new CorpusError(
    "invalid_tool_input",
    `${tool}: ${where} — ${issue?.message ?? "invalid input"}`,
  );
}

/** A non-empty string that survived trimming, or null. */
function trimmedNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Dataset filter as the two spellings of the same thing. The RAGFlow retrieval
 * tool takes `dataset_ids: string[]`; the corpus tools also take `dataset`, one
 * id or name. Both may be sent; they are merged, deduplicated, and an empty
 * result means "every dataset" rather than "nothing".
 */
const datasetFilter = z.object({
  dataset: z.string().optional(),
  dataset_ids: z.array(z.string()).optional(),
});

export const corpusSearchInput = datasetFilter.extend({
  /** What to look for, in the bot's own words. */
  query: z.string().trim().min(1).max(MAX_CORPUS_QUERY_CHARS),
  /** How many chunks to return; the settings' ceiling still applies. */
  top_k: z.number().int().positive().optional(),
  /** Floor for a hit's score. RAGFlow's spelling of the same field is `similarity_threshold`. */
  min_score: z.number().min(0).max(1).optional(),
  similarity_threshold: z.number().min(0).max(1).optional(),
});

export const corpusGetDocumentInput = z.object({
  /** Id of the document, as `corpus_search` and `corpus_list_documents` report it. */
  document_id: z.string().trim().min(1),
  /** Return the text as well as the metadata; true unless the bot says otherwise. */
  include_text: z.boolean().optional(),
});

export const corpusListDatasetsInput = z.object({}).strict();

export const corpusListDocumentsInput = z.object({
  dataset: z.string().optional(),
  dataset_ids: z.array(z.string()).optional(),
  /** Documents to skip; must come with `limit`. */
  offset: z.number().int().min(0).optional(),
  /** Documents per page; defaults to the settings' ceiling. */
  limit: z.number().int().positive().optional(),
});

export const corpusToolDefinitions = [
  {
    name: CORPUS_TOOL_NAMES.search,
    description:
      "Search the company's knowledge corpus and return the most relevant chunks, each with its " +
      "score and the document it came from. Restrict the search to one or more datasets with " +
      "`dataset` or `dataset_ids`. Use it instead of the RAGFlow retrieval tool: same question, " +
      "the answer is already what a shadow run compares.",
    inputSchema: z.toJSONSchema(corpusSearchInput),
  },
  {
    name: CORPUS_TOOL_NAMES.getDocument,
    description:
      "Read one corpus document: its metadata, its parse state, and (unless `include_text` is " +
      "false) its text assembled from the indexed chunks. Use the document id a search result " +
      "reported.",
    inputSchema: z.toJSONSchema(corpusGetDocumentInput),
  },
  {
    name: CORPUS_TOOL_NAMES.listDatasets,
    description:
      "List the datasets of the company's corpus with their document and chunk counts. Use it to " +
      "find the dataset to search in when the question does not name one.",
    inputSchema: z.toJSONSchema(corpusListDatasetsInput),
  },
  {
    name: CORPUS_TOOL_NAMES.listDocuments,
    description:
      "List the documents of a dataset with their parse state (queued, parsing, embedding, ready, " +
      "failed). Use it to check whether a document is ready to be searched before asking for it.",
    inputSchema: z.toJSONSchema(corpusListDocumentsInput),
  },
] as const;

/** The settings, or the reason there are no tools at all. */
function requireSettings(settings: CorpusModuleSettings): CorpusModuleSettings {
  if (!settings.enabled) {
    throw new CorpusError(
      "corpus_disabled",
      "The knowledge corpus is not enabled on this instance: a board operator turns it on in the " +
        "corpus settings",
    );
  }
  return settings;
}

/** The port, or the reason a call cannot be served. */
function requirePort(port: CorpusMcpPort | null): CorpusMcpPort {
  if (!port) {
    throw new CorpusError(
      "corpus_unavailable",
      "The knowledge corpus is enabled but its data side is not available on this instance",
    );
  }
  return port;
}

/** Ids from both spellings of the dataset filter, trimmed and deduplicated. */
function datasetIds(input: { dataset?: string; dataset_ids?: string[] }): string[] {
  const ids = [
    ...(input.dataset_ids ?? []),
    ...(input.dataset === undefined ? [] : [input.dataset]),
  ]
    .map((value) => trimmedNonEmpty(value))
    .filter((value): value is string => value !== null);
  return [...new Set(ids)];
}

/** `top_k` within the settings' ceiling; a request above it is refused, not clamped. */
function resolveTopK(requested: number | undefined, settings: CorpusModuleSettings): number {
  if (requested === undefined) return settings.defaultTopK;
  if (requested > settings.maxTopK) {
    throw new CorpusError(
      "invalid_tool_input",
      `corpus_search: top_k — ${requested} is above the limit of ${settings.maxTopK}`,
    );
  }
  return requested;
}

/** `limit` of a document page within the settings' ceiling; same rule as `top_k`. */
function resolveLimit(requested: number | undefined, settings: CorpusModuleSettings): number {
  if (requested === undefined) return settings.maxTopK;
  if (requested > settings.maxTopK) {
    throw new CorpusError(
      "invalid_tool_input",
      `corpus_list_documents: limit — ${requested} is above the limit of ${settings.maxTopK}`,
    );
  }
  return requested;
}

export interface CorpusToolDeps {
  settings: CorpusModuleSettings;
  port: CorpusMcpPort | null;
}

/** Runs `corpus_search`. */
async function callSearch(args: unknown, deps: CorpusToolDeps): Promise<CorpusSearchResult> {
  const settings = requireSettings(deps.settings);
  const parsed = corpusSearchInput.safeParse(args);
  if (!parsed.success) throw invalidInput(CORPUS_TOOL_NAMES.search, parsed.error);
  const datasets = datasetIds(parsed.data);
  const minScore = parsed.data.min_score ?? parsed.data.similarity_threshold ?? null;
  return requirePort(deps.port).search({
    query: parsed.data.query,
    datasets,
    topK: resolveTopK(parsed.data.top_k, settings),
    minScore,
  });
}

/** Runs `corpus_get_document`. */
async function callGetDocument(args: unknown, deps: CorpusToolDeps): Promise<CorpusDocumentView> {
  requireSettings(deps.settings);
  const parsed = corpusGetDocumentInput.safeParse(args);
  if (!parsed.success) throw invalidInput(CORPUS_TOOL_NAMES.getDocument, parsed.error);
  return requirePort(deps.port).getDocument({
    documentId: parsed.data.document_id,
    includeText: parsed.data.include_text ?? true,
  });
}

/** Runs `corpus_list_datasets`. */
async function callListDatasets(args: unknown, deps: CorpusToolDeps): Promise<CorpusDatasetSummary[]> {
  requireSettings(deps.settings);
  const parsed = corpusListDatasetsInput.safeParse(args ?? {});
  if (!parsed.success) throw invalidInput(CORPUS_TOOL_NAMES.listDatasets, parsed.error);
  return requirePort(deps.port).listDatasets();
}

/** Runs `corpus_list_documents`. */
async function callListDocuments(
  args: unknown,
  deps: CorpusToolDeps,
): Promise<CorpusDocumentListPage> {
  const settings = requireSettings(deps.settings);
  const parsed = corpusListDocumentsInput.safeParse(args ?? {});
  if (!parsed.success) throw invalidInput(CORPUS_TOOL_NAMES.listDocuments, parsed.error);
  const datasets = datasetIds(parsed.data);
  const offset = parsed.data.offset ?? 0;
  if (parsed.data.offset !== undefined && parsed.data.limit === undefined) {
    throw new CorpusError(
      "invalid_tool_input",
      `${CORPUS_TOOL_NAMES.listDocuments}: limit — an offset needs a limit to page with`,
    );
  }
  return requirePort(deps.port).listDocuments({
    // A page belongs to one dataset: the first id of the filter, or none for the
    // whole corpus.
    datasetId: datasets[0] ?? null,
    offset,
    limit: resolveLimit(parsed.data.limit, settings),
  });
}

/**
 * Runs one tool by name. Throws `CorpusError` with a stable code: a tool call
 * that cannot succeed is a result a bot reads, never a crash of the endpoint.
 */
export async function callCorpusTool(
  name: string,
  args: unknown,
  deps: CorpusToolDeps,
): Promise<unknown> {
  switch (name) {
    case CORPUS_TOOL_NAMES.search:
      return callSearch(args, deps);
    case CORPUS_TOOL_NAMES.getDocument:
      return callGetDocument(args, deps);
    case CORPUS_TOOL_NAMES.listDatasets:
      return callListDatasets(args, deps);
    case CORPUS_TOOL_NAMES.listDocuments:
      return callListDocuments(args, deps);
    default:
      throw new CorpusError("invalid_tool_input", `Unknown corpus tool: ${name}`);
  }
}

/** True when `name` is one of the four tools; the endpoint uses it to answer -32602. */
export function isCorpusToolName(name: unknown): name is CorpusToolName {
  return (
    typeof name === "string" &&
    (Object.values(CORPUS_TOOL_NAMES) as string[]).includes(name)
  );
}

export type { CorpusChunkHit, CorpusDatasetSummary, CorpusDocumentListPage, CorpusDocumentView, CorpusSearchResult };