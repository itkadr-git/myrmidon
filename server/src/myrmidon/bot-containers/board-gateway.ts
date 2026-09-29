// server/src/myrmidon/bot-containers/board-gateway.ts
//
// myrmidon(W2a): the bot's OWN board tool gateway, as a reconcile over injected
// operations. The database-bound operations live in board-gateway-ports.ts; the
// rules live here:
//
//   - One gateway per bot AND per assignment digest, owned by the bot (its agent id
//     is on the gateway). A bot gets only its own gateway, and no token is ever
//     shared between bots or with the instance-wide MYRMIDON_BOT_MCP_SERVERS.
//   - A changed assignment is a NEW gateway, never a switched profile: switching a
//     live gateway to another profile adds a binding and leaves the old one, so the
//     gateway would serve the union of both and a revoked tool would stay reachable.
//     The previous gateway is disabled and its tokens revoked in the same pass,
//     before the new one is made: an assignment that shrank takes effect at once.
//     The new gateway has a new address, so the bot's profile changes and the bot
//     restarts through the reconciler's usual drain.
//   - The bot's token is a `gateway_client` token that expires (30 days), kept as a
//     company secret. It is reused while it is a live token of the CURRENT gateway
//     with more than 10 days left; the reconciler calls this once a minute per bot,
//     so a value that changed on every call would restart the bot every minute.
//   - A rotated-out token stays valid for a day (the bot restarts on the new one
//     through the drain, and a long run still holds the old one), then is revoked.
//   - Creating is all-or-nothing from the caller's side: if the new token cannot be
//     stored as the secret it is revoked, so nothing is left active that no secret
//     can reveal.
//   - Only gateways this module made are touched (marked by their metadata); a
//     gateway an operator made by hand for the same agent is never disabled here.
//   - With no assignment (nothing assigned, the setting off) every gateway of the
//     bot is released and nothing is delivered.

/** The name the bot's board tool gateway server carries in its profile: the same name hermes_local uses. */
export const BOT_BOARD_GATEWAY_SERVER_NAME = "paperclip-assigned";

/** The setting that turns per-bot board gateways off (default: on). */
export const BOT_BOARD_GATEWAY_ENV = "MYRMIDON_BOT_BOARD_GATEWAY";

/** The metadata marker of a gateway made here. */
export const BOT_GATEWAY_SOURCE = "myrmidon_bot_containers";

/** The name the bot's gateway token carries in the token table, so an operator can see what it is for. */
export const BOT_GATEWAY_TOKEN_NAME = "myrmidon-bot-container";

export const BOT_GATEWAY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BOT_GATEWAY_TOKEN_RENEW_BEFORE_MS = 10 * 24 * 60 * 60 * 1000;
export const BOT_GATEWAY_TOKEN_STRAY_GRACE_MS = 24 * 60 * 60 * 1000;

export function botGatewaySecretName(agentId: string): string {
  return `myrmidon-bot-${agentId}-board-gateway-token`;
}

/** `MYRMIDON_BOT_BOARD_GATEWAY`: on unless `0`, `false`, `no` or `off`. */
export function isBotBoardGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BOT_BOARD_GATEWAY_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

/** The address of a gateway on the board: the board's origin (as the container reaches it), no `/api`. */
export function botBoardGatewayUrl(boardUrl: string, gatewayPublicId: string): string {
  const base = boardUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  return `${base}/mcp/gateways/${gatewayPublicId}`;
}

export interface BotToolAssignment {
  /** Identifies exactly which connections and tools are assigned: a different set is a different digest. */
  digest: string;
  /** The immutable profile of this assignment, created when it is not there yet; returns its id. */
  ensureProfile(): Promise<string>;
}

export interface BotGatewayRecord {
  id: string;
  /** The `gw_...` id in the gateway's public address. */
  publicId: string;
  digest: string;
}

