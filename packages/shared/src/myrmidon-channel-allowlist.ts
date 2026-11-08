import { z } from "zod";
import { CHAT_PROVIDERS } from "./types/chat-channels.js";

/**
 * myrmidon(CA-A): the channel allowlist contract — who may write to the
 * company's bots. The owner's rule (OPE-4949): admission is by the channel
 * identity (a Telegram id / @username), a board account is optional. The
 * mechanism is provider-general (Telegram first, then MAX, WhatsApp, mail);
 * this module is the shared wire contract behind the board screen and the
 * server gate.
 */

/** Admission scope: every bot of the company, or one specific endpoint. */
export const CHANNEL_ALLOWLIST_SCOPES = ["company", "endpoint"] as const;
export type ChannelAllowlistScope = (typeof CHANNEL_ALLOWLIST_SCOPES)[number];

/** A row is active or revoked; revoked never admits but keeps audit memory. */
export const CHANNEL_ALLOWLIST_STATUSES = ["active", "revoked"] as const;
export type ChannelAllowlistStatus = (typeof CHANNEL_ALLOWLIST_STATUSES)[number];

/** One allowlist record as the API returns it. */
export interface ChannelAllowedUser {
  id: string;
  companyId: string;
  provider: string;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  scope: ChannelAllowlistScope;
  endpointId: string | null;
  boardUserId: string | null;
  status: ChannelAllowlistStatus;
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A channel user id: the provider's own identifier, trimmed, bounded. */
const externalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:@+-]+$/, "externalId must be a channel user id");

/** A handle stored with the leading `@` stripped; letters, digits, dot, dash, underscore. */
const handleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ""))
  .pipe(z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "handle is not a valid username"));

export const channelAllowedUserCreateSchema = z
  .object({
    provider: z.enum(CHAT_PROVIDERS),
    externalId: externalIdSchema,
    handle: handleSchema.nullish(),
    displayName: z.string().trim().min(1).max(200).nullish(),
    scope: z.enum(CHANNEL_ALLOWLIST_SCOPES).default("company"),
    endpointId: z.string().regex(UUID_RE).nullable().optional(),
    boardUserId: z.string().regex(UUID_RE).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "endpoint" && !value.endpointId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointId"],
        message: "scope 'endpoint' requires an endpointId",
      });
    }
    if (value.scope === "company" && value.endpointId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointId"],
        message: "scope 'company' must not carry an endpointId",
      });
    }
  });
export type ChannelAllowedUserCreate = z.infer<typeof channelAllowedUserCreateSchema>;

export const channelAllowedUserUpdateSchema = z
  .object({
    handle: handleSchema.nullable().optional(),
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    scope: z.enum(CHANNEL_ALLOWLIST_SCOPES).optional(),
    endpointId: z.string().regex(UUID_RE).nullable().optional(),
    boardUserId: z.string().regex(UUID_RE).nullable().optional(),
    status: z.enum(CHANNEL_ALLOWLIST_STATUSES).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "company" && value.endpointId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointId"],
        message: "scope 'company' must not carry an endpointId",
      });
    }
  });
export type ChannelAllowedUserUpdate = z.infer<typeof channelAllowedUserUpdateSchema>;

/** Activity-log actions of the allowlist (the board journal). */
export const CHANNEL_ALLOWLIST_ACTIONS = {
  created: "channel_allowlist.created",
  updated: "channel_allowlist.updated",
  revoked: "channel_allowlist.revoked",
  /** An unadmitted writer was refused and an access request was raised. */
  accessRequested: "channel_allowlist.access_requested",
  /** A refusal answered to the writer (one line, no details). */
  refused: "channel_allowlist.refused",
} as const;

/**
 * The one-line refusal the writer sees (owner rule: an answer, no details).
 * Board UI and server both reference it so the text stays identical.
 */
export const CHANNEL_ALLOWLIST_REFUSAL_TEXT =
  "Доступ к этому боту не предоставлен. Запрос передан владельцу.";

/** The access-request card title shown to the owner/admin. */
export function channelAccessRequestTitle(handle: string | null): string {
  return handle
    ? `Запрос доступа к боту от @${handle}`
    : "Запрос доступа к боту от пользователя канала";
}
