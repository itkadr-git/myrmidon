// server/src/myrmidon/channel-allowlist/service.ts
//
// myrmidon(CA-A): the channel allowlist service — who may write to the
// company's bots, in the general channel layer (OPE-4949: Telegram is the
// first consumer, MAX/WhatsApp/mail reuse the same mechanism). Admission is
// by the channel identity (provider user id / handle); a board account is
// optional (owner clarification 06.10).
//
// Two halves:
//   - CRUD for the board screen (list/create/revoke), audited through the
//     activity log like every mutating board surface;
//   - the decision + refusal side the chat layer calls: `admitChannelWriter`
//     (is this sender on the list?) and `raiseChannelAccessRequest` (a person
//     outside the list is not served — the owner or a designated admin gets
//     an access-request card on the board, once per sender per UTC day).
//
// Rights on the writer (Part B) attach to the row later; the row shape
// already reserves the place (one row per person per scope).

import { and, desc, eq, sql } from "drizzle-orm";
import {
  chatEndpoints,
  chatExternalPrincipals,
  companyMemberships,
  myrmidonChannelAllowedUsers,
  type Db,
} from "@paperclipai/db";
import {
  CHANNEL_ALLOWLIST_ACTIONS,
  channelAccessRequestTitle,
  type ChannelAllowedUser,
  type ChannelAllowlistScope,
  type ChatProvider,
  type ChannelAllowlistStatus,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { badRequest, notFound } from "../../errors.js";
import { issueService } from "../../services/issues.js";
import { logActivity } from "../../services/activity-log.js";

type AllowedUserRow = typeof myrmidonChannelAllowedUsers.$inferSelect;

function toView(row: AllowedUserRow): ChannelAllowedUser {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    externalId: row.externalId,
    handle: row.handle,
    displayName: row.displayName,
    scope: row.scope as ChannelAllowlistScope,
    endpointId: row.endpointId,
    boardUserId: row.boardUserId,
    status: row.status as ChannelAllowlistStatus,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `@alice`, `alice` and `AlIce` are the same handle for matching. */
export function normalizeChannelHandle(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^@+/, "").toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * The admission decision as a pure function over candidate rows: an active
 * row admits when it covers the whole company, or the exact endpoint the
 * message arrived at, and the person matches by provider id or (when both
 * sides carry a handle) by case-insensitive handle. Revoked rows never
 * admit — they stay for audit.
 */
export function isAdmittedByRows(
  rows: ReadonlyArray<Pick<AllowedUserRow, "provider" | "externalId" | "handle" | "scope" | "endpointId" | "status">>,
  input: {
    provider: ChatProvider;
    externalId: string;
    handle: string | null;
    endpointId: string;
  },
): boolean {
  const wantHandle = normalizeChannelHandle(input.handle);
  return rows.some((row) => {
    if (row.status !== "active") return false;
    if (row.provider !== input.provider) return false;
    if (row.scope === "endpoint" && row.endpointId !== input.endpointId) return false;
    const rowHandle = normalizeChannelHandle(row.handle);
    return (
      row.externalId === input.externalId ||
      (wantHandle !== null && rowHandle !== null && rowHandle === wantHandle)
    );
  });
}

/**
 * A handle that can run selects — the service's `Db` or a transaction. The
 * final task-mutation boundary (chat-channels' `lockCurrentPrincipal-
 * Authorization`) re-reads admission inside its own transaction so a
 * concurrent board revocation cannot race the inbound snapshot.
 */
export type ChannelAdmissionDb = Db;

/** Active rows for one company + provider (the decision reads them). */
export async function fetchAdmissionRows(
  db: ChannelAdmissionDb,
  companyId: string,
  provider: ChatProvider,
): Promise<AllowedUserRow[]> {
  return db
    .select()
    .from(myrmidonChannelAllowedUsers)
    .where(
      and(
        eq(myrmidonChannelAllowedUsers.companyId, companyId),
        eq(myrmidonChannelAllowedUsers.provider, provider),
        eq(myrmidonChannelAllowedUsers.status, "active"),
      ),
    );
}

/**
 * The gate the chat layer asks: is this unlinked channel writer on the
 * allowlist? A read failure denies (fail closed) but is logged — an
 * admission gate that fails open would silently admit strangers.
 */
export async function admitChannelWriter(
  db: ChannelAdmissionDb,
  input: {
    companyId: string;
    provider: ChatProvider;
    externalId: string;
    handle: string | null;
    endpointId: string;
  },
): Promise<boolean> {
  try {
    const rows = await fetchAdmissionRows(db, input.companyId, input.provider);
    return isAdmittedByRows(rows, input);
  } catch (error) {
    logger.warn({ err: error, companyId: input.companyId }, "myrmidon(CA-A): allowlist lookup failed, denying");
    return false;
  }
}

/**
 * The same decision from the principal row id — for the mutation-boundary
 * re-check where the caller has the id (inside its transaction) rather than
 * the resolved principal. Fail-closed like `admitChannelWriter`.
 */
export async function admitChannelPrincipal(
  database: ChannelAdmissionDb,
  input: {
    companyId: string;
    provider: ChatProvider;
    endpointId: string;
    principalId: string;
  },
): Promise<boolean> {
  try {
    const principal = await database
      .select({ externalId: chatExternalPrincipals.externalId, handle: chatExternalPrincipals.handle })
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.id, input.principalId),
          eq(chatExternalPrincipals.companyId, input.companyId),
        ),
      )
      .then((rows) => rows[0] ?? null)
    if (!principal) return false;
    const rows = await fetchAdmissionRows(database, input.companyId, input.provider);
    return isAdmittedByRows(rows, {
      provider: input.provider,
      externalId: principal.externalId,
      handle: principal.handle,
      endpointId: input.endpointId,
    });
  } catch (error) {
    logger.warn({ err: error, companyId: input.companyId }, "myrmidon(CA-A): principal admission re-check failed, denying");
    return false;
  }
}

