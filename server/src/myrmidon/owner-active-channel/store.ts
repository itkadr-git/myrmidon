// server/src/myrmidon/owner-active-channel/store.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): the owner's last activity per channel.
//
// Two touches, one table: a portal session request marks `web` (see the call
// site in middleware/auth.ts), an inbound Telegram DM marks `telegram` (see
// the call site in services/chat-channels.ts, next to the X8b bridge). The
// read side answers the one question the board needs: which channel is the
// owner active in right now — the freshest touch younger than the inactivity
// threshold. A touch write is advisory bookkeeping, never a request failure:
// `touchOwnerActivityBestEffort` swallows everything into a warning log.

import { and, eq, inArray } from "drizzle-orm";
import { myrmidonOwnerActivity, type Db } from "@paperclipai/db";
import {
  OWNER_CHANNELS,
  resolveActiveOwnerChannel,
  type OwnerChannel,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";

/** Read-only enough of a Db for the store; matches how the bridge takes handles. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Record that the owner was seen in `channel` now. An upsert on the
 * (user, channel) unique index: a touch never races, the latest write wins.
 */
export async function markOwnerActivity(
  db: DbOrTx,
  input: { userId: string; channel: OwnerChannel; at?: Date },
): Promise<void> {
  if (!input.userId) return;
  const at = input.at ?? new Date();
  await db
    .insert(myrmidonOwnerActivity)
    .values({ userId: input.userId, channel: input.channel, lastActiveAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [myrmidonOwnerActivity.userId, myrmidonOwnerActivity.channel],
      set: { lastActiveAt: at, updatedAt: at },
    });
}

/** The last touches of one board user, both channels; missing channel — null. */
export async function readOwnerActivity(
  db: DbOrTx,
  userId: string,
): Promise<Record<OwnerChannel, string | null>> {
  const out: Record<OwnerChannel, string | null> = { web: null, telegram: null };
  const rows = await db
    .select({
      channel: myrmidonOwnerActivity.channel,
      lastActiveAt: myrmidonOwnerActivity.lastActiveAt,
    })
    .from(myrmidonOwnerActivity)
    .where(
      and(
        eq(myrmidonOwnerActivity.userId, userId),
        inArray(myrmidonOwnerActivity.channel, [...OWNER_CHANNELS]),
      ),
    );
  for (const row of rows) {
    if ((OWNER_CHANNELS as readonly string[]).includes(row.channel)) {
      out[row.channel as OwnerChannel] = row.lastActiveAt.toISOString();
    }
  }
  return out;
}

/**
 * The channel the owner is active in, or null when every touch is older than
 * the threshold. Pure decision in `@paperclipai/shared`; this wrapper only
 * reads the touches.
 */
export async function resolveOwnerActiveChannel(
  db: DbOrTx,
  userId: string,
  options: { thresholdMin: number; now?: Date },
): Promise<OwnerChannel | null> {
  if (!userId) return null;
  const lastActiveAt = await readOwnerActivity(db, userId);
  return resolveActiveOwnerChannel(lastActiveAt, {
    thresholdMin: options.thresholdMin,
    now: options.now?.getTime(),
  });
}

// A session touches the store on every request; the debounce window keeps
// that to one write per user per window. Only the web channel needs it —
// Telegram messages arrive at human pace already.
const WEB_TOUCH_DEBOUNCE_MS = 30_000;
const lastWebTouch = new Map<string, number>();

/**
 * Fire-and-forget web touch for the middleware. Never awaited by the request
 * path and never throws: a failed write logs a warning and the next request
 * in the debounce window retries.
 */
export function touchWebActivityBestEffort(db: Db, userId: string): void {
  if (!userId) return;
  const now = Date.now();
  const seen = lastWebTouch.get(userId);
  if (seen !== undefined && now - seen < WEB_TOUCH_DEBOUNCE_MS) return;
  lastWebTouch.set(userId, now);
  markOwnerActivity(db, { userId, channel: "web" }).catch((err) => {
    lastWebTouch.delete(userId);
    logger.warn({ err, userId }, "owner web activity touch failed");
  });
}

/** Drop the debounce state (tests; the map is process-local by design). */
export function resetWebActivityTouchDebounce(): void {
  lastWebTouch.clear();
}

/**
 * Fire-and-forget touch for any channel (the Telegram intake path calls it).
 * Never awaited by the caller path and never throws.
 */
export function markOwnerActivityBestEffort(
  db: Db,
  input: { userId: string; channel: OwnerChannel },
): void {
  if (!input.userId) return;
  markOwnerActivity(db, input).catch((err) => {
    logger.warn({ err, userId: input.userId, channel: input.channel }, "owner activity touch failed");
  });
}
