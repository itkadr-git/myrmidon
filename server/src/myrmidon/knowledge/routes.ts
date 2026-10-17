import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "../../routes/authz.js";
import { KnowledgeDomainError } from "./domain.js";
import { createKnowledgeModule } from "./service.js";

export function myrmidonKnowledgeRoutes(db: Db) {
  const router = Router();
  router.get("/myrmidon/companies/:companyId/knowledge/suggestions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "pending";
      if (!["pending", "accepted", "declined", "all"].includes(status)) {
        res.status(400).json({ error: "invalid status" });
        return;
      }
      res.json({ suggestions: await createKnowledgeModule(db, companyId).listSuggestions(status as "pending" | "accepted" | "declined" | "all") });
    } catch (error) {
      if (error instanceof KnowledgeDomainError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });
  router.patch("/myrmidon/companies/:companyId/knowledge/suggestions/:suggestionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const suggestion = await createKnowledgeModule(db, companyId).editSuggestion(
        { actorType: "user", actorId: req.actor.userId ?? "board" },
        {
          suggestionId: req.params.suggestionId as string,
          body: typeof req.body?.body === "string" ? req.body.body : "",
          rationale: typeof req.body?.rationale === "string" ? req.body.rationale : null,
        },
      );
      res.json({ suggestion });
    } catch (error) {
      if (error instanceof KnowledgeDomainError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });
  router.post("/myrmidon/companies/:companyId/knowledge/suggestions/:suggestionId/decision", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const decision = req.body?.decision;
    if (decision !== "accepted" && decision !== "declined") {
      res.status(400).json({ error: "decision must be accepted or declined" });
      return;
    }
    if (req.body?.reason !== undefined && typeof req.body.reason !== "string") {
      res.status(400).json({ error: "reason must be a string" });
      return;
    }
    try {
      const suggestion = await createKnowledgeModule(db, companyId).decideSuggestion(
        { actorType: "user", actorId: req.actor.userId ?? "board" },
        {
          suggestionId: req.params.suggestionId as string,
          decision,
          reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        },
      );
      res.json({ suggestion });
    } catch (error) {
      if (error instanceof KnowledgeDomainError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });
  return router;
}
