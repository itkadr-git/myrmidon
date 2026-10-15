import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, DraftInput, Field, ToggleField } from "../agent-config-primitives";
import {
  APPLY_POLL_INTERVAL_MS,
  APPLY_POLL_TIMEOUT_MS,
  APPLY_PROGRESS_TEXT,
  APPLY_TIMEOUT_TEXT,
  botContainerApi,
  botContainerStatusKey,
  clearStoredApplyJob,
  describeApplyError,
  describeApplyJobStatus,
  describeApplyOutcome,
  readStoredApplyJob,
  storeApplyJob,
  type ApplyFeedback,
  type BotApplyAccepted,
  type BotContainerStatus,
} from "./botContainerApi";
import {
  BOT_CONTAINER_NUMBER_FIELDS,
  botContainerProblems,
  disableBotContainer,
  enableBotContainer,
  parseBotContainerNumber,
  readBotContainerCard,
  setBotContainerNumber,
  setBotContainerText,
  type BotContainerCard,
  type BotContainerNumberField,
} from "./botContainerConfig";

/**
 * myrmidon(W2b): the "Container" section of a hermes_gateway agent card. Stored as
 * `adapterConfig.container = { enabled, image, memoryMb, cpus, pidsLimit, group? }`.
 * Saving the card stores the settings; "Apply now" asks the server to reconcile the
 * SAVED card with the bot's container (create it, refresh its profile, restart the
 * gateway), so it is off while the section has unsaved edits.
 */

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const NUMBER_FIELD_ORDER: BotContainerNumberField[] = ["memoryMb", "cpus", "pidsLimit"];

function NumberField({
  field,
  value,
  onCommit,
}: {
  field: BotContainerNumberField;
  value: unknown;
  onCommit: (value: number) => void;
}) {
  const spec = BOT_CONTAINER_NUMBER_FIELDS[field];
  const shown = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const parsed = parseBotContainerNumber(field, draft);
  return (
    <Field label={`${spec.label} (${spec.unit})`}>
      <input
        type="text"
        inputMode={spec.integer ? "numeric" : "decimal"}
        className={inputClass}
        aria-label={spec.label}
        aria-invalid={!parsed.ok}
        data-testid={`myrmidon-bot-container-${field}`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          // Only a valid number reaches the card; an invalid draft keeps the last valid value.
          const next = parseBotContainerNumber(field, event.target.value);
          if (next.ok) onCommit(next.value);
        }}
      />
      {!parsed.ok && (
        <p className="mt-1 text-xs text-amber-400" data-testid={`myrmidon-bot-container-${field}-error`}>
          {parsed.message}
        </p>
      )}
    </Field>
  );
}

function stateLabel(state: "running" | "stopped" | "missing" | "unhealthy"): string {
  switch (state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "unhealthy":
      return "Unhealthy";
    default:
      return "Not created yet";
  }
}

function statusText(status: BotContainerStatus | null, statusError: string | null): string {
  if (!status) return statusError ? `Container status unavailable: ${statusError}` : "Checking container status...";
  if (!status.enabled) return "Bot containers are switched off on this instance: nothing here is applied.";
  if (!status.runtimeConfigured) return "No container runtime is configured on this instance yet.";
  if (status.containerError) return `Container status unavailable: ${status.containerError}`;
  if (!status.container) return "Container status is not available for this agent.";
  const image = status.container.image ? ` (${status.container.image})` : "";
  return `${stateLabel(status.container.state)}${image}`;
}

/** One line for the rollout category of the saved card, or null when the server did not say. */
export function imageTrackingText(status: BotContainerStatus | null): string | null {
  const tracking = status?.imageTracking;
  if (!tracking) return null;
  switch (tracking.category) {
    case "tracks_release":
      return `Bot image rollout: follows the release (now ${tracking.image}).`;
    case "pinned":
      return `Bot image rollout: pinned${tracking.image ? ` to ${tracking.image}` : ""}; the release does not move this bot.`;
    default:
      return `Bot image rollout: not applicable (${tracking.reason}).`;
  }
}

