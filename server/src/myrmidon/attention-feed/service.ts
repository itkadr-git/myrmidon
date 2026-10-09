import {
  ATTENTION_FEED_BOUNDS,
  ATTENTION_FEED_LIMIT_KEYS,
  ATTENTION_FEED_UPDATED_ACTION,
  attentionFeedStoredPatch,
  mergeAttentionFeedSettings,
  resolveAttentionFeedSettings,
  type AttentionFeedBounds,
  type AttentionFeedLimitKey,
  type AttentionFeedLimitSource,
  type AttentionFeedSettings,
  type AttentionFeedSettingsPatch,
  type AttentionFeedStoredPatch,
  type StoredAttentionFeedSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { LogActivityInput } from "../../services/activity-log.js";

/**
 * Read and change the attention-feed windows without a restart (myrmidon
 * 1.6.6 SETTINGS-UI, part C-4).
 *
 * Contract: `instance_settings.general.attentionFailedRunHorizonDays` and
 * `.attentionFeedCacheTtlSeconds` are the source of truth once an operator
 * saves them; there is no environment variable, so the built-in default (7
 * days, 45 s) is the only fallback. The feed re-reads the row on the next
 * build — `server/src/services/attention.ts` keeps its settings read behind a
 * short memo — so a PATCH applies without a restart, and no runtime has to be
 * rebuilt here.
 */

export interface AttentionFeedActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export interface AttentionFeedView {
  settings: AttentionFeedSettings;
  sources: Record<AttentionFeedLimitKey, AttentionFeedLimitSource>;
  bounds: AttentionFeedBounds;
}

export interface AttentionFeedServiceDeps {
  settings: {
    getGeneral(): Promise<StoredAttentionFeedSettings>;
    updateGeneral(patch: AttentionFeedStoredPatch): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
}

export interface AttentionFeedService {
  read(): Promise<AttentionFeedView>;
  update(patch: AttentionFeedSettingsPatch, actor: AttentionFeedActor): Promise<AttentionFeedView>;
}

// One write at a time, in the order the requests arrive: two overlapping
// PATCHes would otherwise read the same "before" row and the loser would
// silently overwrite the winner's value with a stale one (the same queue the
// host-disk threshold uses).
let attentionFeedTransitionQueue: Promise<void> = Promise.resolve();

function withAttentionFeedTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = attentionFeedTransitionQueue.then(run);
  attentionFeedTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function attentionFeedService(deps: AttentionFeedServiceDeps): AttentionFeedService {
  async function read(): Promise<AttentionFeedView> {
    const general = await deps.settings.getGeneral();
    const resolved = resolveAttentionFeedSettings(general);
    return {
      settings: resolved.settings,
      sources: resolved.sources,
      bounds: ATTENTION_FEED_BOUNDS,
    };
  }

  return {
    read,

    update: (patch, actor) =>
      withAttentionFeedTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveAttentionFeedSettings(general);
        const next = mergeAttentionFeedSettings(before.settings, patch);
        const changedKeys = ATTENTION_FEED_LIMIT_KEYS.filter(
          (key) => before.settings[key] !== next[key],
        );

        // Only the keys the operator actually sent are written: the other stays
        // in whatever shape the row already had, so a row saved before this
        // route existed is not silently rewritten into an explicit default.
        await deps.settings.updateGeneral(attentionFeedStoredPatch(next, patch));

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: ATTENTION_FEED_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: "attention-feed",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { windows: next, changedKeys, actorType: actor.actorType },
          "attention feed windows updated without a restart",
        );
        return read();
      }),
  };
}

export type { AttentionFeedSettings, AttentionFeedSettingsPatch };