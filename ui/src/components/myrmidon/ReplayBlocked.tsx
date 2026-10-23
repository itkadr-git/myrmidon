// N1: make the automatic "do not replay" hold visible and clearable by people.
// A task in this state is never woken again; the vendor UI only shows a quiet
// notice on the task page. The board UI is for people; the server additionally
// refuses agents (list: board only; resolve: board only for this path).
import { useContext, useState } from "react";
import { QueryClientContext, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";
import {
  describeResolveError,
  formError,
  replayBlockedApi,
  replayBlockedQueryKey,
  submitReplayBlockedResolution,
  type ReplayBlockedActionOutcome,
  type ReplayBlockedForm,
  type ReplayBlockedIssue,
  type ReplayBlockedOutcome,
} from "./replayBlockedApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const ALERT_CLASS =
  "border border-red-300/70 bg-red-50 text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100";

// myrmidon(OPE-8950): visible strings live in area.settings-bots-host-2.replay-blocked.*
type Translate = (key: string, options?: Record<string, unknown>) => string;

// Lazy: the language is read at render time, not frozen at import.
const OUTCOME_KEYS: Record<ReplayBlockedOutcome, string> = {
  restore: "area.settings-bots-host-2.replay-blocked.outcomeRestore",
  done: "area.settings-bots-host-2.replay-blocked.outcomeDone",
  cancel: "area.settings-bots-host-2.replay-blocked.outcomeCancel",
};

const ACTION_OUTCOME_KEYS: Record<ReplayBlockedActionOutcome, string> = {
  completed: "area.settings-bots-host-2.replay-blocked.actionsCompleted",
  not_performed: "area.settings-bots-host-2.replay-blocked.actionsNotPerformed",
  mixed: "area.settings-bots-host-2.replay-blocked.actionsMixed",
};

/** One shared request per company: every row and the task page read the same list. */
export function useReplayBlockedIssues(companyId: string | null | undefined) {
  return useQuery({
    queryKey: replayBlockedQueryKey(companyId ?? ""),
    queryFn: () => replayBlockedApi.list(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useReplayBlockedIssue(companyId: string | null | undefined, issueId: string) {
  const { data } = useReplayBlockedIssues(companyId);
  return data?.issues.find((item) => item.issueId === issueId) ?? null;
}

export function ReplayBlockedChipView({ item }: { item: ReplayBlockedIssue | null }) {
  const { t } = useTranslation() as { t: Translate };
  if (!item) return null;
  return (
    <span
      data-testid="myrmidon-replay-blocked-chip"
      title={t("area.settings-bots-host-2.replay-blocked.chipTitle", { reason: item.nextAction ?? item.cause })}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${ALERT_CLASS}`}
    >
      <OctagonX className="h-3 w-3" />
      {t("area.settings-bots-host-2.replay-blocked.chipLabel")}
    </span>
  );
}

function ReplayBlockedChipQuery({ companyId, issueId }: { companyId: string | null | undefined; issueId: string }) {
  return <ReplayBlockedChipView item={useReplayBlockedIssue(companyId, issueId)} />;
}

/** Chip for task list rows. Renders nothing where rows are shown without a query client. */
export function ReplayBlockedChip(props: { companyId: string | null | undefined; issueId: string }) {
  return useContext(QueryClientContext) ? <ReplayBlockedChipQuery {...props} /> : null;
}

export function ReplayBlockedNoticeView({
  item,
  pending,
  error,
  onSubmit,
}: {
  item: ReplayBlockedIssue;
  pending: boolean;
  error: string | null;
  onSubmit: (form: ReplayBlockedForm) => void;
}) {
  const { t } = useTranslation() as { t: Translate };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ReplayBlockedForm>({ outcome: "restore", actionOutcome: "not_performed", checked: "" });
  const invalid = formError(form, item);
  return (
    <div role="alert" data-testid="myrmidon-replay-blocked-notice" className={`my-2 rounded-md px-3 py-2 text-sm ${ALERT_CLASS}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 font-semibold">
            <OctagonX className="h-4 w-4 shrink-0" />
            {t("area.settings-bots-host-2.replay-blocked.noticeTitle")}
          </div>
          <p>
            <Trans
              i18nKey="area.settings-bots-host-2.replay-blocked.causeLine"
              values={{ action: item.nextAction ?? t("area.settings-bots-host-2.replay-blocked.defaultAction"), cause: item.cause }}
              components={{ code: <code /> }}
            />
            {item.runId && item.runAgentId ? (
              <>
                {" "}
                <Link to={`/agents/${item.runAgentId}/runs/${item.runId}`} className="underline">
                  {t("area.settings-bots-host-2.replay-blocked.openRun")}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {t("area.settings-bots-host-2.replay-blocked.reviewAndClear")}
          </Button>
        )}
      </div>
      {open && (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && !pending) onSubmit(form);
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="myrmidon-replay-outcome">{t("area.settings-bots-host-2.replay-blocked.outcomeLabel")}</Label>
            <select
              id="myrmidon-replay-outcome"
              className={SELECT_CLASS}
              value={form.outcome}
              onChange={(event) => setForm({ ...form, outcome: event.target.value as ReplayBlockedOutcome })}
            >
              {(Object.keys(OUTCOME_KEYS) as ReplayBlockedOutcome[]).map((value) => (
                <option key={value} value={value}>
                  {t(OUTCOME_KEYS[value])}
                </option>
              ))}
            </select>
          </div>
          {form.outcome === "restore" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="myrmidon-replay-action-outcome">{t("area.settings-bots-host-2.replay-blocked.actionOutcomeLabel")}</Label>
              <select
                id="myrmidon-replay-action-outcome"
                className={SELECT_CLASS}
                value={form.actionOutcome}
                onChange={(event) =>
                  setForm({ ...form, actionOutcome: event.target.value as ReplayBlockedActionOutcome })
                }
              >
                {(Object.keys(ACTION_OUTCOME_KEYS) as ReplayBlockedActionOutcome[]).map((value) => (
                  <option key={value} value={value}>
                    {t(ACTION_OUTCOME_KEYS[value])}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="myrmidon-replay-checked">{t("area.settings-bots-host-2.replay-blocked.checkedLabel")}</Label>
            <Textarea
              id="myrmidon-replay-checked"
              value={form.checked}
              placeholder={t("area.settings-bots-host-2.replay-blocked.checkedPlaceholder")}
              onChange={(event) => setForm({ ...form, checked: event.target.value })}
            />
          </div>
          {invalid && form.checked.length > 0 && <p className="text-xs">{invalid}</p>}
          {error && (
            <p data-testid="myrmidon-replay-blocked-error" className="font-medium">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!!invalid || pending}>
              {pending ? t("area.settings-bots-host-2.replay-blocked.clearing") : t("area.settings-bots-host-2.replay-blocked.clearButton")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.close")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Notice for the task page. */
export function ReplayBlockedNotice({
  companyId,
  issueId,
  onResolved,
}: {
  companyId: string;
  issueId: string;
  onResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const item = useReplayBlockedIssue(companyId, issueId);
  const mutation = useMutation({
    mutationFn: (form: ReplayBlockedForm) => submitReplayBlockedResolution(item!, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: replayBlockedQueryKey(companyId) });
      onResolved?.();
    },
  });
  if (!item) return null;
  return (
    <ReplayBlockedNoticeView
      item={item}
      pending={mutation.isPending}
      error={mutation.isError ? describeResolveError(mutation.error, item) : null}
      onSubmit={(form) => mutation.mutate(form)}
    />
  );
}
