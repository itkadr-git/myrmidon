import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  INVITE_JOIN_TYPES,
  JOIN_REQUEST_STATUSES,
  JOIN_REQUEST_TYPES,
  PERMISSION_KEYS,
} from "../constants.js";
import { optionalAgentAdapterTypeSchema } from "../adapter-type.js";

export const createCompanyInviteSchema = z.object({
  allowedJoinTypes: z.enum(INVITE_JOIN_TYPES).default("both"),
  humanRole: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES).optional().nullable(),
  defaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  agentMessage: z.string().max(4000).optional().nullable(),
});

export type CreateCompanyInvite = z.infer<typeof createCompanyInviteSchema>;

export const createOpenClawInvitePromptSchema = z.object({
  agentMessage: z.string().max(4000).optional().nullable(),
});

export type CreateOpenClawInvitePrompt = z.infer<
  typeof createOpenClawInvitePromptSchema
>;

export const acceptInviteSchema = z.object({
  requestType: z.enum(JOIN_REQUEST_TYPES),
  agentName: z.string().min(1).max(120).optional(),
  adapterType: optionalAgentAdapterTypeSchema,
  capabilities: z.string().max(4000).optional().nullable(),
  agentDefaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  // OpenClaw join compatibility fields accepted at top level.
  responsesWebhookUrl: z.string().max(4000).optional().nullable(),
  responsesWebhookMethod: z.string().max(32).optional().nullable(),
  responsesWebhookHeaders: z.record(z.string(), z.unknown()).optional().nullable(),
  paperclipApiUrl: z.string().max(4000).optional().nullable(),
  webhookAuthHeader: z.string().max(4000).optional().nullable(),
});

export type AcceptInvite = z.infer<typeof acceptInviteSchema>;

export const listJoinRequestsQuerySchema = z.object({
  status: z.enum(JOIN_REQUEST_STATUSES).optional(),
  requestType: z.enum(JOIN_REQUEST_TYPES).optional(),
});

export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;

export const listCompanyInvitesQuerySchema = z.object({
  state: z.enum(["active", "revoked", "accepted", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ListCompanyInvitesQuery = z.infer<typeof listCompanyInvitesQuerySchema>;

export const claimJoinRequestApiKeySchema = z.object({
  claimSecret: z.string().min(16).max(256),
});

export type ClaimJoinRequestApiKey = z.infer<typeof claimJoinRequestApiKeySchema>;

export const boardCliAuthAccessLevelSchema = z.enum([
  "board",
  "instance_admin_required",
]);

export type BoardCliAuthAccessLevel = z.infer<typeof boardCliAuthAccessLevelSchema>;

export const createCliAuthChallengeSchema = z.object({
  command: z.string().min(1).max(240),
  clientName: z.string().max(120).optional().nullable(),
  requestedAccess: boardCliAuthAccessLevelSchema.default("board"),
  requestedCompanyId: z.string().guid().optional().nullable(),
});

export type CreateCliAuthChallenge = z.infer<typeof createCliAuthChallengeSchema>;

export const resolveCliAuthChallengeSchema = z.object({
  token: z.string().min(16).max(256),
});

export type ResolveCliAuthChallenge = z.infer<typeof resolveCliAuthChallengeSchema>;

// myrmidon(ROLE-SCOPED-TOKENS): board API keys carry a scope that limits what
// admin actions the key can perform, mirroring agent key scopes. Existing keys
// without a stored scope keep full access (backwards compatible default).
export const BOARD_API_KEY_SCOPE_KINDS = [
  "full",
  "read_only",
  "ops",
  "agents_manage",
  "secrets_manage",
  "release",
  // myrmidon(1.6.6 MONITORING E): the key a linking component (Zabbix
  // aggregator, Alertmanager webhook, collector) carries. It may only create
  // and update a task plus report its own liveness, so a leaked or expired
  // link key cannot do operator work — the shared operator key is no longer
  // the only thing standing between a broken link and the whole board.
  "monitoring_link",
] as const;

export const BOARD_API_KEY_ROLE_SCOPE_KINDS = [
  "read_only",
  "ops",
  "agents_manage",
  "secrets_manage",
  "release",
] as const;

/**
 * myrmidon(1.6.6 MONITORING E): the scope of a linking component's board key.
 * The policy fields live on the key itself — the watchdog reads them from the
 * key row, so a link is described in exactly one place and the liveness
 * thresholds apply without a second settings surface.
 */
export const monitoringLinkScopeSchema = z.object({
  kind: z.literal("monitoring_link"),
  /** Stable slug the alarm and the status feed report on, e.g. "zabbix-aggregator". */
  linkKey: z.string().trim().min(1).max(120),
  /** The company whose tasks the link writes and whose observers get the alarm. */
  companyId: z.string().guid(),
  /**
   * No-pulse threshold in seconds. The board's watchdog adds at most one sweep
   * interval on top, so the default (480s = 8 min) keeps detection inside the
   * 10-minute budget the issue asks for with the default 60s sweep.
   */
  staleAfterSec: z.coerce.number().int().min(60).max(86_400).default(480),
  /** Where the High alarm lands; resolved from the company when absent. */
  alertAssigneeAgentId: z.string().guid().optional().nullable(),
});

export type MonitoringLinkScope = z.infer<typeof monitoringLinkScopeSchema>;

export const boardApiKeyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["full", ...BOARD_API_KEY_ROLE_SCOPE_KINDS]) }),
  monitoringLinkScopeSchema,
]);