/**
 * The people an access request goes to. The owner's rule names the owner
 * (or a designated administrator — that override arrives with Part C); the
 * chain falls through the board's admin tiers so the card reaches a
 * responsible human on every real company layout: owner → admin →
 * operator. A company with none of these answers empty: the refusal still
 * stands, only the card is not raised (a board with no administrator is
 * not the sender's problem, and inventing a recipient would be worse).
 */
export async function channelAccessRequestRecipients(
  db: Db,
  companyId: string,
): Promise<string[]> {
  for (const role of ["owner", "admin", "operator"] as const) {
    const rows = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, role),
        ),
      );
    if (rows.length > 0) return rows.map((row) => row.principalId);
  }
  return [];
}

/**
 * Raises the owner-facing access-request card on the board: one task per
 * sender per UTC day (the idempotency key carries the day, so a flood of
 * refused messages yields exactly one card). The task carries the channel
 * identity the owner needs to admit the person; nothing is executed for the
 * sender in the same turn.
 */
export async function raiseChannelAccessRequest(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    provider: ChatProvider;
    externalId: string;
    handle: string | null;
    displayName: string | null;
    now?: Date;
  },
): Promise<{ issueId: string; recipients: string[] } | null> {
  const recipients = await channelAccessRequestRecipients(db, input.companyId);
  if (recipients.length === 0) {
    logger.warn(
      { companyId: input.companyId },
      "myrmidon(CA-A): access request has no owner/admin recipient — refusing silently by rule, nothing executed",
    );
    return null;
  }
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const endpoint = await db
    .select({ botDisplayName: chatEndpoints.botDisplayName, botUsername: chatEndpoints.botUsername })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, input.companyId),
        eq(chatEndpoints.id, input.endpointId),
      ),
    )
    .then((rows) => rows[0] ?? null)
  const who = input.handle ? `@${input.handle}` : input.externalId;
  const issue = await issueService(db).create(
    input.companyId,
    {
      title: channelAccessRequestTitle(input.handle),
      description: [
        `Channel access request from ${input.provider} user ${who} (id ${input.externalId}).`,
        input.displayName ? `Display name: ${input.displayName}.` : null,
        `Bot endpoint: ${endpoint?.botDisplayName ?? (endpoint?.botUsername ? "@" + endpoint.botUsername : input.endpointId)}.`,
        "The sender's message was NOT executed. Add them to the channel allowlist to admit, or deny this request.",
      ]
        .filter(Boolean)
        .join("\n"),
      status: "todo",
      priority: "medium",
      // Board-side card: it waits on the owner, not on an agent.
      assigneeAgentId: null,
      responsibleUserId: recipients[0] ?? null,
      createdByUserId: null,
      originKind: "chat_channel",
      originId: `channel-access:${input.provider}:${input.externalId}:${day}`,
      idempotencyKey: `channel-access:${input.provider}:${input.externalId}:${day}`,
      // The recipient list is read from active owner/admin memberships, so
      // the explicit responsible user is trusted by construction.
      trustExplicitResponsibleUserId: true,
    },
    undefined,
  );
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "channel-allowlist",
    action: CHANNEL_ALLOWLIST_ACTIONS.accessRequested,
    entityType: "channel_access_request",
    entityId: issue.id,
    issueId: issue.id,
    details: {
      provider: input.provider,
      externalId: input.externalId,
      handle: input.handle,
      endpointId: input.endpointId,
      recipients,
    },
  });
  return { issueId: issue.id, recipients };
}

/** Everything the routes and the chat layer need from this module. */
export interface ChannelAllowlistService {
  list(companyId: string): Promise<ChannelAllowedUser[]>;
  create(
    companyId: string,
    input: {
      provider: ChatProvider;
      externalId: string;
      handle?: string | null;
      displayName?: string | null;
      scope: ChannelAllowlistScope;
      endpointId?: string | null;
      boardUserId?: string | null;
    },
    actor: { userId: string | null },
  ): Promise<ChannelAllowedUser>;
  update(
    companyId: string,
    id: string,
    patch: {
      handle?: string | null;
      displayName?: string | null;
      scope?: ChannelAllowlistScope;
      endpointId?: string | null;
      boardUserId?: string | null;
      status?: ChannelAllowlistStatus;
    },
    actor: { userId: string | null },
  ): Promise<ChannelAllowedUser>;
}

