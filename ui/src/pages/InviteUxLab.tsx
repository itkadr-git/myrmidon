// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { i18n, useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Link2,
  Loader2,
  MailPlus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";

const inviteRoleOptions = () =>
  [
    {
      value: "viewer",
      label: i18n.t("area.ux-labs.invite-ux-lab.roles.viewer.label"),
      description: i18n.t("area.ux-labs.invite-ux-lab.roles.viewer.description"),
      gets: i18n.t("area.ux-labs.invite-ux-lab.roles.viewer.gets"),
    },
    {
      value: "operator",
      label: i18n.t("area.ux-labs.invite-ux-lab.roles.operator.label"),
      description: i18n.t("area.ux-labs.invite-ux-lab.roles.operator.description"),
      gets: i18n.t("area.ux-labs.invite-ux-lab.roles.operator.gets"),
    },
    {
      value: "admin",
      label: i18n.t("area.ux-labs.invite-ux-lab.roles.admin.label"),
      description: i18n.t("area.ux-labs.invite-ux-lab.roles.admin.description"),
      gets: i18n.t("area.ux-labs.invite-ux-lab.roles.admin.gets"),
    },
    {
      value: "owner",
      label: i18n.t("area.ux-labs.invite-ux-lab.roles.owner.label"),
      description: i18n.t("area.ux-labs.invite-ux-lab.roles.owner.description"),
      gets: i18n.t("area.ux-labs.invite-ux-lab.roles.owner.gets"),
    },
  ] as const;

const inviteHistory = () =>
  [
    {
      id: "invite-active",
      state: i18n.t("area.ux-labs.invite-ux-lab.history.state.active"),
      humanRole: i18n.t("area.ux-labs.invite-ux-lab.roles.operator.label"),
      invitedBy: "Board User 25",
      email: "board25@myrmidon.local",
      createdAt: "Apr 25, 2026, 9:00 AM",
      canRevoke: true,
      hasReviewLink: true,
    },
    {
      id: "invite-accepted",
      state: i18n.t("area.ux-labs.invite-ux-lab.history.state.accepted"),
      humanRole: i18n.t("area.ux-labs.invite-ux-lab.roles.viewer.label"),
      invitedBy: "Board User 24",
      email: "board24@myrmidon.local",
      createdAt: "Apr 24, 2026, 8:15 AM",
      canRevoke: false,
      hasReviewLink: false,
    },
    {
      id: "invite-revoked",
      state: i18n.t("area.ux-labs.invite-ux-lab.history.state.revoked"),
      humanRole: i18n.t("area.ux-labs.invite-ux-lab.roles.admin.label"),
      invitedBy: "Board User 20",
      email: "board20@myrmidon.local",
      createdAt: "Apr 20, 2026, 2:45 PM",
      canRevoke: false,
      hasReviewLink: false,
    },
    {
      id: "invite-expired",
      state: i18n.t("area.ux-labs.invite-ux-lab.history.state.expired"),
      humanRole: i18n.t("area.ux-labs.invite-ux-lab.roles.owner.label"),
      invitedBy: "Board User 19",
      email: "board19@myrmidon.local",
      createdAt: "Apr 19, 2026, 7:10 PM",
      canRevoke: false,
      hasReviewLink: false,
    },
  ] as const;

const fieldClassName =
  "w-full border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const panelClassName = "border border-zinc-800 bg-zinc-950/95 p-6";

