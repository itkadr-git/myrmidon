// server/src/myrmidon/monitoring/alerts/token.ts
// myrmidon(1.6.6-ALERTS): webhook settings + the token secret resolution. The
// token reference uses the maintenance/zabbix pattern: `env:<NAME>` reads an
// environment variable, `file:<path>` reads a file (a Docker secret). The
// resolved value is compared in memory and never logged or returned.

import { readFileSync } from "node:fs";

export interface AlertWebhookSettings {
  /** Token reference (`env:<NAME>` or `file:<PATH>`), or null = webhook off. */
  tokenRef: string | null;
  companyId: string;
}

export const ALERT_WEBHOOK_TOKEN_REF_ENV = "MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF";
export const ALERTS_COMPANY_ID_ENV = "MYRMIDON_ALERTS_COMPANY_ID";

export function readAlertsSettings(env: NodeJS.ProcessEnv = process.env): AlertWebhookSettings {
  return {
    tokenRef: env[ALERT_WEBHOOK_TOKEN_REF_ENV]?.trim() || null,
    companyId: env[ALERTS_COMPANY_ID_ENV]?.trim() || "",
  };
}

export interface TokenRefDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

/**
 * Resolves the token reference: `env:<NAME>` or `file:<path>`. Returns null
 * when the reference is unset so the route can answer 503. Throws on a
 * malformed reference or an empty value; the value itself is never included
 * in the error.
 */
export function resolveAlertTokenRef(ref: string | null, deps: TokenRefDeps = {}): string | null {
  if (!ref) return null;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let value: string | undefined;
  if (ref.startsWith("env:")) value = env[ref.slice(4)];
  else if (ref.startsWith("file:")) value = readFile(ref.slice(5));
  else throw new Error("MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF must be env:<NAME> or file:<PATH>");
  const token = value?.trim();
  if (!token) throw new Error("monitoring alerts webhook token reference resolved to an empty value");
  return token;
}
