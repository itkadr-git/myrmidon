import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  AlertTriangle,
  Mail,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { AccessStep } from "@/features/connections/ConnectionSetupFlow";
import { TrustPresetSection } from "@/components/TrustPresetSection";
import { EmailSafetyNotice } from "@/components/EmailSafetyNotice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  getTrustPreset,
  getLowTrustBoundary,
  lowTrustBoundaryHasScope,
} from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
import { i18n, useTranslation } from "@/i18n";
import type {
  AgentPermissions,
  EmailEndpointSummary,
} from "@myrmidon/shared";
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const DEFAULT_DOMAIN = "agentmail.to";

export function EmailEndpointSetup() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [connectionId, setConnectionId] = useState(
    params.get("connectionId") ?? "",
  );
  const [step, setStep] = useState(params.get("connectionId") ? 3 : 0);
  const [agentId, setAgentId] = useState(params.get("agentId") ?? "");
  const [grantKind, setGrantKind] = useState<"user" | "organization" | "agent">(
    "user",
  );
  const [agentAccess, setAgentAccess] = useState<"specific" | "all">(
    "specific",
  );
  const [agentIds, setAgentIds] = useState<Set<string>>(
    new Set(params.get("agentId") ? [params.get("agentId")!] : []),
  );
  const [apiKey, setApiKey] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const [addressMode, setAddressMode] = useState("new");
  const [inboxId, setInboxId] = useState("");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const [mode, setMode] = useState<"websocket" | "webhook">("websocket");
  const [trustOpen, setTrustOpen] = useState(false);
  const [permissions, setPermissions] = useState<Partial<AgentPermissions>>({});
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId && trustOpen,
  });
  const boundaryIssues = useQuery({
    queryKey: ["email-boundary-issues", companyId],
    queryFn: () => issuesApi.list(companyId),
    enabled: !!companyId && trustOpen,
  });
  const chosen = agents.data?.find((a) => a.id === agentId);
  const lowTrust = getTrustPreset(chosen?.permissions) === "low_trust_review";
  const scoped = lowTrustBoundaryHasScope(
    getLowTrustBoundary(chosen?.permissions),
  );
  const inspected = useQuery({
    queryKey: ["email-credential-inspect", companyId, connectionId],
    queryFn: () => emailApi.inspectSaved(companyId, connectionId),
    enabled: !!companyId && !!connectionId && step >= 3,
    retry: false,
  });
  const inboxes = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    enabled: !!companyId,
  });
  const scopedKey = inspected.data?.scope.scope_type === "inbox";
  useEffect(() => {
    if (scopedKey) {
      setAddressMode("existing");
      setInboxId(inspected.data?.inboxes[0]?.inbox_id ?? "");
    }
  }, [scopedKey, inspected.data]);
  const connect = useMutation({
    mutationFn: () =>
      emailApi.connect(companyId, {
        apiKey,
        grantKind: grantKind === "organization" ? "organization" : "user",
        allAgents: agentAccess === "all",
        agentIds: [...agentIds],
        idempotencyKey: requestId,
      }),
    onSuccess: (result) => {
      setApiKey("");
      setConnectionId(result.id);
      setStep(2);
      void cache.invalidateQueries({
        queryKey: queryKeys.tools.connections(companyId),
      });
    },
  });
  const agentDetail = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId),
    enabled: !!agentId && trustOpen,
  });
  const trust = useMutation({
    mutationFn: () =>
      agentsApi.updatePermissions(
        agentId,
        {
          ...permissions,
          canCreateAgents: permissions.canCreateAgents ?? false,
          canCreateSkills: permissions.canCreateSkills ?? true,
          canAssignTasks: agentDetail.data?.access?.canAssignTasks ?? false,
        },
        companyId,
      ),
    onSuccess: () => {
      setTrustOpen(false);
      void cache.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
    },
  });
  const setup = useMutation({
    mutationFn: () =>
      emailApi.setup(companyId, {
        assignedAgentId: agentId,
        credentialConnectionId: connectionId,
        ...(addressMode === "existing" ? { inboxId } : { username, domain }),
        receiveMode: mode,
        idempotencyKey: requestId,
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
      void cache.invalidateQueries({
        queryKey: queryKeys.tools.connectionInstalls(connectionId),
      });
      setStep(6);
    },
  });
  const address =
    addressMode === "existing" ? inboxId : `${username}@${domain}`;
  const labels =
    step < 3
      ? [t("area.apps-chat-email.email-endpoint-setup.steps.access"), t("area.apps-chat-email.email-endpoint-setup.steps.apiKey"), t("area.apps-chat-email.email-endpoint-setup.steps.connected")]
      : [t("area.apps-chat-email.email-endpoint-setup.steps.agent"), t("area.apps-chat-email.email-endpoint-setup.steps.emailAddress"), t("area.apps-chat-email.email-endpoint-setup.steps.review")];
  const current = step < 3 ? step : Math.min(step - 3, 2);
  const error = connect.error ?? setup.error ?? inspected.error ?? agents.error;
  const trustNotice = chosen && (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
      role={lowTrust && scoped ? "note" : "alert"}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {lowTrust && scoped ? (
          <Check className="size-4" />
        ) : (
          <AlertTriangle className="size-4 text-(--status-agent-paused)" />
        )}
        {lowTrust
          ? scoped
            ? t("area.apps-chat-email.email-endpoint-setup.trust.configured")
            : t("area.apps-chat-email.email-endpoint-setup.trust.needsBoundary")
          : t("area.apps-chat-email.email-endpoint-setup.trust.notLowTrust", { name: chosen.name })}
      </p>
      <p className="text-sm text-muted-foreground">
        {lowTrust
          ? t("area.apps-chat-email.email-endpoint-setup.trust.bodyLowTrust")
          : t("area.apps-chat-email.email-endpoint-setup.trust.bodyDefault")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("area.apps-chat-email.email-endpoint-setup.trust.isolationNote")}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setPermissions(chosen.permissions);
          setTrustOpen(true);
        }}
      >
        {lowTrust ? t("area.apps-chat-email.email-endpoint-setup.trust.review") : t("area.apps-chat-email.email-endpoint-setup.trust.configure")}
      </Button>
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">
          {step < 3
            ? t("area.apps-chat-email.email-endpoint-setup.title.connect")
            : step === 6
              ? t("area.apps-chat-email.email-endpoint-setup.title.ready")
              : t("area.apps-chat-email.email-endpoint-setup.title.giveAddress")}
        </h1>
        <Button
          variant="ghost"
          onClick={() =>
            navigate(
              connectionId ? `/apps/${connectionId}/permissions` : "/apps",
            )
          }
        >
          {step === 6 ? t("common.close") : t("common.cancel")}
        </Button>
      </header>
      {step !== 6 && (
        <nav aria-label={t("area.apps-chat-email.email-endpoint-setup.progressAriaLabel")}>
          <ol className="flex gap-4">
            {labels.map((label, i) => (
              <li
                className="flex flex-1 items-center gap-2 text-sm"
                key={label}
              >
                <span
                  className={
                    i <= current
                      ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
                      : "flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
                  }
                >
                  {i < current ? <Check className="size-4" /> : i + 1}
                </span>
                <span aria-current={i === current ? "step" : undefined}>
                  {label}
                </span>
              </li>
            ))}
          </ol>
        </nav>
      )}
      {step === 0 && (
        <AccessStep
          companyId={companyId}
          authKind="api_key"
          grantKinds={["user", "organization"]}
          grantKind={grantKind}
          setGrantKind={setGrantKind}
          installChoice={agentAccess}
          setInstallChoice={setAgentAccess}
          installAgentIds={agentIds}
          setInstallAgentIds={setAgentIds}
          onBack={() => navigate("/apps")}
          onContinue={() => setStep(1)}
          submitLabel={t("area.apps-chat-email.email-endpoint-setup.continue")}
        />
      )}
      {step === 1 && (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          <section className="space-y-4 rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold">
              {t("area.apps-chat-email.email-endpoint-setup.apiKey.title")}
            </h2>
            <Label htmlFor="email-api-key">{t("area.apps-chat-email.email-endpoint-setup.apiKey.label")}</Label>
            <Input
              id="email-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("area.apps-chat-email.email-endpoint-setup.apiKey.placeholder")}
            />
            <a
              href="https://console.agentmail.to"
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              {t("area.apps-chat-email.email-endpoint-setup.apiKey.getKey")}
            </a>
          </section>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep(0)}>
              {t("area.apps-chat-email.email-endpoint-setup.back")}
            </Button>
            <Button disabled={!apiKey.trim() || connect.isPending}>
              {connect.isPending ? t("area.apps-chat-email.email-endpoint-setup.apiKey.connecting") : t("area.apps-chat-email.email-endpoint-setup.apiKey.connect")}
            </Button>
          </div>
        </form>
      )}
      {step === 2 && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <h2 className="text-lg font-semibold">
            {t("area.apps-chat-email.email-endpoint-setup.connected.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("area.apps-chat-email.email-endpoint-setup.connected.next")}
          </p>
          <div className="flex justify-end">
            <Button
              onClick={() => navigate(`/apps/${connectionId}/permissions`)}
            >
              {t("area.apps-chat-email.email-endpoint-setup.connected.openPermissions")} <ArrowRight className="size-4" />
            </Button>
          </div>
        </section>
      )}
      {step === 3 && (
        <>
          <section className="space-y-4 rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold">
              {t("area.apps-chat-email.email-endpoint-setup.agent.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("area.apps-chat-email.email-endpoint-setup.agent.description")}
            </p>
            <Label>{t("area.apps-chat-email.email-endpoint-setup.agent.label")}</Label>
            <SearchableSelect
              value={agentId}
              placeholder={t("area.apps-chat-email.email-endpoint-setup.agent.placeholder")}
              searchPlaceholder={t("area.apps-chat-email.email-endpoint-setup.agent.searchPlaceholder")}
              emptyMessage={t("area.apps-chat-email.email-endpoint-setup.agent.empty")}
              groups={[
                {
                  id: "agents",
                  options: (agents.data ?? [])
                    .filter(
                      (a) =>
                        !["terminated", "pending_approval"].includes(a.status),
                    )
                    .map((a) => ({
                      key: a.id,
                      value: a.id,
                      label: a.name,
                      icon: a.icon,
                    })),
                },
              ]}
              onValueChange={(id, option) => {
                setAgentId(id);
                setUsername(
                  option.label
                    .toLowerCase()
                    .replace(/[^a-z0-9._-]+/g, "-")
                    .slice(0, 64),
                );
              }}
              renderValue={(option) =>
                option && (
                  <span className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>
                        <AgentIcon icon={String(option.icon ?? "bot")} />
                      </AvatarFallback>
                    </Avatar>
                    {option.label}
                  </span>
                )
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("area.apps-chat-email.email-endpoint-setup.agent.activationNote")}
            </p>
          </section>
          {trustNotice}
        </>
      )}
      {step === 4 && (
        <>
          <section className="space-y-5 rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold">
              {t("area.apps-chat-email.email-endpoint-setup.address.title", { name: chosen?.name })}
            </h2>
            <RadioCardGroup
              ariaLabel={t("area.apps-chat-email.email-endpoint-setup.address.sourceAriaLabel")}
              value={addressMode}
              onValueChange={setAddressMode}
              options={[
                {
                  value: "new",
                  title: t("area.apps-chat-email.email-endpoint-setup.address.createNew"),
                  disabled: scopedKey,
                },
                { value: "existing", title: t("area.apps-chat-email.email-endpoint-setup.address.useExisting") },
              ]}
            />
            {addressMode === "new" ? (
              <div className="space-y-2">
                <Label htmlFor="email-name">{t("area.apps-chat-email.email-endpoint-setup.address.label")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="email-name"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  />
                  <span className="text-sm text-muted-foreground">
                    @{domain}
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="email-existing">{t("area.apps-chat-email.email-endpoint-setup.address.availableInbox")}</Label>
                <select
                  id="email-existing"
                  className={selectClass}
                  value={inboxId}
                  onChange={(e) => setInboxId(e.target.value)}
                >
                  <option value="">{t("area.apps-chat-email.email-endpoint-setup.address.chooseInbox")}</option>
                  {inspected.data?.inboxes.map((i) => (
                    <option
                      key={i.inbox_id}
                      disabled={inboxes.data?.some(
                        (e) =>
                          e.address === i.inbox_id && e.status !== "archived",
                      )}
                      value={i.inbox_id}
                    >
                      {i.inbox_id}
                      {inboxes.data?.some((e) => e.address === i.inbox_id)
                        ? ` — ${t("area.apps-chat-email.email-endpoint-setup.address.alreadyAssigned")}`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {t("area.apps-chat-email.email-endpoint-setup.address.advanced")}
              </summary>
              <div className="space-y-4 pt-4">
                {addressMode === "new" && (
                  <>
                    <Label htmlFor="email-domain">{t("area.apps-chat-email.email-endpoint-setup.address.domain")}</Label>
                    <select
                      id="email-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      className={selectClass}
                    >
                      <option>{DEFAULT_DOMAIN}</option>
                      {inspected.data?.domains
                        .filter((d) => d.status === "VERIFIED")
                        .map((d) => (
                          <option key={d.domain_id}>{d.domain}</option>
                        ))}
                    </select>
                    <a
                      className="text-sm underline"
                      href="https://docs.agentmail.to/custom-domains"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("area.apps-chat-email.email-endpoint-setup.address.customDomain")}
                    </a>
                  </>
                )}
                <Label htmlFor="email-mode">{t("area.apps-chat-email.email-endpoint-setup.address.receiving")}</Label>
                <select
                  id="email-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                  className={selectClass}
                >
                  <option value="websocket">
                    {t("area.apps-chat-email.email-endpoint-setup.address.modeLive")}
                  </option>
                  <option value="webhook">
                    {t("area.apps-chat-email.email-endpoint-setup.address.modeWebhook")}
                  </option>
                </select>
              </div>
            </details>
          </section>
          <EmailSafetyNotice />
        </>
      )}
      {step === 5 && (
        <>
          <EmailSafetyNotice />
          {trustNotice}
          <section className="space-y-4 rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold">
              {t("area.apps-chat-email.email-endpoint-setup.review.title")}
            </h2>
            <p className="text-lg font-semibold">{address}</p>
            <p className="text-sm">
              {t("area.apps-chat-email.email-endpoint-setup.review.assignedTo", { name: chosen?.name })} ·{" "}
              {mode === "websocket" ? t("area.apps-chat-email.email-endpoint-setup.review.modeLive") : t("area.apps-chat-email.email-endpoint-setup.review.modeWebhook")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("area.apps-chat-email.email-endpoint-setup.review.note")}
            </p>
          </section>
        </>
      )}
      {step === 6 && (
        <section className="space-y-5 rounded-xl border border-border p-6">
          <p className="flex items-center gap-2 text-sm">
            <Check className="size-4" />
            {t("area.apps-chat-email.email-endpoint-setup.done.receiving", { name: chosen?.name })}
          </p>
          <p className="text-lg font-semibold">{setup.data?.address}</p>
          <EmailSafetyNotice />
          <Button onClick={() => navigate(`/apps/${connectionId}/permissions`)}>
            {t("area.apps-chat-email.email-endpoint-setup.done.back")}
          </Button>
        </section>
      )}
      {step >= 3 && step <= 5 && (
        <div className="flex justify-between border-t border-border pt-5">
          <Button
            variant="ghost"
            onClick={() =>
              step === 3
                ? navigate(`/apps/${connectionId}/permissions`)
                : setStep(step - 1)
            }
          >
            <ArrowLeft className="size-4" />
            {t("area.apps-chat-email.email-endpoint-setup.back")}
          </Button>
          <Button
            disabled={
              !chosen ||
              (lowTrust && !scoped) ||
              (step >= 4 &&
                (!inspected.data ||
                  (addressMode === "existing"
                    ? !inboxId
                    : !/^[a-z0-9][a-z0-9._-]*$/.test(username)))) ||
              setup.isPending
            }
            onClick={() => (step === 5 ? setup.mutate() : setStep(step + 1))}
          >
            {setup.isPending
              ? t("area.apps-chat-email.email-endpoint-setup.action.activating")
              : step === 5
                ? addressMode === "new"
                  ? t("area.apps-chat-email.email-endpoint-setup.action.create")
                  : t("area.apps-chat-email.email-endpoint-setup.action.connect")
                : step === 4
                  ? t("area.apps-chat-email.email-endpoint-setup.action.review")
                  : t("area.apps-chat-email.email-endpoint-setup.continue")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("area.apps-chat-email.email-endpoint-setup.trustDialog.title", { name: chosen?.name })}
            </DialogTitle>
            <DialogDescription>
              {t("area.apps-chat-email.email-endpoint-setup.trustDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <TrustPresetSection
            permissions={permissions}
            onChange={setPermissions}
            companyId={companyId}
            projectCandidates={(projects.data ?? []).map((p) => ({
              id: p.id,
              label: p.name,
            }))}
            issueCandidates={(boundaryIssues.data ?? []).map((issue) => ({
              id: issue.id,
              label: `${issue.identifier} · ${issue.title}`,
            }))}
            allowSingleIssue={false}
            candidatesLoading={projects.isPending || boundaryIssues.isPending}
          />
          <p className="text-xs text-muted-foreground">
            {t("area.apps-chat-email.email-endpoint-setup.trustDialog.note")}
          </p>
          {(trust.error || projects.error || boundaryIssues.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(trust.error ?? projects.error ?? boundaryIssues.error)?.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrustOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                trust.isPending ||
                agentDetail.isPending ||
                !!agentDetail.error ||
                (getTrustPreset(permissions) === "low_trust_review" &&
                  !lowTrustBoundaryHasScope(getLowTrustBoundary(permissions)))
              }
              onClick={() => trust.mutate()}
            >
              {t("area.apps-chat-email.email-endpoint-setup.trustDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function EmailConnectionInboxes({
  companyId,
  connectionId,
  canConfigure,
}: {
  companyId: string;
  connectionId: string;
  canConfigure: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const children = new Set(
    connections.data?.connections
      .filter((c) => c.config?.credentialConnectionId === connectionId)
      .map((c) => c.id),
  );
  const inboxes =
    query.data?.filter(
      (i) => i.connectionId === connectionId || children.has(i.connectionId),
    ) ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t("area.apps-chat-email.email-endpoint-setup.inboxes.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("area.apps-chat-email.email-endpoint-setup.inboxes.description")}
          </p>
        </div>
        {canConfigure && (
          <Button asChild size="lg">
            <Link
              to={`/apps/chat/connect?provider=agentmail&connectionId=${connectionId}`}
            >
              {t("area.apps-chat-email.email-endpoint-setup.inboxes.title")}
            </Link>
          </Button>
        )}
      </div>
      {inboxes.map((i) => (
        <div
          key={i.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
        >
          <Link
            className="text-sm underline"
            to={`/apps/chat/${i.id}/settings`}
          >
            {i.address}
          </Link>
          <span className="text-xs text-muted-foreground">
            {i.lastError ??
              (i.status === "active" ? t("area.apps-chat-email.email-endpoint-setup.inboxes.receiving") : i.status)}
          </span>
        </div>
      ))}
      {!!inboxes.length && <EmailSafetyNotice />}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
    </section>
  );
}
export function EmailEndpointSettings({
  endpointId,
  companyId,
}: {
  endpointId: string;
  companyId: string;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const inbox = query.data?.find(
    (row: EmailEndpointSummary) => row.id === endpointId,
  );
  const [removed, setRemoved] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [receiveMode, setReceiveMode] = useState<"websocket" | "webhook" | "">(
    "",
  );
  const reconnect = useMutation({
    mutationFn: () =>
      emailApi.reconnect(
        endpointId,
        replacementKey,
        receiveMode || inbox!.receiveMode,
      ),
    onSuccess: () => {
      setReplacementKey("");
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      emailApi.control(endpointId, action),
    onSuccess: (result) => {
      setRemoved(result.status === "archived");
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  if (removed)
    return <p>{t("area.apps-chat-email.email-endpoint-setup.settings.disconnected")}</p>;
  if (!inbox)
    return (
      <p role={query.error ? "alert" : undefined}>
        {query.error?.message ?? t("area.apps-chat-email.email-endpoint-setup.settings.loading")}
      </p>
    );
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-bold">{inbox.address}</h1>
      <p className="text-sm text-muted-foreground">
        {inbox.status} ·{" "}
        {inbox.receiveMode === "websocket"
          ? t("area.apps-chat-email.email-endpoint-setup.settings.modeLive")
          : t("area.apps-chat-email.email-endpoint-setup.settings.modeWebhook")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("area.apps-chat-email.email-endpoint-setup.settings.lastCheck", {
          time: inbox.lastSyncAt
            ? new Date(inbox.lastSyncAt).toLocaleString(i18n.language)
            : t("area.apps-chat-email.email-endpoint-setup.settings.notChecked"),
        })}
      </p>
      <p className="text-sm">
        {t("area.apps-chat-email.email-endpoint-setup.settings.note")}
      </p>
      {inbox.lastError && (
        <p role="alert" className="text-sm text-destructive">
          {inbox.lastError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() =>
            control.mutate(inbox.status === "active" ? "pause" : "resume")
          }
        >
          {inbox.status === "active" ? t("area.apps-chat-email.email-endpoint-setup.settings.pause") : t("area.apps-chat-email.email-endpoint-setup.settings.resume")}
        </Button>
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() => control.mutate("remove")}
        >
          {t("area.apps-chat-email.email-endpoint-setup.settings.disconnect")}
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-reconnect-key">
          {t("area.apps-chat-email.email-endpoint-setup.settings.reconnectKey")}
        </Label>
        <Input
          id="email-reconnect-key"
          type="password"
          autoComplete="off"
          value={replacementKey}
          onChange={(e) => setReplacementKey(e.target.value)}
        />
        <Label htmlFor="email-reconnect-mode">
          {t("area.apps-chat-email.email-endpoint-setup.settings.receivingMode")}
        </Label>
        <select
          id="email-reconnect-mode"
          className={selectClass}
          value={receiveMode || inbox.receiveMode}
          onChange={(e) =>
            setReceiveMode(e.target.value as "websocket" | "webhook")
          }
        >
          <option value="websocket">{t("area.apps-chat-email.email-endpoint-setup.settings.modeLive")}</option>
          <option value="webhook">{t("area.apps-chat-email.email-endpoint-setup.settings.modeWebhook")}</option>
        </select>
        <Button
          variant="outline"
          disabled={!replacementKey || reconnect.isPending}
          onClick={() => reconnect.mutate()}
        >
          {t("area.apps-chat-email.email-endpoint-setup.settings.reconnect")}
        </Button>
      </div>
      {reconnect.error && (
        <p role="alert" className="text-sm text-destructive">
          {reconnect.error.message}
        </p>
      )}
      {control.error && (
        <p role="alert" className="text-sm text-destructive">
          {control.error.message}
        </p>
      )}
    </div>
  );
}
