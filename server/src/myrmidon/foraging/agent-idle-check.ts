// server/src/myrmidon/foraging/agent-idle-check.ts
//
// myrmidon(1.6.2-FORAGING-IDLE-GATE): the "только в простое" rule of the pass.
//
// The product rule: learning happens only in the idle time of a role, work
// always comes first. Two halves live here so the rule reads as one thing:
//
//   - `planIdleGate` is pure. Given whether the rule is on, the roles the
//     registry has sources for and the roles that currently have work, it
//     answers which roles this pass may read and why it was held back. No
//     database, no clock, so the tests pin it without a container.
//   - `createDbRoleBusyProbe` is the single query behind "this role has work":
//     an agent of the company with that role and a run that is queued or
//     running. Nothing else counts as work — a paused or finished agent is idle.
//
// The rule never blocks a role that has no sources, and it only ever REMOVES a
// role from a pass; a role with no work in flight is read exactly as before.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { ForagingSkipReason } from "@paperclipai/shared";

/** The run statuses that mean "an agent of this role has work in flight". */
export const FORAGING_BUSY_RUN_STATUSES = ["queued", "running"] as const;

export interface IdleGatePlan {
  /** The roles this pass may read now, in the order the registry listed them. */
  readableRoles: string[];
  /** The roles the rule kept out of this pass. */
  blockedRoles: string[];
  /** Set only when the rule held the whole pass back (every role had work). */
  skipReason: ForagingSkipReason | null;
}

/**
 * Plans one pass against the idle-only rule. With the rule off the plan is the
 * registry itself (nothing is held back). With the rule on, a role that has
 * work is blocked, and the pass reports `agents_busy_for_role` only when that
 * leaves it with nothing to read — a partial pass still runs and still records
 * the blocked roles, so the screen can show both facts.
 */
export function planIdleGate(input: {
  idleOnly: boolean;
  roles: readonly string[];
  busyRoles: readonly string[];
}): IdleGatePlan {
  const roles = [...new Set(input.roles)];
  if (!input.idleOnly || roles.length === 0) {
    return { readableRoles: roles, blockedRoles: [], skipReason: null };
  }
  const busy = new Set(input.busyRoles);
  const blockedRoles = roles.filter((role) => busy.has(role));
  const readableRoles = roles.filter((role) => !busy.has(role));
  return {
    readableRoles,
    blockedRoles,
    skipReason: readableRoles.length === 0 ? "agents_busy_for_role" : null,
  };
}

/** Reads which roles of a company have work in flight. Injected, so the pass is testable. */
export interface RoleBusyProbe {
  /** The subset of `roles` that has at least one agent with work in flight. */
  busyRoles(companyId: string, roles: readonly string[]): Promise<string[]>;
}

/** The probe used when no database is wired: no role is ever busy. */
export const nullRoleBusyProbe: RoleBusyProbe = {
  async busyRoles() {
    return [];
  },
};

/**
 * The database probe: one distinct query over the agents of the company and
 * their runs. `queued` and `running` are the two statuses that mean work is
 * happening or about to happen; everything else is idle time a pass may use.
 */
export function createDbRoleBusyProbe(db: Db): RoleBusyProbe {
  return {
    async busyRoles(companyId, roles) {
      const wanted = [...new Set(roles)].filter((role) => role.trim() !== "");
      if (wanted.length === 0) return [];
      const rows = await db
        .selectDistinct({ role: agents.role })
        .from(agents)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(agents.companyId, companyId),
            inArray(agents.role, wanted),
            inArray(heartbeatRuns.status, [...FORAGING_BUSY_RUN_STATUSES]),
          ),
        );
      return rows.map((row) => row.role);
    },
  };
}