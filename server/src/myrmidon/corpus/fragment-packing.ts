import type { CorpusChunkHit } from "./contract.js";

/** A search hit selected for an agent context, with an explicit source citation. */
export interface PackedCorpusFragment {
  chunkId: string;
  ordinal: number;
  text: string;
  score: number;
  source: CorpusChunkHit["document"];
  citation: string;
  tokenCount: number;
}

export interface PackedCorpusFragments {
  fragments: PackedCorpusFragment[];
  /** The exact context text represented by `fragments`. */
  text: string;
  tokenCount: number;
}

export interface PackCorpusFragmentsOptions {
  /** Maximum estimated tokens, including citations and separators. */
  tokenBudget: number;
  /** Hits below this score are not eligible for packing. Defaults to zero. */
  minScore?: number;
  /** Optional token estimator. When omitted, an estimator safe for Latin and non-Latin text is used. */
  estimateTokens?: (text: string) => number;
}

const SEPARATOR = "\n\n";

/**
 * Conservative token estimator that handles Latin and non-Latin scripts
 * (e.g., Cyrillic, CJK, Arabic, emojis) without external tokenizer dependencies.
 *
 * In standard BPE tokenizers (cl100k, LLaMA, Claude):
 * - ASCII alphanumeric words average ~3-4 characters per token; ceil(chars / 3) is a safe bound.
 * - Whitespace runs are ~1 token per sequence (or ceil(len / 4)).
 * - Non-Latin alphabetic scripts (Cyrillic, Greek, Hebrew, Arabic) are ~1-2 tokens per word,
 *   or ceil(chars / 1.5) to avoid undercounting compared to naive len/4.
 * - CJK ideographs/syllables are typically 1-2 tokens per character.
 * - Emojis and astral symbols are 2-4 tokens.
 * - Punctuation and symbols are 1 token each.
 */
export function estimateFragmentTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  let tokens = 0;
  const segmenter =
    /[a-zA-Z0-9_]+|[ \t\r\n]+|[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]+|[\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff]+|[^\s\w\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]+|./gu;
  let match: RegExpExecArray | null;
  while ((match = segmenter.exec(text)) !== null) {
    const s = match[0];
    if (/^[ \t\r\n]+$/.test(s)) {
      tokens += Math.ceil(s.length / 4);
    } else if (/^[a-zA-Z0-9_]+$/.test(s)) {
      tokens += Math.ceil(s.length / 3);
    } else if (/^[\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff]+$/.test(s)) {
      tokens += Math.ceil(s.length / 1.5);
    } else if (/^[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]+$/.test(s)) {
      tokens += [...s].length * 2;
    } else {
      tokens += Math.ceil(s.length / 2);
    }
  }
  return Math.max(1, tokens);
}

/**
 * Selects ranked corpus hits into a bounded, cited context.
 *
 * Hits are considered in their supplied relevance order. A fragment is added
 * only when its text, citation, and separator fit as a unit; it is never
 * truncated. This makes the returned context safe to pass to a model without
 * losing the source attached to a fragment.
 */
export function packCitedFragments(
  hits: readonly CorpusChunkHit[],
  options: PackCorpusFragmentsOptions,
): PackedCorpusFragments {
  const { tokenBudget, minScore = 0 } = options;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error("tokenBudget must be a non-negative safe integer");
  }
  if (!Number.isFinite(minScore)) {
    throw new Error("minScore must be finite");
  }

  const estimate = options.estimateTokens ?? estimateFragmentTokens;
  const fragments: PackedCorpusFragment[] = [];
  let currentText = "";
  let currentTokens = 0;

  for (const hit of hits) {
    if (hit.score < minScore || !hit.text?.trim() || !hit.document?.id?.trim()) continue;

    const citation = `[Source: ${hit.document.name || hit.document.id} (${hit.document.id}, chunk ${hit.chunkId})]`;
    const fragmentText = `${citation}\n${hit.text}`;
    const candidateText = fragments.length === 0 ? fragmentText : `${currentText}${SEPARATOR}${fragmentText}`;
    const candidateTokens = estimate(candidateText);
    if (candidateTokens > tokenBudget) continue;

    const selected: PackedCorpusFragment = {
      chunkId: hit.chunkId,
      ordinal: hit.ordinal,
      text: hit.text,
      score: hit.score,
      source: hit.document,
      citation,
      tokenCount: estimate(fragmentText),
    };
    fragments.push(selected);
    currentText = candidateText;
    currentTokens = candidateTokens;
  }

  return {
    fragments,
    text: currentText,
    tokenCount: currentTokens,
  };
}

/**
 * Verifies that the packed fragments stay strictly within budget and each fragment
 * carries an explicit source citation. Returns false if budget exceeded or citation absent.
 */
export function isPackedContextValid(
  packed: PackedCorpusFragments,
  tokenBudget: number,
  options?: { estimateTokens?: (text: string) => number },
): boolean {
  if (!packed || !Array.isArray(packed.fragments)) return false;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) return false;

  const estimate = options?.estimateTokens ?? estimateFragmentTokens;

  // 1. Budget check: neither reported count nor actual text estimate may exceed budget
  if (packed.tokenCount > tokenBudget) return false;
  if (estimate(packed.text) > tokenBudget) return false;

  // 2. Citation check for every selected fragment
  for (const fragment of packed.fragments) {
    if (!fragment.citation || !fragment.citation.trim()) return false;
    if (!fragment.source || !fragment.source.id) return false;
    if (
      !fragment.citation.includes(fragment.source.id) &&
      !(fragment.source.name && fragment.citation.includes(fragment.source.name))
    ) {
      return false;
    }
    if (!packed.text.includes(fragment.citation)) return false;
    if (!packed.text.includes(fragment.text)) return false;
  }

  return true;
}

export const validatePackedFragments = isPackedContextValid;
