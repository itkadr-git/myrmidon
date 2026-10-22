// server/src/myrmidon/knowledge/mcp.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-2): the MCP surface of the knowledge module.
//
// One MCP endpoint per company — `POST /api/myrmidon/companies/:companyId/knowledge/mcp`
// — mirrors the REST routes through the same gates and the same module: an agent
// reads and writes the same knowledge with the same rights, whatever side of the
// API it enters from (§6). The tool names are the shared `KNOWLEDGE_TOOL_NAMES`;
// `tools/list` describes them from `KNOWLEDGE_TOOL_DEFINITIONS` below.
//
// Gates, in order (the same five as the REST routes):
//   1. Company access (`assertCompanyAccess`).
//   2. `permissions.toolAccess` grant for the named tool (S6) — an agent
//      without the grant is refused with `knowledge_tool_access_denied`.
//   3. Injection scan on the write payloads.
//   4. Autonomy matrix (`knowledge_publish` outside the `auto` sections parks
//      an approval card and returns a tool error; `rule_approve` by an agent
//      refuses outright — тест П4).
//   5. The K-1 domain gates on top.

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { knowledgeProposeSchema, isKnowledgeAutoSection, defaultAutonomyMatrix, resolveAutonomy } from "@paperclipai/shared";
import {
  KNOWLEDGE_APPROVAL_REQUIRED_CODE,
  KNOWLEDGE_INJECTION_FLAGGED_CODE,
  KNOWLEDGE_RULE_APPROVE_FORBIDDEN_CODE,
  KNOWLEDGE_TOOL_ACCESS_DENIED_CODE,
} from "@paperclipai/shared";
import type { AutonomyMatrix } from "@paperclipai/shared";
import { HttpError, forbidden, notFound, unprocessable } from "../../errors.js";
import { assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { KnowledgeDomainError } from "./domain.js";
import { createKnowledgeModule, type KnowledgeModule } from "./service.js";
import { guardrailsInjectionEnabled, injectionScoreThreshold, scanForInjection } from "../guardrails/injection.js";
import { dbAutonomyStore, agentRoleFromDb } from "../autonomy/store.js";

// ---------------------------------------------------------------------------
// Tool definitions (tools/list payload)
// ---------------------------------------------------------------------------

/** JSON-Schema descriptions of the knowledge tools an MCP client sees. */
export const KNOWLEDGE_TOOL_DEFINITIONS = [
  {
    name: "knowledge_search",
    description:
      "Full-text search over the company's published knowledge. Returns items with slug, title, summary and score.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: { type: "string", description: "The search query (1..500 chars)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max items (default 20)." },
      },
      required: ["q"],
    },
  },
  {
    name: "knowledge_read",
    description: "Read one knowledge item by id or slug (published content, tags, sources).",
    inputSchema: {
      type: "object" as const,
      properties: { idOrSlug: { type: "string", description: "Item id or slug." } },
      required: ["idOrSlug"],
    },
  },
  {
    name: "knowledge_list",
    description: "List knowledge items, optionally filtered by kind/status/space prefix.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", enum: ["note", "wiki", "answer", "task_outcome", "rule"] },
        status: { type: "string", enum: ["draft", "in_review", "published", "archived", "superseded"] },
        space: { type: "string", description: "Folder-path prefix." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "knowledge_backlinks",
    description: "List items linking to the given knowledge item.",
    inputSchema: {
      type: "object" as const,
      properties: { idOrSlug: { type: "string" } },
      required: ["idOrSlug"],
    },
  },
  {
    name: "knowledge_propose",
    description:
      "Propose a knowledge change (new page or edit). Requires at least one source — a proposal without sources is refused.",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetSlug: { type: "string", description: "The item to edit; omit for a new page." },
        title: { type: "string" },
        body: { type: "string" },
        sources: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["task", "pr", "issue", "run", "document", "decision", "url"] },
              ref: { type: "string" },
              note: { type: "string" },
            },
            required: ["kind", "ref"],
          },
        },
      },
      required: ["body", "sources"],
    },
  },
  {
    name: "knowledge_write_draft",
    description:
      "Create an item or add a draft revision. Writes stay draft/in review until published; the injection scanner checks the payload.",
    inputSchema: {
      type: "object" as const,
      properties: {
        idOrSlug: { type: "string", description: "Existing item to draft into; omit to create a new one." },
        slug: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        kind: { type: "string", enum: ["note", "wiki", "answer", "task_outcome", "rule"] },
        folderPath: { type: "string" },
        submit: { type: "boolean", description: "Submit straight to review instead of leaving the revision as draft." },
      },
      required: ["content"],
    },
  },
  {
    name: "knowledge_publish",
    description:
      "Publish a revision. Inside the auto sections (glossary/releases/architecture) it publishes outright; outside it parks an approval card and returns knowledge_approval_required.",
    inputSchema: {
      type: "object" as const,
      properties: {
        idOrSlug: { type: "string" },
        revisionId: { type: "string" },
      },
      required: ["idOrSlug"],
    },
  },
  {
    name: "rule_propose",
    description:
      "Propose a rule (a caste-level instruction). An agent may only propose; approving a rule is forbidden for agents (тест П4).",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetSlug: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        sources: { type: "array", items: { type: "object" } },
      },
      required: ["body", "sources"],
    },
  },
] as const;

