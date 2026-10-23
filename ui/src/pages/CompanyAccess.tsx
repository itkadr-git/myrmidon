import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ROLE_LABELS,
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  hidesCompanyPage,
  readAgentBoardAdmin,
  type Agent,
} from "@paperclipai/shared";
import { Shield, ShieldCheck, Trash2 } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { agentDetailHref } from "@/pages/agent-detail-navigation";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link, Navigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { usePluginSlots } from "@/plugins/slots";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { InvitesSection } from "@/components/access/InvitesSection";
import { i18n, useTranslation } from "@/i18n";

const reassignmentIssueStatuses = "backlog,todo,in_progress,in_review,blocked,failed,timed_out";
type EditableMemberStatus = "pending" | "active" | "suspended";

export function CompanyAccess() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Invites render as a tab of this page; `company.invites` hides just that
  // tab while `company.members` (the route gate) hides the whole page.
  const { hidden: hiddenSettings } = useHiddenSettings();
  const hideInvitesTab = hidesCompanyPage(hiddenSettings, "company.invites");
  const requestedTab = searchParams.get("tab") === "invites" ? "invites" : "members";
  const activeTab = hideInvitesTab ? "members" : requestedTab;
  const handleTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "invites") {
          next.set("tab", "invites");
        } else {
          next.delete("tab");
        }
        return next;
      },
      { replace: true },
    );
  };
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [reassignmentTarget, setReassignmentTarget] = useState<string>("__unassigned");
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>(null);
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("area.settings-company.company-access.organization"), href: "/dashboard" },
      { label: t("area.settings-company.company-access.settings"), href: "/company/settings" },
      { label: t("area.settings-company.company-access.members") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const joinRequestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", "pending_approval"),
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!, "pending_approval"),
    enabled: !!selectedCompanyId && !!membersQuery.data?.access.canApproveJoinRequests,
  });

  const refreshAccessData = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId, "pending_approval") });
  };

  const updateMemberMutation = useMutation({
    mutationFn: async (input: { memberId: string; membershipRole: CompanyMember["membershipRole"]; status: EditableMemberStatus }) => {
      return accessApi.updateMember(selectedCompanyId!, input.memberId, {
        membershipRole: input.membershipRole,
        status: input.status,
      });
    },
    onSuccess: async () => {
      setEditingMemberId(null);
      await refreshAccessData();
      pushToast({
        title: t("area.settings-company.company-access.memberUpdated"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("area.settings-company.company-access.failedToUpdateMember"),
        body: error instanceof Error ? error.message : t("area.settings-company.company-access.unknownError"),
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("area.settings-company.company-access.joinRequestApproved"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("area.settings-company.company-access.failedToApproveJoinRequest"),
        body: error instanceof Error ? error.message : t("area.settings-company.company-access.unknownError"),
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: t("area.settings-company.company-access.joinRequestRejected"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("area.settings-company.company-access.failedToRejectJoinRequest"),
        body: error instanceof Error ? error.message : t("area.settings-company.company-access.unknownError"),
        tone: "error",
      });
    },
  });

  const editingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === editingMemberId) ?? null,
    [editingMemberId, membersQuery.data?.members],
  );
  const removingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === removingMemberId) ?? null,
    [removingMemberId, membersQuery.data?.members],
  );

  const assignedIssuesQuery = useQuery({
    queryKey: ["access", "member-assigned-issues", selectedCompanyId ?? "", removingMember?.principalId ?? ""],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeUserId: removingMember!.principalId,
        status: reassignmentIssueStatuses,
      }),
    enabled: !!selectedCompanyId && !!removingMember,
  });

  const archiveMemberMutation = useMutation({
    mutationFn: async (input: { memberId: string; target: string }) => {
      const reassignment =
        input.target.startsWith("agent:")
          ? { assigneeAgentId: input.target.slice("agent:".length), assigneeUserId: null }
          : input.target.startsWith("user:")
            ? { assigneeAgentId: null, assigneeUserId: input.target.slice("user:".length) }
            : null;
      return accessApi.archiveMember(selectedCompanyId!, input.memberId, { reassignment });
    },
    onSuccess: async (result) => {
      setRemovingMemberId(null);
      setReassignmentTarget("__unassigned");
      await refreshAccessData();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listAssignedToMe(selectedCompanyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      }
      pushToast({
        title: t("area.settings-company.company-access.memberRemoved"),
        body:
          result.reassignedIssueCount > 0
            ? t("area.settings-company.company-access.tasksCleanedUp", { count: result.reassignedIssueCount })
            : undefined,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("area.settings-company.company-access.failedToRemoveMember"),
        body: error instanceof Error ? error.message : t("area.settings-company.company-access.unknownError"),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!editingMember) return;
    setDraftRole(editingMember.membershipRole);
    setDraftStatus(isEditableMemberStatus(editingMember.status) ? editingMember.status : "suspended");
  }, [editingMember]);

  useEffect(() => {
    if (!removingMember) return;
    setReassignmentTarget("__unassigned");
  }, [removingMember]);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("area.settings-company.company-access.selectAnOrganizationToManage")}</div>;
  }

  if (membersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("area.settings-company.company-access.loadingOrganizationAccess")}</div>;
  }

  if (membersQuery.error) {
    const message =
      membersQuery.error instanceof ApiError && membersQuery.error.status === 403
        ? t("area.settings-company.company-access.youDoNotHavePermission")
        : membersQuery.error instanceof Error
          ? membersQuery.error.message
          : t("area.settings-company.company-access.failedToLoadOrganizationMembers");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access;
  const pendingHumanJoinRequests =
    joinRequestsQuery.data?.filter((request) => request.requestType === "human") ?? [];
  const joinRequestActionPending =
    approveJoinRequestMutation.isPending || rejectJoinRequestMutation.isPending;
  const activeReassignmentUsers = members.filter(
    (member) =>
      member.status === "active" &&
      member.principalType === "user" &&
      member.id !== removingMemberId,
  );
  const activeReassignmentAgents = (agentsQuery.data ?? []).filter(isAssignableAgent);
  const assignedIssues = assignedIssuesQuery.data ?? [];
  // myrmidon(ADMIN-AGENT): agents that hold the board administrator flag, shown
  // in the members table so the rights page names every board administrator.
  // Fail-closed reader: only an explicit true flags an administrator, and
  // terminated agents stay out of the listing.
  const boardAdminAgents = (agentsQuery.data ?? [])
    .filter((agent) => agent.status !== "terminated")
    .filter((agent) => readAgentBoardAdmin({ permissions: agent.permissions }));

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("area.settings-company.company-access.organizationMembers")}</h1>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-4">
        {!hideInvitesTab && (
          <PageTabBar
            items={[
              { value: "members", label: t("area.settings-company.company-access.members") },
              { value: "invites", label: t("area.settings-company.company-access.invites") },
            ]}
            align="start"
            value={activeTab}
            onValueChange={handleTabChange}
          />
        )}
        <TabsContent value="members" className="space-y-8">

      {access && !access.currentUserRole && (
        <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {t("area.settings-company.company-access.thisAccountCanManageAccess")}
        </div>
      )}

      <section className="space-y-4">
        {access?.canApproveJoinRequests && pendingHumanJoinRequests.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{t("area.settings-company.company-access.pendingHumanJoins")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("area.settings-company.company-access.reviewPendingJoinRequestsBefore")}
                </p>
              </div>
              <Badge variant="outline">{t("area.settings-company.company-access.pendingCount", { count: pendingHumanJoinRequests.length })}</Badge>
            </div>
            <div className="space-y-3">
              {pendingHumanJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("area.settings-company.company-access.unknownHumanRequester")
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    t("area.settings-company.company-access.noEmailAvailable")
                  }
                  context={
                    request.invite
                      ? request.invite.humanRole
                        ? t("area.settings-company.company-access.joinInviteWithRole", { types: request.invite.allowedJoinTypes, role: request.invite.humanRole })
                        : t("area.settings-company.company-access.joinInvite", { types: request.invite.allowedJoinTypes })
                      : t("area.settings-company.company-access.inviteMetadataUnavailable")
                  }
                  detail={t("area.settings-company.company-access.submitted", { date: new Date(request.createdAt).toLocaleString() })}
                  approveLabel={t("area.settings-company.company-access.approveHuman")}
                  rejectLabel={t("area.settings-company.company-access.rejectHuman")}
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-(--sz-44rem) text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("area.settings-company.company-access.name")}</th>
                <th className="px-3 py-2 font-medium">{t("area.settings-company.company-access.email")}</th>
                <th className="px-3 py-2 font-medium">{t("area.settings-company.company-access.role")}</th>
                <th className="px-3 py-2 font-medium">{t("area.settings-company.company-access.status")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("area.settings-company.company-access.action")}</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && boardAdminAgents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-muted-foreground">
                    {t("area.settings-company.company-access.noUserMembershipsFoundFor")}
                  </td>
                </tr>
              ) : null}
              {boardAdminAgents.map((agent) => (
                <tr key={`agent-${agent.id}`} className="border-b border-border" data-testid="board-admin-agent-row">
                  <td className="px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar size="sm">
                        <AvatarFallback>{agent.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <Link to={agentDetailHref(agent.urlKey, "permissions")} className="truncate font-medium">
                        {agent.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">—</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span>{AGENT_ROLE_LABELS[agent.role as keyof typeof AGENT_ROLE_LABELS] ?? agent.role}</span>
                      <Badge variant="outline" data-testid="board-admin-agent-badge">{t("area.settings-company.company-access.boardAdministrator")}</Badge>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={agent.status === "active" ? "secondary" : "outline"}>
                      {agent.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-right text-muted-foreground">
                    <Link to={agentDetailHref(agent.urlKey, "permissions")}>{t("area.settings-company.company-access.permissions")}</Link>
                  </td>
                </tr>
              ))}
              {members.map((member) => {
                const removalReason = member.removal?.reason ?? null;
                const canArchive = member.removal?.canArchive ?? true;
                const displayName = memberDisplayName(member);
                return (
                  <tr key={member.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar size="sm">
                          {member.user?.image ? <AvatarImage src={member.user.image} alt={displayName} /> : null}
                          <AvatarFallback>{memberInitials(member)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate font-medium">{displayName}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {member.user?.email || member.principalId}
                    </td>
                    <td className="px-3 py-3">
                      {member.membershipRole
                        ? HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole]
                        : t("area.settings-company.company-access.unset")}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={member.status === "active" ? "secondary" : member.status === "suspended" ? "destructive" : "outline"}>
                        {member.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>
                          {t("area.settings-company.company-access.edit")}
                        </Button>
                        <span
                          className="inline-flex"
                          title={!canArchive ? removalReason ?? undefined : undefined}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRemovingMemberId(member.id)}
                            disabled={!canArchive}
                            title={!canArchive ? removalReason ?? undefined : undefined}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            {t("common.remove")}
                          </Button>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMemberId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("area.settings-company.company-access.editMember")}</DialogTitle>
            <DialogDescription>
              {t("area.settings-company.company-access.editMemberDescription", { name: editingMember?.user?.name || editingMember?.user?.email || editingMember?.principalId })}
            </DialogDescription>
          </DialogHeader>
          {editingMember && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("area.settings-company.company-access.organizationRole")}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftRole ?? ""}
                    onChange={(event) =>
                      setDraftRole((event.target.value || null) as CompanyMember["membershipRole"])
                    }
                  >
                    <option value="">{t("area.settings-company.company-access.unset")}</option>
                    {Object.entries(HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("area.settings-company.company-access.membershipStatus")}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftStatus}
                    onChange={(event) =>
                      setDraftStatus(event.target.value as EditableMemberStatus)
                    }
                  >
                    <option value="active">{t("area.settings-company.company-access.active")}</option>
                    <option value="pending">{t("area.settings-company.company-access.pending")}</option>
                    <option value="suspended">{t("area.settings-company.company-access.suspended")}</option>
                  </select>
                </label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMemberId(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!editingMember) return;
                updateMemberMutation.mutate({
                  memberId: editingMember.id,
                  membershipRole: draftRole,
                  status: draftStatus,
                });
              }}
              disabled={updateMemberMutation.isPending}
            >
              {updateMemberMutation.isPending ? t("area.settings-company.company-access.saving") : t("area.settings-company.company-access.saveMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removingMember} onOpenChange={(open) => !open && setRemovingMemberId(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("area.settings-company.company-access.removeMember")}</DialogTitle>
            <DialogDescription>
              {t("area.settings-company.company-access.removeMemberDescription", { name: memberDisplayName(removingMember) })}
            </DialogDescription>
          </DialogHeader>
          {removingMember && (
            <div className="space-y-5">
              <div className="rounded-lg border border-border px-3 py-3">
                <div className="text-sm font-medium">{memberDisplayName(removingMember)}</div>
                <div className="text-sm text-muted-foreground">{removingMember.user?.email || removingMember.principalId}</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {assignedIssuesQuery.isLoading
                    ? t("area.settings-company.company-access.checkingAssignedTasks")
                    : t("area.settings-company.company-access.openAssignedTasks", { count: assignedIssues.length })}
                </div>
              </div>

              {assignedIssues.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("area.settings-company.company-access.taskReassignment")}</div>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={reassignmentTarget}
                    onChange={(event) => setReassignmentTarget(event.target.value)}
                  >
                    <option value="__unassigned">{t("area.settings-company.company-access.leaveUnassigned")}</option>
                    {activeReassignmentUsers.length > 0 ? (
                      <optgroup label={t("area.settings-company.company-access.humans")}>
                        {activeReassignmentUsers.map((member) => (
                          <option key={member.id} value={`user:${member.principalId}`}>
                            {memberDisplayName(member)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {activeReassignmentAgents.length > 0 ? (
                      <optgroup label={t("area.settings-company.company-access.agents")}>
                        {activeReassignmentAgents.map((agent) => (
                          <option key={agent.id} value={`agent:${agent.id}`}>
                            {agent.name} ({agent.role})
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <div className="max-h-36 overflow-auto rounded-lg border border-border">
                    {assignedIssues.slice(0, 6).map((issue) => (
                      <div key={issue.id} className="border-b border-border px-3 py-2 text-sm last:border-b-0">
                        <div className="font-medium">{issue.identifier ?? issue.id.slice(0, 8)}</div>
                        <div className="truncate text-muted-foreground">{issue.title}</div>
                      </div>
                    ))}
                    {assignedIssues.length > 6 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        {t("area.settings-company.company-access.moreTasks", { count: assignedIssues.length - 6 })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingMemberId(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!removingMember) return;
                archiveMemberMutation.mutate({
                  memberId: removingMember.id,
                  target: reassignmentTarget,
                });
              }}
              disabled={archiveMemberMutation.isPending || assignedIssuesQuery.isLoading}
            >
              {archiveMemberMutation.isPending ? t("area.settings-company.company-access.removing") : t("area.settings-company.company-access.removeMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </TabsContent>
        {!hideInvitesTab && (
          <TabsContent value="invites">
            <InvitesSection />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function CompanyAccessLegacyRoute() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.settings-company.company-access.settings"), href: "/company/settings" },
      { label: t("area.settings-company.company-access.access") },
    ]);
  }, [setBreadcrumbs]);

  const permissionsSlot = slots.find((slot) => slot.routePath === "permissions");
  if (permissionsSlot) {
    return <Navigate to="/company/settings/permissions" replace />;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{t("area.settings-company.company-access.checkingForAdvancedPermissionExtensions")}</div>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("area.settings-company.company-access.advancedPermissions")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("area.settings-company.company-access.advancedAccessScopedAssignmentAnd")}
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("area.settings-company.company-access.advancedPermissionsUnavailable")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("area.settings-company.company-access.advancedPermissionsNeedExtension")}
          </p>
          {errorMessage ? (
            <p className="text-sm text-destructive">{t("area.settings-company.company-access.pluginExtensionsUnavailable", { message: errorMessage })}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/company/settings/members">{t("area.settings-company.company-access.openMembers")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/company/settings/members?tab=invites">{t("area.settings-company.company-access.openInvites")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function memberDisplayName(member: CompanyMember | null) {
  if (!member) return i18n.t("area.settings-company.company-access.thisMember");
  return member.user?.name?.trim() || member.user?.email || member.principalId;
}

function memberInitials(member: CompanyMember) {
  const value = memberDisplayName(member).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}

function isAssignableAgent(agent: Agent) {
  return agent.status !== "terminated" && agent.status !== "pending_approval";
}

function isEditableMemberStatus(status: CompanyMember["status"]): status is EditableMemberStatus {
  return status === "pending" || status === "active" || status === "suspended";
}

function PendingJoinRequestCard({
  title,
  subtitle,
  context,
  detail,
  detailSecondary,
  approveLabel,
  rejectLabel,
  disabled,
  onApprove,
  onReject,
}: {
  title: string;
  subtitle: string;
  context: string;
  detail: string;
  detailSecondary?: string;
  approveLabel: string;
  rejectLabel: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-sm text-muted-foreground">{subtitle}</div>
          </div>
          <div className="text-sm text-muted-foreground">{context}</div>
          <div className="text-sm text-muted-foreground">{detail}</div>
          {detailSecondary ? <div className="text-sm text-muted-foreground">{detailSecondary}</div> : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onReject} disabled={disabled}>
            {rejectLabel}
          </Button>
          <Button type="button" onClick={onApprove} disabled={disabled}>
            {approveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
