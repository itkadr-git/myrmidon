import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import type { TFunction } from "i18next";
import type { ToolActionRequestListItem } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { issuesApi } from "@/api/issues";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useTranslation } from "@/i18n";

/**
 * "Ask first" review queue (M1b float / M9 card, PAP-10859).
 *
 * Renders pending `tool_action_requests` as prosumer cards with three choices:
 *   • Allow once   → approve this single request
 *   • Always allow → approve + create a trust rule (won't ask again)
 *   • Decline      → reject this request
 *
 * Pass `connectionId` to scope the queue to a single app (App detail); omit it
 * to show every pending request (Needs attention page).
 */
export function ReviewQueueCard({
  connectionId,
  emptyState = "hidden",
  heading,
  plain = false,
}: {
  connectionId?: string;
  emptyState?: "hidden" | "reassure";
  heading?: string;
  plain?: boolean;
}) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();

  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests(selectedCompanyId ?? "__none__", "pending"),
    queryFn: () => toolsApi.listActionRequests(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const items = useMemo(() => {
    const all = query.data?.actionRequests ?? [];
    return connectionId ? all.filter((item) => item.connectionId === connectionId) : all;
  }, [query.data, connectionId]);

  if (!selectedCompanyId) return null;
  if (query.isLoading) return null;
  if (query.isError) return <p role="alert" className="text-sm text-destructive">{t("area.apps-connections-3.review-queue-card.loadFailed")}</p>;

  if (items.length === 0) {
    if (emptyState === "hidden") return null;
    return (
      <div className={plain ? "py-5 text-sm text-muted-foreground" : "rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground"}>
        {t("area.apps-connections-3.review-queue-card.empty")}
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-bold text-foreground">{heading ?? t("area.apps-connections-3.review-queue-card.defaultHeading")}</h2>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <ReviewRow key={item.request.id} companyId={selectedCompanyId} item={item} plain={plain} />
        ))}
      </div>
    </section>
  );
}

function ReviewRow({
  companyId,
  item,
  plain,
}: {
  companyId: string;
  item: ToolActionRequestListItem;
  plain: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [resolving, setResolving] = useState<null | "allow" | "always" | "decline">(null);

  const interactionQuery = useQuery({
    queryKey: queryKeys.issues.interactions(item.request.issueId ?? "__none__"),
    queryFn: () => issuesApi.listInteractions(item.request.issueId!),
    enabled: Boolean(item.request.issueId && item.request.interactionId),
  });
  const linkedInteraction = interactionQuery.data?.find(row => row.id === item.request.interactionId);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(companyId, "pending") });
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
    if (item.request.issueId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(item.request.issueId) });
  };

  const allowOnce = useMutation({
    mutationFn: () => toolsApi.approveActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("allow"),
    onSuccess: () => {
      pushToast({ title: t("area.apps-connections-3.review-queue-card.allowedOnceTitle"), body: t("area.apps-connections-3.review-queue-card.allowedOnceBody", { action: actionLabel(item, t) }), tone: "success" });
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error, t);
    },
    onSettled: () => setResolving(null),
  });

  const alwaysAllow = useMutation({
    mutationFn: async () => {
      return toolsApi.approveActionRequest(companyId, item.request.id, true);
    },
    onMutate: () => setResolving("always"),
    onSuccess: () => {
      pushToast({
        title: t("area.apps-connections-3.review-queue-card.alwaysAllowedTitle"),
        body: t("area.apps-connections-3.review-queue-card.alwaysAllowedBody", { action: actionLabel(item, t) }),
        tone: "success",
      });
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error, t);
    },
    onSettled: () => setResolving(null),
  });

  const decline = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("decline"),
    onSuccess: () => {
      pushToast({ title: t("area.apps-connections-3.review-queue-card.declinedTitle"), body: t("area.apps-connections-3.review-queue-card.declinedBody", { action: actionLabel(item, t) }), tone: "info" });
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error, t);
    },
    onSettled: () => setResolving(null),
  });

  if (linkedInteraction) return <IssueThreadInteractionCard
    interaction={linkedInteraction}
    onAcceptInteraction={async (_interaction, _keys, _options, rememberAction) => {
      try { await toolsApi.approveActionRequest(companyId, item.request.id, rememberAction); }
      finally { invalidate(); }
    }}
    onRejectInteraction={async (_interaction, reason) => {
      try { await toolsApi.declineActionRequest(companyId, item.request.id, reason); }
      finally { invalidate(); }
    }}
  />;

  const busy = resolving !== null;
  const preview = item.request.previewMarkdown?.trim();

  return (
    <div className={plain ? "py-3" : "rounded-xl border border-border bg-card p-4"}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-bold text-foreground">{actionLabel(item, t)}</span>
        {item.applicationName && (
          <span className="text-muted-foreground">
            {t("area.apps-connections-3.review-queue-card.inApp", { app: humanizeConnectionDisplayName(item.applicationName) })}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{t("area.apps-connections-3.review-queue-card.asked", { when: timeAgo(item.request.createdAt) })}</span>
      </div>

      {preview ? (
        <div className="mt-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <MarkdownBody>{preview}</MarkdownBody>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          {t("area.apps-connections-3.review-queue-card.agentWantsAction")}
        </p>
      )}

      {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <p className="mt-2 text-xs text-muted-foreground">{t("area.apps-connections-3.review-queue-card.alwaysAllowHint")}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => allowOnce.mutate()} disabled={busy}>
          {resolving === "allow" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          {t("area.apps-connections-3.review-queue-card.allowOnce")}
        </Button>
        {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <Button size="sm" variant="outline" onClick={() => alwaysAllow.mutate()} disabled={busy}>
          {resolving === "always" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {t("area.apps-connections-3.review-queue-card.alwaysAllow")}
        </Button> : null}
        <Button size="sm" variant="ghost" onClick={() => decline.mutate()} disabled={busy}>
          {resolving === "decline" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
          {t("area.apps-connections-3.review-queue-card.decline")}
        </Button>
      </div>
    </div>
  );
}

function actionLabel(item: ToolActionRequestListItem, t: TFunction): string {
  if (!item.toolTitle && !item.toolName) return t("area.apps-connections-3.review-queue-card.thisAction");
  return humanizeConnectionDisplayName(item.toolName ?? "", { title: item.toolTitle });
}

function failToast(
  pushToast: ReturnType<typeof useToast>["pushToast"],
  error: unknown,
  t: TFunction,
) {
  pushToast({
    title: t("area.apps-connections-3.review-queue-card.saveFailedTitle"),
    body: error instanceof Error ? error.message : t("area.apps-connections-3.review-queue-card.tryAgain"),
    tone: "error",
  });
}