/** The tool names this MCP endpoint serves, for asserts in tests. */
export const KNOWLEDGE_MCP_TOOL_NAMES = KNOWLEDGE_TOOL_DEFINITIONS.map((tool) => tool.name);

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface KnowledgeMcpDeps {
  /** Bind the store to the path company. Tests inject a stub module. */
  moduleFor(companyId: string): KnowledgeModule;
  /** The autonomy matrix resolver; null falls back to the safe defaults. */
  matrixFor?(companyId: string): Promise<AutonomyMatrix | null>;
  /** An agent caller needs a tool grant; production wires the tool-access policy. */
  agentHasToolAccess?(input: { agentId: string; companyId: string; toolName: string }): Promise<boolean>;
  /** The agent's matrix role; production derives it via `agentRoleFromDb`. */
  roleForAgent?(agentId: string): Promise<string | null>;
  /** Record a parked publish as an approval card. */
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
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcBody {
  id?: JsonRpcId;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

function isErrorLike(err: unknown): err is Error {
  return err instanceof Error;
}

export function knowledgeMcpRoutes(deps: KnowledgeMcpDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const threshold = injectionScoreThreshold(env);
  const injectionOn = guardrailsInjectionEnabled(env);

  function actorOf(req: Request) {
    const info = getActorInfo(req);
    return {
      actorType: (info.actorType === "agent" ? "agent" : "user") as "agent" | "user",
      actorId: info.actorId,
      agentId: info.actorType === "agent" ? (info.agentId ?? null) : null,
      label: `${info.actorType}:${info.actorId ?? "unknown"}`,
    };
  }

  async function assertToolAccess(req: Request, companyId: string, toolName: string): Promise<void> {
    const actor = actorOf(req);
    if (actor.actorType !== "agent") return;
    const allowed = deps.agentHasToolAccess
      ? await deps.agentHasToolAccess({ agentId: actor.agentId ?? "", companyId, toolName })
      : false;
    if (!allowed) {
      throw forbidden("knowledge access requires a tool grant (permissions.toolAccess)", {
        code: KNOWLEDGE_TOOL_ACCESS_DENIED_CODE,
      });
    }
  }

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
      throw new HttpError(
        409,
        `knowledge_publish outside the auto sections requires approval. Card ${card?.actionRequestId ?? "(unavailable)"} parked.`,
        { code: KNOWLEDGE_APPROVAL_REQUIRED_CODE, actionRequestId: card?.actionRequestId ?? null },
      );
    }
  }

  /** Rule approvals by an agent are forbidden outright — before any grant gateway (тест П4). */
  function assertRuleApproveAllowed(req: Request, itemKind: string): void {
    const actor = actorOf(req);
    if (actor.actorType === "agent" && itemKind === "rule") {
      throw forbidden(
        "rule_approve is forbidden for agents (тест П4): a rule changes what every agent of a caste is told, only the human approves one.",
        KNOWLEDGE_RULE_APPROVE_FORBIDDEN_CODE,
      );
    }
  }

  async function loadItem(mod: KnowledgeModule, idOrSlug: string) {
    const item = await mod.get(idOrSlug);
    if (!item) throw notFound(`No knowledge item ${JSON.stringify(idOrSlug)} in this company.`);
    return item;
  }

  /** Run one tool call through the gates; throws HttpError on refusal. */
  async function callTool(req: Request, companyId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const mod = deps.moduleFor(companyId);
    const actor = actorOf(req);
    const actorRef = { actorType: actor.actorType, actorId: actor.actorId } as const;
    switch (name) {
      case "knowledge_search": {
        const q = String(args.q ?? "").trim();
        if (!q) throw unprocessable("knowledge_search requires a non-empty q.", { code: "knowledge_search_requires_q" });
        const items = await mod.search(q, typeof args.limit === "number" ? args.limit : 20);
        return { items };
      }
      case "knowledge_read": {
        const item = await loadItem(mod, String(args.idOrSlug ?? ""));
        return { item };
      }
      case "knowledge_list": {
        const items = await mod.listItems({
          kind: typeof args.kind === "string" ? (args.kind as never) : undefined,
          status: typeof args.status === "string" ? (args.status as never) : undefined,
          folderPrefix: typeof args.space === "string" ? args.space : undefined,
        });
        return { items: typeof args.limit === "number" ? items.slice(0, args.limit) : items.slice(0, 50) };
      }
      case "knowledge_backlinks": {
        return { backlinks: await mod.backlinks(String(args.idOrSlug ?? "")) };
      }
      case "knowledge_propose": {
        // §3.4: a proposal without sources is refused before the Zod parse —
        // the schema pins sources min(1), and a raw ZodError would surface as
        // an unnamed validation failure instead of the contract reason code.
        if (!Array.isArray(args.sources) || args.sources.length === 0) {
          throw unprocessable("A knowledge proposal must name at least one source.", {
            code: "knowledge_propose_requires_sources",
            field: "sources",
          });
        }
        const input = knowledgeProposeSchema.parse({ targetSlug: args.targetSlug, title: args.title, body: args.body, sources: args.sources });
        assertCleanWrite(input.body, "body");
        return {
          suggestion: await mod.suggest(actorRef, {
            body: input.body,
            rationale: input.title ?? undefined,
            targetSlug: input.targetSlug ?? undefined,
            sourceKind: input.sources[0]!.kind,
            sourceRef: input.sources[0]!.ref,
          }),
        };
      }
      case "rule_propose": {
        if (!Array.isArray(args.sources) || args.sources.length === 0) {
          throw unprocessable("A rule proposal must name at least one source.", {
            code: "knowledge_propose_requires_sources",
            field: "sources",
          });
        }
        const input = knowledgeProposeSchema.parse({ targetSlug: args.targetSlug, title: args.title, body: args.body, sources: args.sources });
        assertCleanWrite(input.body, "body");
        return {
          suggestion: await mod.suggest(actorRef, {
            body: input.body,
            rationale: input.title ?? undefined,
            targetSlug: input.targetSlug ?? undefined,
            sourceKind: input.sources[0]!.kind,
            sourceRef: input.sources[0]!.ref,
          }),
        };
      }
      case "knowledge_write_draft": {
        assertCleanWrite(String(args.content ?? ""), "content");
        if (typeof args.idOrSlug === "string" && args.idOrSlug.length > 0) {
          const revision = await mod.draft(
            args.idOrSlug,
            {
              content: String(args.content),
              changeSummary: typeof args.changeSummary === "string" ? args.changeSummary : null,
              sources: Array.isArray(args.sources) ? (args.sources as never) : undefined,
            },
            actorRef,
          );
          if (args.submit === true) {
            const item = await mod.submit(args.idOrSlug, actorRef, revision.id);
            return { item };
          }
          return { revision };
        }
        const item = await mod.create(
          {
            slug: String(args.slug ?? `mcp-${Date.now()}`),
            title: String(args.title ?? "Untitled"),
            content: String(args.content),
            kind: typeof args.kind === "string" ? (args.kind as never) : "note",
            summary: typeof args.summary === "string" ? args.summary : null,
            folderPath: typeof args.folderPath === "string" ? args.folderPath : "",
            tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
            approverKind: null,
            sources: Array.isArray(args.sources) ? (args.sources as never) : undefined,
          },
          actorRef,
        );
        return { item };
      }
      case "knowledge_publish": {
        const idOrSlug = String(args.idOrSlug ?? "");
        const revisionId = typeof args.revisionId === "string" ? args.revisionId : undefined;
        const item = await loadItem(mod, idOrSlug);
        await assertPublishAllowed(req, companyId, item, revisionId ?? null);
        return { item: await mod.publish(idOrSlug, actorRef, revisionId) };
      }
      default:
        throw notFound(`Unknown knowledge tool: ${name}`);
    }
  }

  router.post("/myrmidon/companies/:companyId/knowledge/mcp", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as JsonRpcBody;
    const id = body.id ?? null;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });

    if (body.method === "initialize") {
      return send({
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myrmidon-knowledge", version: "1" },
      });
    }
    if (body.method === "notifications/initialized") return res.status(202).end();
    if (body.method === "tools/list") {
      return send({ tools: KNOWLEDGE_TOOL_DEFINITIONS });
    }
    if (body.method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof params.name === "string" ? params.name : "";
    if (!KNOWLEDGE_MCP_TOOL_NAMES.includes(toolName as never)) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName || "(none)"}` } });
    }

    // Approvals of `rule` items are not an MCP tool at all: an agent can never
    // approve a rule (тест П4) — the REST route guards it, the MCP surface has
    // no such method. knowledge_approve-like calls land on the REST surface.
    try {
      await assertToolAccess(req, companyId, toolName);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(req, companyId, toolName, args);
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      if (error instanceof KnowledgeDomainError) {
        return send({
          isError: true,
          content: [{ type: "text", text: error.message }],
          structuredContent: { code: error.code },
        });
      }
      if (isErrorLike(error) && "status" in error && typeof (error as { status?: unknown }).status === "number") {
        const http = error as HttpErrorLike;
        return res.status(http.status).json({
          jsonrpc: "2.0",
          id,
          error: { code: http.status === 403 ? -32604 : -32000, message: http.message, data: { code: http.details ?? null } },
        });
      }
      return send({
        isError: true,
        content: [{ type: "text", text: isErrorLike(error) ? error.message : "knowledge tool failed" }],
        structuredContent: { code: "unknown" },
      });
    }
  });

  return router;
}

interface HttpErrorLike extends Error {
  status: number;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export function myrmidonKnowledgeMcpRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return knowledgeMcpRoutes({
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
      };
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
