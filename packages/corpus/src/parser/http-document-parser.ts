// myrmidon(CORPUS-2.0): the `DocumentParser` port on top of the HTTP client.
//
// The port is what the rest of the module (the worker of part C) sees: one call, chunks out.
// Failures are thrown as `DocumentParserError` with `retryable` set — that is the flag the corpus
// worker needs to record a failed job and let the queue decide about another attempt, so a 5xx or
// a timeout never takes the worker down with it. The richer surface of the client (submit, poll,
// outcome) stays exported for callers that want to watch a job themselves.

import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  ParsedDocumentChunk,
} from "../ports.js";
import { createDocumentParserClient, type DocumentParserClientOptions } from "./document-parser-client.js";
import { DocumentParserError } from "./errors.js";
import type { DocumentParseResult as ParsedJobResult, DocumentParseSubmission } from "./types.js";

export type HttpDocumentParserOptions = DocumentParserClientOptions;

/** The parse service of the corpus module, behind the port the module wires. */
export function createHttpDocumentParser(options: DocumentParserClientOptions): DocumentParser {
  const client = createDocumentParserClient(options);
  return {
    async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
      assertRequest(request);
      const outcome = await client.parseDocument(toSubmission(request));
      if (!outcome.ok) throw outcome.error;
      return toPortResult(outcome.result, request);
    },
  };
}

function assertRequest(request: DocumentParseRequest): void {
  if (request.content === null && request.sourceUri === null) {
    throw new DocumentParserError({
      kind: "rejected",
      message: "a parse request needs either the document bytes or a source URI",
      retryable: false,
    });
  }
}

function toSubmission(request: DocumentParseRequest): DocumentParseSubmission {
  return {
    fileName: fileNameOf(request),
    mimeType: request.contentType ?? "application/octet-stream",
    title: request.title,
    parserVersion: request.parserVersion,
    ...(request.content ? { content: request.content } : {}),
    ...(request.sourceUri ? { sourceUri: request.sourceUri } : {}),
  };
}

function fileNameOf(request: DocumentParseRequest): string {
  const fromUri = request.sourceUri ? request.sourceUri.split("/").pop()?.split("?")[0] : undefined;
  if (fromUri && fromUri.length > 0) return fromUri;
  return request.title.length > 0 ? request.title : "document";
}

function toPortResult(result: ParsedJobResult, request: DocumentParseRequest): DocumentParseResult {
  return {
    chunks: result.pages.length > 0 ? pagesToChunks(result) : textToChunks(result),
    metadata: {
      jobId: result.jobId,
      parserVersion: request.parserVersion,
      pageCount: result.pages.length,
    },
  };
}

/**
 * One page of the service is one parsed block. The sliding-window chunker of the ingest pipeline
 * turns these blocks into the product's chunks, so the reading order has to survive the trip.
 */
function pagesToChunks(result: ParsedJobResult): ParsedDocumentChunk[] {
  return [...result.pages]
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((page, index) => ({
      chunkIndex: index,
      content: page.text,
      tokenCount: null,
      metadata: { pageNumber: page.pageNumber },
    }));
}

function textToChunks(result: ParsedJobResult): ParsedDocumentChunk[] {
  return [{ chunkIndex: 0, content: result.text, tokenCount: null, metadata: {} }];
}