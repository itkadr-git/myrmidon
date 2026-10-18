import type { Db } from "@paperclipai/db";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { attentionFeedRoutes } from "./routes.js";
import {
  attentionFeedService,
  type AttentionFeedService,
  type AttentionFeedView,
} from "./service.js";

/**
 * Entry point of the attention-feed settings route (myrmidon 1.6.6 SETTINGS-UI,
 * part C-4).
 *
 * One service per server process, over the shared instance settings: the same
 * `instance_settings.general` row the attention feed reads on each build, so a
 * PATCH is visible to the next feed request without a restart. Startup does
 * nothing and no value is cached here — the feed's own read is the only cache,
 * bounded by `attentionFeedCacheTtlSeconds`.
 */

export { attentionFeedService } from "./service.js";
export type { AttentionFeedService, AttentionFeedView } from "./service.js";

export function myrmidonAttentionFeedRoutes(db: Db) {
  const settings = instanceSettingsService(db);
  const service: AttentionFeedService = attentionFeedService({
    settings: {
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
    },
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
  });
  return attentionFeedRoutes(db, service);
}