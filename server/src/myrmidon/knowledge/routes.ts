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

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
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
} from "@paperclipai/shared";
import type { AutonomyMatrix } from "@paperclipai/shared";
import { HttpError, forbidden, notFound, unprocessable } from "../../errors.js";
import { assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
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
      res.json({ revisions: await mod.listRevisions(req.params.idOrSlug as string) });
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
        res.json({ revision: await mod.getRevision(req.params.idOrSlug as string, req.params.revisionId as string) });
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
      res.json({ backlinks: await mod.backlinks(req.params.idOrSlug as string) });
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
      const item = await mod.get(req.params.idOrSlug as string);
      if (!item) throw notFound(`No knowledge item ${JSON.stringify(req.params.idOrSlug)} in this company.`);
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
          req.params.idOrSlug as string,
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
      res.json({ item: await mod.submit(req.params.idOrSlug as string, { actorType: actor.actorType, actorId: actor.actorId }, revisionId) });
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
        const item = await loadItemForMutation(mod, req.params.idOrSlug as string);
        await assertPublishAllowed(req, companyId, item, revisionId ?? null);
        res.json({ item: await mod.publish(req.params.idOrSlug as string, { actorType: actor.actorType, actorId: actor.actorId }, revisionId) });
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
        const item = await loadItemForMutation(mod, req.params.idOrSlug as string);
        // Gate 4b runs BEFORE the tool-grant gateway: a `rule` approval by an
        // agent is forbidden outright (тест П4), whatever grants, matrix or
        // the agent's own instructions say. Loading the item is the only way
        // to see its kind; the load itself needs no grant.
        assertRuleApproveAllowed(req, item.kind);
        await assertKnowledgeToolAccess(req, "rule_approve");
        // §3.4: the approver presents their kind explicitly in the request;
        // S4 compares it against the item's approverKind. A caller without
        // the matching kind is refused by the domain gate (403).
        const approverKindInput = typeof req.body?.approverKind === "string" ? req.body.approverKind : null;
        res.json({
          item: await mod.approve(
            req.params.idOrSlug as string,
            { actorType: actor.actorType, actorId: actor.actorId, kind: approverKindInput },
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
        const item = await loadItemForMutation(mod, req.params.idOrSlug as string);
        await assertPublishAllowed(req, companyId, item, req.body.toRevisionId);
        res.json({
          item: await mod.rollback(
            req.params.idOrSlug as string,
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
      res.json({ item: await mod.archive(req.params.idOrSlug as string, { actorType: actor.actorType, actorId: actor.actorId }) });
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
        res.json({
          item: await mod.supersede(
            req.params.idOrSlug as string,
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

  router.post("/myrmidon/companies/:companyId/knowledge/import", async (req: Request, res: Response) => {
    const companyId = companyOf(req);
    await assertKnowledgeToolAccess(req, "knowledge_publish");
    const mod = deps.moduleFor(companyId);
    const actor = actorOf(req);
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw unprocessable("import expects a gzipped tree in the request body");
    }
    try {
      res.json(await mod.importTree(buf, { actorType: actor.actorType, actorId: actor.actorId }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export function myrmidonKnowledgeRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return knowledgeRoutes({
    moduleFor: (companyId) => createKnowledgeModule(db, companyId),
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
      } satisfies import("@paperclipai/shared").ToolAccessDecision;
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
