// myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948): the per-caste model comparison
// panel of the "Agent castes" settings screen (section 3, under the caste
// table — CastesScreenView renders the header, the caste selector and the
// loading/error rows, this component renders the table and the decision).
//
// Shows the reference-run comparison as a model → score table and marks the
// best free enabled model (the server's suggestion; local fallback derivation
// for older servers — see casteModelEval.ts). The caste model changes only
// through the existing PATCH (castesApi.update) after the owner confirms;
// decline changes nothing on the server.
//
// Pure view (props → markup), split from the wire tier (CastesContainer.tsx)
// the same way CastesScreenView is — component tests render real rows without
// a network or a query client.
import { useState } from "react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { bestFreeEnabledModel, sortEvalResults } from "./casteModelEval";
import type { CasteModelEvalResultView } from "./castesApi";

export interface CasteModelEvalViewProps {
  /** The caste the comparison belongs to (testid scoping + remount key). */
  casteKey: string;
  results: readonly CasteModelEvalResultView[];
  /** Server-chosen suggestion; null when nothing qualifies or omitted. */
  suggestedModel: string | null;
  /** The caste model the API last reported (marks the current row). */
  currentModel: string | null;
  /** True while the confirmation PATCH is in flight. */
  confirming: boolean;
  onConfirm: (model: string) => void;
  onDecline: () => void;
}

/** Pure view: no fetching, so it is testable in isolation. */
export function CasteModelEvalView({
  casteKey,
  results,
  suggestedModel,
  currentModel,
  confirming,
  onConfirm,
  onDecline,
}: CasteModelEvalViewProps) {
  const { t } = useTranslation();
  // Decline is a local dismissal: nothing is sent, the decision row goes
  // away, and the state resets when another caste is picked (the parent
  // remounts this component per caste via `key`).
  const [declined, setDeclined] = useState(false);
  const best = bestFreeEnabledModel(results, suggestedModel);
  const rows = sortEvalResults(results, best);

  return (
    <div className="space-y-3" data-testid={`myrmidon-castes-model-eval-panel-${casteKey}`}>
      {results.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`myrmidon-castes-model-eval-empty-${casteKey}`}
        >
          {t("castes.modelEval.empty")}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid={`myrmidon-castes-model-eval-table-${casteKey}`}
            >
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-2">{t("castes.modelEval.columnModel")}</th>
                  <th className="py-1 pr-2">{t("castes.modelEval.columnScore")}</th>
                  <th className="py-1 pr-2">{t("castes.modelEval.columnCurrent")}</th>
                  <th className="py-1">{t("castes.modelEval.columnBest")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isBest = best !== null && row.model === best;
                  return (
                    <tr
                      key={row.model}
                      className="border-b border-border"
                      data-testid={`myrmidon-castes-model-eval-row-${casteKey}-${row.model}`}
                    >
                      <td
                        className="py-1.5 pr-2 font-mono text-xs"
                        data-testid={`myrmidon-castes-model-eval-model-${casteKey}-${row.model}`}
                      >
                        {row.model}
                        {row.free ? (
                          <span
                            className="ml-2 rounded-md border border-border px-1.5 py-0.5 text-xs"
                            data-testid={`myrmidon-castes-model-eval-free-${casteKey}-${row.model}`}
                          >
                            {t("castes.modelEval.freeBadge")}
                          </span>
                        ) : null}
                        {row.enabled ? null : (
                          <span
                            className="ml-2 rounded-md border border-border px-1.5 py-0.5 text-xs"
                            data-testid={`myrmidon-castes-model-eval-disabled-${casteKey}-${row.model}`}
                          >
                            {t("castes.modelEval.disabledBadge")}
                          </span>
                        )}
                      </td>
                      <td
                        className="py-1.5 pr-2 font-mono text-xs"
                        data-testid={`myrmidon-castes-model-eval-score-${casteKey}-${row.model}`}
                      >
                        {row.score}
                      </td>
                      <td className="py-1.5 pr-2 text-xs">
                        {currentModel === row.model ? (
                          <span
                            data-testid={`myrmidon-castes-model-eval-current-${casteKey}-${row.model}`}
                          >
                            {t("castes.modelEval.isCurrent")}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 text-xs">
                        {isBest ? (
                          <span
                            className="rounded-md border border-border px-1.5 py-0.5"
                            data-testid={`myrmidon-castes-model-eval-best-${casteKey}-${row.model}`}
                          >
                            {t("castes.modelEval.bestMark")}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {best && !declined ? (
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid={`myrmidon-castes-model-eval-decide-${casteKey}`}
            >
              <Button
                size="sm"
                disabled={confirming}
                onClick={() => onConfirm(best)}
                data-testid={`myrmidon-castes-model-eval-confirm-${casteKey}`}
              >
                {confirming
                  ? t("castes.modelEval.confirming")
                  : t("castes.modelEval.confirm", { model: best })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDeclined(true);
                  onDecline();
                }}
                data-testid={`myrmidon-castes-model-eval-decline-${casteKey}`}
              >
                {t("castes.modelEval.decline")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
