// ui/src/ui2/screens/knowledge/Ui2Regulations.tsx
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the Regulations screen of Autonomy —
// "список по кастам, «кто должен одобрить», кнопки по approver_kind".
//
// It reads the same autonomy snapshot the matrix screen reads (one facade, no
// second store) and layers the K-4 view on top: regulations grouped by caste,
// the approver named in words, and only the verbs the current actor may press.
// A person approves here without the plugin; the agent's regulations say so and
// keep the button disabled.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { autonomyApi, autonomyQueryKey } from "@/components/myrmidon/autonomy/autonomyApi";
import type { AutonomyRegulation } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import type { Ui2MessageKey } from "../../i18n/locales";
import {
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import { Ui2Page, Ui2Section, Ui2StatusDot, Ui2Tile, Ui2Tiles } from "../../components/ui2Primitives";
import {
  countPendingRegulations,
  groupRegulationsByCaste,
  regulationActions,
  regulationApproverLabelKey,
  regulationKnowledgeLink,
  regulationRollbackRevision,
  regulationStatusTone,
} from "./regulationsModel";
import type { RegulationAction, RegulationLike, RegulationRow } from "./regulationsModel";

type MessageKey = Ui2MessageKey;
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

// The caste labels come from the shared role labels — one source of words.
const CASTE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_ROLE_LABELS),
);

/** The snapshot's regulation plus the approver fields K-3 added to the facade. */
function toRegulationLike(regulation: AutonomyRegulation): RegulationLike {
  const raw = regulation as unknown as { approverKind?: unknown; approver_kind?: unknown };
  return {
    id: regulation.id,
    role: regulation.role,
    title: regulation.title,
    status: regulation.status,
    revision: regulation.revision,
    bodyMarkdown: regulation.bodyMarkdown,
    supersededBy: regulation.supersededBy,
    wikiPageId: regulation.wikiPageId,
    approverKind: raw.approverKind ?? raw.approver_kind,
    revisions: (regulation.revisions ?? []).map((revision) => ({
      revision: revision.revision,
      title: revision.title,
      at: revision.at,
      by: revision.author?.id,
    })),
  };
}

function statusKey(status: string): MessageKey {
  switch ((status ?? "").toLowerCase()) {
    case "draft":
      return "ui2.regulations.status.draft";
    case "approved":
      return "ui2.regulations.status.approved";
    case "superseded":
      return "ui2.regulations.status.superseded";
    default:
      return "ui2.regulations.status.other";
  }
}

function RegulationActionButton({
  action,
  onAct,
  busy,
  t,
}: {
  action: RegulationAction;
  onAct: (action: RegulationAction) => void;
  busy: boolean;
  t: Translate;
}) {
  return (
    <button
      type="button"
      className={`ui2-regulation-action ui2-regulation-action-${action.key} rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50`}
      data-action={action.key}
      data-approver-kind={action.approverKind}
      disabled={!action.enabled || busy}
      title={t(action.reasonKey as MessageKey)}
      onClick={() => onAct(action)}
    >
      {t(action.reasonKey as MessageKey)}
    </button>
  );
}

function RegulationCard({
  row,
  onAction,
  busyId,
  t,
}: {
  row: RegulationRow;
  onAction: (regulation: RegulationLike, action: RegulationAction) => void;
  busyId: string | null;
  t: Translate;
}) {
  const regulation = row.regulation;
  const actions = useMemo(() => regulationActions(regulation, "human"), [regulation]);
  const knowledgeLink = regulationKnowledgeLink(regulation.wikiPageId);
  const revisionCount = regulation.revisions?.length ?? regulation.revision;
  return (
    <li
      className="ui2-regulation-card flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-approver-kind={row.approverKind}
      data-status={regulation.status}
    >
      <div className="ui2-regulation-head flex flex-wrap items-center gap-2">
        <Ui2StatusDot tone={regulationStatusTone(regulation.status)} />
        <span className="ui2-regulation-title text-sm font-medium">{regulation.title}</span>
        <span className="ui2-regulation-status text-xs text-muted-foreground">
          {t(statusKey(regulation.status))}
        </span>
        <span className="ui2-regulation-revision text-xs text-muted-foreground">
          {t("ui2.regulations.revision", { revision: regulation.revision })}
        </span>
        <span className="ui2-regulation-revisions text-xs text-muted-foreground">
          {t("ui2.regulations.casteRevisions", { count: revisionCount })}
        </span>
      </div>
      <p className="ui2-regulation-approver text-xs">
        {t("ui2.regulations.approverLabel", {
          who: t(regulationApproverLabelKey(row.approverKind) as MessageKey),
        })}
      </p>
      <div className="ui2-regulation-actions flex flex-wrap items-center gap-2">
        {actions.map((action) =>
          action.key === "openInKnowledge" && knowledgeLink ? (
            <Link
              key={action.key}
              className="ui2-regulation-action ui2-regulation-action-openInKnowledge rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              data-action={action.key}
              to={knowledgeLink}
            >
              {t("ui2.regulations.action.openInKnowledge")}
            </Link>
          ) : (
            <RegulationActionButton
              key={action.key}
              action={action}
              onAct={(pressed) => onAction(regulation, pressed)}
              busy={busyId === regulation.id}
              t={t}
            />
          ),
        )}
      </div>
    </li>
  );
}

