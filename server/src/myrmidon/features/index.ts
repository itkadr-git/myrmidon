// myrmidon(FEATURES): entry points of the Instance -> Features page.

import type { Db } from "@paperclipai/db";
import { featuresRoutes, sharedFeaturesService } from "./routes.js";

export { FEATURE_REGISTRY, findFeature } from "./registry.js";
export { featuresService, evaluateFeature, FeatureError } from "./service.js";
export { recordFeatureOutcome, recordFeatureFailure, summarizeFeatureOutcomes } from "./recorder.js";
export { readFeatureAttentionSignals, observeFeatureHealth } from "./attention.js";
export { startFeatureHealthSweep, stopFeatureHealthSweep } from "./sweep.js";
export type { FeatureDefinition, FeatureContext, FeaturePorts } from "./types.js";

/** Router for app.ts: GET /api/myrmidon/features, PATCH /api/myrmidon/features/:key. */
export function myrmidonFeaturesRoutes(db: Db) {
  return featuresRoutes(db, sharedFeaturesService(db));
}
