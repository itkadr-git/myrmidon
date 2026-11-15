// server/src/myrmidon/github-shared-identity/webhook-disabled-signal.ts
//
// myrmidon(OPE-12868): the board signal behind a GitHub App webhook that
// GitHub reports as absent (HTTP 404 on the App-hook config PATCH — the App's
// webhook is not "Active" on the App's settings page).
//
// webhook-sync raises the latch when the PATCH answers 404 and clears it when
// a later sync succeeds; this module is the same process-level-registry shape
// the auth-401 burst signal uses (myrmidon/auth-401-burst/attention.ts): the
// attention feed reads the registry on the fly, no notification store. The
// card stays up until a sync confirms the webhook again — exactly the "silent
// for two days" hole this closes: the sync endpoint answered 502 without any
// operator-visible trace.
//
// No secret ever reaches this module: the signal carries ids, a hostname and
// an ISO timestamp — never a token, key, or webhook secret.

export interface GitHubAppWebhookDisabledSignal {
  companyId: string;
  /** The GitHub App entry (settings.apps[].id), not the numeric App id. */
  entryId: string;
  appId: string;
  /** Host of the webhook URL — for the card text only, no path/query. */
  webhookHost: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const registry = new Map<string, GitHubAppWebhookDisabledSignal>();

function key(companyId: string, entryId: string): string {
  return `${companyId}:${entryId}`;
}

/** webhook-sync calls this when GitHub answers 404 on the hook config PATCH;
 * re-latching the same entry refreshes lastSeenAt, idempotently. */
export function recordGitHubAppWebhookDisabledSignal(signal: {
  companyId: string;
  entryId: string;
  appId: string;
  webhookHost: string;
  at?: string;
}): void {
  const at = signal.at ?? new Date().toISOString();
  const existing = registry.get(key(signal.companyId, signal.entryId));
  registry.set(key(signal.companyId, signal.entryId), {
    companyId: signal.companyId,
    entryId: signal.entryId,
    appId: signal.appId,
    webhookHost: signal.webhookHost,
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastSeenAt: at,
  });
}

/** webhook-sync calls this after a confirmed sync (PATCH 200 + read-back) so
 * the card disappears the moment the webhook actually works again. */
export function clearGitHubAppWebhookDisabledSignal(companyId: string, entryId: string): void {
  registry.delete(key(companyId, entryId));
}

/** Drop every latch — used when an App entry or its webhook secret id is
 * removed from the settings, and as a test reset. */
export function forgetGitHubAppWebhookDisabledSignals(entryId: string): void;
export function forgetGitHubAppWebhookDisabledSignals(): void;
export function forgetGitHubAppWebhookDisabledSignals(entryId?: string): void {
  if (entryId === undefined) {
    registry.clear();
    return;
  }
  for (const [k, signal] of registry) {
    if (signal.entryId === entryId) registry.delete(k);
  }
}

/** The feed reads this per company; one card per still-disabled App entry. */
export function readGitHubAppWebhookDisabledSignals(companyId: string): GitHubAppWebhookDisabledSignal[] {
  return [...registry.values()].filter((signal) => signal.companyId === companyId);
}

export function hasGitHubAppWebhookDisabledSignal(companyId: string, entryId: string): boolean {
  return registry.has(key(companyId, entryId));
}

/** Stable dedup key: one card per App entry while its latch is set. */
export function githubAppWebhookDisabledSignalDedupKey(signal: GitHubAppWebhookDisabledSignal): string {
  return `github_app_webhook_disabled:${signal.companyId}:${signal.entryId}`;
}

/** Why-now line for the card. Names the fix: only the App owner can flip the
 * "Active" webhook switch on the App's GitHub settings page. */
export function githubAppWebhookDisabledSignalWhyNow(signal: GitHubAppWebhookDisabledSignal): string {
  return `GitHub reported this App's webhook as not configured (HTTP 404 on a webhook sync, first seen ${signal.firstSeenAt}). While the webhook is disabled on the App's GitHub settings page, the board receives no GitHub events — CI results, pull requests and comments all stop. The App owner must enable the webhook (Settings → Developer settings → GitHub Apps → Webhook → Active) and then run webhook sync again; no API can turn it on.`;
}

/** Severity: a dead webhook is a whole-board event stop, ranked with the other ops alerts. */
export function githubAppWebhookDisabledSignalSeverity(): "critical" {
  return "critical";
}