/** myrmidon(BOT-ROLLOUT): the release-image verdict line of the card, or null when
 *  the server did not say (older server). */
export function imageRolloutText(status: BotContainerStatus | null): string | null {
  const rollout = status?.imageRollout;
  if (!rollout) return null;
  if (rollout.onReleaseImage) return "On the release image.";
  return `Not on the current release image: ${rollout.reason}.`;
}

/** Why "Apply now" cannot run right now, or null when it can. */
export function applyBlockedReason(
  status: BotContainerStatus | null,
  unsaved: boolean,
  statusError: string | null,
): string | null {
  if (unsaved) return "Save the card first: Apply now uses the saved settings.";
  if (!status) return statusError ? "Container status is unavailable." : "Checking container status...";
  if (!status.enabled) return "Bot containers are not enabled on this instance.";
  if (!status.runtimeConfigured) return "The bot container runtime is not configured on this instance.";
  if (!status.eligible) return `The saved card cannot be applied: ${status.reason ?? "it is not a complete container config."}`;
  return null;
}

export interface AgentCardContainerFieldsViewProps {
  /** `adapterConfig.container` as currently edited. */
  value: unknown;
  onChange: (next: BotContainerCard | undefined) => void;
  /** The section (or the adapter) has edits that are not saved yet. */
  unsaved: boolean;
  status: BotContainerStatus | null;
  statusError: string | null;
  applying: boolean;
  /** myrmidon(1.6.5 ASYNC-BOT-APPLY-UI): an apply job is live and being polled —
   *  the progress line under the buttons says so while no outcome exists yet. */
  progress: boolean;
  feedback: ApplyFeedback | null;
  onApply: () => void;
  onRefresh: () => void;
}

/** myrmidon(CONCURRENCY-SYNC): what the "Concurrent runs limit" block shows. */
export interface ConcurrencyView {
  /** The value the card asks for (the server normalizes it). */
  board: string;
  /** The value the gateway was given, or why there is none to show. */
  gateway: string;
  diverged: boolean;
  note: string | null;
  warning: string | null;
}

/**
 * The limit block's content, or null when the status says nothing about it (no status
 * yet, or an agent the server does not treat as a managed or unmanaged gateway).
 *
 * An applied value the container's profile does not report reads as "not reported
 * yet", never as a match: the reading only compares what the board and the gateway
 * each say, and a missing number is not a number.
 */
export function concurrencyView(status: BotContainerStatus | null): ConcurrencyView | null {
  if (!status) return null;
  const limit = status.gatewayConcurrency;
  if (!limit && !status.gatewayConcurrencyNote && !status.gatewayConcurrencyWarning) return null;
  return {
    board: `Board: ${limit?.board ?? status.boardMaxConcurrentRuns}`,
    gateway: limit
      ? limit.applied === null
        ? "Gateway: not reported yet"
        : `Gateway: ${limit.applied}`
      : "Gateway: not managed by the board",
    diverged: limit?.diverged ?? false,
    note: status.gatewayConcurrencyNote,
    warning: status.gatewayConcurrencyWarning,
  };
}

