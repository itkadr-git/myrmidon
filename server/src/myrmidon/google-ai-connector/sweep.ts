// myrmidon(GOOGLE-AI-CONNECT-UI): the periodic bridge health sweep.
//
// Modelled on the Telegram notify error sweep: a timer tick probes the bridge
// health for every connected company through the service; when a company
// transitions into `stale`, the notify port asks the owner through the board's
// Telegram channel. A company that is not connected costs nothing. Failures of
// one company are logged and do not stop the others.
//
// Wiring: server/src/index.ts starts it next to the other myrmidon sweeps. It
// is a no-op while no company has a Google AI connection.

import type { GoogleAiConnectorService } from "./service.js";
import { logger } from "../../middleware/logger.js";

export const GOOGLE_AI_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_GOOGLE_AI_SWEEP_SEC";
const DEFAULT_SWEEP_INTERVAL_SEC = 900;
const MIN_SWEEP_INTERVAL_SEC = 60;
const MAX_SWEEP_INTERVAL_SEC = 86_400;

export function readGoogleAiSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GOOGLE_AI_SWEEP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SWEEP_INTERVAL_SEC || value > MAX_SWEEP_INTERVAL_SEC) {
    return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

/** What the stale transition says to the owner. Plain question, no jargon,
 * no secret material; the panel screen is the answer path. */
export function staleOwnerMessage(companyId: string): string {
  return [
    "Your Google AI Pro connection has expired.",
    "",
    "The signing-in cookies of your Google account stopped working on gemini.google.com,",
    "so agents cannot generate through your subscription until you reconnect.",
    "",
    "To fix it: open Company settings → Connections → Google AI Pro, export the cookies",
    "from the browser you stay signed in with, paste the JSON into the box and press Reconnect.",
    `(company ${companyId})`,
  ].join("\n");
}

export interface GoogleAiSweepDeps {
  service: GoogleAiConnectorService;
  /** Deliver the stale question to the owner's channel (Telegram in production). */
  notify?: (companyId: string, text: string) => Promise<void>;
  now?(): Date;
}

export interface GoogleAiSweepResult {
  companies: number;
  staleNow: number;
  notified: number;
}

/** One full pass over every connected company. */
export async function googleAiSweepOnce(deps: GoogleAiSweepDeps): Promise<GoogleAiSweepResult> {
  const companyIds = await deps.service.connectedCompanyIds();
  let staleNow = 0;
  let notified = 0;
  for (const companyId of companyIds) {
    try {
      const check = await deps.service.checkHealth(companyId, { kind: "system" });
      if (check.staleNow) {
        staleNow += 1;
        if (deps.notify) {
          await deps.notify(companyId, staleOwnerMessage(companyId));
          notified += 1;
        }
      }
    } catch (err) {
      logger.warn({ err, companyId }, "google-ai-connector health pass failed for one company");
    }
  }
  return { companies: companyIds.length, staleNow, notified };
}

/** Arm the timer; returns the stop function. The first pass runs one tick in. */
export function startGoogleAiSweep(deps: GoogleAiSweepDeps & { env?: NodeJS.ProcessEnv }): () => void {
  const tickMs = readGoogleAiSweepIntervalMs(deps.env ?? process.env);
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await googleAiSweepOnce(deps);
    } catch (err) {
      logger.error({ err }, "google-ai-connector sweep tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
