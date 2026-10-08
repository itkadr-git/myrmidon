// myrmidon(CORPUS-A): pure domain invariants — no database, no dialect.
import { describe, expect, it } from "vitest";
import {
  CORPUS_DEFAULT_EMBEDDING_MODEL,
  CORPUS_EMBEDDING_DIMENSIONS,
  CORPUS_PARSE_STATUSES,
  assertDocumentStatusTransition,
  assertEmbeddingDimensions,
  canTransitionDocumentStatus,
  isCorpusParseStatus,
  isTerminalParseStatus,
  parseJobRetryDelayMs,
} from "./domain.js";

describe("corpus domain", () => {
  it("declares the parse lifecycle states", () => {
    expect(CORPUS_PARSE_STATUSES).toEqual(["queued", "parsing", "embedding", "ready", "failed"]);
    expect(isCorpusParseStatus("queued")).toBe(true);
    expect(isCorpusParseStatus("unknown")).toBe(false);
  });

  it("uses the pilot-proven embedding defaults", () => {
    expect(CORPUS_DEFAULT_EMBEDDING_MODEL).toBe("dashscope-text-embedding-v4");
    expect(CORPUS_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it("walks the happy path queued -> parsing -> embedding -> ready", () => {
    expect(canTransitionDocumentStatus("queued", "parsing")).toBe(true);
    expect(canTransitionDocumentStatus("parsing", "embedding")).toBe(true);
    expect(canTransitionDocumentStatus("embedding", "ready")).toBe(true);
  });

  it("fails from any in-flight state and re-queues only through queued", () => {
    expect(canTransitionDocumentStatus("parsing", "failed")).toBe(true);
    expect(canTransitionDocumentStatus("embedding", "failed")).toBe(true);
    expect(canTransitionDocumentStatus("failed", "queued")).toBe(true);
    expect(canTransitionDocumentStatus("ready", "queued")).toBe(true);
    expect(canTransitionDocumentStatus("ready", "parsing")).toBe(false);
    expect(canTransitionDocumentStatus("failed", "embedding")).toBe(false);
    expect(() => assertDocumentStatusTransition("ready", "parsing")).toThrow(/illegal/);
  });

  it("treats ready and failed as terminal", () => {
    expect(isTerminalParseStatus("ready")).toBe(true);
    expect(isTerminalParseStatus("failed")).toBe(true);
    expect(isTerminalParseStatus("embedding")).toBe(false);
  });

  it("validates embedding dimensionality", () => {
    expect(() => assertEmbeddingDimensions(new Array(1024).fill(0.5))).not.toThrow();
    expect(() => assertEmbeddingDimensions(new Array(3).fill(0))).toThrow(/1024/);
    const withNaN = new Array(1024).fill(0);
    withNaN[10] = Number.NaN;
    expect(() => assertEmbeddingDimensions(withNaN)).toThrow(/finite/);
  });

  it("backs off parse-job retries with a cap", () => {
    expect(parseJobRetryDelayMs(1)).toBe(5_000);
    expect(parseJobRetryDelayMs(2)).toBe(25_000);
    expect(parseJobRetryDelayMs(3)).toBe(125_000);
    expect(parseJobRetryDelayMs(100)).toBe(30 * 60_000);
  });
});