export type BoardApiKeyScope = z.infer<typeof boardApiKeyScopeSchema>;
export type BoardApiKeyScopeKind = BoardApiKeyScope["kind"];

/**
 * True when the scope belongs to a linking component's minimal-rights key.
 *
 * myrmidon(1.6.6 MONITORING E): this is not a discriminant check. Every caller
 * uses it to decide whether the narrow link rules apply — the middleware, the
 * company confinement in authz, the pulse endpoint — so a `monitoring_link`
 * scope that lost the policy fields it cannot work without must not count as
 * one. Failing closed here is what keeps a truncated row from being read as a
 * usable link key.
 */
export function isMonitoringLinkScope(
  scope: BoardApiKeyScope | null | undefined,
): scope is MonitoringLinkScope {
  return monitoringLinkScopeSchema.safeParse(scope).success;
}

/**
 * myrmidon(1.6.6 MONITORING E): a stored scope that is present but unreadable
 * must never widen to full access — a malformed role key would otherwise
 * silently become an operator key, which is exactly the escalation this
 * change exists to close. Only an absent scope (a key created before
 * ROLE-SCOPED-TOKENS, or created without one) keeps the backwards-compatible
 * full access, so existing operator and CLI flows stay unaffected.
 */
export function normalizeBoardApiKeyScope(value: unknown): BoardApiKeyScope {
  const parsed = boardApiKeyScopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (value === null || value === undefined) return { kind: "full" };
  // A bare string is what a hand-written or legacy row looks like. Honour it
  // when it names a kind explicitly — the narrowest reading of a readable
  // value — and fail closed on everything else, including a `monitoring_link`
  // scope that lost the policy fields it cannot work without.
  if (typeof value === "string") {
    const named = BOARD_API_KEY_ROLE_SCOPE_KINDS.find((kind) => kind === value);
    if (named) return { kind: named };
    if (value === "full") return { kind: "full" };
  }
  return { kind: "read_only" };
}

export const createBoardApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120).default("paperclipai cli"),
  expiresAt: z.coerce.date().optional().nullable(),
  requestedCompanyId: z.string().guid().optional().nullable(),
  // myrmidon(ROLE-SCOPED-TOKENS): optional scope; absent scope means full
  // access on the server. No zod default here — clients (CLI) parse payloads
  // through this schema before sending, and a default would silently add a
  // scope key to their wire contract.
  scope: boardApiKeyScopeSchema.optional(),
});

