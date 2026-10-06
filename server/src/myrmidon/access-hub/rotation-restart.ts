// myrmidon(SEC1-C): rotation → restart wiring for the Access section.
//
// After an ssh key (or any access-hub typed secret) rotates, the agents with
// a binding on that secret must pick up the new value in their containers.
// The board already owns the whole restart path: the bot-container profile
// compiler resolves secret bindings into the container env, and the
// reconciler restarts the container through a maintenance window whenever
// the compiled profile changed (restart-hash). Part C only needs to NAME the
// agents that hold a binding on the secret — `applyBotContainerNow` does the
// drain/restart inside the window, and it is a no-op for agents that are not
// container bots. Nothing here invents a second restart mechanism.
//
// The binding lookup lives in routes.ts as the single implementation (the
// route that calls it queries the same `company_secret_bindings` rows that
// grant/revoke write); this module only builds the runtime adapter that
// connects those agent rows to the board's apply path.

import { applyBotContainerNow, type BotContainerAgent } from "../bot-containers/index.js";
import { getBotContainerRuntime } from "../bot-containers/routes-wiring.js";

/** Build the real runtime adapter the routes use in production. */
export function rotationRestartRuntime(
  env: NodeJS.ProcessEnv = process.env,
): { applyNow: (agent: BotContainerAgent) => Promise<{ kind: string }> } {
  return {
    applyNow: async (agent) => {
      // The startup wiring registered the single runtime the sweep and the
      // "Apply now" button share; a server without bot containers (flag off,
      // no scheduler) has none, and the rotation reports not_applicable.
      const runtime = getBotContainerRuntime();
      if (!runtime) {
        return { kind: "not_applicable" };
      }
      const outcome = await applyBotContainerNow(
        {
          agentId: agent.agentId,
          adapterType: agent.adapterType,
          adapterConfig: agent.adapterConfig ?? {},
        },
        runtime,
        // myrmidon(OPE-4789): a rotation restart is an explicit, rare event
        // (the operator rotated a secret) — it must not be answered by the
        // sweep's freshness reuse.
        { env, force: true },
      );
      return { kind: outcome.kind };
    },
  };
}
