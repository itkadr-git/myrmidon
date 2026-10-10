// myrmidon(CORPUS-2.0): Reciprocal Rank Fusion for the hybrid (vector + full text) search.
//
// The pilot showed the two rankings must be merged by rank, not by score: cosine distance
// and `ts_rank` are not comparable. RRF scores every candidate as the sum of 1 / (k0 + rank)
// over the rankings it appears in, with k0 = 60 and at most k_candidates rows taken from each
// ranking before the merge.

export interface FusionParameters {
  /** RRF constant; keeps the head of a ranking from dominating the merge. */
  readonly k0: number;
  /** How many rows of each ranking take part in the merge. */
  readonly kCandidates: number;
}

export const DEFAULT_FUSION_PARAMETERS: FusionParameters = {
  k0: 60,
  kCandidates: 100,
};

export interface FusedCandidate {
  readonly id: string;
  /** Sum of 1 / (k0 + rank) over the rankings the candidate appears in. */
  readonly score: number;
  /** 1-based rank in the vector ranking, or null when the candidate is only in the full text one. */
  readonly vectorRank: number | null;
  /** 1-based rank in the full text ranking, or null when the candidate is only in the vector one. */
  readonly fullTextRank: number | null;
}

export function assertFusionParameters(parameters: FusionParameters): FusionParameters {
  if (!Number.isInteger(parameters.k0) || parameters.k0 < 1) {
    throw new RangeError("fusion k0 must be a positive integer");
  }
  if (!Number.isInteger(parameters.kCandidates) || parameters.kCandidates < 1) {
    throw new RangeError("fusion kCandidates must be a positive integer");
  }
  return parameters;
}

/**
 * Merges the two rankings. Duplicates inside one ranking keep their best rank. The result is
 * ordered by score descending; ties fall back to the better rank and then to the id, so the
 * order of equal-scored candidates never depends on the order they were merged in.
 */
export function reciprocalRankFusion(
  vectorIds: readonly string[],
  fullTextIds: readonly string[],
  parameters: FusionParameters = DEFAULT_FUSION_PARAMETERS,
): FusedCandidate[] {
  const { k0, kCandidates } = assertFusionParameters(parameters);
  const candidates = new Map<string, { score: number; vectorRank: number | null; fullTextRank: number | null }>();

  const merge = (ids: readonly string[], key: "vectorRank" | "fullTextRank"): void => {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of ids) {
      if (rank >= kCandidates) break;
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      const candidate = candidates.get(id) ?? { score: 0, vectorRank: null, fullTextRank: null };
      candidate.score += 1 / (k0 + rank);
      candidate[key] = rank;
      candidates.set(id, candidate);
    }
  };

  merge(vectorIds, "vectorRank");
  merge(fullTextIds, "fullTextRank");

  return [...candidates.entries()]
    .map(([id, candidate]) => ({ id, ...candidate }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Equal fused score: the vector ranking is the primary signal, then the full-text one,
      // then the id — so the order is stable across runs and engines.
      const leftVector = left.vectorRank ?? Number.MAX_SAFE_INTEGER;
      const rightVector = right.vectorRank ?? Number.MAX_SAFE_INTEGER;
      if (leftVector !== rightVector) return leftVector - rightVector;
      const leftFullText = left.fullTextRank ?? Number.MAX_SAFE_INTEGER;
      const rightFullText = right.fullTextRank ?? Number.MAX_SAFE_INTEGER;
      if (leftFullText !== rightFullText) return leftFullText - rightFullText;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}