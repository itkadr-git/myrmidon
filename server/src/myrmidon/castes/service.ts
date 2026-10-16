// server/src/myrmidon/castes/service.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): the company caste directory service.
//
// Owns these rules:
//
//  - First read of a company seeds the 12 built-ins (idempotent; store).
//  - POST creates a caste; a duplicate key in the company is a 409.
//  - PATCH may change every mutable field (names, color, icon, default model,
//    swarm flag, task ceiling) — never `key`, never `builtIn`. A body that
//    tries to change either is a 400.
//  - DELETE without agents on the caste removes it (204). With agents:
//    without `reassignTo` — 409 ("agents are on the caste"); with it — the
//    agents of the company with `role = key` move to `reassignTo` and the
//    caste is deleted, in ONE transaction. `reassignTo` must exist in the
//    company's directory and differ from the deleted key, else 400.
//  - The role queue is built from `agents.role` (roleQueueRows of 1.6-SWARM),
//    so reassigned agents carry their assigned tasks into the new caste's
//    queue as a transactional consequence — no queue rewrite is needed here.
//  - Every mutation writes one activity-log entry (create / update / remove /
//    remove_with_reassign).
//
// Everything injectable arrives through CasteServiceDeps so the suite runs the
// real service with fakes (the real wiring is wiring.ts).

import { and, eq, sql } from "drizzle-orm";
import {
  type CreateCasteInput,
  type CasteView,
  type PatchCasteInput,
} from "@paperclipai/shared";
import { agents, agentCastes, type Db } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../../errors.js";
import { createCasteStore, type CasteStore } from "./store.js";

export interface CasteServiceDeps {
  db: Db;
  store?: CasteStore;
  now?(): Date;
}

/** Activity-log entry of one caste mutation. */
export interface CasteActivityEntry {
  companyId: string;
  action:
    | "caste_created"
    | "caste_updated"
    | "caste_removed"
    | "caste_removed_reassigned";
  casteKey: string;
  details: Record<string, unknown>;
}

