// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
import type { ReactNode } from "react";
import { Trans } from "react-i18next";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SystemNotice } from "@/components/SystemNotice";
import { i18n, useTranslation } from "@/i18n";
import { systemNoticeFixtures } from "@/fixtures/systemNoticeFixtures";
import { cn } from "@/lib/utils";
import {
  CircleDashed,
  FlaskConical,
  Layers,
  ListChecks,
  Sparkles,
} from "lucide-react";

function LabSection({
  id,
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-(--rad-28) border border-border/70 bg-background/85 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
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

function FixtureFrame({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
        <CircleDashed className="h-3.5 w-3.5" />
        {caption}
      </div>
      {children}
    </div>
  );
}

function NoteCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

function MockUserBubble({
  authorName,
  body,
  alignEnd,
}: {
  authorName: string;
  body: string;
  alignEnd?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-2.5", alignEnd && "justify-end")}>
      {!alignEnd ? (
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
      <div className={cn("flex min-w-0 max-w-(--pct-85) flex-col", alignEnd && "items-end")}>
        <div
          className={cn(
            "mb-1 px-1 text-sm font-medium text-foreground",
            alignEnd ? "text-right" : "text-left",
          )}
        >
          {authorName}
        </div>
        <div className="min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
          {body}
        </div>
      </div>
      {alignEnd ? (
        <Avatar size="sm" className="shrink-0">
          <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
    </div>
  );
}

function MockAgentBubble({ agentName, body }: { agentName: string; body: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>{agentName.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 max-w-(--pct-85) flex-col">
        <div className="mb-1 px-1 text-sm font-medium text-foreground">{agentName}</div>
        <div className="min-w-0 max-w-full rounded-2xl border border-border/70 bg-background px-4 py-2.5 text-sm leading-6 text-foreground">
          {body}
        </div>
      </div>
    </div>
  );
}

const checklist = (): string[] => [
  i18n.t("area.ux-labs.system-notice-ux-lab.checklist.item1"),
  i18n.t("area.ux-labs.system-notice-ux-lab.checklist.item2"),
  i18n.t("area.ux-labs.system-notice-ux-lab.checklist.item3"),
  i18n.t("area.ux-labs.system-notice-ux-lab.checklist.item4"),
  i18n.t("area.ux-labs.system-notice-ux-lab.checklist.item5"),
];

export function SystemNoticeUxLab() {
  const { t } = useTranslation();
  const fixtureById = new Map(systemNoticeFixtures.map((f) => [f.id, f] as const));

  const warningCollapsed = fixtureById.get("warning-collapsed")!;
  const warningExpanded = fixtureById.get("warning-expanded")!;
  const dangerCollapsed = fixtureById.get("danger-collapsed")!;
  const dangerExpanded = fixtureById.get("danger-expanded")!;
  const neutralCollapsed = fixtureById.get("neutral-collapsed")!;
  const neutralExpanded = fixtureById.get("neutral-expanded")!;
  const warningNoDetails = fixtureById.get("warning-no-details")!;

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(245,158,11,0.10),transparent_28%),linear-gradient(180deg,rgba(8,145,178,0.08),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-amber-700 dark:text-amber-300">
              <FlaskConical className="h-3.5 w-3.5" />
              {t("area.ux-labs.system-notice-ux-lab.header.eyebrow")}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">
              {t("area.ux-labs.system-notice-ux-lab.header.title")}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t("area.ux-labs.system-notice-ux-lab.header.description")}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.system-notice-ux-lab.header.badgePlan")}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.system-notice-ux-lab.header.badgePhase")}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.system-notice-ux-lab.header.badgeTones")}
              </Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              <ListChecks className="h-4 w-4 text-amber-700 dark:text-amber-300" />
              {t("area.ux-labs.system-notice-ux-lab.header.proves")}
            </div>
            <div className="space-y-3">
              {checklist().map((line) => (
                <div
                  key={line}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {line}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        id="tones"
        eyebrow={t("area.ux-labs.system-notice-ux-lab.tones.eyebrow")}
        title={t("area.ux-labs.system-notice-ux-lab.tones.title")}
        description={t("area.ux-labs.system-notice-ux-lab.tones.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(245,158,11,0.05),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <FixtureFrame caption={warningCollapsed.caption}>
            <SystemNotice {...warningCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={warningExpanded.caption}>
            <SystemNotice {...warningExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={dangerCollapsed.caption}>
            <SystemNotice {...dangerCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={dangerExpanded.caption}>
            <SystemNotice {...dangerExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={neutralCollapsed.caption}>
            <SystemNotice {...neutralCollapsed} />
          </FixtureFrame>
          <FixtureFrame caption={neutralExpanded.caption}>
            <SystemNotice {...neutralExpanded} />
          </FixtureFrame>
          <FixtureFrame caption={warningNoDetails.caption}>
            <SystemNotice {...warningNoDetails} />
          </FixtureFrame>
        </div>
      </LabSection>

      <LabSection
        id="hierarchy"
        eyebrow={t("area.ux-labs.system-notice-ux-lab.hierarchy.eyebrow")}
        title={t("area.ux-labs.system-notice-ux-lab.hierarchy.title")}
        description={t("area.ux-labs.system-notice-ux-lab.hierarchy.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(8,145,178,0.05),transparent_28%),var(--background)]"
      >
        <div className="space-y-4 rounded-2xl border border-border/70 bg-background/70 p-4">
          <MockUserBubble
            authorName="Riley Board"
            body={t("area.ux-labs.system-notice-ux-lab.hierarchy.userQuestion")}
            alignEnd
          />
          <MockAgentBubble
            agentName="CodexCoder"
            body={t("area.ux-labs.system-notice-ux-lab.hierarchy.agentReply")}
          />
          <SystemNotice
            tone="danger"
            label={t("area.ux-labs.system-notice-ux-lab.hierarchy.noticeLabel")}
            source={{ label: "Myrmidon", href: "/PAP/agents" }}
            timestamp="2026-05-04T16:48:00.000Z"
            body={t("area.ux-labs.system-notice-ux-lab.hierarchy.noticeBody")}
            metadata={[
              {
                title: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaRecoveryOwner"),
                rows: [
                  {
                    kind: "issue",
                    label: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaRecoveryIssue"),
                    identifier: "PAP-3440",
                    href: "/PAP/issues/PAP-3440",
                    title: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaRecoveryIssueTitle"),
                  },
                  {
                    kind: "agent",
                    label: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaOwner"),
                    name: "CTO",
                    href: "/PAP/agents/cto",
                  },
                ],
              },
              {
                title: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaRunEvidence"),
                rows: [
                  {
                    kind: "run",
                    label: t("area.ux-labs.system-notice-ux-lab.hierarchy.metaSourceRun"),
                    runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
                    href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
                    status: "succeeded",
                  },
                ],
              },
            ]}
          />
          <MockUserBubble
            authorName="Riley Board"
            body={t("area.ux-labs.system-notice-ux-lab.hierarchy.userThanks")}
            alignEnd
          />
        </div>
      </LabSection>

      <div className="grid gap-5 xl:grid-cols-2">
        <LabSection
          eyebrow={t("area.ux-labs.system-notice-ux-lab.before.eyebrow")}
          title={t("area.ux-labs.system-notice-ux-lab.before.title")}
          description={t("area.ux-labs.system-notice-ux-lab.before.description")}
          accentClassName="bg-[linear-gradient(180deg,rgba(244,63,94,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="flex items-start gap-2.5">
              <Avatar size="sm" className="shrink-0">
                <AvatarFallback>{t("area.ux-labs.system-notice-ux-lab.before.youInitials")}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 max-w-(--pct-85) flex-col">
                <div className="mb-1 px-1 text-sm font-medium text-foreground">{t("area.ux-labs.system-notice-ux-lab.before.you")}</div>
                <div className="min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground">
                  <div className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2.5 text-sm text-red-950 dark:text-red-100">
                    <div className="flex items-start gap-2">
                      <Sparkles className="mt-1 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                      <div className="min-w-0">
                        <p className="m-0 font-semibold">{t("area.ux-labs.system-notice-ux-lab.before.noticeTitle")}</p>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-(length:--text-compact) leading-5">
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.sourceIssue")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.sourceRun")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.recoveryRun")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.statusBefore")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.cause")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.owner")}</li>
                          <li>{t("area.ux-labs.system-notice-ux-lab.before.item.action")}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              <Trans
                i18nKey="area.ux-labs.system-notice-ux-lab.before.note"
                components={{ you: <span className="font-medium text-foreground" /> }}
              />
            </p>
          </div>
        </LabSection>

        <LabSection
          eyebrow={t("area.ux-labs.system-notice-ux-lab.after.eyebrow")}
          title={t("area.ux-labs.system-notice-ux-lab.after.title")}
          description={t("area.ux-labs.system-notice-ux-lab.after.description")}
          accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent_28%),var(--background)]"
        >
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
            <SystemNotice {...dangerCollapsed} />
            <p className="px-1 text-xs text-muted-foreground">
              <Trans
                i18nKey="area.ux-labs.system-notice-ux-lab.after.note"
                components={{ details: <span className="font-medium text-foreground" /> }}
              />
            </p>
          </div>
        </LabSection>
      </div>

      <Card className="gap-4 border-border/70 bg-background/85 py-0">
        <CardHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            <Layers className="h-4 w-4 text-amber-700 dark:text-amber-300" />
            {t("area.ux-labs.system-notice-ux-lab.notes.eyebrow")}
          </div>
          <CardTitle className="text-lg">{t("area.ux-labs.system-notice-ux-lab.notes.title")}</CardTitle>
          <CardDescription>
            {t("area.ux-labs.system-notice-ux-lab.notes.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5 pt-0 text-sm text-muted-foreground">
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{t("area.ux-labs.system-notice-ux-lab.notes.component.title")}</div>
            {t("area.ux-labs.system-notice-ux-lab.notes.component.use")}{" "}
            <NoteCode>{`<SystemNotice />`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.component.from")}{" "}
            <NoteCode>{`@/components/SystemNotice`}</NoteCode>.{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.component.accepts")}{" "}
            <NoteCode>{`tone`}</NoteCode>,{" "}
            <NoteCode>{`label`}</NoteCode>,{" "}
            <NoteCode>{`body`}</NoteCode>,{" "}
            <NoteCode>{`metadata`}</NoteCode>,{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.and")}{" "}
            <NoteCode>{`detailsDefaultOpen`}</NoteCode>.
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{t("area.ux-labs.system-notice-ux-lab.notes.routing.title")}</div>
            {t("area.ux-labs.system-notice-ux-lab.notes.routing.comments")}{" "}
            <NoteCode>{`authorType === "system"`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.or")}{" "}
            <NoteCode>{`presentation.kind === "system_notice"`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.routing.render")}{" "}
            <NoteCode>{`IssueChatUserMessage`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.routing.tail")}
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{t("area.ux-labs.system-notice-ux-lab.notes.a11y.title")}</div>
            {t("area.ux-labs.system-notice-ux-lab.notes.a11y.button")}{" "}
            <NoteCode>{`aria-expanded`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.and")}{" "}
            <NoteCode>{`aria-controls`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.a11y.wired")}{" "}
            <NoteCode>{`role="status"`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.and")}{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.a11y.an")}{" "}
            <NoteCode>{`aria-label`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.a11y.tail")}
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
            <div className="mb-1 font-medium text-foreground">{t("area.ux-labs.system-notice-ux-lab.notes.legacy.title")}</div>
            {t("area.ux-labs.system-notice-ux-lab.notes.legacy.existing")}{" "}
            <NoteCode>{`presentation`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.legacy.keep")}{" "}
            <NoteCode>{`SuccessfulRunHandoffCommentCallout`}</NoteCode>{" "}
            {t("area.ux-labs.system-notice-ux-lab.notes.legacy.tail")}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SystemNoticeUxLab;
