// server/src/myrmidon/bot-containers/agent-config.ts
//
// Pure helpers for reading a bot's container settings off its card. Kept separate
// from index.ts (which also wires up the real maintenance service, pulling in
// server/src/services) so these can be unit tested without loading that chain —
// the same reason server/src/myrmidon/maintenance/index.ts has no direct test file
// of its own: everything testable in it is pushed down into domain.ts/service.ts.

import type { BotContainerSpec, BotExtraMount } from "./driver.js";
import { BOT_KEY_PATTERN } from "./template.js";

export const BOT_CONTAINERS_ENV = "MYRMIDON_BOT_CONTAINERS";

export function isBotContainersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BOT_CONTAINERS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

/**
 * The product defaults of a container card's limits: what the card form writes
 * when the section is switched on (ui/src/components/myrmidon/botContainerConfig.ts),
 * what the bot image rollout enrolls a card without limits with, and what the
 * migration that completed legacy cards used. There is one set for every bot
 * image family (hermes, hermes-dev, hermes-node): no per-family limits exist.
 */
export const BOT_CONTAINER_DEFAULTS = { memoryMb: 2048, cpus: 1, pidsLimit: 512 } as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * myrmidon(1.6.4-BOT-CONTAINER-CARD): why a card's `container` block may not be
 * SAVED, or null. A block must say `enabled` (true or false) and, while enabled,
 * carry positive `memoryMb`, `cpus` and `pidsLimit` — a card without them is
 * refused by the reconciler at apply time ("container.enabled is not true",
 * "container.memoryMb must be a positive number"), which is too late and too
 * quiet for whoever saved it. A card without a `container` block is fine, and
 * so is any other adapter type.
 */
export function botContainerCardSaveProblem(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (adapterType !== HERMES_GATEWAY_ADAPTER_TYPE) return null;
  const raw = adapterConfig?.container;
  if (raw === undefined || raw === null) return null;
  if (!isPlainRecord(raw)) return "adapterConfig.container must be an object";
  if (typeof raw.enabled !== "boolean") {
    return "adapterConfig.container.enabled must be true or false: a container block without it is never applied";
  }
  if (raw.enabled !== true) return null;
  const { memoryMb, cpus, pidsLimit } = raw;
  const missing: string[] = [];
  if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || memoryMb <= 0) missing.push("memoryMb (a positive number)");
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0) missing.push("cpus (a positive number)");
  if (typeof pidsLimit !== "number" || !Number.isInteger(pidsLimit) || pidsLimit <= 0) missing.push("pidsLimit (a positive integer)");
  if (missing.length > 0) {
    return `adapterConfig.container is enabled but lacks ${missing.join(", ")}; defaults are memoryMb ${BOT_CONTAINER_DEFAULTS.memoryMb}, cpus ${BOT_CONTAINER_DEFAULTS.cpus}, pidsLimit ${BOT_CONTAINER_DEFAULTS.pidsLimit}`;
  }
  return null;
}

/** How a bot follows the release's bot image (myrmidon(1.6.4-BOT-CONTAINER-CARD)). */
export type BotImageTracking =
  | { category: "tracks_release"; image: string }
  | { category: "pinned"; image: string | null; reason: string }
  | { category: "not_applicable"; image: null; reason: string };

/** A digest-pinned image of one of the three bot image repositories. Mirrors
 *  `release_image_for` of scripts/myrmidon/deploy/bot-image-rollout.sh. */
const RELEASE_BOT_IMAGE_PATTERN = /myrmidon-hermes(?:-dev|-node)?@sha256:[0-9a-f]{64}$/;

/**
 * The category a rollout puts a container bot in: it TRACKS the release (an
 * enabled, complete card whose image is a digest of one of our bot repositories:
 * the rollout moves it to the release image of that repository), is PINNED
 * (an enabled card on any other image or none: the rollout leaves it alone), or
 * is NOT APPLICABLE (no managed container: other adapter, no block, disabled,
 * incomplete). Shared by the status API and mirrored in the rollout script, so
 * a bot is never skipped without being named.
 */
export function classifyBotImageTracking(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): BotImageTracking {
  const parsed = readBotContainerAgentConfig(adapterType, adapterConfig);
  if (!parsed.ok) return { category: "not_applicable", image: null, reason: parsed.reason };
  if (RELEASE_BOT_IMAGE_PATTERN.test(parsed.config.image.trim())) {
    return { category: "tracks_release", image: parsed.config.image.trim() };
  }
  return {
    category: "pinned",
    image: parsed.config.image.trim(),
    reason: "the card names an image that is not a digest of a bot image repository; the rollout does not move it",
  };
}

export interface BotContainerAgentConfig {
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** myrmidon(1.6.1-BOT-DISK-C): optional per-bot disk quota in MB on the card;
   *  wins over the instance-settings per-agent/per-caste/default quota. */
  diskQuotaMb?: number;
  /** `container.extraMounts`: extra read-only directories the bot sees (a shared
   *  sources directory, templates, common tools). Their sources are checked
   *  against MYRMIDON_BOT_MOUNT_SOURCES when the container template is built. */
  extraMounts: BotExtraMount[];
}