export type CreateBoardApiKey = z.infer<typeof createBoardApiKeySchema>;

export const updateMemberPermissionsSchema = z.object({
  grants: z.array(
    z.object({
      permissionKey: z.enum(PERMISSION_KEYS),
      scope: z.record(z.string(), z.unknown()).optional().nullable(),
    }),
  ),
});

export type UpdateMemberPermissions = z.infer<typeof updateMemberPermissionsSchema>;

const editableMembershipStatuses = ["pending", "active", "suspended"] as const;

export const updateCompanyMemberSchema = z.object({
  membershipRole: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES).optional().nullable(),
  status: z.enum(editableMembershipStatuses).optional(),
}).refine((value) => value.membershipRole !== undefined || value.status !== undefined, {
  message: "membershipRole or status is required",
});

export type UpdateCompanyMember = z.infer<typeof updateCompanyMemberSchema>;

export const updateCompanyMemberWithPermissionsSchema = z.object({
  membershipRole: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES).optional().nullable(),
  status: z.enum(editableMembershipStatuses).optional(),
  grants: updateMemberPermissionsSchema.shape.grants.default([]),
}).refine((value) => value.membershipRole !== undefined || value.status !== undefined, {
  message: "membershipRole or status is required",
});

export type UpdateCompanyMemberWithPermissions = z.infer<typeof updateCompanyMemberWithPermissionsSchema>;

export const archiveCompanyMemberSchema = z.object({
  reassignment: z
    .object({
      assigneeAgentId: z.string().guid().optional().nullable(),
      assigneeUserId: z.string().guid().optional().nullable(),
    })
    .optional()
    .nullable(),
}).superRefine((value, ctx) => {
  if (value.reassignment?.assigneeAgentId && value.reassignment.assigneeUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Choose either an agent or user reassignment target",
      path: ["reassignment"],
    });
  }
});

export type ArchiveCompanyMember = z.infer<typeof archiveCompanyMemberSchema>;

export const updateUserCompanyAccessSchema = z.object({
  companyIds: z.array(z.string().guid()).default([]),
});

export type UpdateUserCompanyAccess = z.infer<typeof updateUserCompanyAccessSchema>;

export const searchAdminUsersQuerySchema = z.object({
  query: z.string().trim().max(120).optional().default(""),
});

export type SearchAdminUsersQuery = z.infer<typeof searchAdminUsersQuerySchema>;

const profileImageAssetPathPattern = /^\/api\/assets\/[^/?#]+\/content(?:\?[^#]*)?(?:#.*)?$/;

function isValidProfileImage(value: string): boolean {
  if (profileImageAssetPathPattern.test(value)) return true;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const profileImageSchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine(isValidProfileImage, { message: "Invalid profile image URL" });

export const currentUserProfileSchema = z.object({
  id: z.string().min(1),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email().nullable(),
  ),
  name: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().min(1).max(120).nullable(),
  ),
  image: profileImageSchema.nullable(),
});

export type CurrentUserProfile = z.infer<typeof currentUserProfileSchema>;

export const authSessionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
  }),
  user: currentUserProfileSchema,
  // The front-end Sentry DSN for the current instance, or `null` when the
  // operator has set neither `SENTRY_DSN_FRONTEND` nor the legacy
  // `SENTRY_DSN`. Required, not optional: a missing value must fail the
  // response schema instead of silently disabling browser error
  // monitoring. The browser reads this value to open its own Sentry gate —
  // see `ui/src/lib/sentry.ts`.
  sentryDsn: z.string().min(1).nullable(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const updateCurrentUserProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  image: z
    .union([profileImageSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => value === "" ? null : value),
});

export type UpdateCurrentUserProfile = z.infer<typeof updateCurrentUserProfileSchema>;
