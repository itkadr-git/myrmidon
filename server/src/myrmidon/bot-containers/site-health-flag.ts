// server/src/myrmidon/bot-containers/site-health-flag.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the one switch of the site health work. Everything T4 changes
// in what already existed (a draining site keeps its client, a draining site is reachable for a
// move) is tied to this switch, so without MYRMIDON_SITE_HEALTH=1 the board behaves as before.

import { isBotContainersEnabled } from "./agent-config.js";

export const SITE_HEALTH_ENV = "MYRMIDON_SITE_HEALTH";

export function isSiteHealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isBotContainersEnabled(env) && env[SITE_HEALTH_ENV]?.trim() === "1";
}

/**
 * Whether a registry site of this status may be talked to (a move reads from it, writes to it).
 * Active always; draining only with MYRMIDON_SITE_HEALTH, because only then the monitor drains
 * sites and the return pass has to reach one. Everything else never.
 */
export function siteStatusIsReachable(status: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return status === "active" || (status === "draining" && isSiteHealthEnabled(env));
}