export function Ui2Regulations() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const viewQuery = useQuery({
    queryKey: autonomyQueryKey(companyId),
    queryFn: () => autonomyApi.view(companyId),
    enabled: Boolean(companyId),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: autonomyQueryKey(companyId) });
  };

  const approve = useMutation({
    mutationFn: (regulation: RegulationLike) => autonomyApi.approveRegulation(companyId, regulation.id),
    onSuccess: () => {
      setNote(null);
      void invalidate();
    },
    onError: () => setNote(t("ui2.regulations.action.failed")),
    onSettled: () => setBusyId(null),
  });

  const rollback = useMutation({
    mutationFn: (input: { id: string; revision: number }) =>
      autonomyApi.restoreRegulationRevision(companyId, input.id, input.revision),
    onSuccess: () => {
      setNote(null);
      void invalidate();
    },
    onError: () => setNote(t("ui2.regulations.action.failed")),
    onSettled: () => setBusyId(null),
  });

  const regulations = useMemo(
    () => (viewQuery.data?.regulations ?? []).map(toRegulationLike),
    [viewQuery.data],
  );
  const groups = useMemo(() => groupRegulationsByCaste(regulations, CASTE_LABELS), [regulations]);
  const pending = useMemo(() => countPendingRegulations(regulations), [regulations]);

  const onAction = (regulation: RegulationLike, action: RegulationAction): void => {
    if (action.key === "approve") {
      setBusyId(regulation.id);
      approve.mutate(regulation);
      return;
    }
    if (action.key === "requestApproval") {
      // The agent carries this regulation itself: the person in front of the
      // screen does not press "approve" on its behalf (K-4, the a/o marker).
      setNote(
        t("ui2.regulations.approverLabel", {
          who: t(regulationApproverLabelKey(action.approverKind) as MessageKey),
        }),
      );
      return;
    }
    if (action.key === "rollback") {
      const target = regulationRollbackRevision(regulation);
      if (target === null) return;
      setBusyId(regulation.id);
      rollback.mutate({ id: regulation.id, revision: target });
    }
  };

  return (
    <Ui2Page title={t("ui2.regulations.title")} subtitle={t("ui2.regulations.subtitle")}>
      {viewQuery.isLoading ? (
        <Ui2SkeletonRows rows={4} />
      ) : viewQuery.isError ? (
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={viewQuery.error instanceof Error ? viewQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => {
            void viewQuery.refetch();
          }}
          withCache={false}
        />
      ) : (
        <>
          <Ui2Tiles>
            <Ui2Tile label={t("ui2.regulations.title")} value={String(regulations.length)} />
            <Ui2Tile
              label={t("ui2.regulations.action.approve")}
              value={t("ui2.regulations.pending", { count: pending })}
              tone={pending > 0 ? "warning" : "ok"}
            />
          </Ui2Tiles>

          {note ? <p className="ui2-regulations-note text-xs text-muted-foreground">{note}</p> : null}

          {groups.length === 0 ? (
            <Ui2EmptyStateView title={t("ui2.regulations.empty")} variant="done" />
          ) : (
            groups.map((group) => (
              <Ui2Section key={group.role} title={group.label}>
                {group.rows.length === 0 ? (
                  <p className="ui2-regulations-caste-empty text-xs text-muted-foreground">
                    {t("ui2.regulations.caste.empty")}
                  </p>
                ) : (
                  <ul className="ui2-regulations-list flex flex-col gap-2">
                    {group.rows.map((row) => (
                      <RegulationCard
                        key={row.regulation.id}
                        row={row}
                        onAction={onAction}
                        busyId={busyId}
                        t={t}
                      />
                    ))}
                  </ul>
                )}
              </Ui2Section>
            ))
          )}
        </>
      )}
    </Ui2Page>
  );
}