import { z } from "zod";

/** ADM's stable namespaces and the corresponding Myrmidon knowledge kinds. */
export const ADM_KNOWLEDGE_SPACES = {
  policy: { prefix: "adm/policy/", kind: "rule" },
  trigger: { prefix: "adm/trigger/", kind: "rule" },
  reference: { prefix: "adm/reference/", kind: "wiki" },
  skills: { prefix: "adm/skills/", kind: "skill_card" },
  lessons: { prefix: "adm/lessons/", kind: "wiki" },
} as const;

export type AdmKnowledgeNamespace = keyof typeof ADM_KNOWLEDGE_SPACES;
export type AdmConnectorCode =
  | "ADM_INVALID_METADATA"
  | "ADM_UNAUTHORIZED"
  | "ADM_FORBIDDEN"
  | "ADM_NOT_FOUND"
  | "ADM_REVISION_CONFLICT"
  | "ADM_RATE_LIMITED"
  | "ADM_UPSTREAM_UNAVAILABLE";

const triggerSchema = z.enum([
  "ssh", "deploy", "paperclip-api", "incident", "config-change", "release", "merge", "owner-message",
]);
const metadataSchema = z.object({
  schema_version: z.literal(1),
  slug: z.string().regex(/^adm\/(policy|trigger|reference|skills|lessons)\/[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(["rule", "wiki", "skill_card"]),
  title: z.string().min(1).max(160),
  summary: z.string().max(300),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)),
  triggers: z.array(triggerSchema),
  priority: z.number().int().min(0).max(100),
  owner: z.string().min(1),
  source_ref: z.string().min(1),
  sensitivity: z.literal("internal"),
  status: z.enum(["draft", "proposed", "published", "archived"]),
  revision_id: z.string().min(1),
  updated_at: z.string().datetime({ offset: true }),
  body: z.string().optional(),
  approver_kind: z.literal("owner").optional(),
}).superRefine((item, ctx) => {
  const namespace = item.slug.split("/")[1];
  const expectedKind = ADM_KNOWLEDGE_SPACES[namespace as AdmKnowledgeNamespace]?.kind;
  if (item.kind !== expectedKind) ctx.addIssue({ code: "custom", path: ["kind"], message: "kind does not match ADM namespace" });
  if (item.kind === "rule" && item.approver_kind !== "owner") {
    ctx.addIssue({ code: "custom", path: ["approver_kind"], message: "ADM rules require owner approval" });
  }
});
export type AdmKnowledgeMetadata = z.infer<typeof metadataSchema>;

export interface AdmKnowledgeItem {
  id: string;
  slug: string;
  kind: string;
  title: string;
  summary: string | null;
  status: string;
  tags?: string[];
  updatedAt: string;
  deliveredRevisionId?: string | null;
  content?: string;
  [key: string]: unknown;
}

export interface AdmKnowledgeRestPort {
  search(query: string, options: { space: string; limit: number }): Promise<readonly AdmKnowledgeItem[]>;
  list(options: { space: string; kind: string; status: "published"; limit: number }): Promise<readonly AdmKnowledgeItem[]>;
  read(id: string): Promise<AdmKnowledgeItem | null>;
}

export class AdmConnectorError extends Error {
  constructor(readonly code: AdmConnectorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdmConnectorError";
  }
}

function mapError(error: unknown): AdmConnectorError {
  if (error instanceof AdmConnectorError) return error;
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
  const code: AdmConnectorCode = status === 401 ? "ADM_UNAUTHORIZED"
    : status === 403 ? "ADM_FORBIDDEN"
    : status === 404 ? "ADM_NOT_FOUND"
    : status === 409 ? "ADM_REVISION_CONFLICT"
    : status === 429 ? "ADM_RATE_LIMITED"
    : "ADM_UPSTREAM_UNAVAILABLE";
  return new AdmConnectorError(code, "ADM knowledge request failed", { cause: error });
}

function namespaceOf(slug: string): AdmKnowledgeNamespace | null {
  const match = /^adm\/(policy|trigger|reference|skills|lessons)\//.exec(slug);
  return match ? match[1] as AdmKnowledgeNamespace : null;
}

function assertNamespaceItem(item: AdmKnowledgeItem, namespace: AdmKnowledgeNamespace): void {
  if (!item.slug.startsWith(ADM_KNOWLEDGE_SPACES[namespace].prefix) || item.kind !== ADM_KNOWLEDGE_SPACES[namespace].kind) {
    throw new AdmConnectorError("ADM_INVALID_METADATA", "Knowledge item does not match its ADM namespace");
  }
}

/** Thin REST adapter: deterministic selection stays in connector code; reads use stable item IDs. */
export function createAdmKnowledgeAdapter(rest: AdmKnowledgeRestPort) {
  return {
    async search(query: string, namespace: AdmKnowledgeNamespace, limit = 50): Promise<AdmKnowledgeItem[]> {
      if (!query.trim()) throw new AdmConnectorError("ADM_INVALID_METADATA", "Search query must not be empty");
      try {
        const items = await rest.search(query, { space: ADM_KNOWLEDGE_SPACES[namespace].prefix, limit });
        return items.filter((item) => {
          if (!item.slug.startsWith(ADM_KNOWLEDGE_SPACES[namespace].prefix)) return false;
          assertNamespaceItem(item, namespace);
          return item.status === "published";
        });
      } catch (error) { throw mapError(error); }
    },
    async list(namespace: AdmKnowledgeNamespace, limit = 100): Promise<AdmKnowledgeItem[]> {
      try {
        const items = await rest.list({
          space: ADM_KNOWLEDGE_SPACES[namespace].prefix,
          kind: ADM_KNOWLEDGE_SPACES[namespace].kind,
          status: "published",
          limit,
        });
        return items.map((item) => { assertNamespaceItem(item, namespace); return item; });
      } catch (error) { throw mapError(error); }
    },
    async read(id: string): Promise<AdmKnowledgeItem> {
      try {
        const item = await rest.read(id);
        if (!item) throw new AdmConnectorError("ADM_NOT_FOUND", "Knowledge item not found");
        const namespace = namespaceOf(item.slug);
        if (!namespace) throw new AdmConnectorError("ADM_INVALID_METADATA", "Knowledge item is outside adm/*");
        assertNamespaceItem(item, namespace);
        if (item.status !== "published") throw new AdmConnectorError("ADM_NOT_FOUND", "Published knowledge item not found");
        return item;
      } catch (error) { throw mapError(error); }
    },
    validateMetadata(value: unknown): AdmKnowledgeMetadata {
      const parsed = metadataSchema.safeParse(value);
      if (!parsed.success) throw new AdmConnectorError("ADM_INVALID_METADATA", "ADM knowledge metadata is invalid", { cause: parsed.error });
      return parsed.data;
    },
  };
}
