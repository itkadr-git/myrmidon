// myrmidon(BOT-ROLLOUT): the release bot-image rollout status and settings —
// the shared contract of the status API field and the instance-settings key,
// used by the server status route, the rollout settings panel and the agent
// card's "Release image" block.
//
// A bot "tracks the release" when its card names a digest-pinned image of one
// of the bot image repositories (classifyBotImageTracking in
// server/src/myrmidon/bot-containers/agent-config.ts). The rollout script then
// moves the card to the release's image of the SAME repository — which the
// script resolves from the registry at deploy time, so the SERVER never knows
// an exact target image. The rollout settings (busy-wait timeout, batch size,
// soft pause after a busy bot) live in `instance_settings.general` under
// BOT_IMAGE_ROLLOUT_SETTINGS_KEY and are editable from the instance settings
// page; each env variable stays the default and the upper bound (a stored
// value past the env cap reads as the cap, so the UI can never widen a
// deployment policy beyond what the operator allowed).

import { z } from "zod";

/** The `instance_settings.general` key the rollout settings are stored under. */
export const BOT_IMAGE_ROLLOUT_SETTINGS_KEY = "myrmidonBotImageRollout";

/** The env variable names the rollout script reads (scripts/myrmidon/deploy/). */
export const BOT_IMAGE_ROLLOUT_ENV = {
  botTimeoutSec: "MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC",
  batchSize: "MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE",
  busySoftPauseSec: "MYRMIDON_BOT_IMAGE_ROLLOUT_BUSY_SOFT_PAUSE_SEC",
} as const;

/** Hard module bounds, below any env value: the script itself clamps a batch
 *  over 5 and dies on a non-positive timeout, so the UI cannot write one. */
export const BOT_IMAGE_ROLLOUT_LIMITS = {
  botTimeoutSec: { min: 10, max: 86400 },
  batchSize: { min: 1, max: 5 },
  busySoftPauseSec: { min: 0, max: 3600 },
} as const;

const botTimeoutSecSchema = z.number().int().min(BOT_IMAGE_ROLLOUT_LIMITS.botTimeoutSec.min).max(BOT_IMAGE_ROLLOUT_LIMITS.botTimeoutSec.max);
const batchSizeSchema = z.number().int().min(BOT_IMAGE_ROLLOUT_LIMITS.batchSize.min).max(BOT_IMAGE_ROLLOUT_LIMITS.batchSize.max);
const busySoftPauseSecSchema = z.number().int().min(BOT_IMAGE_ROLLOUT_LIMITS.busySoftPauseSec.min).max(BOT_IMAGE_ROLLOUT_LIMITS.busySoftPauseSec.max);

/** The stored shape of `instance_settings.general.myrmidonBotImageRollout`. */
export const botImageRolloutSettingsSchema = z
  .object({
    /** How long one deferred (busy) bot is retried before its card keeps the
     *  old image and the sweep applies the release image later. */
    botTimeoutSec: botTimeoutSecSchema.optional(),
    /** Bot cards switched per batch (the script's hard cap is 5). */
    batchSize: batchSizeSchema.optional(),
    /** Soft pause after a busy bot before the batch moves on; 0 = off. */
    busySoftPauseSec: busySoftPauseSecSchema.optional(),
  })
  .strict();

export type BotImageRolloutSettings = z.infer<typeof botImageRolloutSettingsSchema>;

export const patchBotImageRolloutSettingsSchema = botImageRolloutSettingsSchema.partial();
export type BotImageRolloutSettingsPatch = z.infer<typeof patchBotImageRolloutSettingsSchema>;

/** A lenient view of the stored row: an unreadable object reads as absent. */
export const storedBotImageRolloutSettingsSchema = botImageRolloutSettingsSchema
  .partial()
  .optional()
  .catch(undefined);

