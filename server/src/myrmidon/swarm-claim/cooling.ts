// server/src/myrmidon/swarm-claim/cooling.ts
//
// myrmidon(1.6.5 OPE-6608, review item 1): the cooling of a task as the swarm
// matcher asks it — an adapter, not a rule.
//
// The product has ONE cooling rule: `isIssueCoolingDown` of
// `../wake-task-guard.ts` (F-26 T5, design §4.3) — the exponential window after
// the stale automatic runs of a task, lifted by a change of the task by a person
// or another agent, tuned by `general.swarm` (`cooldownBaseMin`,
// `cooldownCeilingHours`). Idle pickup asks it, the cooling list of the swarm
// panel shows it, and the matcher asks it here. This file only adapts the call:
// the matcher works per task and wants a yes/no, the rule takes the company,
// the settings and the clock and answers a status.

import type { Db } from "@paperclipai/db";
import type { SwarmSettings } from "@paperclipai/shared";
import { isIssueCoolingDown, readSwarmSettings } from "../wake-task-guard.js";

/** The settings of the cooling window the rule reads (`general.swarm`). */
export type SwarmCoolingSettings = Pick<SwarmSettings, "cooldownBaseMin" | "cooldownCeilingHours">;

/**
 * True while the task waits out its cooling window. `settings` is the pass's
 * reading of `general.swarm`; absent, it is read here (one settings read). Like
 * the rule itself, a read failure answers "not cooling": a pairing must never
 * die on the guard.
 */
export async function swarmTaskCoolingDown(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    now: Date;
    settings?: SwarmCoolingSettings;
  },
): Promise<boolean> {
  const settings = input.settings ?? (await readSwarmSettings(db));
  const status = await isIssueCoolingDown(db, input.companyId, input.issueId, settings, input.now);
  return status.cooling;
}

/** The pass's reading of the cooling settings (`general.swarm`); never throws. */
export function readSwarmCoolingSettings(db: Db): Promise<SwarmCoolingSettings> {
  return readSwarmSettings(db);
}
