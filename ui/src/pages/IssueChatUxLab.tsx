// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IssueChatThread } from "../components/IssueChatThread";
import {
  issueChatUxAgentMap,
  issueChatUxFeedbackVotes,
  issueChatUxLinkedRuns,
  issueChatUxLiveComments,
  issueChatUxLiveEvents,
  issueChatUxLiveRuns,
  issueChatUxMentions,
  issueChatUxReassignOptions,
  issueChatUxReviewComments,
  issueChatUxReviewEvents,
  issueChatUxSubmittingComments,
  issueChatUxTranscriptsByRunId,
} from "../fixtures/issueChatUxFixtures";
import { i18n, useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Bot, Brain, FlaskConical, Loader2, MessagesSquare, Route, Sparkles, WandSparkles } from "lucide-react";

const noop = async () => {};

const highlights = (): string[] => [
  i18n.t("area.ux-labs.issue-chat-ux-lab.highlights.running"),
  i18n.t("area.ux-labs.issue-chat-ux-lab.highlights.history"),
  i18n.t("area.ux-labs.issue-chat-ux-lab.highlights.queued"),
  i18n.t("area.ux-labs.issue-chat-ux-lab.highlights.submitting"),
  i18n.t("area.ux-labs.issue-chat-ux-lab.highlights.empty"),
];

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

function useDemoReasoningLines(): string[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line1"),
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line2"),
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line3"),
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line4"),
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line5"),
      t("area.ux-labs.issue-chat-ux-lab.reasoning.line6"),
    ],
    [t],
  );
}

