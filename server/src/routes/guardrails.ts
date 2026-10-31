import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import {
  listGuardrailRulesQuerySchema,
  type GuardrailRule,
  type GuardrailRuleStatus,
  type GuardrailRuleType,
} from "@myrmidon/shared";
import { assertAuthenticated, assertCompanyAccess, assertBoardOrgAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { MOCK_GUARDRAIL_RULES } from "../fixtures/guardrails.js";

export interface GuardrailsRoutesOptions {
  rules?: GuardrailRule[];
  rulesStore?: {
    listRules: (options: {
      companyId?: string;
      status?: GuardrailRuleStatus;
      type?: GuardrailRuleType;
    }) => Promise<GuardrailRule[]> | GuardrailRule[];
  };
}

export function encodeGuardrailCursor(ruleId: string): string {
  return Buffer.from(JSON.stringify({ id: ruleId }), "utf8").toString("base64url");
}

export function decodeGuardrailCursor(cursor: string): string | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && parsed.id.length > 0) {
      return parsed.id;
    }
    return null;
  } catch {
    return null;
  }
}

export function guardrailsRoutes(_db: Db, options?: GuardrailsRoutesOptions) {
  const router = Router();
  const baseRules = options?.rules ?? MOCK_GUARDRAIL_RULES;

  async function getFilteredRules(params: {
    companyId?: string;
    status?: GuardrailRuleStatus;
    type?: GuardrailRuleType;
  }): Promise<GuardrailRule[]> {
    let list: GuardrailRule[];
    if (options?.rulesStore) {
      list = await options.rulesStore.listRules(params);
    } else {
      list = [...baseRules];
    }

    return list
      .filter((rule) => {
        if (params.companyId && rule.companyId && rule.companyId !== params.companyId) {
          return false;
        }
        if (params.status && rule.status !== params.status) {
          return false;
        }
        if (params.type && rule.type !== params.type) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function handleListRules(req: Request, companyId?: string) {
    const query = listGuardrailRulesQuerySchema.parse(req.query);
    const filtered = await getFilteredRules({
      companyId,
      status: query.status,
      type: query.type,
    });

    const limit = query.limit ?? 50;
    let startIndex = 0;

    if (query.cursor) {
      const cursorId = decodeGuardrailCursor(query.cursor);
      if (!cursorId) {
        throw badRequest("Invalid pagination cursor format");
      }
      const cursorIndex = filtered.findIndex((r) => r.id === cursorId);
      if (cursorIndex === -1) {
        throw badRequest("Invalid pagination cursor: rule not found");
      }
      startIndex = cursorIndex + 1;
    }

    const page = filtered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < filtered.length;
    const nextCursor = hasMore && page.length > 0 ? encodeGuardrailCursor(page[page.length - 1].id) : null;

    return {
      rules: page,
      nextCursor,
      total: filtered.length,
    };
  }

  // Company-scoped routes:
  router.get("/companies/:companyId/guardrails/rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await handleListRules(req, companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/guardrails", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await handleListRules(req, companyId);
    res.json(result);
  });

  // System/board-wide routes:
  router.get("/guardrails/rules", async (req, res) => {
    assertAuthenticated(req);
    assertBoardOrgAccess(req);
    const result = await handleListRules(req);
    res.json(result);
  });

  router.get("/guardrails", async (req, res) => {
    assertAuthenticated(req);
    assertBoardOrgAccess(req);
    const result = await handleListRules(req);
    res.json(result);
  });

  return router;
}
