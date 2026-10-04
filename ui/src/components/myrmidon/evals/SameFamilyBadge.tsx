// myrmidon(OPE-4150 EVALS-JUDGE-FAMILY): same-family judge badge.
//
// Shown next to a reference-task eval result when the judge model and the
// evaluated agent model come from the same model family (both DashScope/Qwen,
// for example): the judge is effectively grading "its own kind", and the owner
// should see that at a glance. Tokens only (DESIGN.md): Tailwind palette
// names, no raw values.

import { useTranslation } from "@/i18n";

export interface SameFamilyBadgeProps {
  /** True when the judge and the evaluated subject share a model family. */
  sameFamily: boolean;
}

/** Pure badge: no data fetching, so it is testable in isolation. */
export function SameFamilyBadge({ sameFamily }: SameFamilyBadgeProps) {
  const { t } = useTranslation();
  if (!sameFamily) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-600/50 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-400/50 dark:bg-amber-950 dark:text-amber-300"
      data-testid="same-family-badge"
      title={t("evals.sameFamily.tooltip", {
        defaultValue: "The judge model belongs to the same family as the evaluated agent model",
      })}
    >
      <span aria-hidden="true">⚖</span>
      <span>{t("evals.sameFamily.label", { defaultValue: "Same-family judge" })}</span>
    </span>
  );
}