export function createCasteService(deps: CasteServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? createCasteStore({ db: deps.db, now });

  type Row = Awaited<ReturnType<typeof store.findCaste>>;

  function view(row: NonNullable<Row>): CasteView {
    return {
      key: row.key,
      nameEn: row.nameEn,
      nameRu: row.nameRu,
      description: row.description,
      color: row.color,
      icon: row.icon,
      defaultModel: row.defaultModel,
      swarmEligible: row.swarmEligible,
      maxActiveTasks: row.maxActiveTasks,
      builtIn: row.builtIn,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function loadCaste(companyId: string, key: string) {
    const row = await store.findCaste(companyId, key);
    if (!row) throw notFound(`Caste "${key}" not found in this company`);
    return row;
  }

  /**
   * Lists the company's castes, seeding the 12 built-ins on the first read.
   * Read fresh from the database on every call (owner's liveness criterion).
   */
  async function listCastes(companyId: string): Promise<CasteView[]> {
    const rows = await store.listCastes(companyId);
    return rows.map(view);
  }

  /** POST: creates a caste; a duplicate key in the company is a 409. */
  async function createCaste(input: {
    companyId: string;
    body: CreateCasteInput;
    activity?: (entry: CasteActivityEntry) => Promise<void> | void;
  }): Promise<CasteView> {
    const row = await store.insertCaste({
      companyId: input.companyId,
      key: input.body.key,
      nameEn: input.body.nameEn,
      nameRu: input.body.nameRu ?? null,
      description: input.body.description ?? null,
      color: input.body.color ?? "gray",
      icon: input.body.icon ?? null,
      defaultModel: input.body.defaultModel ?? null,
      swarmEligible: input.body.swarmEligible ?? true,
      maxActiveTasks: input.body.maxActiveTasks ?? null,
      builtIn: false,
    });
    await input.activity?.({
      companyId: input.companyId,
      action: "caste_created",
      casteKey: row.key,
      details: { nameEn: row.nameEn, builtIn: false },
    });
    return view(row);
  }

  /**
   * PATCH: mutable fields only. `key` and `builtIn` are immutable — a body
   * that carries either is a 400 (the route schema already strips unknown
   * fields, so an explicit `key`/`builtIn` means the caller tried to change
   * it and must be told).
   *
   * `isDefault` (1.6.5 F-26 T3) is the settings radio: true moves the flag from
   * the previous default to this caste in one transaction (the partial unique
   * index allows exactly one per company). false on a non-default row is a
   * no-op; false on the default itself is a 409 — a company always keeps a
   * default, so the caller must name the next one, not clear the field.
   */
  async function updateCaste(input: {
    companyId: string;
    key: string;
    body: PatchCasteInput & { key?: unknown; builtIn?: unknown };
    activity?: (entry: CasteActivityEntry) => Promise<void> | void;
  }): Promise<CasteView> {
    const body = input.body as Record<string, unknown>;
    if ("key" in body) {
      throw badRequest("caste key is immutable", { code: "caste_key_immutable" });
    }
    if ("builtIn" in body) {
      throw badRequest("builtIn cannot be changed", { code: "caste_builtin_immutable" });
    }
    const current = await loadCaste(input.companyId, input.key);

    const patch: Record<string, unknown> = {};
    if (input.body.nameEn !== undefined) patch.nameEn = input.body.nameEn;
    if (input.body.nameRu !== undefined) patch.nameRu = input.body.nameRu;
    if (input.body.description !== undefined) patch.description = input.body.description;
    if (input.body.color !== undefined) patch.color = input.body.color;
    if (input.body.icon !== undefined) patch.icon = input.body.icon;
    if (input.body.defaultModel !== undefined) patch.defaultModel = input.body.defaultModel;
    if (input.body.swarmEligible !== undefined) patch.swarmEligible = input.body.swarmEligible;
    if (input.body.maxActiveTasks !== undefined) {
      patch.maxActiveTasks = input.body.maxActiveTasks;
    }
    const wantsDefault = input.body.isDefault;
    if (Object.keys(patch).length === 0 && wantsDefault === undefined) {
      throw badRequest("no mutable fields in the patch", { code: "caste_patch_empty" });
    }
    if (wantsDefault === false && current.isDefault) {
      throw conflict(
        "a company always keeps a default caste; set another caste as default first",
        { code: "caste_default_required" },
      );
    }

    // The flag first, in its own transaction (clear the old default, then set
    // the new one): the partial unique index forbids two defaults even for the
    // instant between two updates of the same statement batch.
    if (wantsDefault === true) {
      await store.setDefaultCaste(input.companyId, input.key);
    }
    const row =
      Object.keys(patch).length > 0
        ? await store.updateCaste(input.companyId, input.key, patch)
        : await loadCaste(input.companyId, input.key);
    const fields = Object.keys(patch);
    if (wantsDefault === true) fields.push("isDefault");
    await input.activity?.({
      companyId: input.companyId,
      action: "caste_updated",
      casteKey: row.key,
      details: wantsDefault === true ? { fields, becameDefault: true } : { fields },
    });
    return view(row);
  }

  /**
   * DELETE (annex 03.10 + 1.6.5 F-26 T3):
   *  - caste with no agents and no default flag — removed (204), reassignTo
   *    ignored;
   *  - caste with agents and no reassignTo — 409 "agents are on the caste";
   *  - caste with agents and reassignTo — same transaction moves the agents
   *    with `role = key` to the target caste and deletes the row (204);
   *  - the DEFAULT caste needs `reassignTo` even when no agent sits on it: the
   *    flag moves to the target in the same transaction, so a company never
   *    loses its default (409 caste_default_requires_reassign otherwise).
   * `reassignTo` must exist in the company's directory and differ from the
   * deleted key, else 400.
   */
  async function removeCaste(input: {
    companyId: string;
    key: string;
    reassignTo?: string;
    activity?: (entry: CasteActivityEntry) => Promise<void> | void;
  }): Promise<void> {
    const current = await loadCaste(input.companyId, input.key);
    const wasDefault = current.isDefault;
    const affected = await countAgentsOnCaste(input.companyId, input.key);

    if (wasDefault && !input.reassignTo) {
      throw conflict(
        "the default caste cannot be removed without reassignTo; the default flag moves to the target",
        { code: "caste_default_requires_reassign", affected },
      );
    }

    if (affected === 0 && !wasDefault) {
      const removed = await store.deleteCaste(input.companyId, input.key);
      if (!removed) throw notFound(`Caste "${input.key}" not found in this company`);
      await input.activity?.({
        companyId: input.companyId,
        action: "caste_removed",
        casteKey: input.key,
        details: { reassignedAgents: 0 },
      });
      return;
    }

    if (!input.reassignTo) {
      throw conflict("agents are on the caste; reassignTo is required", {
        code: "caste_has_agents",
        affected,
      });
    }
    if (input.reassignTo === input.key) {
      throw badRequest("reassignTo must differ from the deleted caste key", {
        code: "caste_reassign_same",
      });
    }
    const target = await store.findCaste(input.companyId, input.reassignTo);
    if (!target) {
      throw badRequest(`reassignTo caste "${input.reassignTo}" does not exist in this company`, {
        code: "caste_reassign_target_missing",
      });
    }

    // One transaction: reassign the agents, then drop the caste. The role
    // queue is derived from agents.role (roleQueueRows), so the moved agents'
    // assigned tasks follow into the target caste's queue by construction.
    // The row delete happens here too — same atomic unit — so no separate
    // delete below.
    await deps.db.transaction(async (tx) => {
      if (wasDefault) {
        // Clear the old default before flagging the target: the partial unique
        // index would otherwise refuse the second default row.
        await tx
          .update(agentCastes)
          .set({ isDefault: false, updatedAt: now() })
          .where(and(eq(agentCastes.companyId, input.companyId), eq(agentCastes.isDefault, true)));
      }
      await tx
        .update(agents)
        .set({ role: input.reassignTo!, updatedAt: now() })
        .where(and(eq(agents.companyId, input.companyId), eq(agents.role, input.key)));
      if (wasDefault) {
        await tx
          .update(agentCastes)
          .set({ isDefault: true, updatedAt: now() })
          .where(
            and(
              eq(agentCastes.companyId, input.companyId),
              eq(agentCastes.key, input.reassignTo!),
            ),
          );
      }
      await tx
        .delete(agentCastes)
        .where(and(eq(agentCastes.companyId, input.companyId), eq(agentCastes.key, input.key)));
    });

    await input.activity?.({
      companyId: input.companyId,
      action: "caste_removed_reassigned",
      casteKey: input.key,
      details: {
        reassignTo: input.reassignTo,
        reassignedAgents: affected,
        ...(wasDefault ? { defaultMovedTo: input.reassignTo } : {}),
      },
    });
  }

  function countAgentsOnCaste(companyId: string, key: string): Promise<number> {
    return deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, key)))
      .then((rows) => rows[0]?.count ?? 0);
  }

  return {
    listCastes,
    createCaste,
    updateCaste,
    removeCaste,
  };
}

export type CasteService = ReturnType<typeof createCasteService>;
