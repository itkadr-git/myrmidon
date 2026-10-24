// server/src/myrmidon/knowledge/routes.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-2): the REST surface of the knowledge module.
//
//   GET    /api/myrmidon/companies/:companyId/knowledge/search
//   GET    /api/myrmidon/companies/:companyId/knowledge/items
//   GET    /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug
//   GET    /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/revisions
//   GET    /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/revisions/:revisionId
//   GET    /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/backlinks
//   POST   /api/myrmidon/companies/:companyId/knowledge/items
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/draft
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/submit
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/publish
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/approve
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/rollback
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/archive
//   POST   /api/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/supersede
//   POST   /api/myrmidon/companies/:companyId/knowledge/propose
//   GET    /api/myrmidon/companies/:companyId/knowledge/suggestions
//   POST   /api/myrmidon/companies/:companyId/knowledge/suggestions/:id/accept
//   POST   /api/myrmidon/companies/:companyId/knowledge/suggestions/:id/decline
//   GET    /api/myrmidon/companies/:companyId/knowledge/export
//   POST   /api/myrmidon/companies/:companyId/knowledge/import
//
// People and agents reach knowledge through ONE service with ONE set of rules
// (§6). The gates, in order:
//
//   1. Company access (assertCompanyAccess) — the same rule as the rest of the
//      myrmidon API. Cross-company ids are indistinguishable from missing.
//   2. `permissions.toolAccess` (S6): an agent caller needs a tool grant
//      (`knowledge_*` or the company-local route path); a board user passes.
//   3. Injection scan on the write payload (guardrails/injection): a flagged
//      body is refused 422 before the store sees it (§3.4 «сканер на запись»).
//   4. Autonomy matrix (§3.6): `knowledge_publish` outside the `auto`
//      sections parks an approval card; `rule_approve` by an agent is refused
//      outright (тест П4), whatever the matrix or the agent's instructions
//      say. `knowledge_external_publish` has no route — it is a tool-gateway
//      action class, not a board API call.
//   5. The domain gates of K-1 (approvalRequired/approverKind, suggestion
//      state machine) still apply on top.

