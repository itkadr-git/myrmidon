// server/src/myrmidon/features/definitions/github-app-identity.ts
//
// myrmidon(FEATURES): the GitHub App identity feature.
//
// Health source: activity_log entries for GitHub App token minting:
// - `myrmidon.github_app.issued`
// - `myrmidon.github_app.denied`
//
// Broken when denied share > 50% over 10 min, or 0 issued when >= 5 denied.

import { entry, healthOff, iso, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const GITHUB_APP_IDENTITY_FEATURE_KEY = "github-app-identity";
const GITHUB_SHARED_IDENTITY_GENERAL_KEY = "myrmidonGithubSharedIdentity";
const TEN_MINUTES_MS = 10 * 60_000;

export const githubAppIdentityFeature: FeatureDefinition = {
  key: GITHUB_APP_IDENTITY_FEATURE_KEY,
  name: "GitHub App identity (shared tokens)",
  description:
    "Issues short-lived installation tokens for bots via company GitHub App.",
  docs: "docs/myrmidon/guides/features-page.md",
  settings: { path: "/company/settings", panel: "GitHub shared identity" },

  readConfig(ctx) {
    const rawMap = ctx.general[GITHUB_SHARED_IDENTITY_GENERAL_KEY];
    const map =
      typeof rawMap === "object" && rawMap !== null && !Array.isArray(rawMap)
        ? (rawMap as Record<string, unknown>)
        : {};

    let totalApps = 0;
    let enabledCompanies = 0;

    for (const companySettings of Object.values(map)) {
      if (typeof companySettings !== "object" || companySettings === null) continue;
      const s = companySettings as { enabled?: boolean; apps?: unknown[] };
      const apps = Array.isArray(s.apps) ? s.apps : [];
      totalApps += apps.length;
      if (s.enabled !== false && apps.length > 0) {
        enabledCompanies += 1;
      }
    }

    const isEnabled = enabledCompanies > 0;

    return {
      enabled: isEnabled,
      entries: [
        entry(
          "Configured Apps",
          totalApps,
          totalApps > 0 ? "database" : "default",
        ),
        entry(
          "Companies with active shared identity",
          enabledCompanies,
          enabledCompanies > 0 ? "database" : "default",
        ),
      ],
    };
  },

  async health(ctx, config) {
    const since10m = new Date(ctx.now.getTime() - TEN_MINUTES_MS);

    const [denied10m, issued10m, denied24h, issued24h, lastIssuedAt, lastDeniedAt] =
      await Promise.all([
        ctx.ports.activity.count(["myrmidon.github_app.denied"], since10m),
        ctx.ports.activity.count(["myrmidon.github_app.issued"], since10m),
        ctx.ports.activity.count(["myrmidon.github_app.denied"], ctx.since),
        ctx.ports.activity.count(["myrmidon.github_app.issued"], ctx.since),
        ctx.ports.activity.latest(["myrmidon.github_app.issued"]),
        ctx.ports.activity.latest(["myrmidon.github_app.denied"]),
      ]);

    const base = {
      effect: { label: "tokens issued in 10 min", value: issued10m },
      lastSuccessAt: iso(lastIssuedAt),
      errors24h: denied24h,
    };

    const total10m = denied10m + issued10m;
    const isFailing =
      (total10m > 0 && denied10m / total10m > 0.5) ||
      (issued10m === 0 && denied10m >= 5);

    if (isFailing) {
      const reason =
        issued10m === 0
          ? `${denied10m} GitHub App token request(s) denied (0 issued) in the last 10 min`
          : `${denied10m} of ${total10m} GitHub App token requests denied (${Math.round((denied10m / total10m) * 100)}%) in the last 10 min`;
      return makeHealth("failing", reason, base);
    }

    if (issued10m > 0) {
      return makeHealth(
        "working",
        `${issued10m} GitHub App token(s) issued in the last 10 min (${denied10m} denied)`,
        base,
      );
    }

    if (issued10m === 0 && denied10m > 0) {
      return makeHealth(
        "unknown",
        `${denied10m} GitHub App token request(s) denied, 0 issued in the last 10 min (<5 threshold for failure)`,
        base,
      );
    }

    if (issued24h > 0) {
      return makeHealth(
        "working",
        `no token requests in the last 10 min (${issued24h} issued in 24 h)`,
        base,
      );
    }

    if (!config.enabled && denied24h === 0) {
      return healthOff("no GitHub App identity configured");
    }

    return makeHealth(
      "unknown",
      "unknown — no GitHub App token requests in 24 h",
      base,
    );
  },
};
