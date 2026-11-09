import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/i18n";
import type { TFunction } from "i18next";

const inviteRoleOptions = (t: TFunction) =>
  [
    {
      value: "viewer",
      label: t("area.access-secrets-1.invites-section.roleViewer"),
      description: t("area.access-secrets-1.invites-section.roleViewerDescription"),
      gets: t("area.access-secrets-1.invites-section.roleViewerGets"),
    },
    {
      value: "operator",
      label: t("area.access-secrets-1.invites-section.roleOperator"),
      description: t("area.access-secrets-1.invites-section.roleOperatorDescription"),
      gets: t("area.access-secrets-1.invites-section.roleOperatorGets"),
    },
    {
      value: "admin",
      label: t("area.access-secrets-1.invites-section.roleAdmin"),
      description: t("area.access-secrets-1.invites-section.roleAdminDescription"),
      gets: t("area.access-secrets-1.invites-section.roleAdminGets"),
    },
    {
      value: "owner",
      label: t("area.access-secrets-1.invites-section.roleOwner"),
      description: t("area.access-secrets-1.invites-section.roleOwnerDescription"),
      gets: t("area.access-secrets-1.invites-section.roleOwnerGets"),
    },
  ] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { t, i18n } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      afterFallback?.();
    }
    pushToast({
      title: t("area.access-secrets-1.invites-section.clipboardUnavailable"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, t("area.access-secrets-1.invites-section.inviteSelected"), selectLatestInviteUrl);
  }

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        defaultsPayload: { email: inviteeEmail.trim() },
        agentMessage: null,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      setInviteeEmail("");
      setEmailError(null);
      const copied = await copyText(invite.inviteUrl, t("area.access-secrets-1.invites-section.copyManually"));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("area.access-secrets-1.invites-section.inviteCreated"),
        body: copied ? t("area.access-secrets-1.invites-section.inviteReadyCopied") : t("area.access-secrets-1.invites-section.inviteReady"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("area.access-secrets-1.invites-section.createFailed"),
        body: error instanceof Error ? error.message : t("area.access-secrets-1.invites-section.unknownError"),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("area.access-secrets-1.invites-section.inviteRevoked"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("area.access-secrets-1.invites-section.revokeFailed"),
        body: error instanceof Error ? error.message : t("area.access-secrets-1.invites-section.unknownError"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("area.access-secrets-1.invites-section.selectOrganization")}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("area.access-secrets-1.invites-section.loadingInvites")}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("area.access-secrets-1.invites-section.noPermission")
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("area.access-secrets-1.invites-section.loadFailed");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("area.access-secrets-1.invites-section.intro")}
      </p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("area.access-secrets-1.invites-section.inviteAPerson")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("area.access-secrets-1.invites-section.inviteAPersonText")}
          </p>
        </div>

        <div className="max-w-md space-y-2">
          <Label htmlFor="invitee-email">{t("area.access-secrets-1.invites-section.emailLabel")}</Label>
          <Input
            id="invitee-email"
            type="email"
            autoComplete="email"
            required
            value={inviteeEmail}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "invitee-email-error" : undefined}
            onChange={(event) => {
              setInviteeEmail(event.target.value);
              setEmailError(null);
            }}
          />
          {emailError ? <p id="invitee-email-error" role="alert" className="text-sm text-destructive">{emailError}</p> : null}
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("area.access-secrets-1.invites-section.chooseRole")}</legend>
          <div className="rounded-xl border border-border">
            {inviteRoleOptions(t).map((option, index) => {
              const checked = humanRole === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={option.value}
                    checked={checked}
                    onChange={() => setHumanRole(option.value)}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {t("area.access-secrets-1.invites-section.defaultBadge")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {t("area.access-secrets-1.invites-section.singleUseNote")}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => {
            const email = inviteeEmail.trim();
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              setEmailError(t("area.access-secrets-1.invites-section.emailInvalid"));
              return;
            }
            createInviteMutation.mutate();
          }} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("area.access-secrets-1.invites-section.creating") : t("area.access-secrets-1.invites-section.createInvite")}
          </Button>
          <span className="text-sm text-muted-foreground">{t("area.access-secrets-1.invites-section.historyNote")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("area.access-secrets-1.invites-section.latestLink")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("area.access-secrets-1.invites-section.copied")}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("area.access-secrets-1.invites-section.domainNote")}
              </div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{t("area.access-secrets-1.invites-section.latestUrl")}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("area.access-secrets-1.invites-section.latestUrl")}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                {t("area.access-secrets-1.invites-section.copyLink")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("area.access-secrets-1.invites-section.historyTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("area.access-secrets-1.invites-section.historyText")}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("area.access-secrets-1.invites-section.openQueue")}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("area.access-secrets-1.invites-section.noInvites")}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colState")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colFor")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colInvitedBy")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colCreated")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colJoinRequest")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("area.access-secrets-1.invites-section.colAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state, t)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite, t)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("area.access-secrets-1.invites-section.unknownInviter")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString(i18n.language)}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {t("area.access-secrets-1.invites-section.reviewRequest")}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            {t("area.access-secrets-1.invites-section.revoke")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("area.access-secrets-1.invites-section.inactive")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? t("area.access-secrets-1.invites-section.loadingMore") : t("area.access-secrets-1.invites-section.viewMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked", t: TFunction) {
  switch (state) {
    case "active":
      return t("area.access-secrets-1.invites-section.stateActive");
    case "accepted":
      return t("area.access-secrets-1.invites-section.stateAccepted");
    case "expired":
      return t("area.access-secrets-1.invites-section.stateExpired");
    default:
      return t("area.access-secrets-1.invites-section.stateRevoked");
  }
}

function formatInviteRole(role: string, t: TFunction) {
  switch (role) {
    case "viewer":
      return t("area.access-secrets-1.invites-section.roleViewer");
    case "operator":
      return t("area.access-secrets-1.invites-section.roleOperator");
    case "admin":
      return t("area.access-secrets-1.invites-section.roleAdmin");
    case "owner":
      return t("area.access-secrets-1.invites-section.roleOwner");
    default:
      return role;
  }
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number], t: TFunction) {
  if (invite.allowedJoinTypes === "agent") return t("area.access-secrets-1.invites-section.audienceAgent");
  if (invite.allowedJoinTypes === "both") {
    return invite.humanRole
      ? t("area.access-secrets-1.invites-section.audienceHumanOrAgentRole", { role: formatInviteRole(invite.humanRole, t) })
      : t("area.access-secrets-1.invites-section.audienceHumanOrAgent");
  }
  return invite.humanRole ? formatInviteRole(invite.humanRole, t) : t("area.access-secrets-1.invites-section.audienceHuman");
}
