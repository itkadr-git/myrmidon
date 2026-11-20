import { randomUUID } from "node:crypto";
import type { Db } from "@myrmidon/db";
import { processNativeFinalizationRequest } from "./native-finalization-request-worker.js";

/** Periodically recover durable requests without overlapping passes in this process. */
export function startNativeFinalizationRequestScheduler(input: {
  db: Db;
  onError: (error: unknown) => void;
  intervalMs?: number;
  processRequest?: typeof processNativeFinalizationRequest;
}) {
  const worker = `native-finalization-recovery:${randomUUID()}`;
  const processRequest = input.processRequest ?? processNativeFinalizationRequest;
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      // Bound each pass so a busy outbox cannot monopolize the worker.
      for (let i = 0; i < 20 && !stopped; i++) {
        if (!(await processRequest(input.db, worker, new Date(), 60_000))) break;
      }
    })().catch(input.onError).finally(() => { active = null; });
  };
  const timer = setInterval(tick, input.intervalMs ?? 10_000);
  timer.unref?.();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
