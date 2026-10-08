// myrmidon(CORPUS-2.0): document chunker.
//
// Sliding window over the document, with boundaries on line breaks: a window never starts or
// ends in the middle of a line unless that single line is longer than `maxChars`. Windows are
// filled up to `maxChars`, and the next window starts at the last line that begins at or before
// `end - overlapChars`, so consecutive chunks share a little text (the overlap can exceed
// `overlapChars` by up to one line, which is the price of keeping boundaries on line breaks).
// `content` is the exact slice of the document between those boundaries. Chunk ids are content
// addressed, so re-ingesting an unchanged document updates the same rows instead of adding new
// ones.

import { createHash } from "node:crypto";
import {
  CHUNK_ID_LENGTH,
  resolveChunkingOptions,
  type ChunkDocumentRequest,
  type TextChunk,
} from "./types.js";

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Chunk id of a document position: sha256 over document, ordinal and content, truncated. */
export function chunkId(documentId: string, ordinal: number, content: string): string {
  return createHash("sha256")
    .update(`${documentId}\u0000${ordinal}\u0000${content}`, "utf8")
    .digest("hex")
    .slice(0, CHUNK_ID_LENGTH);
}

export function chunkDocumentText(request: ChunkDocumentRequest): TextChunk[] {
  const options = resolveChunkingOptions(request.chunking);
  const text = request.text.replace(/\r\n?/g, "\n");
  const spans = buildWindows(text, options.maxChars, options.overlapChars);

  const chunks: TextChunk[] = [];
  for (const span of spans) {
    const content = text.slice(span.start, span.end);
    const ordinal = chunks.length;
    chunks.push({
      id: chunkId(request.documentId, ordinal, content),
      ordinal,
      content,
      startOffset: span.start,
      endOffset: span.end,
    });
  }
  return chunks;
}

/**
 * Window boundaries over the text. Every boundary is a line break, except inside a line that
 * does not fit into a window on its own; such a line is split into pieces of `maxChars` with
 * `overlapChars` of overlap. A window always makes progress, so the loop terminates.
 */
function buildWindows(text: string, maxChars: number, overlapChars: number): Span[] {
  const lines = lineSpans(text).map((span) => trimSpan(text, span)).filter((span) => span.end > span.start);
  const windows: Span[] = [];
  let index = 0;

  while (index < lines.length) {
    const first = lines[index];
    if (first.end - first.start > maxChars) {
      // The single line does not fit: split it inside, then continue on the next line.
      for (const piece of splitLongLine(first, maxChars, overlapChars)) windows.push(piece);
      index += 1;
      continue;
    }

    let last = index;
    let end = first.end;
    while (last + 1 < lines.length) {
      const candidate = lines[last + 1];
      const width = candidate.end - first.start + (candidate.start - end > 0 ? candidate.start - end : 0);
      if (width > maxChars) break;
      last += 1;
      end = candidate.end;
    }

    windows.push({ start: first.start, end });
    if (last + 1 >= lines.length) break;
    if (overlapChars === 0) {
      index = last + 1;
      continue;
    }

    // The next window starts at the last line that starts at or before the overlap threshold,
    // so it shares the text around that point with the window that just closed. It always moves
    // forward by at least one line.
    const threshold = end - overlapChars;
    let next = index + 1;
    for (let candidate = index + 1; candidate <= last; candidate += 1) {
      if (lines[candidate].start <= threshold) next = candidate;
    }
    index = next;
  }

  return windows;
}

/** Pieces of a line longer than a window: `maxChars` each, stepping by `maxChars - overlap`. */
function splitLongLine(line: Span, maxChars: number, overlapChars: number): Span[] {
  const pieces: Span[] = [];
  const step = maxChars - overlapChars;
  for (let start = line.start; start < line.end; start += step) {
    const end = Math.min(start + maxChars, line.end);
    pieces.push({ start, end });
    if (end >= line.end) break;
  }
  return pieces;
}

/** Line spans of the text; the line break itself belongs to no span. */
function lineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      spans.push({ start, end: index });
      start = index + 1;
    }
  }
  spans.push({ start, end: text.length });
  return spans;
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && isWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return { start, end };
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}