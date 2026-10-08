// myrmidon(CORPUS-2.0): wire contract of the document parser service.
//
// The shapes below are the client's view of the service the corpus module talks to; the HTTP
// mapping is written down in `README.md` next to this file and is covered by the client tests.

import type { DocumentParserError } from "./errors.js";

export type DocumentParseStatus = "pending" | "running" | "succeeded" | "failed";

export interface DocumentParseSubmission {
  /** Tenant context, when the caller has it; the parse service does not need it to do its job. */
  readonly companyId?: string;
  readonly datasetId?: string;
  /** Corpus document row this parse belongs to, when the caller already has one. */
  readonly documentId?: string;
  readonly fileName: string;
  readonly mimeType: string;
  /** Raw bytes of the document; the client base64-encodes them. */
  readonly content?: Uint8Array;
  /** Absolute URL the service fetches itself, used when the caller does not send bytes. */
  readonly sourceUri?: string;
  /** Title of the document, for the service's own reporting. */
  readonly title?: string;
  /** Parser version requested for this run, recorded by the service. */
  readonly parserVersion?: string;
  /** Idempotency key sent with the submission; generated when the caller does not set one. */
  readonly idempotencyKey?: string;
}

export interface ParsedDocumentPage {
  /** 1-based page number as reported by the service. */
  readonly pageNumber: number;
  readonly text: string;
}

export interface DocumentParseJobError {
  readonly code: string;
  readonly message: string;
}

export interface DocumentParseJob {
  readonly jobId: string;
  readonly status: DocumentParseStatus;
  readonly pages?: readonly ParsedDocumentPage[];
  readonly text?: string;
  readonly error?: DocumentParseJobError;
}

export interface DocumentParseResult {
  readonly jobId: string;
  readonly text: string;
  readonly pages: readonly ParsedDocumentPage[];
}

/**
 * Result of `parseDocument`: the client does not throw for service failures, it reports them,
 * so the worker can record a failed job and let the queue retry it. `error.retryable` decides
 * between another attempt and a permanent failure.
 */
export type DocumentParseOutcome =
  | { readonly ok: true; readonly result: DocumentParseResult }
  | { readonly ok: false; readonly jobId: string | undefined; readonly error: DocumentParserError };