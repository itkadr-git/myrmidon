// myrmidon(FEATURES): evaluates the registry into the report the page shows,
// and flips the inline toggles.
//
// One definition failing to evaluate never breaks the page: its row reports
// `unknown` with the reason, and the other rows are unaffected.

import type { Db } from "@paperclipai/db";
import {
  FEATURE_HEALTH_STATUSES,
  FEATURE_HEALTH_WINDOW_MS,
  type FeatureHealth,
  type FeaturesReport,
  type FeatureView,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { featureBrokenSince, observeFeatureHealth } from "./attention.js";
import { errorMessage, makeHealth } from "./health.js";
import { createDbFeaturePorts } from "./ports.js";
import { summarizeFeatureOutcomes, sanitizeOutcomeMessage } from "./recorder.js";
import { FEATURE_REGISTRY } from "./registry.js";
import type { FeatureActor, FeatureConfig, FeatureContext, FeatureDefinition, FeaturePorts } from "./types.js";

/** The report is cached this long: the page and the sweep share one evaluation. */
const REPORT_CACHE_MS = 20_000;

export class FeatureError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FeatureError";
  }
}

export interface FeaturesServiceDeps {
  db: Db;
  env?: Record<string, string | undefined>;
  ports?: FeaturePorts;
  registry?: readonly FeatureDefinition[];
  readGeneral?: () => Promise<Record<string, unknown>>;
  now?: () => Date;
}

export interface FeaturesService {
  report(options?: { fresh?: boolean }): Promise<FeaturesReport>;
  setEnabled(key: string, enabled: boolean, actor: FeatureActor): Promise<FeatureView>;
}

/** Evaluate one definition; a thrown error becomes an honest `unknown` row. */
export async function evaluateFeature(definition: FeatureDefinition, ctx: FeatureContext): Promise<FeatureView> {
  let config: FeatureConfig = { enabled: null, entries: [] };
  let health: FeatureHealth;
  try {
    config = await definition.readConfig(ctx);
    health = await definition.health(ctx, config);
  } catch (err) {
    const message = sanitizeOutcomeMessage(errorMessage(err));
    health = makeHealth("unknown", `unknown — the health check could not run: ${message}`, {
      lastError: { at: ctx.now.toISOString(), message },
    });
  }
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    docs: definition.docs,
    enabled: config.enabled,
    config: config.entries,
    settings: definition.settings ?? null,
    toggle: definition.setEnabled && config.toggle ? config.toggle : null,
    health,
    needsAttentionSince: null,
  };
}

export function summarizeStatuses(features: readonly FeatureView[]): FeaturesReport["summary"] {
  const summary = Object.fromEntries(FEATURE_HEALTH_STATUSES.map((status) => [status, 0])) as FeaturesReport["summary"];
  for (const feature of features) summary[feature.health.status] += 1;
  return summary;
}

export function featuresService(deps: FeaturesServiceDeps): FeaturesService {
  const env = deps.env ?? process.env;
  const registry = deps.registry ?? FEATURE_REGISTRY;
  const ports = deps.ports ?? createDbFeaturePorts(deps.db);
  const now = deps.now ?? (() => new Date());
  const readGeneral =
    deps.readGeneral ??
    (async () => (await instanceSettingsService(deps.db).getGeneral()) as unknown as Record<string, unknown>);

  let cache: { at: number; report: FeaturesReport } | null = null;

  async function context(): Promise<FeatureContext> {
    const at = now();
    return {
      env,
      general: await readGeneral(),
      now: at,
      since: new Date(at.getTime() - FEATURE_HEALTH_WINDOW_MS),
      ports,
      outcomes: (key) => summarizeFeatureOutcomes(key, at),
    };
  }

  async function evaluate(): Promise<FeaturesReport> {
    const ctx = await context();
    const features = await Promise.all(registry.map((definition) => evaluateFeature(definition, ctx)));
    observeFeatureHealth(
      features.map((feature) => ({
        key: feature.key,
        name: feature.name,
        status: feature.health.status,
        reason: feature.health.reason,
      })),
      ctx.now,
    );
    for (const feature of features) feature.needsAttentionSince = featureBrokenSince(feature.key);
    return { checkedAt: ctx.now.toISOString(), features, summary: summarizeStatuses(features) };
  }

  async function report(options: { fresh?: boolean } = {}): Promise<FeaturesReport> {
    const at = now().getTime();
    if (!options.fresh && cache && at - cache.at < REPORT_CACHE_MS) return cache.report;
    const next = await evaluate();
    cache = { at, report: next };
    return next;
  }

  return {
    report,
    async setEnabled(key, enabled, actor) {
      const definition = registry.find((item) => item.key === key);
      if (!definition) throw new FeatureError(404, `unknown feature: ${key}`);
      const ctx = await context();
      const before = await evaluateFeature(definition, ctx);
      if (!definition.setEnabled || !before.toggle) {
        throw new FeatureError(422, "this feature has no inline switch; change it in its settings panel");
      }
      if (before.toggle.lockedBy === "env") {
        throw new FeatureError(409, "an environment variable forces this value; change the variable instead");
      }
      await definition.setEnabled({ ...ctx, db: deps.db }, enabled, actor);
      cache = null;
      const after = (await report({ fresh: true })).features.find((feature) => feature.key === key);
      if (!after) throw new FeatureError(404, `unknown feature: ${key}`);
      return after;
    },
  };
}