export interface BotGatewayTokenRecord {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface BotBoardGatewayDeps {
  /** What the agent is assigned now; `assignment` is null when there is nothing to deliver. */
  resolveAssignment(): Promise<{ assignment: BotToolAssignment | null; warnings: string[] }>;
  /** Active gateways THIS module made for the agent. */
  listGateways(): Promise<BotGatewayRecord[]>;
  /** A gateway of this assignment for the agent; idempotent for one digest. */
  createGateway(input: { digest: string; profileId: string }): Promise<BotGatewayRecord>;
  disableGateway(gatewayId: string): Promise<void>;
  /** The secret's current value, or null when the secret does not exist. */
  readSecret(): Promise<{ secretId: string; value: string } | null>;
  /** Stores the token as the secret's value: a new version of an existing secret, or a new secret. */
  storeSecret(existing: { secretId: string } | null, token: string): Promise<void>;
  /** The live (not revoked, not expired) token of this gateway whose value is `token`; null when none. */
  findLiveTokenByValue(gatewayId: string, token: string): Promise<BotGatewayTokenRecord | null>;
  /** Every token of this gateway that carries `BOT_GATEWAY_TOKEN_NAME` and is not revoked. */
  listActiveTokens(gatewayId: string): Promise<BotGatewayTokenRecord[]>;
  /** Issues a token; its value is only available here. */
  createToken(gatewayId: string, expiresAt: Date): Promise<{ id: string; token: string }>;
  revokeToken(tokenId: string): Promise<void>;
  now?(): Date;
}

export interface EnsuredBotBoardGateway {
  /** Null when nothing is delivered to the bot. */
  gateway: { publicId: string; token: string } | null;
  /** Cleanup or assignment notes that did not fail the call. Cleanup is retried on the next call. */
  warnings: string[];
}

async function quietly(warnings: string[], what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    warnings.push(`board gateway: ${what} failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Revokes the gateway's tokens, then disables it. A failed step is reported and
 * retried on the next call: the gateway is listed while it is active, so it goes
 * last, and nothing is left with a live token behind a disabled gateway.
 */
async function releaseGateway(deps: BotBoardGatewayDeps, gateway: BotGatewayRecord, warnings: string[]): Promise<void> {
  try {
    for (const token of await deps.listActiveTokens(gateway.id)) await deps.revokeToken(token.id);
  } catch (err) {
    warnings.push(
      `board gateway: revoking the tokens of gateway ${gateway.publicId} failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  await quietly(warnings, `disabling gateway ${gateway.publicId}`, () => deps.disableGateway(gateway.id));
}

async function ensureToken(deps: BotBoardGatewayDeps, gatewayId: string, now: Date, warnings: string[]): Promise<string> {
  const existing = await deps.readSecret();

  if (existing && existing.value.trim()) {
    const live = await deps.findLiveTokenByValue(gatewayId, existing.value);
    if (live && live.expiresAt && live.expiresAt.getTime() - now.getTime() > BOT_GATEWAY_TOKEN_RENEW_BEFORE_MS) {
      if (now.getTime() - live.createdAt.getTime() >= BOT_GATEWAY_TOKEN_STRAY_GRACE_MS) {
        await quietly(warnings, "revoking superseded tokens", async () => {
          for (const token of await deps.listActiveTokens(gatewayId)) {
            if (token.id !== live.id) await deps.revokeToken(token.id);
          }
        });
      }
      return existing.value;
    }
  }

  // No secret, an empty one, a token of another (older) gateway, a revoked or expired one, or one about to expire.
  const created = await deps.createToken(gatewayId, new Date(now.getTime() + BOT_GATEWAY_TOKEN_TTL_MS));
  try {
    await deps.storeSecret(existing ? { secretId: existing.secretId } : null, created.token);
  } catch (err) {
    // The caller sees the original failure: a failed compensation must not mask it.
    await quietly(warnings, `revoking token ${created.id} after the secret could not be stored`, () => deps.revokeToken(created.id));
    throw err;
  }
  return created.token;
}

export async function ensureBotBoardGateway(deps: BotBoardGatewayDeps): Promise<EnsuredBotBoardGateway> {
  const now = (deps.now ?? (() => new Date()))();
  const warnings: string[] = [];
  const resolved = await deps.resolveAssignment();
  warnings.push(...resolved.warnings);
  const active = await deps.listGateways();

  if (!resolved.assignment) {
    for (const gateway of active) await releaseGateway(deps, gateway, warnings);
    return { gateway: null, warnings };
  }

  const { digest } = resolved.assignment;
  let current = active.find((gateway) => gateway.digest === digest) ?? null;
  // Anything else is an older assignment: released BEFORE the new gateway is made.
  for (const gateway of active) {
    if (gateway !== current) await releaseGateway(deps, gateway, warnings);
  }
  if (!current) {
    const profileId = await resolved.assignment.ensureProfile();
    current = await deps.createGateway({ digest, profileId });
  }

  const token = await ensureToken(deps, current.id, now, warnings);
  return { gateway: { publicId: current.publicId, token }, warnings };
}
