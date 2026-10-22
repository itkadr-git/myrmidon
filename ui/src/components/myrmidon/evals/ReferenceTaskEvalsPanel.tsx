// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the reference-task results screen.
//
// This is the screen the acceptance criterion asks for: the results of a
// reference-task run, one row per task, with the same-family judge badge next
// to the tasks the judge scored while coming from the same model family as the
// evaluated agent. Before this panel existed the badge component was imported
// by nothing but its own test (the defect the 05.10 review returned).
//
// Split in two on purpose: `ReferenceTaskEvalsView` is pure props -> markup, so
// the component test renders real rows without a network or a query client;
// `ReferenceTaskEvalsPanel` is the container that fetches the runs.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { SameFamilyBadge } from "./SameFamilyBadge";
import { evalsRunsQueryKey, myrmidonEvalsApi, type EvalRunView } from "./evalsApi";

const PANEL_CLASS = "rounded-lg border border-border bg-card p-4";
const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export interface ReferenceTaskEvalsViewProps {
  runs: readonly EvalRunView[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  isLoading: boolean;
  errorMessage: string | null;
  /** Shown when the company has no runs yet. */
  emptyMessage: string;
  /** Shown while no run is picked yet (only possible with runs present). */
  noRunSelectedMessage: string;
}

function percentOf(run: EvalRunView): string {
  return run.scores ? `${run.scores.scorePercent}%` : "—";
}

/** Pure view: no fetching, so it is testable in isolation. */
export function ReferenceTaskEvalsView({
  runs,
  selectedRunId,
  onSelectRun,
  isLoading,
  errorMessage,
  emptyMessage,
  noRunSelectedMessage,
}: ReferenceTaskEvalsViewProps) {
  const { t } = useTranslation();
  const run = runs.find((candidate) => candidate.id === selectedRunId) ?? null;
  const tasks = run?.scores?.tasks ?? [];

  return (
    <section className={PANEL_CLASS} data-testid="reference-task-evals-panel">
      <h2 className="text-sm font-semibold">{t("evalResults.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("evalResults.subtitle")}</p>

      {isLoading ? <p className="mt-3 text-sm">{t("evalResults.loading")}</p> : null}
      {errorMessage ? (
        <p className="mt-3 text-sm text-destructive" data-testid="reference-task-evals-error">
          {t("evalResults.loadFailed")}: {errorMessage}
        </p>
      ) : null}

      {!isLoading && !errorMessage && runs.length === 0 ? (
        <p className="mt-3 text-sm" data-testid="reference-task-evals-empty">
          {emptyMessage}
        </p>
      ) : null}

      {runs.length > 0 ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium" htmlFor="reference-task-evals-run">
            {t("evalResults.runLabel")}
          </label>
          <select
            id="reference-task-evals-run"
            data-testid="reference-task-evals-run"
            className={SELECT_CLASS}
            value={selectedRunId ?? ""}
            onChange={(event) => onSelectRun(event.target.value)}
          >
            {runs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {t("evalResults.runOption", {
                  role: candidate.role,
                  subject: candidate.subject,
                  percent: percentOf(candidate),
                })}
              </option>
            ))}
          </select>

          {run ? (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span data-testid="reference-task-evals-score">
                  {t("evalResults.scoreLabel")}: {percentOf(run)}
                </span>
                <span data-testid="reference-task-evals-judge">
                  {t("evalResults.judgeModelLabel")}: {run.model ?? "—"}
                </span>
                <span data-testid="reference-task-evals-status">
                  {t("evalResults.statusLabel")}: {run.status}
                </span>
              </div>

              <ul className="divide-y divide-border">
                {tasks.map((task) => (
                  <li
                    key={task.taskSlug}
                    data-testid="reference-task-result"
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span className="font-mono text-xs">{task.taskSlug}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {task.rawScore}/{task.maxScore}
                      </span>
                      <SameFamilyBadge sameFamily={task.sameFamily} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm" data-testid="reference-task-evals-no-run">
              {noRunSelectedMessage}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

export interface ReferenceTaskEvalsPanelProps {
  /** Optional role filter; the pilot corpus is the engineer role. */
  role?: string;
  limit?: number;
}

/** Container: fetches the company's runs and wires the selection. */
export function ReferenceTaskEvalsPanel({ role, limit }: ReferenceTaskEvalsPanelProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: evalsRunsQueryKey(selectedCompanyId ?? "", role, limit),
    queryFn: () => myrmidonEvalsApi.listRuns(selectedCompanyId ?? "", { role, limit }),
    enabled: Boolean(selectedCompanyId),
  });

  const runs = useMemo(() => query.data?.runs ?? [], [query.data]);
  // Keep the selection stable when the list refreshes, and default to the
  // newest run so the screen is useful the moment it opens.
  const effectiveRunId = runs.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : (runs[0]?.id ?? null);

  return (
    <ReferenceTaskEvalsView
      runs={runs}
      selectedRunId={effectiveRunId}
      onSelectRun={setSelectedRunId}
      isLoading={query.isLoading}
      errorMessage={query.error instanceof Error ? query.error.message : null}
      emptyMessage={t("evalResults.empty")}
      noRunSelectedMessage={t("evalResults.noRunSelected")}
    />
  );
}