function RotatingReasoningDemo({ intervalMs = 2200 }: { intervalMs?: number }) {
  const lines = useDemoReasoningLines();
  const [index, setIndex] = useState(0);
  const prevRef = useRef(lines[0]);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: lines[0]!, exiting: null });

  useEffect(() => {
    // Respect reduced motion (also makes the visual suite deterministic —
    // it captures with reducedMotion: "reduce").
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % lines.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, lines.length]);

  const currentLine = lines[index]!;

  useEffect(() => {
    if (currentLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = currentLine;
      setTicker((t) => ({ key: t.key + 1, current: currentLine, exiting: prev }));
    }
  }, [currentLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground/70",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

export function IssueChatUxLab() {
  const { t } = useTranslation();
  const [showComposer, setShowComposer] = useState(true);

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-cyan-700 dark:text-cyan-300">
              <FlaskConical className="h-3.5 w-3.5" />
              {t("area.ux-labs.issue-chat-ux-lab.header.eyebrow")}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{t("area.ux-labs.issue-chat-ux-lab.header.title")}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t("area.ux-labs.issue-chat-ux-lab.header.description")}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {`/tests/ux/chat`}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.issue-chat-ux-lab.header.badgeThread")}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {t("area.ux-labs.issue-chat-ux-lab.header.badgeLiveRun")}
              </Badge>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => setShowComposer((value) => !value)}>
                {showComposer ? t("area.ux-labs.issue-chat-ux-lab.header.hideComposer") : t("area.ux-labs.issue-chat-ux-lab.header.showComposer")}
              </Button>
              <a
                href="#live-execution"
                className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Route className="h-3.5 w-3.5" />
                {t("area.ux-labs.issue-chat-ux-lab.header.jump")}
              </a>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              <WandSparkles className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
              {t("area.ux-labs.issue-chat-ux-lab.header.coveredStates")}
            </div>
            <div className="space-y-3">
              {highlights().map((highlight) => (
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
        id="rotating-text"
        eyebrow={t("area.ux-labs.issue-chat-ux-lab.rotating.eyebrow")}
        title={t("area.ux-labs.issue-chat-ux-lab.rotating.title")}
        description={t("area.ux-labs.issue-chat-ux-lab.rotating.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-2 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t("area.ux-labs.issue-chat-ux-lab.rotating.defaultInterval")}
            </div>
            <RotatingReasoningDemo />
          </div>
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-2 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t("area.ux-labs.issue-chat-ux-lab.rotating.fastInterval")}
            </div>
            <RotatingReasoningDemo intervalMs={1000} />
          </div>
        </div>
      </LabSection>

      <LabSection
        id="working-tokens"
        eyebrow={t("area.ux-labs.issue-chat-ux-lab.workingTokens.eyebrow")}
        title={t("area.ux-labs.issue-chat-ux-lab.workingTokens.title")}
        description={t("area.ux-labs.issue-chat-ux-lab.workingTokens.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_28%),var(--background)]"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-3 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t("area.ux-labs.issue-chat-ux-lab.workingTokens.activeRun")}
            </div>
            <div className="flex items-center gap-2.5 rounded-lg px-1 py-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="shimmer-text">{t("area.ux-labs.issue-chat-ux-lab.workingTokens.working")}</span>
              </span>
              <span className="text-xs text-muted-foreground/60">{t("area.ux-labs.issue-chat-ux-lab.workingTokens.for12s")}</span>
            </div>
          </div>
          <div className="rounded-xl border border-border/60 bg-accent/10 p-4">
            <div className="mb-3 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t("area.ux-labs.issue-chat-ux-lab.workingTokens.completedRun")}
            </div>
            <div className="flex items-center gap-2.5 rounded-lg px-1 py-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                </span>
                {t("area.ux-labs.issue-chat-ux-lab.workingTokens.worked")}
              </span>
              <span className="text-xs text-muted-foreground/60">{t("area.ux-labs.issue-chat-ux-lab.workingTokens.for84s")}</span>
            </div>
          </div>
        </div>
      </LabSection>

      <LabSection
        id="live-execution"
        eyebrow={t("area.ux-labs.issue-chat-ux-lab.live.eyebrow")}
        title={t("area.ux-labs.issue-chat-ux-lab.live.title")}
        description={t("area.ux-labs.issue-chat-ux-lab.live.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(6,182,212,0.05),transparent_28%),var(--background)]"
      >
        <IssueChatThread
          comments={issueChatUxLiveComments}
          linkedRuns={issueChatUxLinkedRuns.slice(0, 1)}
          timelineEvents={issueChatUxLiveEvents}
          liveRuns={issueChatUxLiveRuns}
          issueStatus="todo"
          agentMap={issueChatUxAgentMap}
          currentUserId="user-1"
          onAdd={noop}
          onVote={noop}
          onCancelRun={noop}
          onInterruptQueued={noop}
          draftKey="issue-chat-ux-lab-primary"
          enableReassign
          reassignOptions={issueChatUxReassignOptions}
          currentAssigneeValue="agent:agent-1"
          suggestedAssigneeValue="agent:agent-2"
          mentions={issueChatUxMentions}
          showComposer={showComposer}
          enableLiveTranscriptPolling={false}
          transcriptsByRunId={issueChatUxTranscriptsByRunId}
          hasOutputForRun={(runId) => issueChatUxTranscriptsByRunId.has(runId)}
        />
      </LabSection>

      <LabSection
        eyebrow={t("area.ux-labs.issue-chat-ux-lab.submitting.eyebrow")}
        title={t("area.ux-labs.issue-chat-ux-lab.submitting.title")}
        description={t("area.ux-labs.issue-chat-ux-lab.submitting.description")}
        accentClassName="bg-[linear-gradient(180deg,rgba(59,130,246,0.06),transparent_28%),var(--background)]"
      >
        <IssueChatThread
          comments={issueChatUxSubmittingComments}
          linkedRuns={[]}
          timelineEvents={[]}
          issueStatus="in_progress"
          agentMap={issueChatUxAgentMap}
          currentUserId="user-1"
          onAdd={noop}
          draftKey="issue-chat-ux-lab-submitting"
          showComposer={false}
          enableLiveTranscriptPolling={false}
        />
      </LabSection>

      <div className="grid gap-6 xl:grid-cols-2">
        <LabSection
          eyebrow={t("area.ux-labs.issue-chat-ux-lab.settled.eyebrow")}
          title={t("area.ux-labs.issue-chat-ux-lab.settled.title")}
          description={t("area.ux-labs.issue-chat-ux-lab.settled.description")}
          accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.05),transparent_26%),var(--background)]"
        >
          <IssueChatThread
            comments={issueChatUxReviewComments}
            linkedRuns={issueChatUxLinkedRuns.slice(1)}
            timelineEvents={issueChatUxReviewEvents}
            feedbackVotes={issueChatUxFeedbackVotes}
            feedbackTermsUrl="/feedback-terms"
            issueStatus="in_review"
            agentMap={issueChatUxAgentMap}
            currentUserId="user-1"
            onAdd={noop}
            onVote={noop}
            draftKey="issue-chat-ux-lab-review"
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </LabSection>

        <div className="space-y-6">
          <LabSection
            eyebrow={t("area.ux-labs.issue-chat-ux-lab.empty.eyebrow")}
            title={t("area.ux-labs.issue-chat-ux-lab.empty.title")}
            description={t("area.ux-labs.issue-chat-ux-lab.empty.description")}
            accentClassName="bg-[linear-gradient(180deg,rgba(245,158,11,0.08),transparent_26%),var(--background)]"
          >
            <IssueChatThread
              comments={[]}
              linkedRuns={[]}
              timelineEvents={[]}
              issueStatus="done"
              agentMap={issueChatUxAgentMap}
              currentUserId="user-1"
              onAdd={noop}
              composerDisabledReason={t("area.ux-labs.issue-chat-ux-lab.empty.disabledReason")}
              draftKey="issue-chat-ux-lab-empty"
              enableLiveTranscriptPolling={false}
            />
          </LabSection>

          <Card className="gap-4 border-border/70 bg-background/85 py-0">
            <CardHeader className="px-5 pt-5 pb-0">
              <div className="flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                <MessagesSquare className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                {t("area.ux-labs.issue-chat-ux-lab.checklist.eyebrow")}
              </div>
              <CardTitle className="text-lg">{t("area.ux-labs.issue-chat-ux-lab.checklist.title")}</CardTitle>
              <CardDescription>
                {t("area.ux-labs.issue-chat-ux-lab.checklist.description")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 pt-0 text-sm text-muted-foreground">
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <Bot className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                  {t("area.ux-labs.issue-chat-ux-lab.checklist.hierarchyTitle")}
                </div>
                {t("area.ux-labs.issue-chat-ux-lab.checklist.hierarchyBody")}
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <Sparkles className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                  {t("area.ux-labs.issue-chat-ux-lab.checklist.streamTitle")}
                </div>
                {t("area.ux-labs.issue-chat-ux-lab.checklist.streamBody")}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
