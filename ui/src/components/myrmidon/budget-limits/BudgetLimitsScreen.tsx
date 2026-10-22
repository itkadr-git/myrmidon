// myrmidon(1.7 BUDGET-CONFIG D): the "Budgets" screen — the view tier. It
// renders the limit hierarchy the owner edits: nest (the company and every
// project) → caste → foraging → task, each row with its amount, period, mode
// and spend against the limit, plus the global "signal only" switch and the
// change journal. Layout and local interaction state only; the react-query
// wiring lives in BudgetLimitsScreenContainer.tsx so tests drive both tiers
// separately (the same split the WIP limit and Autonomy screens use).
//
// Every visible string runs through the fork i18n catalog
// (`ui/src/i18n/myrmidon-locales/*.json`, keys under `budgetLimits.*`) — the
// RU screen carries no literal English text, guarded by the
// `legacy-screens-no-english` test.
import { useState } from "react";
import { Wallet } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  BUDGET_LIMIT_MODES,
  BUDGET_LIMIT_PERIODS,
  type BudgetLimitChangeView,
  type BudgetLimitLevel,
  type BudgetLimitMode,
  type BudgetLimitPeriod,
  type BudgetLimitUpsertBody,
  type BudgetLimitUsageRow,
  type BudgetLimitView,
  type BudgetLimitsSignalOnlyView,
} from "./budgetLimitsApi";
import {
  actionLabelKey,
  buildBudgetLimitTree,
  centsToAmountText,
  formatCents,
  levelLabelKey,
  modeLabelKey,
  nodeRefText,
  parseAmountToCents,
  parseRefForLevel,
  periodLabelKey,
  signalOnlySourceLabelKey,
  usagePercent,
  type BudgetLimitNode,
  type BudgetLimitProjectRef,
} from "./budgetLimitsConfig";

/** One row's unsaved edit. */
interface RowDraft {
  amount: string;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
}

const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground";

export interface BudgetLimitsScreenViewProps {
  limits: BudgetLimitView[] | null | undefined;
  usage: BudgetLimitUsageRow[] | null | undefined;
  journal: BudgetLimitChangeView[] | null | undefined;
  signalOnly: BudgetLimitsSignalOnlyView | null | undefined;
  projects: BudgetLimitProjectRef[];
  onSaveLimit: (level: BudgetLimitLevel, ref: string, body: BudgetLimitUpsertBody) => void;
  onDeleteLimit: (level: BudgetLimitLevel, ref: string) => void;
  onToggleSignalOnly: (signalOnly: boolean) => void;
  pending: boolean;
  error: string | null;
}

function defaultDraft(node: BudgetLimitNode): RowDraft {
  return {
    amount: centsToAmountText(node.limit?.amountCents ?? null),
    period: node.limit?.period ?? "calendar_month_utc",
    mode: node.limit?.mode ?? "hard",
    isActive: node.limit?.isActive ?? true,
  };
}

