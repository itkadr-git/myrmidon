// myrmidon(CORPUS-2.0): errors of the document parser client.
//
// The parser is a separate service reached over HTTP. Everything the client can hit is mapped
// onto one error class with a `retryable` flag, so the corpus work queue can decide between
// "try this job again later" and "fail it for good" without parsing message texts.

export type DocumentParserErrorKind =
  /** The service did not answer: connection failure, 5xx, or a response that is not usable. */
  | "unavailable"
  /** The service did not answer within the configured time. */
  | "timeout"
  /** The service refused the request (4xx): bad document, bad key, too large, unsupported type. */
  | "rejected"
  /** The service accepted the job and reported that the document cannot be parsed. */
  | "parse-failed"
  /** The service answered with a body that does not match the contract. */
  | "invalid-response";

export interface DocumentParserErrorOptions {
  readonly kind: DocumentParserErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly attempts?: number;
  readonly cause?: unknown;
}

export class DocumentParserError extends Error {
  readonly kind: DocumentParserErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** Number of requests made for this call, retries included. */
  readonly attempts: number;

  constructor(options: DocumentParserErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DocumentParserError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code;
    this.attempts = options.attempts ?? 1;
  }
}

export function isRetryableDocumentParserError(error: unknown): boolean {
  return error instanceof DocumentParserError && error.retryable;
}

/** Statuses that mean "the request was fine, try again later" rather than "do not retry". */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}