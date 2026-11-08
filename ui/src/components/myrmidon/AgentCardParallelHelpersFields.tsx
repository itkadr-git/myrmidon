import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@/i18n";
import { CollapsibleSection, DraftInput, Field, ToggleField } from "../agent-config-primitives";
import {
  disableParallelHelpers,
  enableParallelHelpers,
  parseHelpersLimit,
  parseHelpersTurnBudget,
  readParallelHelpersCard,
  setHelpersNumber,
  setHelpersText,
  type BotParallelHelpersCard,
} from "./parallelHelpersConfig";

/**
 * myrmidon(PARALLEL-HELPERS): the "Parallel helpers" section of a
 * hermes_gateway agent card. Stored as `adapterConfig.parallelHelpers =
 * { enabled, maxConcurrent, model, childTurnBudget }`; the profile compiler
 * turns it into Hermes' own `delegation` config. The allowed range is not
 * hard-coded here: it comes from the company setting (`ceiling`), and this
 * component only rejects nonsense (non-numbers, absurd values), never policy.
 *
 * The helper model picks from the adapter model list (same picker as the main
 * model field); empty means "inherit the parent agent's model". The per-helper
 * turn budget is optional; empty keeps Hermes' own default.
 */

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export type HelperModelPickerRenderer = (props: {
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => ReactNode;

export function AgentCardParallelHelpersFields({
  value,
  onChange,
  ceiling,
  defaultLimit,
  renderModelPicker,
}: {
  value: unknown;
  onChange: (next: BotParallelHelpersCard | undefined) => void;
  /** Company ceiling for maxConcurrent; the server clamps, this only hints. */
  ceiling: number | null;
  /** The default limit written when the section is turned on with no limit. */
  defaultLimit: number | null;
  /** Same picker and model list as the main model field. */
  renderModelPicker: HelperModelPickerRenderer;
}) {
  const { t } = useTranslation();
  const card = readParallelHelpersCard(value);
  const enabled = card.enabled === true;
  const [expanded, setExpanded] = useState(() => enabled);
  const [modelOpen, setModelOpen] = useState(false);

  const update = (next: BotParallelHelpersCard | undefined) => onChange(next);
  const limitDraft = typeof card.maxConcurrent === "number" ? String(card.maxConcurrent) : "";
  const [limitText, setLimitText] = useState(limitDraft);
  useEffect(() => setLimitText(limitDraft), [limitDraft]);
  const parsedLimit = limitText.trim() === "" ? undefined : parseHelpersLimit(limitText);
  const budgetDraft = typeof card.childTurnBudget === "number" ? String(card.childTurnBudget) : "";
  const [budgetText, setBudgetText] = useState(budgetDraft);
  useEffect(() => setBudgetText(budgetDraft), [budgetDraft]);
  const parsedBudget = budgetText.trim() === "" ? undefined : parseHelpersTurnBudget(budgetText);
  const model = typeof card.model === "string" ? card.model : "";

  return (
    <CollapsibleSection title={t("area.settings-agent-card.agent-card-parallel-helpers-fields.title")} open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
        <ToggleField
          label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.toggleLabel")}
          hint={t("area.settings-agent-card.agent-card-parallel-helpers-fields.toggleHint")}
          checked={enabled}
          onChange={(next) =>
            update(
              next
                ? enableParallelHelpers(card, defaultLimit ?? 2)
                : disableParallelHelpers(card),
            )
          }
          toggleTestId="parallel-helpers-toggle"
        />
        {enabled && (
          <>
            <Field
              label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.maxLabel")}
              hint={
                ceiling === null || ceiling === undefined
                  ? t("area.settings-agent-card.agent-card-parallel-helpers-fields.maxHintNoCeiling")
                  : t("area.settings-agent-card.agent-card-parallel-helpers-fields.maxHintCeiling", { ceiling })
              }
            >
              <input
                type="text"
                inputMode="numeric"
                className={inputClass}
                aria-label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.maxLabel")}
                aria-invalid={parsedLimit ? !parsedLimit.ok : undefined}
                value={limitText}
                onChange={(e) => setLimitText(e.target.value)}
                onBlur={() => {
                  if (parsedLimit && parsedLimit.ok) {
                    update(setHelpersNumber(card, "maxConcurrent", parsedLimit.value));
                  } else if (limitText.trim() === "") {
                    update(setHelpersNumber(card, "maxConcurrent", undefined));
                  }
                }}
              />
              {parsedLimit && !parsedLimit.ok && (
                <p className="text-xs text-destructive" role="alert">{parsedLimit.message}</p>
              )}
            </Field>
            <Field
              label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.modelLabel")}
              hint={t("area.settings-agent-card.agent-card-parallel-helpers-fields.modelHint")}
            >
              {renderModelPicker({
                value: model,
                onChange: (id) => update(setHelpersText(card, "model", id)),
                open: modelOpen,
                onOpenChange: setModelOpen,
              })}
            </Field>
            <Field
              label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.budgetLabel")}
              hint={t("area.settings-agent-card.agent-card-parallel-helpers-fields.budgetHint")}
            >
              <input
                type="text"
                inputMode="numeric"
                className={inputClass}
                aria-label={t("area.settings-agent-card.agent-card-parallel-helpers-fields.budgetLabel")}
                aria-invalid={parsedBudget ? !parsedBudget.ok : undefined}
                value={budgetText}
                onChange={(e) => setBudgetText(e.target.value)}
                onBlur={() => {
                  if (parsedBudget && parsedBudget.ok) {
                    update(setHelpersNumber(card, "childTurnBudget", parsedBudget.value));
                  } else if (budgetText.trim() === "") {
                    update(setHelpersNumber(card, "childTurnBudget", undefined));
                  }
                }}
              />
              {parsedBudget && !parsedBudget.ok && (
                <p className="text-xs text-destructive" role="alert">{parsedBudget.message}</p>
              )}
            </Field>
            <p className="text-xs text-muted-foreground">
              {t("area.settings-agent-card.agent-card-parallel-helpers-fields.applyNote")}
            </p>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}
