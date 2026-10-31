// server/src/myrmidon/bot-containers/fleet-move-maintenance.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): the maintenance window (R3) of a fleet move, on the
// reconciler's per-agent port. `enter` returns only when the bot has no run in flight, so
// the snapshot is taken of a quiet datadir and no run is started twice; the window is the
// admission gate that keeps new runs queued until `exit`.

import type { BotMaintenancePort } from "./reconciler.js";

/** The window's reason. It must NOT start with the bot-profile prefix (maintenance/domain.ts
 *  BOT_PROFILE_WINDOW_REASON_PREFIX): windows with that prefix let chat wakes through. */
export const FLEET_MOVE_WINDOW_REASON = "fleet move of the bot between sites";

const DEFAULT_DRAIN_TIMEOUT_SEC = 300;
const POLL_INTERVAL_MS = 2_000;
/** After the drain timeout R3 interrupts the runs left; this is the slack for its tick. */
const DRAIN_GRACE_MS = 60_000;

export interface FleetMoveMaintenanceOptions {
  drainTimeoutSec?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function fleetMoveMaintenance(port: BotMaintenancePort, options: FleetMoveMaintenanceOptions = {}) {
  const drainTimeoutSec = options.drainTimeoutSec ?? DEFAULT_DRAIN_TIMEOUT_SEC;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  return {
    /** Opens the agent's window and waits until it is `on` with no run in flight. A window
     *  someone else opened is not ours to end, so the move does not start inside it. */
    async enter(botKey: string): Promise<void> {
      const entered = await port.enter(botKey, FLEET_MOVE_WINDOW_REASON, drainTimeoutSec);
      if (!entered.owned) {
        throw new Error(
          `the agent is already under a maintenance window opened by someone else; finish or close it before moving the bot`,
        );
      }
      const deadline = now() + drainTimeoutSec * 1000 + DRAIN_GRACE_MS;
      try {
        for (;;) {
          const view = await port.status(botKey);
          if (view.state === "on" && view.runningRuns === 0) return;
          if (now() >= deadline) {
            throw new Error(`the agent still has ${view.runningRuns} run(s) in flight (window ${view.state}) after the drain timeout`);
          }
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        // The move does not start, so nobody else will close the window it opened.
        await port.exit(botKey, `${FLEET_MOVE_WINDOW_REASON}: not started`).catch(() => undefined);
        throw err;
      }
    },

    /** Closes the window; a window that is already gone is not an error (resume after a restart). */
    async exit(botKey: string): Promise<void> {
      const view = await port.status(botKey);
      if (view.state === "off") return;
      await port.exit(botKey, `${FLEET_MOVE_WINDOW_REASON}: finished`);
    },
  };
}