export function BudgetLimitsScreenView({
  limits,
  usage,
  journal,
  signalOnly,
  projects,
  onSaveLimit,
  onDeleteLimit,
  onToggleSignalOnly,
  pending,
  error,
}: BudgetLimitsScreenViewProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [addedRefs, setAddedRefs] = useState<Array<{ level: BudgetLimitLevel; ref: string }>>([]);
  const [addLevel, setAddLevel] = useState<BudgetLimitLevel | null>(null);
  const [addProjectRef, setAddProjectRef] = useState("");
  const [addFreeRef, setAddFreeRef] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const tree = buildBudgetLimitTree({
    limits: limits ?? [],
    usage: usage ?? [],
    projects,
    extraRefs: addedRefs,
  });
  const rows: Array<{ level: BudgetLimitLevel; nodes: BudgetLimitNode[] }> = [
    { level: "nest", nodes: tree.nest },
    { level: "caste", nodes: tree.caste },
    { level: "foraging", nodes: tree.foraging },
    { level: "issue", nodes: tree.issue },
  ];
  const journalRows = (journal ?? []).slice(0, 20);
  const signalOnlyForced = signalOnly?.source === "env";

  const draftOf = (node: BudgetLimitNode): RowDraft => drafts[node.key] ?? defaultDraft(node);

  const patchDraft = (node: BudgetLimitNode, patch: Partial<RowDraft>) => {
    setFormError(null);
    setDrafts((previous) => ({ ...previous, [node.key]: { ...(previous[node.key] ?? defaultDraft(node)), ...patch } }));
  };

  const saveRow = (node: BudgetLimitNode) => {
    const draft = draftOf(node);
    const parsed = parseAmountToCents(draft.amount);
    if (!parsed.ok) {
      setFormError(t(parsed.messageKey));
      return;
    }
    setFormError(null);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[node.key];
      return next;
    });
    onSaveLimit(node.level, node.ref, {
      amountCents: parsed.cents,
      period: draft.period,
      mode: draft.mode,
      isActive: draft.isActive,
    });
  };

  const submitAdd = (level: BudgetLimitLevel) => {
    const raw = level === "nest" ? addProjectRef : addFreeRef;
    const parsed = parseRefForLevel(level, raw);
    if (!parsed.ok) {
      setAddError(t(parsed.messageKey));
      return;
    }
    setAddError(null);
    if (!rows.find((group) => group.level === level)?.nodes.some((node) => node.ref === parsed.ref)) {
      setAddedRefs((previous) => [...previous, { level, ref: parsed.ref }]);
    }
    setAddLevel(null);
    setAddProjectRef("");
    setAddFreeRef("");
  };

  const addLabel = (level: BudgetLimitLevel) => t("budgetLimits.addTo", { level: t(levelLabelKey(level)) });

  const addLevels: BudgetLimitLevel[] = ["nest", "caste", "issue"];

  return (
    <section className="space-y-6" data-testid="myrmidon-budget-limits">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("budgetLimits.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("budgetLimits.intro")}</p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-budget-limits-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {limits ? (
        <>
          <div className="space-y-2 rounded-md border border-border px-3 py-3">
            <div className="flex items-center gap-3">
              <ToggleSwitch
                checked={signalOnly?.signalOnly ?? true}
                disabled={pending || signalOnlyForced}
                aria-label={t("budgetLimits.signalOnlyLabel")}
                data-testid="budget-limits-signal-only"
                onCheckedChange={(checked) => onToggleSignalOnly(checked)}
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("budgetLimits.signalOnlyLabel")}</p>
                <p className="max-w-2xl text-xs text-muted-foreground">{t("budgetLimits.signalOnlyHint")}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="budget-limits-signal-only-source">
              {signalOnly ? t(signalOnlySourceLabelKey(signalOnly.source)) : t("budgetLimits.loading")}
            </p>
          </div>

          {formError ? (
            <div className="text-sm text-destructive" data-testid="budget-limits-form-error" role="alert">
              {formError}
            </div>
          ) : null}

          <div className="space-y-3">
            <h3 className="text-sm font-medium">{t("budgetLimits.treeTitle")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="budget-limits-tree">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colScope")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colSpent")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colAmount")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colPeriod")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colMode")}</th>
                    <th className="py-1 font-medium">{t("budgetLimits.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((group) =>
                    group.nodes.map((node) => {
                      const draft = draftOf(node);
                      const parsed = parseAmountToCents(draft.amount);
                      const refText = nodeRefText(node);
                      const percent = usagePercent(node.spentCents, node.limit?.amountCents ?? null);
                      return (
                        <tr
                          key={node.key}
                          className="border-t border-border align-top"
                          data-testid={`budget-limits-row-${node.key}`}
                        >
                          <td className="py-2 pr-4">
                            <span className={node.depth > 0 ? "pl-6" : undefined}>{t(levelLabelKey(node.level))}</span>
                            <span className="ml-2 text-muted-foreground">
                              {"key" in refText ? t(refText.key) : refText.text}
                            </span>
                            {node.limit && !node.limit.isActive ? (
                              <span className="ml-2 text-xs text-muted-foreground">{t("budgetLimits.inactive")}</span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4">
                            {node.limit ? (
                              <span data-testid={`budget-limits-spent-${node.key}`}>
                                <span className={node.overLimit ? "font-medium text-destructive" : undefined}>
                                  {formatCents(node.spentCents ?? 0)}
                                </span>
                                <span className="text-muted-foreground">
                                  {" / "}
                                  {formatCents(node.limit.amountCents)}
                                  {percent === null ? null : ` (${t("budgetLimits.percentUsed", { percent })})`}
                                </span>
                                {node.overLimit ? (
                                  <span className="ml-2 text-xs font-medium text-destructive">
                                    {t("budgetLimits.overLimit")}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-muted-foreground" data-testid={`budget-limits-spent-${node.key}`}>
                                {t("budgetLimits.noLimit")}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            <Input
                              inputMode="decimal"
                              className="w-28"
                              value={draft.amount}
                              placeholder={t("budgetLimits.amountPlaceholder")}
                              aria-label={`${t("budgetLimits.colAmount")} — ${t(levelLabelKey(node.level))}`}
                              aria-invalid={parsed.ok ? undefined : true}
                              data-testid={`budget-limits-amount-${node.key}`}
                              onChange={(event) => patchDraft(node, { amount: event.target.value })}
                            />
                            {parsed.ok ? null : (
                              <p className="text-xs text-destructive" role="alert">
                                {t(parsed.messageKey)}
                              </p>
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            <select
                              className={selectClass}
                              value={draft.period}
                              aria-label={t("budgetLimits.colPeriod")}
                              data-testid={`budget-limits-period-${node.key}`}
                              onChange={(event) => patchDraft(node, { period: event.target.value as BudgetLimitPeriod })}
                            >
                              {BUDGET_LIMIT_PERIODS.map((period) => (
                                <option key={period} value={period}>
                                  {t(periodLabelKey(period))}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 pr-4">
                            <select
                              className={selectClass}
                              value={draft.mode}
                              aria-label={t("budgetLimits.colMode")}
                              data-testid={`budget-limits-mode-${node.key}`}
                              onChange={(event) => patchDraft(node, { mode: event.target.value as BudgetLimitMode })}
                            >
                              {BUDGET_LIMIT_MODES.map((mode) => (
                                <option key={mode} value={mode}>
                                  {t(modeLabelKey(mode))}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={pending || !parsed.ok}
                                data-testid={`budget-limits-save-${node.key}`}
                                onClick={() => saveRow(node)}
                              >
                                {node.limit ? t("budgetLimits.save") : t("budgetLimits.create")}
                              </Button>
                              {node.limit ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={pending}
                                  data-testid={`budget-limits-remove-${node.key}`}
                                  onClick={() => onDeleteLimit(node.level, node.ref)}
                                >
                                  {t("budgetLimits.remove")}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {addLevels.map((level) => (
                  <Button
                    key={level}
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid={`budget-limits-add-${level}`}
                    onClick={() => {
                      setAddError(null);
                      setAddFreeRef("");
                      setAddProjectRef("");
                      setAddLevel(addLevel === level ? null : level);
                    }}
                  >
                    {addLabel(level)}
                  </Button>
                ))}
              </div>
              {addLevel ? (
                <div className="space-y-2 rounded-md border border-border px-3 py-2" data-testid="budget-limits-add-form">
                  <Label htmlFor={`budget-limits-add-ref-${addLevel}`}>
                    {addLevel === "nest" ? t("budgetLimits.addProjectLabel") : t("budgetLimits.addRefLabel")}
                  </Label>
                  {addLevel === "nest" ? (
                    <select
                      id={`budget-limits-add-ref-${addLevel}`}
                      className={selectClass}
                      data-testid="budget-limits-add-ref"
                      value={addProjectRef}
                      onChange={(event) => setAddProjectRef(event.target.value)}
                    >
                      <option value="">{t("budgetLimits.addProjectPlaceholder")}</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`budget-limits-add-ref-${addLevel}`}
                      className="max-w-xs"
                      data-testid="budget-limits-add-ref"
                      value={addFreeRef}
                      placeholder={addLevel === "caste" ? t("budgetLimits.addCastePlaceholder") : t("budgetLimits.addIssuePlaceholder")}
                      aria-invalid={addError ? true : undefined}
                      onChange={(event) => setAddFreeRef(event.target.value)}
                    />
                  )}
                  {addError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {addError}
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    data-testid="budget-limits-add-submit"
                    onClick={() => submitAdd(addLevel)}
                  >
                    {t("budgetLimits.addSubmit")}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("budgetLimits.journalTitle")}</h3>
            {journalRows.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="budget-limits-journal-empty">
                {t("budgetLimits.journalEmpty")}
              </p>
            ) : (
              <table className="w-full text-sm" data-testid="budget-limits-journal">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colWhen")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colActor")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colAction")}</th>
                    <th className="py-1 pr-4 font-medium">{t("budgetLimits.colScope")}</th>
                    <th className="py-1 font-medium">{t("budgetLimits.colWhat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {journalRows.map((entry) => (
                    <tr key={entry.id} className="border-t border-border" data-testid={`budget-limits-journal-${entry.id}`}>
                      <td className="py-1.5 pr-4 text-muted-foreground">{new Date(entry.at).toLocaleString()}</td>
                      <td className="py-1.5 pr-4">{entry.actorId}</td>
                      <td className="py-1.5 pr-4">{t(actionLabelKey(entry.action))}</td>
                      <td className="py-1.5 pr-4">
                        {t(levelLabelKey(entry.level))}
                        <span className="ml-2 text-muted-foreground">{entry.ref}</span>
                      </td>
                      <td className="py-1.5">{<JournalChange entry={entry} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-budget-limits-loading">
          {t("budgetLimits.loading")}
        </p>
      )}
    </section>
  );
}

/** The "what changed" cell of one journal entry: create, delete or before → after. */
function JournalChange({ entry }: { entry: BudgetLimitChangeView }) {
  const { t } = useTranslation();
  const before = snapshotAmountOf(entry.before);
  const after = snapshotAmountOf(entry.after);
  if (entry.action === "create") return <>{t("budgetLimits.journalCreated", { amount: formatCents(after ?? 0) })}</>;
  if (entry.action === "delete") return <>{t("budgetLimits.journalDeleted", { amount: formatCents(before ?? 0) })}</>;
  return (
    <>
      {t("budgetLimits.journalUpdated", {
        before: formatCents(before ?? 0),
        after: formatCents(after ?? 0),
      })}
    </>
  );
}

function snapshotAmountOf(snapshot: Record<string, unknown> | null): number | null {
  const value = snapshot?.amountCents;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}