export function AgentCardContainerFieldsView({
  value,
  onChange,
  unsaved,
  status,
  statusError,
  applying,
  progress,
  feedback,
  onApply,
  onRefresh,
}: AgentCardContainerFieldsViewProps) {
  const card = readBotContainerCard(value);
  const enabled = card.enabled === true;
  // A legacy block without `enabled` shows its fields too, so the missing values are visible.
  const showFields = enabled || (typeof card.enabled !== "boolean" && Object.keys(card).length > 0);
  const [expanded, setExpanded] = useState(() => Object.keys(card).length > 0);
  const problems = botContainerProblems(card);
  const blocked = applyBlockedReason(status, unsaved, statusError);
  const image = typeof card.image === "string" ? card.image : "";
  const group = typeof card.group === "string" ? card.group : "";
  const allowlist = status?.imageAllowlist ?? null;
  // The server judges the SAVED image; an edited one is judged after saving.
  const savedImageNotAllowed = status?.imageAllowed === false && !unsaved;
  const concurrency = concurrencyView(status);

  return (
    <CollapsibleSection title="Container" open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3" data-testid="myrmidon-bot-container">
        <ToggleField
          label="Enabled"
          hint="Run this agent's gateway in its own container with the limits below. Off leaves the agent as it is."
          checked={enabled}
          onChange={(on) => onChange(on ? enableBotContainer(card) : disableBotContainer(card))}
          toggleTestId="myrmidon-bot-container-enabled"
        />

        {showFields && (
          <>
            <Field label="Image" hint="The bot image to run. Only images the instance allows can be applied.">
              <DraftInput
                value={image}
                onCommit={(text) => onChange(setBotContainerText(card, "image", text))}
                immediate
                className={inputClass}
                placeholder="registry/name:tag"
                aria-label="Image"
                data-testid="myrmidon-bot-container-image"
              />
              {allowlist !== null && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="myrmidon-bot-container-allowlist">
                  {allowlist.length > 0
                    ? `Allowed on this instance: ${allowlist.join(", ")}`
                    : "This instance allows no images yet, so nothing can be applied."}
                </p>
              )}
              {savedImageNotAllowed && (
                <p className="mt-1 text-xs text-amber-400" data-testid="myrmidon-bot-container-image-not-allowed">
                  The saved image is not on the allowlist and will be refused.
                </p>
              )}
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {NUMBER_FIELD_ORDER.map((field) => (
                <NumberField
                  key={field}
                  field={field}
                  value={card[field]}
                  onCommit={(next) => onChange(setBotContainerNumber(card, field, next))}
                />
              ))}
            </div>

            <Field label="Group" hint="Empty means the agent gets its own container.">
              <DraftInput
                value={group}
                onCommit={(text) => onChange(setBotContainerText(card, "group", text))}
                immediate
                className={inputClass}
                placeholder="Empty: own container"
                aria-label="Group"
                data-testid="myrmidon-bot-container-group"
              />
              {group && (
                <p className="mt-1 text-xs text-amber-400" data-testid="myrmidon-bot-container-group-warning">
                  Shared containers are not supported yet: the container will not be applied while Group is set.
                </p>
              )}
            </Field>
          </>
        )}

        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-400" data-testid="myrmidon-bot-container-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-border px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Container status</div>
              <div className="break-words text-sm" data-testid="myrmidon-bot-container-status">
                {statusText(status, statusError)}
              </div>
              {imageTrackingText(status) && (
                <div className="mt-1 break-words text-xs text-muted-foreground" data-testid="myrmidon-bot-container-tracking">
                  {imageTrackingText(status)}
                </div>
              )}
              {imageRolloutText(status) && (
                <div className="mt-1 flex items-center gap-1.5 break-words text-xs" data-testid="myrmidon-bot-container-release-image">
                  {!status?.imageRollout?.onReleaseImage && (
                    <span
                      className="inline-flex shrink-0 items-center rounded-full border border-amber-400/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
                      data-testid="myrmidon-bot-container-not-on-release"
                    >
                      Not on the current image
                    </span>
                  )}
                  <span className={status?.imageRollout?.onReleaseImage ? "text-muted-foreground" : "text-amber-400/90"}>
                    Release image: {imageRolloutText(status)}
                  </span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={applying}
                data-testid="myrmidon-bot-container-refresh"
              >
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onApply}
                disabled={applying || blocked !== null}
                title={blocked ?? undefined}
                data-testid="myrmidon-bot-container-apply"
              >
                {applying && <Loader2 className="mr-1.5 size-3 animate-spin" aria-hidden="true" />}
                {applying ? "Applying..." : "Apply now"}
              </Button>
            </div>
          </div>
          {blocked && (
            <p className="text-xs text-muted-foreground" data-testid="myrmidon-bot-container-apply-hint">
              {blocked}
            </p>
          )}
          {progress && (
            <p className="text-xs text-muted-foreground" data-testid="myrmidon-bot-container-apply-progress">
              {APPLY_PROGRESS_TEXT}
            </p>
          )}
          {feedback && (
            <p
              role="status"
              className={
                feedback.kind === "ok"
                  ? "text-xs text-green-500"
                  : feedback.kind === "warn"
                    ? "text-xs text-amber-400"
                    : "text-xs text-destructive"
              }
              data-testid="myrmidon-bot-container-feedback"
            >
              {feedback.message}
            </p>
          )}
        </div>

        {concurrency && (
          <div className="space-y-1 rounded-md border border-border px-2.5 py-2" data-testid="myrmidon-bot-container-concurrency">
            <div className="text-xs text-muted-foreground">Concurrent runs limit</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm" data-testid="myrmidon-bot-container-concurrency-board">
                {concurrency.board}
              </span>
              <span className="text-sm" data-testid="myrmidon-bot-container-concurrency-gateway">
                {concurrency.gateway}
              </span>
              {concurrency.diverged && (
                <span
                  className="rounded-full border border-border px-2 py-0.5 text-xs text-amber-400"
                  data-testid="myrmidon-bot-container-concurrency-diverged"
                >
                  Diverged from the board
                </span>
              )}
            </div>
            {concurrency.note && (
              <p className="text-xs text-muted-foreground" data-testid="myrmidon-bot-container-concurrency-note">
                {concurrency.note}
              </p>
            )}
            {concurrency.warning && (
              <p className="text-xs text-amber-400" data-testid="myrmidon-bot-container-concurrency-warning">
                {concurrency.warning}
              </p>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads the status, runs "Apply now".
 *
 *  myrmidon(1.6.5 ASYNC-BOT-APPLY-UI): pressing the button queues the pass
 *  (POST answers 202 + applyId, part A ASYNC-BOT-APPLY) instead of holding the
 *  request for the whole reconcile. The section then polls
 *  GET .../apply/:applyId every 2 s until the job leaves pending/running, at
 *  most ~2 min per round, and shows the outcome — "applied (time)" or the
 *  server's failure text — on the card. While a job is live the button is
 *  disabled and a progress line explains what is happening. The live apply id
 *  lives in sessionStorage, so a page reload in the first minutes resumes the
 *  same job: the outcome, error included, is not lost with the component. */
export function AgentCardContainerFields({
  agentId,
  value,
  savedValue,
  unsaved,
  onChange,
}: {
  agentId: string;
  /** `adapterConfig.container` as edited in the form. */
  value: unknown;
  /** `adapterConfig.container` as saved: the status is asked again when it changes. */
  savedValue: unknown;
  unsaved: boolean;
  onChange: (next: BotContainerCard | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const savedKey = JSON.stringify(savedValue ?? null);
  const statusQuery = useQuery({
    queryKey: [...botContainerStatusKey(agentId), savedKey],
    queryFn: () => botContainerApi.status(agentId),
    retry: false,
  });
  const [feedback, setFeedback] = useState<ApplyFeedback | null>(null);
  // The job whose outcome the section waits for. Null when nothing is live.
  const [activeApplyId, setActiveApplyId] = useState<string | null>(null);
  // Set when a poll round ran out without an outcome — the "check later" hint.
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const deadlineRef = useRef(0);
  // A POST in flight (its answer has not been folded into state yet).
  const [posting, setPosting] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: botContainerStatusKey(agentId) });

  // Resume a job that survived a page reload: the stored id is only taken
  // while it is inside the resume window (readStoredApplyJob drops stale or
  // corrupt entries). Runs once per agent — a reload must not re-drop a job
  // the previous mount already resumed.
  useEffect(() => {
    const stored = readStoredApplyJob(agentId, Date.now());
    if (!stored) return;
    // One final check on resume is what catches an outcome that landed while
    // the page was closed; after the original two-minute round ran out the
    // poll gives up again with the "check later" hint rather than running an
    // open-ended loop for an old job.
    deadlineRef.current = stored.startedAtMs + APPLY_POLL_TIMEOUT_MS;
    setActiveApplyId(stored.applyId);
  }, [agentId]);

  // The polling loop: one GET per interval while a job is live. Every read is
  // database-only on the server, so it is cheap and answers during a pass.
  useEffect(() => {
    if (!activeApplyId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const job = await botContainerApi.applyStatus(agentId, activeApplyId);
        if (cancelled) return;
        const outcome = describeApplyJobStatus(job);
        if (outcome) {
          clearStoredApplyJob(agentId);
          setFeedback(outcome);
          setActiveApplyId(null);
          setPollTimedOut(false);
          void refresh();
          return;
        }
      } catch (error) {
        if (cancelled) return;
        // 404: the job is gone (unknown id — the server may have been
        // rebuilt/migrated while the page was open). Nothing left to wait for:
        // stop rather than poll a dead id forever; a transient failure stays
        // live and the next tick retries it.
        if (error instanceof ApiError && error.status === 404) {
          clearStoredApplyJob(agentId);
          setFeedback(describeApplyError(error));
          setActiveApplyId(null);
          void refresh();
          return;
        }
      }
      if (!cancelled && Date.now() >= deadlineRef.current) {
        // Keep the stored id: the next reload (or this page's next round) can
        // still pick the outcome up — the hint only says the poll gave up.
        setPollTimedOut(true);
        setActiveApplyId(null);
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), APPLY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `refresh` only closes over the stable queryClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeApplyId, agentId]);

  const apply = useMutation({
    mutationFn: () => botContainerApi.apply(agentId),
    onSuccess: (result: BotApplyAccepted) => {
      if (result.applyId) {
        // The async answer (202): watch the job instead of trusting the body.
        // A POST that came back with an already-live job (the previous round
        // timed out and the user pressed again, or another tab queued it)
        // simply starts a fresh two-minute round for the same id.
        deadlineRef.current = Date.now() + APPLY_POLL_TIMEOUT_MS;
        storeApplyJob(agentId, result.applyId, Date.now());
        setPollTimedOut(false);
        setActiveApplyId(result.applyId);
        return;
      }
      // A pre-ASYNC-BOT-APPLY server answered synchronously with the outcome;
      // keep that path working (UI ships against both server generations).
      setFeedback(describeApplyOutcome(result.outcome ?? { kind: "error", message: "the server answered neither applyId nor outcome." }));
      void refresh();
    },
    onError: (error) => {
      setFeedback(describeApplyError(error));
      void refresh();
    },
    onSettled: () => setPosting(false),
  });

  const startApply = () => {
    setFeedback(null);
    setPollTimedOut(false);
    setPosting(true);
    apply.mutate();
  };

  return (
    <AgentCardContainerFieldsView
      value={value}
      onChange={onChange}
      unsaved={unsaved}
      status={statusQuery.data ?? null}
      statusError={
        statusQuery.isError
          ? statusQuery.error instanceof Error
            ? statusQuery.error.message
            : "The status request failed."
          : null
      }
      applying={posting || activeApplyId !== null}
      progress={posting || activeApplyId !== null}
      feedback={pollTimedOut && feedback === null ? { kind: "warn", message: APPLY_TIMEOUT_TEXT } : feedback}
      onApply={() => void startApply()}
      onRefresh={() => void refresh()}
    />
  );
}