export function channelAllowlistService(db: Db): ChannelAllowlistService {
  return {
    async list(companyId) {
      const rows = await db
        .select()
        .from(myrmidonChannelAllowedUsers)
        .where(eq(myrmidonChannelAllowedUsers.companyId, companyId))
        .orderBy(desc(myrmidonChannelAllowedUsers.createdAt));
      return rows.map(toView);
    },

    async create(companyId, input, actor) {
      if (input.scope === "endpoint") {
        if (!input.endpointId) throw badRequest("scope 'endpoint' requires an endpointId");
        const endpoint = await db
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.companyId, companyId),
              eq(chatEndpoints.id, input.endpointId),
            ),
          )
          .then((rows) => rows[0] ?? null)
        if (!endpoint) throw badRequest("endpoint does not belong to this company");
      }
      const existing = await db
        .select()
        .from(myrmidonChannelAllowedUsers)
        .where(
          and(
            eq(myrmidonChannelAllowedUsers.companyId, companyId),
            eq(myrmidonChannelAllowedUsers.provider, input.provider),
            eq(myrmidonChannelAllowedUsers.externalId, input.externalId),
            eq(myrmidonChannelAllowedUsers.scope, input.scope),
            input.endpointId
              ? eq(myrmidonChannelAllowedUsers.endpointId, input.endpointId)
              : sql`${myrmidonChannelAllowedUsers.endpointId} is null`,
          ),
        )
        .then((rows) => rows[0] ?? null)
      // Re-admission of a revoked row updates it in place: one person, one
      // row per scope, so the audit trail keeps a single history per entry.
      if (existing) {
        const [row] = await db
          .update(myrmidonChannelAllowedUsers)
          .set({
            status: "active",
            handle: input.handle ?? existing.handle,
            displayName: input.displayName ?? existing.displayName,
            boardUserId: input.boardUserId ?? existing.boardUserId,
            addedBy: actor.userId ?? "board",
            updatedAt: new Date(),
          })
          .where(eq(myrmidonChannelAllowedUsers.id, existing.id))
          .returning();
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actor.userId ?? "board",
          action: CHANNEL_ALLOWLIST_ACTIONS.created,
          entityType: "channel_allowed_user",
          entityId: row.id,
          details: { provider: row.provider, externalId: row.externalId, handle: row.handle, scope: row.scope },
        });
        return toView(row);
      }
      const [row] = await db
        .insert(myrmidonChannelAllowedUsers)
        .values({
          companyId,
          provider: input.provider as never,
          externalId: input.externalId,
          handle: input.handle ?? null,
          displayName: input.displayName ?? null,
          scope: input.scope,
          endpointId: input.scope === "endpoint" ? (input.endpointId ?? null) : null,
          boardUserId: input.boardUserId ?? null,
          status: "active",
          addedBy: actor.userId ?? "board",
        })
        .returning();
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: CHANNEL_ALLOWLIST_ACTIONS.created,
        entityType: "channel_allowed_user",
        entityId: row.id,
        details: { provider: row.provider, externalId: row.externalId, handle: row.handle, scope: row.scope },
      });
      return toView(row);
    },

    async update(companyId, id, patch, actor) {
      const current = await db
        .select()
        .from(myrmidonChannelAllowedUsers)
        .where(
          and(
            eq(myrmidonChannelAllowedUsers.companyId, companyId),
            eq(myrmidonChannelAllowedUsers.id, id),
          ),
        )
        .then((rows) => rows[0] ?? null)
      if (!current) throw notFound("Channel allowlist entry not found");
      const nextScope = patch.scope ?? (current.scope as ChannelAllowlistScope);
      const nextEndpointId =
        patch.scope !== undefined
          ? nextScope === "endpoint"
            ? (patch.endpointId ?? null)
            : null
          : (patch.endpointId ?? current.endpointId);
      const [row] = await db
        .update(myrmidonChannelAllowedUsers)
        .set({
          handle: patch.handle !== undefined ? patch.handle : current.handle,
          displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
          scope: nextScope,
          endpointId: nextScope === "endpoint" ? nextEndpointId : null,
          boardUserId: patch.boardUserId !== undefined ? patch.boardUserId : current.boardUserId,
          status: patch.status ?? (current.status as ChannelAllowlistStatus),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(myrmidonChannelAllowedUsers.companyId, companyId),
            eq(myrmidonChannelAllowedUsers.id, id),
          ),
        )
        .returning();
      const action =
        patch.status === "revoked"
          ? CHANNEL_ALLOWLIST_ACTIONS.revoked
          : CHANNEL_ALLOWLIST_ACTIONS.updated;
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action,
        entityType: "channel_allowed_user",
        entityId: row.id,
        details: { provider: row.provider, externalId: row.externalId, handle: row.handle, scope: row.scope, status: row.status },
      });
      return toView(row);
    },
  };
}
