/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
    /**
     * Reference-only entry. The envelope dropped this body to stay inside its
     * character budget; identity and freshness stay comparable through `id`,
     * `updatedAt`, `deleted` and the author fields. Read the body from the task
     * thread when the text is needed.
     */
    bodyOmitted?: boolean;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  /**
   * The run this wake continues (the handoff/retry source, else the latest
   * finished run of the agent on the task) and how it ended. A fresh-session
   * agent reads this instead of the previous run's messages.
   */
  previousRun?: { runId: string; status: string } | null;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  coverage: {
    /**
     * `summary_only` and `recent_messages` are set by the wake renderer when a
     * card's `wakeHistory` mode shortens the message list.
     */
    kind: "full_task_history" | "task_history_delta" | "summary_only" | "recent_messages";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}

/**
 * References that point at the wake payload of a run instead of copying it.
 * The continuation row keeps these links so a reader can rebuild the wake
 * reference without a second copy of `paperclipWake`.
 */
export interface ExecutionContinuationWakeLinks {
  runId: string;
  originCommentIds: string[];
  sourceRunId: string | null;
  interactionId: string | null;
}
