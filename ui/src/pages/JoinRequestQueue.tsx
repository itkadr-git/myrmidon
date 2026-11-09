import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function JoinRequestQueue() {
  const { t, i18n } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("area.access-secrets-2.join-request-queue.orgFallback"), href: "/dashboard" },
      { label: t("area.access-secrets-2.join-request-queue.breadcrumbInbox"), href: "/inbox" },
      { label: t("area.access-secrets-2.join-request-queue.breadcrumbJoinRequests") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const requestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", `${status}:${requestType}`),
    queryFn: () =>
      accessApi.listJoinRequests(
        selectedCompanyId!,
        status,
        requestType === "all" ? undefined : requestType,
      ),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!) });
      pushToast({ title: t("area.access-secrets-2.join-request-queue.approvedToast"), tone: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: t("area.access-secrets-2.join-request-queue.rejectedToast"), tone: "success" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("area.access-secrets-2.join-request-queue.selectOrg")}</div>;
  }

  if (requestsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("area.access-secrets-2.join-request-queue.loading")}</div>;
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? t("area.access-secrets-2.join-request-queue.noPermission")
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : t("area.access-secrets-2.join-request-queue.loadFailed");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("area.access-secrets-2.join-request-queue.title")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("area.access-secrets-2.join-request-queue.intro")}
        </p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("area.access-secrets-2.join-request-queue.statusLabel")}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">{t("area.access-secrets-2.join-request-queue.statusPending")}</option>
            <option value="approved">{t("area.access-secrets-2.join-request-queue.statusApproved")}</option>
            <option value="rejected">{t("area.access-secrets-2.join-request-queue.statusRejected")}</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">{t("area.access-secrets-2.join-request-queue.typeLabel")}</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">{t("area.access-secrets-2.join-request-queue.typeAll")}</option>
            <option value="human">{t("area.access-secrets-2.join-request-queue.typeHuman")}</option>
            <option value="agent">{t("area.access-secrets-2.join-request-queue.typeAgent")}</option>
          </select>
        </label>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            {t("area.access-secrets-2.join-request-queue.empty")}
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {request.status.replace("_", " ")}
                    </Badge>
                    <Badge variant="outline">{request.requestType}</Badge>
                    {request.adapterType ? <Badge variant="outline">{request.adapterType}</Badge> : null}
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || request.requestingUserId || t("area.access-secrets-2.join-request-queue.unknownHuman")
                        : request.agentName || t("area.access-secrets-2.join-request-queue.unknownAgent")}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {request.requestType === "human"
                        ? request.requesterUser?.email || request.requestEmailSnapshot || request.requestingUserId
                        : request.capabilities || request.requestIp}
                    </div>
                  </div>
                </div>

                {request.status === "pending_approval" ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => rejectMutation.mutate(request.id)}
                      disabled={rejectMutation.isPending}
                    >
                      {t("area.access-secrets-2.join-request-queue.reject")}
                    </Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >
                      {t("area.access-secrets-2.join-request-queue.approve")}
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("area.access-secrets-2.join-request-queue.inviteContext")}</div>
                  <div className="mt-2">
                    {request.invite
                      ? [
                          t("area.access-secrets-2.join-request-queue.inviteSummary", { joinType: request.invite.allowedJoinTypes }),
                          request.invite.humanRole
                            ? t("area.access-secrets-2.join-request-queue.inviteDefaultRole", { role: request.invite.humanRole })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" • ")
                      : t("area.access-secrets-2.join-request-queue.inviteUnavailable")}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">{t("area.access-secrets-2.join-request-queue.requestDetails")}</div>
                  <div className="mt-2">{t("area.access-secrets-2.join-request-queue.submitted", { date: new Date(request.createdAt).toLocaleString(i18n.language) })}</div>
                  <div>{t("area.access-secrets-2.join-request-queue.sourceIp", { ip: request.requestIp })}</div>
                  {request.requestType === "agent" && request.capabilities ? <div>{request.capabilities}</div> : null}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
