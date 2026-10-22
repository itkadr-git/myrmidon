// myrmidon(FEATURES): the registry of fork features.
//
// One entry per feature, in the order the page shows them before the health
// sort. To add a feature: write a `FeatureDefinition` (see types.ts), add it to
// the list below, and add its translations to the UI catalogs. A feature with
// no health signal still gets an entry: it reports `unknown`, which is more
// useful to an operator than an absent row.

import { agentMemoryFeature } from "./definitions/agent-memory.js";
import { botDiskFeature } from "./definitions/bot-disk.js";
import { botLspFeature } from "./definitions/bot-lsp.js";
import { budgetEnforcementFeature } from "./definitions/budget-enforcement.js";
import { chatHoldsFeature } from "./definitions/chat-holds.js";
import { costAttributionFeature } from "./definitions/cost-attribution.js";
import { hostDiskFeature } from "./definitions/host-disk.js";
import { modelFallbackFeature } from "./definitions/model-fallback.js";
import { pluginEntitlementsFeature } from "./definitions/plugin-entitlements.js";
import { runAdmissionFeature } from "./definitions/run-admission.js";
import { sharedPackageCacheFeature } from "./definitions/shared-package-cache.js";
import { swarmClaimFeature } from "./definitions/swarm-claim.js";
import { telegramDmStatusFeature } from "./definitions/telegram-dm-status.js";
import { workspaceHygieneFeature } from "./definitions/workspace-hygiene.js";
import type { FeatureDefinition } from "./types.js";

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
  swarmClaimFeature,
  runAdmissionFeature,
  botDiskFeature,
  sharedPackageCacheFeature,
  botLspFeature,
  agentMemoryFeature,
  costAttributionFeature,
  telegramDmStatusFeature,
  chatHoldsFeature,
  budgetEnforcementFeature,
  pluginEntitlementsFeature,
  hostDiskFeature,
  workspaceHygieneFeature,
  modelFallbackFeature,
];

export function findFeature(key: string): FeatureDefinition | undefined {
  return FEATURE_REGISTRY.find((feature) => feature.key === key);
}
