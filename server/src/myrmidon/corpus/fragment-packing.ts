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
}

const SEPARATOR = "\n\n";

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

  const fragments: PackedCorpusFragment[] = [];
  let tokenCount = 0;
  for (const hit of hits) {
    if (hit.score < minScore || !hit.text.trim() || !hit.document.id.trim()) continue;

    const citation = `[Source: ${hit.document.name || hit.document.id} (${hit.document.id}, chunk ${hit.chunkId})]`;
    const fragmentText = `${citation}\n${hit.text}`;
    const candidateText = fragments.length === 0 ? fragmentText : `${SEPARATOR}${fragmentText}`;
    const candidateTokens = Math.ceil(candidateText.length / 4);
    if (tokenCount + candidateTokens > tokenBudget) continue;

    const selected: PackedCorpusFragment = {
      chunkId: hit.chunkId,
      ordinal: hit.ordinal,
      text: hit.text,
      score: hit.score,
      source: hit.document,
      citation,
      tokenCount: Math.ceil(fragmentText.length / 4),
    };
    fragments.push(selected);
    tokenCount += candidateTokens;
  }

  return { fragments, text: fragments.map((fragment) => `${fragment.citation}\n${fragment.text}`).join(SEPARATOR), tokenCount };
}