import express, { Router, type Request, type Response } from "express";
import type { Db } from "@myrmidon/db";
import {
  knowledgeApproveSchema,
  knowledgeCreateItemSchema,
  knowledgeDraftSchema,
  knowledgeListQuerySchema,
  knowledgeProposeSchema,
  knowledgePublishSchema,
  knowledgeRollbackSchema,
  knowledgeSearchQuerySchema,
  knowledgeSuggestionDecisionSchema,
  knowledgeSupersedeSchema,
  KNOWLEDGE_APPROVAL_REQUIRED_CODE,
  KNOWLEDGE_INJECTION_FLAGGED_CODE,
  KNOWLEDGE_RULE_APPROVE_FORBIDDEN_CODE,
  KNOWLEDGE_TOOL_ACCESS_DENIED_CODE,
  isKnowledgeAutoSection,
  defaultAutonomyMatrix,
  resolveAutonomy,
} from "@myrmidon/shared";
import type { AutonomyMatrix } from "@myrmidon/shared";
import { HttpError, forbidden, notFound, unprocessable } from "../../errors.js";
import { assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
import { approverKindFromRequest } from "../approver-kind.js";
import { assertRuleWriteGrade, builtinCasteSensitivity, type CasteSensitivityResolver } from "../rule-grade.js";
import { resolveCasteSensitivity } from "../caste-sensitivity.js";
import { KnowledgeDomainError } from "./domain.js";
import type { KnowledgeItemStatus, KnowledgeKind } from "./domain.js";
import { createKnowledgeModule, type KnowledgeModule } from "./service.js";
import { guardrailsInjectionEnabled, injectionScoreThreshold, scanForInjection } from "../guardrails/injection.js";
import { dbAutonomyStore, agentRoleFromDb } from "../autonomy/store.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface KnowledgeRoutesDeps {
  /** Bind the store to the path company. Tests inject a stub module. */
  moduleFor(companyId: string): KnowledgeModule;
  /**
   * The autonomy matrix resolver. Production reads `dbAutonomyStore(db)`;
   * tests inject a fixed matrix. Returns null when the matrix store is
   * unavailable — the route then falls back to the safe defaults.
   */
  matrixFor?(companyId: string): Promise<AutonomyMatrix | null>;
  /** An agent caller needs a tool grant; production wires the tool-access policy. */
  agentHasToolAccess?(input: {
    agentId: string;
    companyId: string;
    toolName: string;
  }): Promise<boolean>;
  /**
   * The agent's matrix role (§3.6 caste key). Production derives it from the
   * `agents` table via `agentRoleFromDb`; tests inject a fixed role.
   */
  roleForAgent?(agentId: string): Promise<string | null>;
  /** Record a parked publish as an approval card (tool_action_requests). */
  parkPublishForApproval?(input: {
    companyId: string;
    agentId: string | null;
    actorLabel: string;
    itemId: string;
    itemSlug: string;
    revisionId: string | null;
    toolName: string;
  }): Promise<{ actionRequestId: string | null }>;
  /**
   * The company's caste directory (which castes are sensitive) for the rule
   * grade check. Production reads the database; without it the built-in
   * sensitive castes apply.
   */
  casteSensitivity?: CasteSensitivityResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function toHttpError(err: unknown): unknown {
  if (err instanceof KnowledgeDomainError) {
    return new HttpError(err.status, err.message, { code: err.code });
  }
  return err;
}

function itemIdOrSlug(req: Request): string {
  const raw = req.params.idOrSlug;
  return Array.isArray(raw) ? raw.join("/") : (raw as string | undefined) ?? "";
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function knowledgeRoutes(deps: KnowledgeRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const threshold = injectionScoreThreshold(env);
  const injectionOn = guardrailsInjectionEnabled(env);

  function companyOf(req: Request): string {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  function actorOf(req: Request) {
    const info = getActorInfo(req);
    return {
      actorType: (info.actorType === "agent" ? "agent" : info.actorType === "user" ? "user" : "system") as
        | "agent"
        | "user"
        | "system",
      actorId: info.actorId,
      agentId: info.actorType === "agent" ? (info.agentId ?? null) : null,
      label: `${info.actorType}:${info.actorId ?? "unknown"}`,
    };
  }

  function assertApproverAuthority(req: Request, companyId: string, approverKind: string | null): void {
    const actor = req.actor;
    if (actor.type !== "board") {
      throw forbidden("Only a board user may approve a rule.", { code: "approver_authority_required" });
    }
    if (approverKind === null) {
      throw forbidden("This user has no active approver membership in the company.", { code: "approver_authority_required" });
    }
    const membership = actor.memberships?.find((entry) => entry.companyId === companyId && entry.status === "active");
    const authorized = approverKind === "owner"
      ? actor.source === "local_implicit" || membership?.membershipRole === "owner"
      : approverKind === "adm" || approverKind === "admin"
        ? actor.isInstanceAdmin === true || membership?.membershipRole === "admin"
        : approverKind === "operator"
          ? membership?.membershipRole === "operator" || membership?.membershipRole === "member"
          : false;
    if (!authorized) {
      throw forbidden(`This user is not authorized to approve as ${approverKind}.`, { code: "approver_authority_required" });
    }
  }

  /** Gate 2: an agent caller needs a tool grant; a board user passes. */
  async function assertKnowledgeToolAccess(req: Request, toolName: string): Promise<void> {
    const actor = actorOf(req);
    if (actor.actorType !== "agent") return;
    const allowed = deps.agentHasToolAccess
      ? await deps.agentHasToolAccess({ agentId: actor.agentId ?? actor.actorId ?? "", companyId: companyOf(req), toolName })
      : false;
    if (!allowed) {
      throw forbidden("knowledge access requires a tool grant (permissions.toolAccess)", {
        code: KNOWLEDGE_TOOL_ACCESS_DENIED_CODE,
      });
    }
  }

  /** Gate 3: injection scan on the write payload. */
  function assertCleanWrite(payload: string, field: string): void {
    if (!injectionOn) return;
    const scan = scanForInjection(payload, threshold);
    if (scan.flagged) {
      throw unprocessable(
        `${field} matched the injection guardrails (score ${scan.score.toFixed(2)}: ${scan.matched.join(", ")}). Refused before write.`,
        { code: KNOWLEDGE_INJECTION_FLAGGED_CODE, field },
      );
    }
  }

  /**
   * Gate 4: `knowledge_publish`. An `auto` section resolves to `allowed`;
   * anything else is `approval_required` by the safe default, and a parked
   * publish records an approval card. A board user always publishes.
   */
  async function assertPublishAllowed(
    req: Request,
    companyId: string,
    item: { id: string; slug: string; folderPath: string; kind: string },
    revisionId: string | null,
  ): Promise<void> {
    const actor = actorOf(req);
    if (actor.actorType !== "agent") return;
    if (isKnowledgeAutoSection(item.folderPath)) return;
    const agentId = actor.agentId ?? "";
    const stored = deps.matrixFor ? await deps.matrixFor(companyId) : null;
    const matrix = stored ?? defaultAutonomyMatrix();
    const role = deps.roleForAgent ? await deps.roleForAgent(agentId) : null;
    const verdict = resolveAutonomy(role, "knowledge_publish", matrix, agentId);
    if (verdict === "forbidden") {
      throw forbidden("knowledge_publish is forbidden for this actor by the autonomy matrix", {
        code: "autonomy_forbidden",
      });
    }
    if (verdict === "approval_required") {
      const card = deps.parkPublishForApproval
        ? await deps.parkPublishForApproval({
            companyId,
            agentId: actor.agentId,
            actorLabel: actor.label,
            itemId: item.id,
            itemSlug: item.slug,
            revisionId,
            toolName: "knowledge_publish",
          })
        : null;
      const err = new HttpError(
        409,
        `knowledge_publish outside the auto sections requires approval. Card ${card?.actionRequestId ?? "(unavailable)"} parked.`,
        { code: KNOWLEDGE_APPROVAL_REQUIRED_CODE, actionRequestId: card?.actionRequestId ?? null },
      );
      throw err;
    }
  }

  /**
   * Gate 4c: a bulk import can land published pages of any section (rules
   * included) in one call, so an agent passes only when the autonomy matrix
   * says `allowed` for `knowledge_publish`; the safe default
   * (`approval_required`) refuses with 409, `forbidden` with 403. A board user
   * always imports.
   */
  async function assertBulkImportAllowed(req: Request, companyId: string): Promise<void> {
    const actor = actorOf(req);
    if (actor.actorType !== "agent") return;
    const agentId = actor.agentId ?? "";
    const stored = deps.matrixFor ? await deps.matrixFor(companyId) : null;
    const matrix = stored ?? defaultAutonomyMatrix();
    const role = deps.roleForAgent ? await deps.roleForAgent(agentId) : null;
    const verdict = resolveAutonomy(role, "knowledge_publish", matrix, agentId);
    if (verdict === "forbidden") {
      throw forbidden("knowledge import is forbidden for this actor by the autonomy matrix", {
        code: "autonomy_forbidden",
      });
    }
    if (verdict === "approval_required") {
      throw new HttpError(409, "knowledge import by an agent requires approval: ask a board user to import the tree.", {
        code: KNOWLEDGE_APPROVAL_REQUIRED_CODE,
        actionRequestId: null,
      });
    }
  }

  /** Gate 4b: `rule_approve` by an agent is forbidden, whatever the matrix says. */
  function assertRuleApproveAllowed(req: Request, itemKind: string): void {
    const actor = actorOf(req);
    if (actor.actorType === "agent" && itemKind === "rule") {
      throw forbidden(
        "rule_approve is forbidden for agents (тест П4): a rule changes what every agent of a caste is told, only the human approves one.",
        { code: KNOWLEDGE_RULE_APPROVE_FORBIDDEN_CODE },
      );
    }
  }

  /** Load the item for a mutation; 404 when missing (the store's `get` returns null). */
  async function loadItemForMutation(mod: KnowledgeModule, idOrSlug: string) {
    const item = await mod.get(idOrSlug);
    if (!item) throw notFound(`No knowledge item ${JSON.stringify(idOrSlug)} in this company.`);
    return item;
  }

  /**
   * K-3: every route that changes what a rule says or delivers passes the one
   * shared grade check (../rule-grade.ts). Notes and other kinds are not
   * graded here.
   */
  async function assertRuleGrade(req: Request, companyId: string, item: { kind: string; roles?: readonly string[] | null }): Promise<string | null> {
    if (item.kind !== "rule") return null;
    return assertRuleWriteGrade(req, companyId, deps.casteSensitivity ?? builtinCasteSensitivity, item.roles ?? []);
  }

  // --------------------------------------------------------------- reads

  router.get("/myrmidon/companies/:companyId/knowledge/search", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_search");
    const query = knowledgeSearchQuerySchema.parse(req.query);
    const mod = deps.moduleFor(companyId);
    try {
      const items = await mod.search(query.q, query.limit ?? 20);
      res.json({ query: query.q, items });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/companies/:companyId/knowledge/items", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_list");
    const query = knowledgeListQuerySchema.parse(req.query);
    const mod = deps.moduleFor(companyId);
    try {
      const items = await mod.listItems({
        kind: query.kind,
        status: query.status as KnowledgeItemStatus | undefined,
        folderPrefix: query.space,
      });
      res.json({ items: items.slice(0, query.limit ?? 50) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/revisions", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_read");
    const mod = deps.moduleFor(companyId);
    try {
      res.json({ revisions: await mod.listRevisions(itemIdOrSlug(req)) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/revisions/:revisionId",
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_read");
      const mod = deps.moduleFor(companyId);
      try {
        res.json({ revision: await mod.getRevision(itemIdOrSlug(req), req.params.revisionId as string) });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.get("/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/backlinks", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_backlinks");
    const mod = deps.moduleFor(companyId);
    try {
      res.json({ backlinks: await mod.backlinks(itemIdOrSlug(req)) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  // NOTE: the bare item route is registered after the suffixed GET routes:
  // `*idOrSlug` is greedy (the slug itself carries `/`, e.g. glossary/term),
  // so registered earlier it would shadow `/revisions` and `/backlinks`.
  router.get("/myrmidon/companies/:companyId/knowledge/items/*idOrSlug", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_read");
    const mod = deps.moduleFor(companyId);
    try {
      const idOrSlug = itemIdOrSlug(req);
      const item = await mod.get(idOrSlug);
      if (!item) throw notFound(`No knowledge item ${JSON.stringify(idOrSlug)} in this company.`);
      res.json({ item });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/companies/:companyId/knowledge/suggestions", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_list");
    const mod = deps.moduleFor(companyId);
    const status =
      typeof req.query.status === "string" && ["pending", "accepted", "declined", "all"].includes(req.query.status)
        ? (req.query.status as "pending" | "accepted" | "declined" | "all")
        : undefined;
    try {
      res.json({ suggestions: await mod.listSuggestions(status) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/companies/:companyId/knowledge/export", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_list");
    const mod = deps.moduleFor(companyId);
    try {
      const buf = await mod.exportTree();
      res.setHeader("content-type", "application/gzip");
      res.setHeader("content-disposition", `attachment; filename="knowledge-${companyId}.json.gz"`);
      res.send(buf);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  // --------------------------------------------------------------- writes

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items",
    validate(knowledgeCreateItemSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_write_draft");
      assertCleanWrite(req.body.content, "content");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        const item = await mod.create(
          {
            slug: req.body.slug,
            title: req.body.title,
            content: req.body.content,
            kind: req.body.kind,
            summary: req.body.summary ?? null,
            folderPath: req.body.folderPath,
            tags: req.body.tags,
            approverKind: req.body.approverKind ?? null,
            sources: req.body.sources,
          },
          { actorType: actor.actorType, actorId: actor.actorId },
        );
        res.status(201).json({ item });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/draft",
    validate(knowledgeDraftSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_write_draft");
      assertCleanWrite(req.body.content, "content");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        const revision = await mod.draft(
          itemIdOrSlug(req),
          {
            content: req.body.content,
            changeSummary: req.body.changeSummary ?? null,
            sources: req.body.sources,
          },
          { actorType: actor.actorType, actorId: actor.actorId },
        );
        res.status(201).json({ revision });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post("/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/submit", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_write_draft");
    const mod = deps.moduleFor(companyId);
    const actor = actorOf(req);
    const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : undefined;
    try {
      res.json({ item: await mod.submit(itemIdOrSlug(req), { actorType: actor.actorType, actorId: actor.actorId }, revisionId) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/publish",
    validate(knowledgePublishSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_publish");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : undefined;
      try {
        const item = await loadItemForMutation(mod, itemIdOrSlug(req));
        await assertPublishAllowed(req, companyId, item, revisionId ?? null);
        await assertRuleGrade(req, companyId, item);
        res.json({ item: await mod.publish(itemIdOrSlug(req), { actorType: actor.actorType, actorId: actor.actorId }, revisionId) });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/approve",
    validate(knowledgeApproveSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      const revisionId = typeof req.body?.revisionId === "string" ? req.body.revisionId : undefined;
      try {
        const item = await loadItemForMutation(mod, itemIdOrSlug(req));
        assertRuleApproveAllowed(req, item.kind);
        await assertKnowledgeToolAccess(req, "rule_approve");
        const approverKindInput = approverKindFromRequest(req, companyId);
        const checkedActorGrade = item.kind === "rule"
          ? await assertRuleGrade(req, companyId, item)
          : null;
        const approverKind = item.kind === "rule"
          ? (item.approverKind ?? (checkedActorGrade === "admin" ? "adm" : checkedActorGrade))
          : approverKindInput;
        assertApproverAuthority(req, companyId, approverKind);
        const actorGrade = checkedActorGrade ?? approverKindInput;
        if (actorGrade === null) {
          throw forbidden("approving needs an operator, admin or owner membership of the company", {
            code: "approver_kind_mismatch",
          });
        }
        if (item.approverKind !== null && approverKind !== item.approverKind) {
          throw forbidden("The actor's membership grade does not match the rule approver grade.", {
            code: "approver_kind_mismatch",
          });
        }

        res.json({
          item: await mod.approve(
            itemIdOrSlug(req),
            { actorType: actor.actorType, actorId: actor.actorId, kind: approverKind },
            { revisionId },
          ),
        });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/rollback",
    validate(knowledgeRollbackSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_publish");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        const item = await loadItemForMutation(mod, itemIdOrSlug(req));
        await assertPublishAllowed(req, companyId, item, req.body.toRevisionId);
        await assertRuleGrade(req, companyId, item);
        res.json({
          item: await mod.rollback(
            itemIdOrSlug(req),
            { actorType: actor.actorType, actorId: actor.actorId },
            { targetRevisionId: req.body.toRevisionId },
          ),
        });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post("/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/archive", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_publish");
    const mod = deps.moduleFor(companyId);
    const actor = actorOf(req);
    try {
      // Archiving takes a page out of what agents read: same gates as publish
      // (autonomy matrix + the agent-never-touches-a-rule bar).
      const item = await loadItemForMutation(mod, itemIdOrSlug(req));
      assertRuleApproveAllowed(req, item.kind);
      await assertPublishAllowed(req, companyId, item, null);
      await assertRuleGrade(req, companyId, item);
      res.json({ item: await mod.archive(itemIdOrSlug(req), { actorType: actor.actorType, actorId: actor.actorId }) });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post(
    "/myrmidon/companies/:companyId/knowledge/items/*idOrSlug/supersede",
    validate(knowledgeSupersedeSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_publish");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        const current = await loadItemForMutation(mod, itemIdOrSlug(req));
        assertRuleApproveAllowed(req, current.kind);
        await assertPublishAllowed(req, companyId, current, null);
        await assertRuleGrade(req, companyId, current);
        res.json({
          item: await mod.supersede(
            itemIdOrSlug(req),
            { actorType: actor.actorType, actorId: actor.actorId },
            { bySlug: req.body.replacementSlug },
          ),
        });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/propose",
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_propose");
      // §3.4: a proposal without sources is refused 422 before the store sees
      // it — the criterion «knowledge_propose без источников → 422». This
      // check runs before the Zod parse on purpose: the shared schema pins
      // sources min(1), and the generic ZodError branch of the error handler
      // answers 400, which would bury the contract-status the API promises.
      if (!Array.isArray(req.body?.sources) || req.body.sources.length === 0) {
        throw unprocessable("A knowledge proposal must name at least one source.", {
          code: "knowledge_propose_requires_sources",
          field: "sources",
        });
      }
      assertCleanWrite(String(req.body?.body ?? ""), "body");
      const parsed = knowledgeProposeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw unprocessable("Invalid knowledge proposal payload.", {
          code: "knowledge_propose_invalid",
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      const body = parsed.data;
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        const suggestion = await mod.suggest(
          { actorType: actor.actorType, actorId: actor.actorId },
          {
            body: body.body,
            rationale: body.title ?? undefined,
            targetSlug: body.targetSlug ?? undefined,
            sourceKind: body.sources[0]!.kind,
            sourceRef: body.sources[0]!.ref,
          },
        );
        res.status(201).json({ suggestion });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/suggestions/:id/accept",
    validate(knowledgeSuggestionDecisionSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_propose");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        res.json({
          suggestion: await mod.decideSuggestion(
            { actorType: actor.actorType, actorId: actor.actorId },
            { suggestionId: req.params.id as string, decision: "accepted" },
          ),
        });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/knowledge/suggestions/:id/decline",
    validate(knowledgeSuggestionDecisionSchema),
    async (req: Request, res: Response) => {
      const companyId = companyOf(req);
      await assertKnowledgeToolAccess(req, "knowledge_propose");
      const mod = deps.moduleFor(companyId);
      const actor = actorOf(req);
      try {
        res.json({
          suggestion: await mod.decideSuggestion(
            { actorType: actor.actorType, actorId: actor.actorId },
            { suggestionId: req.params.id as string, decision: "declined" },
          ),
        });
      } catch (err) {
        throw toHttpError(err);
      }
    },
  );

  // The app-level parser only reads JSON; the exported tree is a gzip body, so
  // this route carries its own raw parser (the matching `export` content type
  // plus the usual binary aliases).
  router.post(
    "/myrmidon/companies/:companyId/knowledge/import",
    express.raw({ type: ["application/gzip", "application/x-gzip", "application/octet-stream"], limit: "50mb" }),
    async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_publish");
    const mod = deps.moduleFor(companyId);
    const actor = actorOf(req);
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw unprocessable("import expects a gzipped tree in the request body");
    }
    await assertBulkImportAllowed(req, companyId);
    try {
      res.json(
        await mod.importTree(
          buf,
          { actorType: actor.actorType, actorId: actor.actorId },
          { approverKind: approverKindFromRequest(req, companyId) },
        ),
      );
    } catch (err) {
      throw toHttpError(err);
    }
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export function myrmidonKnowledgeRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return knowledgeRoutes({
    moduleFor: (companyId) => createKnowledgeModule(db, companyId),
    casteSensitivity: (companyId) => resolveCasteSensitivity(db, companyId),
    roleForAgent: agentRoleFromDb(db),
    matrixFor: async () => {
      try {
        const store = dbAutonomyStore(db);
        const doc = await store.read();
        return doc.matrix;
      } catch {
        return null;
      }
    },
    agentHasToolAccess: async ({ agentId, companyId, toolName }) => {
      // An agent caller needs a `knowledge_*` tool grant (permissions.toolAccess,
      // S6). The tool-access policy decides; an unresolvable policy is a deny.
      try {
        const { toolAccessPolicyService } = await import("../../services/tool-access-policy.js");
        const policy = toolAccessPolicyService(db);
        const decision = await policy.decide({
          companyId,
          actor: { actorType: "agent", actorId: agentId, agentId, userId: null },
          request: { toolName, arguments: {}, idempotencyKey: null, sideEffecting: false },
        });
        return decision.allowed;
      } catch {
        return false;
      }
    },
    parkPublishForApproval: async ({ companyId, agentId, actorLabel, itemId, itemSlug, revisionId, toolName }) => {
      const { toolAccessPolicyService } = await import("../../services/tool-access-policy.js");
      const policy = toolAccessPolicyService(db);
      const accessDecision = {
        decision: "require_approval" as const,
        allowed: false,
        reasonCode: "requires_approval_policy" as const,
        explanation: `knowledge_publish outside the auto sections requires board approval (${actorLabel}).`,
        effectiveProfileIds: [],
        matchedPolicyIds: [],
      } satisfies import("@myrmidon/shared").ToolAccessDecision;
      const recorded = await policy.recordInvocation(
        {
          companyId,
          actor: { actorType: agentId ? ("agent" as const) : ("user" as const), actorId: agentId ?? actorLabel, agentId, userId: null },
          request: {
            toolName,
            arguments: { itemId, itemSlug, revisionId },
            idempotencyKey: `knowledge-publish:${itemId}:${revisionId ?? "latest"}`,
            sideEffecting: true,
          },
        },
        accessDecision,
      );
      return { actionRequestId: recorded.actionRequest?.id ?? null };
    },
    env,
  });
}
