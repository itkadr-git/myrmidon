// myrmidon(1.6.6 FEATURE-HEALTH): SWARM scent classifier feature definition.
//
// Health reports broken (misconfigured/failing) if:
// 1. The contour is unconfigured: missing baseUrl, missing secret in company secrets,
//    or model does not exist in LiteLLM gateway models.
// 2. >50% of classifications over the last hour failed (ok=false).
//
// Broken health triggers an attention feed card for domain owner (adm) and a Zabbix alert.

import {
  DEFAULT_SCENT_CLASSIFIER_MODEL,
  readScentSettings,
} from "@myrmidon/shared";
import { entry, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const SWARM_SCENT_FEATURE_KEY = "swarm-scent";

export const swarmScentFeature: FeatureDefinition = {
  key: SWARM_SCENT_FEATURE_KEY,
  name: "SWARM scent classifier",
  description:
    "Classifies role caste scent on incoming tasks via LiteLLM evaluations gateway.",
  docs: "docs/myrmidon/guides/features-page.md#swarm-scent",

  readConfig(ctx) {
    const settings = readScentSettings((ctx.general as Record<string, unknown> | null)?.swarm, ctx.env);
    const secretName =
      settings.apiKeySecretName?.trim() ||
      ctx.env.SCENT_KEY_SECRET_ENV?.trim() ||
      ctx.env.MYRMIDON_EVALS_API_KEY_SECRET?.trim() ||
      "MYRMIDON_EVALS_API_KEY";
    const baseUrl = ctx.ports.scent.baseUrl();

    return {
      enabled: settings.enabled,
      entries: [
        entry("Switch", settings.enabled ? "enabled" : "disabled", "settings"),
        entry("Model", settings.model || DEFAULT_SCENT_CLASSIFIER_MODEL, "settings"),
        entry("Secret", secretName, "settings"),
        entry("Base URL", baseUrl || "(not set)", baseUrl ? "env" : "default"),
      ],
    };
  },

  async health(ctx) {
    const settings = readScentSettings((ctx.general as Record<string, unknown> | null)?.swarm, ctx.env);
    if (!settings.enabled) {
      return makeHealth("off", "classifier is disabled in settings");
    }

    const baseUrl = ctx.ports.scent.baseUrl();
    if (!baseUrl) {
      return makeHealth(
        "misconfigured",
        "контур не настроен: нет базового URL (MYRMIDON_EVALS_BASE_URL)",
      );
    }

    const secretName =
      settings.apiKeySecretName?.trim() ||
      ctx.env.SCENT_KEY_SECRET_ENV?.trim() ||
      ctx.env.MYRMIDON_EVALS_API_KEY_SECRET?.trim() ||
      "MYRMIDON_EVALS_API_KEY";
    const hasSecret = await ctx.ports.scent.hasSecret(secretName);
    if (!hasSecret) {
      return makeHealth(
        "misconfigured",
        `контур не настроен: секрет ключа '${secretName}' отсутствует в компании`,
      );
    }

    const model = settings.model?.trim() || DEFAULT_SCENT_CLASSIFIER_MODEL;
    const modelInGateway = await ctx.ports.scent.isModelInGateway(model);
    if (!modelInGateway) {
      return makeHealth(
        "misconfigured",
        `контур не настроен: модель '${model}' отсутствует в шлюзе LiteLLM`,
      );
    }

    const hourAgo = new Date(ctx.now.getTime() - 3600_000);
    const { total, failed } = await ctx.ports.scent.stats(hourAgo);
    const base = {
      effect: { label: "classifications in the last hour", value: total },
      errors24h: failed,
      lastSuccessAt: null,
    };

    if (total > 0 && failed / total > 0.5) {
      const pct = Math.round((failed / total) * 100);
      return makeHealth(
        "failing",
        `>50% классификаций за час завершились ошибкой (${failed}/${total}, ${pct}%)`,
        base,
      );
    }

    if (total > 0) {
      return makeHealth(
        "working",
        `${total - failed}/${total} classifications succeeded in the last hour`,
        base,
      );
    }

    return makeHealth(
      "working",
      `classifier ready (${model}); no issues classified in the last hour`,
      base,
    );
  },
};
