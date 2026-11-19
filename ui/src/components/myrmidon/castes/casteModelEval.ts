// myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948): pure highlight logic for the
// per-caste model comparison panel in the "Agent castes" settings screen.
//
// The server's `suggestedModel` (OPE-12933) owns the ranking: the UI's job is
// to mark that model in the table, so the owner sees which model the reference
// run picked as the best free enabled one before they confirm anything. When
// an older server (before OPE-12933) omits `suggestedModel`, the UI falls back
// to deriving the same pick locally: free + enabled + max score, stable
// alphabetical tie-break. The UI never changes the caste model by itself —
// the change goes out only through the existing PATCH (castesApi.update) after
// the owner's explicit confirmation.
import type { CasteModelEvalResultView } from "./castesApi";

/**
 * Best free enabled model of a comparison: `suggestedModel` from the server
 * when it points at one of the rows, otherwise the local derivation — max
 * score among free+enabled, alphabetical tie-break for stability.
 */
export function bestFreeEnabledModel(
  results: readonly CasteModelEvalResultView[],
  suggestedModel: string | null | undefined,
): string | null {
  const qualified = results.filter((row) => row.free && row.enabled && row.score !== null);
  if (qualified.length === 0) return null;
  if (suggestedModel && results.some((row) => row.model === suggestedModel)) {
    return suggestedModel;
  }
  return qualified.reduce((best, row) => {
    if (row.score > best.score) return row;
    if (row.score < best.score) return best;
    return row.model < best.model ? row : best;
  }).model;
}

/**
 * Sort the comparison rows: the highlighted (best free enabled) model first,
 * then by score descending, then alphabetically for stable order.
 */
export function sortEvalResults(
  results: readonly CasteModelEvalResultView[],
  bestModel: string | null,
): CasteModelEvalResultView[] {
  const cmp = (a: CasteModelEvalResultView, b: CasteModelEvalResultView): number => {
    const aBest = bestModel !== null && a.model === bestModel;
    const bBest = bestModel !== null && b.model === bestModel;
    if (aBest !== bBest) return aBest ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.model.localeCompare(b.model);
  };
  return [...results].sort(cmp);
}