export type BotContainerAgentConfigResult =
  | { ok: true; config: BotContainerAgentConfig }
  | { ok: false; reason: string };

/** Why `container.group` is refused for now. A container shared by a project's
 *  bots (containers-plan-senior-2026-09-28.md §1.2) needs one spec and one
 *  profile for the whole group and a maintenance window over every member agent
 *  before its gateway restarts (§2.2 p.4); reconciling it per agent, from each
 *  member's own card, would recreate and rewrite the shared container from
 *  different cards and restart it under the other members' running work. */
export const CONTAINER_GROUP_UNSUPPORTED_REASON =
  "container.group (a container shared by several agents) is not supported yet: it needs one spec, one profile and a maintenance window over every member agent, which this reconciler does not provide";

/**
 * Reads `adapterConfig.container` off an agent's card. Only `hermes_gateway`
 * agents are eligible (containers-plan-senior-2026-09-28.md's G3 scope); anything
 * else, or a missing/incomplete/`enabled !== true` block, is reported as
 * not-applicable rather than thrown — a malformed card must not take a sweep of
 * other agents down. A card asking for a shared `group` container is refused the
 * same way (see CONTAINER_GROUP_UNSUPPORTED_REASON).
 */
export function readBotContainerAgentConfig(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): BotContainerAgentConfigResult {
  if (adapterType !== HERMES_GATEWAY_ADAPTER_TYPE) {
    return { ok: false, reason: `adapter type "${adapterType}" is not ${HERMES_GATEWAY_ADAPTER_TYPE}` };
  }
  const raw = adapterConfig?.container;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "adapterConfig.container is not set" };
  }
  const c = raw as Record<string, unknown>;
  if (c.enabled !== true) return { ok: false, reason: "adapterConfig.container.enabled is not true" };
  if (c.group !== undefined && c.group !== null) return { ok: false, reason: CONTAINER_GROUP_UNSUPPORTED_REASON };

  const { image, memoryMb, cpus, pidsLimit } = c;
  if (typeof image !== "string" || image.trim().length === 0) {
    return { ok: false, reason: "container.image must be a non-empty string" };
  }
  if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || memoryMb <= 0) {
    return { ok: false, reason: "container.memoryMb must be a positive number" };
  }
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0) {
    return { ok: false, reason: "container.cpus must be a positive number" };
  }
  if (typeof pidsLimit !== "number" || !Number.isInteger(pidsLimit) || pidsLimit <= 0) {
    return { ok: false, reason: "container.pidsLimit must be a positive integer" };
  }
  const extraMounts = readExtraMounts(c.extraMounts);
  if (!extraMounts.ok) return { ok: false, reason: extraMounts.reason };
  // myrmidon(1.6.1-BOT-DISK-C): an optional per-bot disk quota on the card.
  const diskQuotaMb =
    typeof c.diskQuotaMb === "number" && Number.isInteger(c.diskQuotaMb) && c.diskQuotaMb > 0 ? c.diskQuotaMb : undefined;
  return { ok: true, config: { image, memoryMb, cpus, pidsLimit, extraMounts: extraMounts.mounts, ...(diskQuotaMb !== undefined ? { diskQuotaMb } : {}) } };
}

/**
 * Reads `container.extraMounts`. Structural only — a missing field means "no
 * extra mounts", an entry that is not `{source, path, readOnly?}` is refused
 * with the field named. Whether the source may be mounted at all (the
 * instance allowlist) is the driver's decision (template.ts
 * validateExtraMounts), so a card outside the allowlist is refused where the
 * container is built, with the security boundary and the card reader kept
 * apart.
 */
function readExtraMounts(
  raw: unknown,
): { ok: true; mounts: BotExtraMount[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, mounts: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "container.extraMounts must be an array" };
  const mounts: BotExtraMount[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `container.extraMounts[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `${where} must be an object` };
    }
    const mount = entry as Record<string, unknown>;
    if (typeof mount.source !== "string" || mount.source.trim().length === 0) {
      return { ok: false, reason: `${where}.source must be a non-empty string` };
    }
    if (typeof mount.path !== "string" || !mount.path.startsWith("/")) {
      return { ok: false, reason: `${where}.path must be an absolute container path` };
    }
    if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
      return { ok: false, reason: `${where}.readOnly must be a boolean` };
    }
    if (mount.readOnly === false) {
      return {
        ok: false,
        reason: `${where}.readOnly=false is not supported: a shared directory is only mounted read-only`,
      };
    }
    mounts.push({ source: mount.source, containerPath: mount.path, readOnly: true });
  }
  return { ok: true, mounts };
}

/** One container per bot, keyed by its agent id; null when the id cannot be a
 *  bot key (agent ids are lowercase uuids, which always can). */
export function botKeyForAgent(agentId: string): string | null {
  return BOT_KEY_PATTERN.test(agentId) ? agentId : null;
}

export function botContainerSpec(botKey: string, config: BotContainerAgentConfig, network: string): BotContainerSpec {
  return {
    botKey,
    image: config.image,
    memoryMb: config.memoryMb,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    network,
    extraMounts: config.extraMounts,
  };
}