/** The stored settings, or an empty override set when absent/corrupt. */
export function normalizeBotImageRolloutSettings(raw: unknown): BotImageRolloutSettings {
  const parsed = botImageRolloutSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

// --- rollout status (the status route's imageRollout field) ----------------

/** The image rollout verdict of one bot, answered by
 *  GET /api/myrmidon/agents/:id/bot-container/status as `imageRollout`.
 *  targetImage is null today: the rollout script resolves the release's
 *  digest-pinned image from the registry at deploy time, so the server has no
 *  exact target to report. */
export interface BotImageRolloutStatus {
  /** The card already names a release image of its repository (the rollout's
   *  is_release_ref verdict — a digest of one of the bot image repositories). */
  onReleaseImage: boolean;
  targetImage: string | null;
  /** Why the bot is not switched to the release image right now; null when it
   *  is on one. */
  reason: string | null;
}

/** The statuses the rollout switches a bot in (scripts/myrmidon/deploy/
 *  bot-image-rollout.sh: "idle | paused"); anything else is busy — an unknown
 *  status is treated as busy there, so the same is reported here. */
export const ROLLOUT_SWITCHABLE_AGENT_STATUSES = ["idle", "paused"] as const;

/**
 * The rollout verdict of one bot from its tracking category and its agent
 * status (the same source the rollout script reads — no docker query).
 */
export function resolveBotImageRolloutStatus(input: {
  tracking:
    | { category: "tracks_release"; image: string }
    | { category: "pinned"; image: string | null; reason: string }
    | { category: "not_applicable"; image: null; reason: string };
  agentStatus: string | null;
  /** Whether this instance knows a release bot image at all (a target the
   *  rollout could move the card to). Without one the verdict is
   *  "no release image configured" even for a tracking card. */
  hasReleaseImage: boolean;
}): BotImageRolloutStatus {
  const { tracking, agentStatus, hasReleaseImage } = input;
  if (tracking.category === "not_applicable") {
    return { onReleaseImage: false, targetImage: null, reason: `not_applicable: ${tracking.reason}` };
  }
  if (tracking.category === "pinned") {
    return { onReleaseImage: false, targetImage: null, reason: `pinned: ${tracking.reason}` };
  }
  if (agentStatus === null || !ROLLOUT_SWITCHABLE_AGENT_STATUSES.includes(agentStatus as (typeof ROLLOUT_SWITCHABLE_AGENT_STATUSES)[number])) {
    return {
      onReleaseImage: false,
      targetImage: null,
      reason: `agent busy (status ${agentStatus ?? "unknown"}): переключится при освобождении`,
    };
  }
  if (!hasReleaseImage) {
    return { onReleaseImage: false, targetImage: null, reason: "no release image configured" };
  }
  return { onReleaseImage: true, targetImage: null, reason: null };
}

// --- env + settings resolution ----------------------------------------------

/** The environment view the resolvers read: a plain string map, so the
 *  emitted .d.ts never names NodeJS.ProcessEnv (the shared package is also
 *  consumed by plugin authoring, where the Node types are absent). */
export type RolloutEnv = Record<string, string | undefined>;

/** The process environment of the caller, read without naming `process` in
 *  the module's type surface. */
function processEnv(): RolloutEnv {
  return (globalThis as { process?: { env?: RolloutEnv } }).process?.env ?? {};
}

function parseEnvInt(env: RolloutEnv, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** One resolved knob: the env value is the default AND the upper bound; the
 *  stored override wins only inside it (the source says where it came from). */
export interface ResolvedRolloutKnob {
  value: number;
  source: "env" | "settings" | "default";
  envCap: number;
}

function resolveKnob(input: {
  env: RolloutEnv;
  envName: string;
  envDefault: number;
  moduleMax: number;
  stored: number | undefined;
}): ResolvedRolloutKnob {
  const envValue = parseEnvInt(input.env, input.envName);
  const cap = Math.min(envValue ?? input.envDefault, input.moduleMax);
  if (input.stored !== undefined) {
    return { value: Math.min(input.stored, cap), source: "settings", envCap: cap };
  }
  if (envValue !== null) return { value: cap, source: "env", envCap: cap };
  return { value: cap, source: "default", envCap: cap };
}

/** The rollout settings in force: each knob resolved env→settings-override. */
export interface ResolvedBotImageRolloutSettings {
  botTimeoutSec: ResolvedRolloutKnob;
  batchSize: ResolvedRolloutKnob;
  busySoftPauseSec: ResolvedRolloutKnob;
}

/**
 * Resolve the rollout settings of an instance: env is the default and the
 * upper bound, `general.myrmidonBotImageRollout` overrides it inside the
 * bound. Pure — the caller reads the stored row (instance-settings) and hands
 * in `stored`; this module never touches the database.
 */
export function resolveBotImageRolloutSettings(
  env: RolloutEnv = processEnv(),
  stored?: unknown,
): ResolvedBotImageRolloutSettings {
  const settings = normalizeBotImageRolloutSettings(stored);
  return {
    botTimeoutSec: resolveKnob({
      env,
      envName: BOT_IMAGE_ROLLOUT_ENV.botTimeoutSec,
      envDefault: 900,
      moduleMax: BOT_IMAGE_ROLLOUT_LIMITS.botTimeoutSec.max,
      stored: settings.botTimeoutSec,
    }),
    batchSize: resolveKnob({
      env,
      envName: BOT_IMAGE_ROLLOUT_ENV.batchSize,
      envDefault: 5,
      moduleMax: BOT_IMAGE_ROLLOUT_LIMITS.batchSize.max,
      stored: settings.batchSize,
    }),
    busySoftPauseSec: resolveKnob({
      env,
      envName: BOT_IMAGE_ROLLOUT_ENV.busySoftPauseSec,
      envDefault: 0,
      moduleMax: BOT_IMAGE_ROLLOUT_LIMITS.busySoftPauseSec.max,
      stored: settings.busySoftPauseSec,
    }),
  };
}

/**
 * Whether the instance knows a release bot image the rollout could move a
 * card to: today there is no such server-side signal (the rollout script
 * resolves it from the registry at deploy time), so this reads the reserved
 * env knob MYRMIDON_BOT_RELEASE_IMAGE — set it to the digest-pinned release
 * image reference (any of the three bot repositories) and the status API
 * reports real on/off-the-current-image verdicts; unset, a tracking bot
 * reports "no release image configured". myrmidon(BOT-ROLLOUT): when part A
 * lands a registry-resolved signal, this becomes its reader.
 */
export const BOT_RELEASE_IMAGE_ENV = "MYRMIDON_BOT_RELEASE_IMAGE";

export function hasReleaseBotImage(env: RolloutEnv = processEnv()): boolean {
  const raw = env[BOT_RELEASE_IMAGE_ENV]?.trim();
  return typeof raw === "string" && raw.length > 0;
}
