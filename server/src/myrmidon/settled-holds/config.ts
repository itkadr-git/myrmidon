// myrmidon(L2): setting for whether a settled "do not replay" recovery hold
// should still block an explicitly authorized wake. See
// docs/myrmidon/SETTINGS.md (MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES).

import { liveStrandedSettings } from "../runs-queue-settings/live.js";

/**
 * false (the default) is our behavior: a closed (resolved/cancelled)
 * recovery action's `evidence.automaticRecovery.replay === "blocked"`
 * disposition blocks only the heartbeat scheduler's automatic retry of the
 * exact stopped turn, not a new, explicitly authorized wake. Set
 * MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES=1 to restore the vendor's
 * original behavior, where that disposition blocks every wake.
 */
export function settledHoldsBlockExplicitWakes(): boolean {
  // OPE-4096: resolves live (UI value → env forced override → default false);
  // the explicit env value always wins, so `=1` still restores the vendor behavior.
  return liveStrandedSettings(process.env).settledHoldsBlockExplicitWakes;
}
