// Run queue priority (myrmidon 1.6.5 RUN-PRIORITY part B): the one line under
// a queued run's card — "Queue position 3 of 12, waiting: the host CPU
// ceiling is closed". The data has two sources, merged:
//
//   1. metadata the server already carries on the comment/run
//      (`queuePosition`, `queueLength`, `waitReason` — the same contextSnapshot
//      token the admission sweep writes); the core may publish them.
//   2. GET /api/heartbeat-runs/:runId — the queued run's own waitReason (the core publishes no rank).
//
// When neither answers — the run is not readable, or it left the queue — the
// component renders nothing. It never shows a position the UI made up.
//
// No react-query here on purpose: the chat thread renders this per-message
// outside any provider guarantee of ours, so it polls with a plain effect.
import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import {
  describeRunQueuePosition,
  runQueueApi,
  type RunQueuePosition,
} from "./runQueueApi";

/** The metadata shape the server may attach to a queued comment/run. */
export function runQueuePositionFromMetadata(
  runId: string | null | undefined,
  custom: Record<string, unknown>,
): RunQueuePosition | null {
  if (!runId) return null;
  const position = typeof custom.queuePosition === "number" ? custom.queuePosition : null;
  const queueLength = typeof custom.queueLength === "number" ? custom.queueLength : null;
  const waitReason = typeof custom.waitReason === "string" ? custom.waitReason : null;
  const queuedAt = typeof custom.queuedAt === "string" ? custom.queuedAt : null;
  if (position === null && queueLength === null && waitReason === null) return null;
  return { runId, position, queueLength, waitReason, queuedAt };
}

/** Merge metadata over the served position: metadata wins per field. */
export function mergeRunQueuePosition(
  fromMetadata: RunQueuePosition | null,
  served: RunQueuePosition | null,
): RunQueuePosition | null {
  if (fromMetadata && served) {
    return {
      runId: served.runId,
      position: fromMetadata.position ?? served.position,
      queueLength: fromMetadata.queueLength ?? served.queueLength,
      waitReason: fromMetadata.waitReason ?? served.waitReason,
      queuedAt: fromMetadata.queuedAt ?? served.queuedAt,
    };
  }
  return fromMetadata ?? served ?? null;
}

const POLL_MS = 30_000;

export function RunQueueWaitLine({
  runId,
  metadata,
}: {
  /** The queued run this line describes (queueTargetRunId on the card). */
  runId: string | null;
  /** Server metadata already carried on the comment, when present. */
  metadata?: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  const fromMetadata = runQueuePositionFromMetadata(runId, metadata ?? {});
  const [served, setServed] = useState<RunQueuePosition | null>(null);
  // Fetch while the position is unknown — an old server sends no queue fields
  // on the comment, and the core may publish the rank either in the
  // comment metadata; otherwise the run itself is read. A wait reason alone does
  // not stop the fetch: the position may still arrive.
  const needsFetch = Boolean(runId) && (fromMetadata === null || fromMetadata.position === null);
  useEffect(() => {
    if (!runId || !needsFetch) return;
    let stopped = false;
    const load = async () => {
      try {
        const next = await runQueueApi.position(runId);
        if (!stopped) setServed(next);
      } catch {
        // A failing read is "no data yet" for a badge line: the card without
        // the line beats an error thrown into the thread.
        if (!stopped) setServed(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, needsFetch]);

  const line = describeRunQueuePosition(mergeRunQueuePosition(fromMetadata, served), t);
  if (!line) return null;
  return (
    <div
      className="mt-1 px-1 text-(length:--text-micro) text-amber-800/90 dark:text-amber-200/90"
      data-testid="run-queue-wait-line"
    >
      {line}
    </div>
  );
}