function LabSection({
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-(--rad-28) border border-border/70 bg-background/80 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function StatusCard({
  icon,
  title,
  body,
  tone = "default",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone?: "default" | "warn" | "success" | "error";
}) {
  const toneClassName = {
    default: "border-border/70 bg-background/85",
    warn: "border-amber-400/40 bg-amber-500/[0.08]",
    success: "border-emerald-400/40 bg-emerald-500/[0.08]",
    error: "border-rose-400/40 bg-rose-500/[0.08]",
  }[tone];

  return (
    <Card className={cn("rounded-(--rad-24) shadow-none", toneClassName)}>
      <CardHeader className="space-y-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-current/10 bg-background/70 text-muted-foreground">
          {icon}
        </div>
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="mt-2 text-sm leading-6">{body}</CardDescription>
        </div>
      </CardHeader>
    </Card>
  );
}

function InviteLandingShell({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-zinc-800 bg-zinc-950 shadow-[0_30px_80px_rgba(2,6,23,0.55)]">
      <div className="grid gap-px bg-zinc-800 lg:grid-cols-(--gtc-37)">
        <section className={cn(panelClassName, "space-y-6 bg-zinc-950")}>{left}</section>
        <section className={cn(panelClassName, "h-full bg-zinc-950")}>{right}</section>
      </div>
    </div>
  );
}

function InviteSummaryPanel({
  title,
  description,
  inviteMessage,
  requestedAccess,
  signedInLabel,
}: {
  title: string;
  description: string;
  inviteMessage?: string;
  requestedAccess: string;
  signedInLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-start gap-4">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-16 w-16 rounded-none border border-zinc-800"
        />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.invitedToJoin")}</p>
          <h3 className="mt-2 text-2xl font-semibold text-zinc-100">{title}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">{description}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetaCard label={t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.organization")} value="Acme Robotics" />
        <MetaCard label={t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.invitedBy")} value="Board User" />
        <MetaCard label={t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.requestedAccess")} value={requestedAccess} />
        <MetaCard label={t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.inviteExpires")} value="Mar 7, 2027" />
      </div>

      {inviteMessage ? (
        <div className="border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="text-xs uppercase tracking-(--tracking-caps) text-amber-200/80">{t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.messageFromInviter")}</div>
          <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
        </div>
      ) : null}

      {signedInLabel ? (
        <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50">
          {t("area.ux-labs.invite-ux-lab.inviteSummaryPanel.signedInAs")} <span className="font-medium">{signedInLabel}</span>.
        </div>
      ) : null}
    </>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 p-3">
      <div className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{label}</div>
      <div className="mt-1 text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function InlineAuthPreview({
  mode,
  feedback,
  working,
}: {
  mode: "sign_up" | "sign_in";
  feedback?: { tone: "info" | "error"; text: string };
  working?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">
          {mode === "sign_up" ? t("area.ux-labs.invite-ux-lab.inlineAuthPreview.createYourAccount") : t("area.ux-labs.invite-ux-lab.inlineAuthPreview.signInToContinue")}
        </h3>
        <p className="mt-1 text-sm text-zinc-400">
          {mode === "sign_up"
            ? t("area.ux-labs.invite-ux-lab.inlineAuthPreview.startWithAMyrmidon")
            : t("area.ux-labs.invite-ux-lab.inlineAuthPreview.useTheMyrmidonAccount")}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_up"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >
          {t("area.ux-labs.invite-ux-lab.inlineAuthPreview.createAccount")}
        </button>
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_in"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >
          {t("area.ux-labs.invite-ux-lab.inlineAuthPreview.iAlreadyHaveAn")}
        </button>
      </div>

      <form className="space-y-4">
        {mode === "sign_up" ? (
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.inlineAuthPreview.name")}</span>
            <input name="name" className={fieldClassName} defaultValue="Jane Example" readOnly />
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.inlineAuthPreview.email")}</span>
          <input name="email" type="email" className={fieldClassName} defaultValue="jane@example.com" readOnly />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.inlineAuthPreview.password")}</span>
          <input name="password" type="password" className={fieldClassName} defaultValue="supersecret" readOnly />
        </label>
        {feedback ? (
          <p className={cn("text-xs", feedback.tone === "info" ? "text-amber-300" : "text-red-400")}>
            {feedback.text}
          </p>
        ) : null}
        <Button type="button" className="w-full rounded-none" disabled={working}>
          {working ? t("area.ux-labs.invite-ux-lab.inlineAuthPreview.working") : mode === "sign_in" ? t("area.ux-labs.invite-ux-lab.inlineAuthPreview.signInAndContinue") : t("area.ux-labs.invite-ux-lab.inlineAuthPreview.createAccountAndContinue")}
        </Button>
      </form>

      <p className="text-xs leading-5 text-zinc-500">
        {mode === "sign_up"
          ? t("area.ux-labs.invite-ux-lab.inlineAuthPreview.alreadySignedUpBefore")
          : t("area.ux-labs.invite-ux-lab.inlineAuthPreview.noAccountYetSwitch")}
      </p>
    </div>
  );
}

function AgentRequestPreview() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{t("area.ux-labs.invite-ux-lab.agentRequestPreview.submitAgentDetails")}</h3>
        <p className="mt-1 text-sm text-zinc-400">
          {t("area.ux-labs.invite-ux-lab.agentRequestPreview.thisInviteWillCreate")}
        </p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.agentRequestPreview.agentName")}</span>
        <input className={fieldClassName} defaultValue="Acme Ops Agent" readOnly />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.agentRequestPreview.adapterType")}</span>
        <select className={fieldClassName} defaultValue="codex_local" disabled>
          <option value="codex_local">{`Codex`}</option>
          <option value="claude_local">{`Claude Code`}</option>
          <option value="cursor">{`Cursor`}</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{t("area.ux-labs.invite-ux-lab.agentRequestPreview.capabilities")}</span>
        <textarea
          className={fieldClassName}
          rows={4}
          defaultValue={t("area.ux-labs.invite-ux-lab.agentRequestPreview.reviewsInvitesTriagesRequests")}
          readOnly
        />
      </label>
      <Button type="button" className="w-full rounded-none">
        {t("area.ux-labs.invite-ux-lab.agentRequestPreview.submitRequest")}
      </Button>
    </div>
  );
}

function AcceptInvitePreview({
  autoAccept,
  isCurrentMember,
  error,
}: {
  autoAccept?: boolean;
  isCurrentMember?: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{t("area.ux-labs.invite-ux-lab.acceptInvitePreview.acceptOrganizationInvite")}</h3>
        <p className="mt-1 text-sm text-zinc-400">
          {autoAccept
            ? t("area.ux-labs.invite-ux-lab.acceptInvitePreview.grantingYourAccessTo")
            : isCurrentMember
              ? t("area.ux-labs.invite-ux-lab.acceptInvitePreview.thisAccountAlreadyBelongs")
              : t("area.ux-labs.invite-ux-lab.acceptInvitePreview.thisWillGrantOr")}
        </p>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {autoAccept ? (
        <div className="text-sm text-zinc-400">{t("area.ux-labs.invite-ux-lab.acceptInvitePreview.submittingRequest")}</div>
      ) : (
        <Button type="button" className="w-full rounded-none" disabled={isCurrentMember}>
          {t("area.ux-labs.invite-ux-lab.acceptInvitePreview.acceptInvite")}
        </Button>
      )}
    </div>
  );
}

function InviteResultPreview({
  title,
  description,
  claimSecret,
  onboardingTextUrl,
  joinedNow = false,
}: {
  title: string;
  description: string;
  claimSecret?: string;
  onboardingTextUrl?: string;
  joinedNow?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
      <div className="flex items-center gap-3">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-12 w-12 rounded-none border border-zinc-800"
        />
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="mt-4 space-y-3">
        <p className="text-sm text-zinc-400">{description}</p>
        {joinedNow ? (
          <Button type="button" className="w-full rounded-none">
            {t("area.ux-labs.invite-ux-lab.inviteResultPreview.openBoard")}
          </Button>
        ) : (
          <>
            <div className="border border-zinc-800 p-3">
              <p className="mb-1 text-xs text-zinc-500">{t("area.ux-labs.invite-ux-lab.inviteResultPreview.approvalPage")}</p>
              <a className="text-sm text-zinc-200 underline underline-offset-2" href="/company/settings/members">
                {t("area.ux-labs.invite-ux-lab.inviteResultPreview.settingsMembers")}
              </a>
            </div>
            <p className="text-xs text-zinc-500">
              {t("area.ux-labs.invite-ux-lab.inviteResultPreview.refreshAfterApproval")}
            </p>
          </>
        )}
        {claimSecret ? (
          <div className="space-y-1 border border-zinc-800 p-3 text-xs text-zinc-400">
            <div className="text-zinc-200">{t("area.ux-labs.invite-ux-lab.inviteResultPreview.claimSecret")}</div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">{`POST /api/agents/claim-api-key`}</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="text-xs text-zinc-400">
            {t("area.ux-labs.invite-ux-lab.inviteResultPreview.onboarding")} <span className="font-mono break-all">{onboardingTextUrl}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AuthScreenPreview({ mode, error }: { mode: "sign_in" | "sign_up"; error?: string }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-border/70 bg-background shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
      <div className="grid gap-px bg-border/60 md:grid-cols-2">
        <div className="flex min-h-(--sz-420px) flex-col justify-center bg-background px-8 py-10">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-8 flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{`Myrmidon`}</span>
            </div>
            <h3 className="text-xl font-semibold">
              {mode === "sign_in" ? t("area.ux-labs.invite-ux-lab.authScreenPreview.signInToMyrmidon") : t("area.ux-labs.invite-ux-lab.authScreenPreview.createYourMyrmidonAccount")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "sign_in"
                ? t("area.ux-labs.invite-ux-lab.authScreenPreview.useYourEmailAnd")
                : t("area.ux-labs.invite-ux-lab.authScreenPreview.createAnAccountFor")}
            </p>
            <div className="mt-6 space-y-4">
              {mode === "sign_up" ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{t("area.ux-labs.invite-ux-lab.authScreenPreview.name")}</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    defaultValue="Jane Example"
                    readOnly
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{t("area.ux-labs.invite-ux-lab.authScreenPreview.email")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="jane@example.com"
                  readOnly
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{t("area.ux-labs.invite-ux-lab.authScreenPreview.password")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="supersecret"
                  readOnly
                />
              </label>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <Button type="button" className="w-full">
                {mode === "sign_in" ? t("area.ux-labs.invite-ux-lab.authScreenPreview.signIn") : t("area.ux-labs.invite-ux-lab.authScreenPreview.createAccount")}
              </Button>
            </div>
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? t("area.ux-labs.invite-ux-lab.authScreenPreview.needAnAccount") : t("area.ux-labs.invite-ux-lab.authScreenPreview.alreadyHaveAnAccount")}{" "}
              <span className="font-medium text-foreground underline underline-offset-2">
                {mode === "sign_in" ? t("area.ux-labs.invite-ux-lab.authScreenPreview.createOne") : t("area.ux-labs.invite-ux-lab.authScreenPreview.signIn2")}
              </span>
            </div>
          </div>
        </div>
        <div className="hidden min-h-(--sz-420px) items-center justify-center bg-[radial-gradient(circle_at_top,rgba(8,145,178,0.18),transparent_48%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,1))] px-8 py-10 md:flex">
          <div className="max-w-sm space-y-4 text-zinc-200">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-cyan-200">
              {t("area.ux-labs.invite-ux-lab.authScreenPreview.authPreview")}
            </div>
            <div className="text-2xl font-semibold">{t("area.ux-labs.invite-ux-lab.authScreenPreview.sideBySideSignup")}</div>
            <p className="text-sm leading-6 text-zinc-400">
              {t("area.ux-labs.invite-ux-lab.authScreenPreview.frameNote")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompanyInvitesPreview() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-5 xl:grid-cols-(--gtc-38)">
      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MailPlus className="h-4 w-4" />
            {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.organizationInvites")}
          </div>
          <div>
            <CardTitle>{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.createInvite")}</CardTitle>
            <CardDescription className="mt-2">
              {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.generateAHumanInvite")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.chooseARole")}</legend>
            <div className="rounded-2xl border border-border">
              {inviteRoleOptions().map((option, index) => (
                <label
                  key={option.value}
                  className={cn("flex cursor-default gap-3 px-4 py-4", index > 0 && "border-t border-border")}
                >
                  <input
                    type="radio"
                    readOnly
                    checked={option.value === "operator"}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.default")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.singleUseNote")}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.createInvite")}</Button>
            <span className="text-sm text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.inviteHistoryBelowKeeps")}</span>
          </div>

          <div className="space-y-3 rounded-2xl border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.latestInviteLink")}</div>
                <div className="text-sm text-muted-foreground">
                  {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.thisUrlIncludesThe")}
                </div>
              </div>
              <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <Check className="h-3.5 w-3.5" />
                {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.copied")}
              </div>
            </div>
            <button
              type="button"
              className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-left text-sm break-all"
            >
              {`https://myrmidon.local/invite/new-token`}
            </button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline">
                <ExternalLink className="h-4 w-4" />
                {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.openInvite")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.inviteHistory")}</CardTitle>
              <CardDescription className="mt-2">
                {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.historyDescription")}
              </CardDescription>
            </div>
            <a href="/inbox/requests" className="text-sm underline underline-offset-4">
              {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.openJoinRequestQueue")}
            </a>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.state")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.role")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.invitedBy")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.created")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.joinRequest")}</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.action")}</th>
                </tr>
              </thead>
              <tbody>
                {inviteHistory().map((invite) => (
                  <tr key={invite.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-3 align-top">
                      <Badge variant="outline" className="border-border text-muted-foreground">
                        {invite.state}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 align-top">{invite.humanRole}</td>
                    <td className="px-5 py-3 align-top">
                      <div>{invite.invitedBy}</div>
                      <div className="text-xs text-muted-foreground">{invite.email}</div>
                    </td>
                    <td className="px-5 py-3 align-top text-muted-foreground">{invite.createdAt}</td>
                    <td className="px-5 py-3 align-top">
                      {invite.hasReviewLink ? (
                        <a href="/inbox/requests" className="underline underline-offset-4">
                          {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.reviewRequest")}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      {invite.canRevoke ? (
                        <Button type="button" size="sm" variant="outline">
                          {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.revoke")}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.inactive")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-border p-4">
              <div className="text-sm font-medium">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.emptyHistoryState")}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.noInvitesHaveBeen")}
              </div>
            </div>
            <div className="rounded-2xl border border-rose-400/40 bg-rose-500/[0.07] p-4">
              <div className="text-sm font-medium text-foreground">{t("area.ux-labs.invite-ux-lab.companyInvitesPreview.permissionError")}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {t("area.ux-labs.invite-ux-lab.companyInvitesPreview.youDoNotHave")}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function InviteUxLab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-cyan-700 dark:text-cyan-300">
              <FlaskConical className="h-3.5 w-3.5" />
              {t("area.ux-labs.invite-ux-lab.inviteUxLab")}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{t("area.ux-labs.invite-ux-lab.inviteAndSignupUx")}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t("area.ux-labs.invite-ux-lab.header.description")}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {`/tests/ux/invites`}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.invite-ux-lab.signupInviteStates")}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.invite-ux-lab.fixtureBackedPreview")}
              </Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t("area.ux-labs.invite-ux-lab.coveredStates")}
            </div>
            <div className="space-y-3">
              {[
                t("area.ux-labs.invite-ux-lab.inviteLoadingAccessCheck"),
                t("area.ux-labs.invite-ux-lab.inlineAccountCreationAnd"),
                t("area.ux-labs.invite-ux-lab.humanAcceptAgentRequest"),
                t("area.ux-labs.invite-ux-lab.pendingApprovalJoinedNow"),
                t("area.ux-labs.invite-ux-lab.organizationInviteCreationCopied"),
              ].map((highlight) => (
                <div
                  key={highlight}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {highlight}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        eyebrow={t("area.ux-labs.invite-ux-lab.topLevelStates")}
        title={t("area.ux-labs.invite-ux-lab.landingStateCoverage")}
        description={t("area.ux-labs.invite-ux-lab.smallCardsForThe")}
        accentClassName="bg-[linear-gradient(180deg,rgba(59,130,246,0.05),transparent_30%),var(--background)]"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatusCard
            icon={<Loader2 className="h-4 w-4 animate-spin" />}
            title={t("area.ux-labs.invite-ux-lab.loadingInvite")}
            body={t("area.ux-labs.invite-ux-lab.shownWhileInviteSummary")}
          />
          <StatusCard
            icon={<Clock3 className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.checkingYourAccess")}
            body={t("area.ux-labs.invite-ux-lab.shownAfterSignIn")}
          />
          <StatusCard
            icon={<KeyRound className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.invalidInviteToken")}
            body={t("area.ux-labs.invite-ux-lab.theTokenIsMissing")}
            tone="error"
          />
          <StatusCard
            icon={<Link2 className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.inviteNotAvailable")}
            body={t("area.ux-labs.invite-ux-lab.usedForExpiredRevoked")}
            tone="warn"
          />
          <StatusCard
            icon={<ShieldCheck className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.bootstrapComplete")}
            body={t("area.ux-labs.invite-ux-lab.resultScreenForBootstrap")}
            tone="success"
          />
          <StatusCard
            icon={<ArrowRight className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.autoAcceptInProgress")}
            body={t("area.ux-labs.invite-ux-lab.signedInHumanUsers")}
          />
          <StatusCard
            icon={<Users className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.alreadyAMember")}
            body={t("area.ux-labs.invite-ux-lab.acceptanceStaysDisabledAnd")}
          />
          <StatusCard
            icon={<UserPlus className="h-4 w-4" />}
            title={t("area.ux-labs.invite-ux-lab.inviteResultSurfaces")}
            body={t("area.ux-labs.invite-ux-lab.bothPendingApprovalAnd")}
            tone="success"
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={t("area.ux-labs.invite-ux-lab.inviteLanding")}
        title={t("area.ux-labs.invite-ux-lab.splitScreenInviteFlows")}
        description={t("area.ux-labs.invite-ux-lab.theseFramesMirrorThe")}
        accentClassName="bg-[linear-gradient(180deg,rgba(234,179,8,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={t("area.ux-labs.invite-ux-lab.joinAcmeRobotics")}
                description={t("area.ux-labs.invite-ux-lab.createYourMyrmidonAccount")}
                inviteMessage={t("area.ux-labs.invite-ux-lab.welcomeAboard")}
                requestedAccess={t("area.ux-labs.invite-ux-lab.operator")}
              />
            }
            right={<InlineAuthPreview mode="sign_up" />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={t("area.ux-labs.invite-ux-lab.joinAcmeRobotics")}
                description={t("area.ux-labs.invite-ux-lab.createYourMyrmidonAccount")}
                inviteMessage={t("area.ux-labs.invite-ux-lab.welcomeAboard")}
                requestedAccess={t("area.ux-labs.invite-ux-lab.operator")}
              />
            }
            right={
              <InlineAuthPreview
                mode="sign_in"
                feedback={{
                  tone: "info",
                  text: t("area.ux-labs.invite-ux-lab.anAccountAlreadyExists"),
                }}
              />
            }
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={t("area.ux-labs.invite-ux-lab.joinAcmeRobotics")}
                description={t("area.ux-labs.invite-ux-lab.yourAccountIsReady")}
                inviteMessage={t("area.ux-labs.invite-ux-lab.welcomeAboard")}
                requestedAccess={t("area.ux-labs.invite-ux-lab.operator")}
                signedInLabel="Jane Example"
              />
            }
            right={<AcceptInvitePreview autoAccept />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={t("area.ux-labs.invite-ux-lab.joinAcmeRobotics")}
                description={t("area.ux-labs.invite-ux-lab.reviewTheInviteDetails")}
                requestedAccess={t("area.ux-labs.invite-ux-lab.agentJoinRequest")}
              />
            }
            right={<AgentRequestPreview />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={t("area.ux-labs.invite-ux-lab.joinAcmeRobotics")}
                description={t("area.ux-labs.invite-ux-lab.yourAccountIsReady")}
                requestedAccess={t("area.ux-labs.invite-ux-lab.operator")}
                signedInLabel="Jane Example"
              />
            }
            right={<AcceptInvitePreview error={t("area.ux-labs.invite-ux-lab.thisAccountAlreadyBelongs")} isCurrentMember />}
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={t("area.ux-labs.invite-ux-lab.resultStates")}
        title={t("area.ux-labs.invite-ux-lab.approvalAndCompletionScreens")}
        description={t("area.ux-labs.invite-ux-lab.theseAreThePost")}
        accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_30%),var(--background)]"
      >
        <div className="grid gap-5 xl:grid-cols-3">
          <InviteResultPreview
            title={t("area.ux-labs.invite-ux-lab.requestToJoinAcme")}
            description={t("area.ux-labs.invite-ux-lab.boardUserMustApprove")}
            claimSecret="pcp_claim_secret_demo"
            onboardingTextUrl="/api/invites/pcp_invite_test/onboarding.txt"
          />
          <InviteResultPreview
            title={t("area.ux-labs.invite-ux-lab.youJoinedTheOrganization")}
            description={t("area.ux-labs.invite-ux-lab.yourAccountAlreadyMatched")}
            joinedNow
          />
          <InviteResultPreview
            title={t("area.ux-labs.invite-ux-lab.requestToJoinAcme")}
            description={t("area.ux-labs.invite-ux-lab.askThemToVisit")}
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={t("area.ux-labs.invite-ux-lab.standaloneAuth")}
        title={t("area.ux-labs.invite-ux-lab.authPageStates")}
        description={t("area.ux-labs.invite-ux-lab.theGeneralAuthPage")}
        accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <AuthScreenPreview mode="sign_in" error={t("area.ux-labs.invite-ux-lab.invalidEmailOrPassword")} />
          <AuthScreenPreview mode="sign_up" />
        </div>
      </LabSection>

      <LabSection
        eyebrow={t("area.ux-labs.invite-ux-lab.settings")}
        title={t("area.ux-labs.invite-ux-lab.organizationInviteManagement")}
        description={t("area.ux-labs.invite-ux-lab.thisSectionCapturesThe")}
        accentClassName="bg-[linear-gradient(180deg,rgba(244,114,182,0.06),transparent_28%),var(--background)]"
      >
        <CompanyInvitesPreview />
      </LabSection>
    </div>
  );
}
