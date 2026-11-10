// server/src/myrmidon/monitoring/intake/token.ts
// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): intake webhook settings and the
// shared-secret resolution, following the maintenance/zabbix `env:`/`file:`
// reference pattern of the alerts module. The resolved secret value lives in
// memory only: it is compared for the signature and never logged or returned.

import { readFileSync } from "node:fs";

export const WEBHOOK_INTAKE_TOKEN_REF_ENV = "MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF";
export const WEBHOOK_INTAKE_COMPANY_ID_ENV = "MYRMIDON_WEBHOOK_INTAKE_COMPANY_ID";

export interface WebhookIntakeSettings {
  /** Secret reference (`env:<NAME>` or `file:<PATH>`), or null = intake off. */
  tokenRef: string | null;
  companyId: string;
}

export function readWebhookIntakeSettings(env: NodeJS.ProcessEnv = process.env): WebhookIntakeSettings {
  return {
    tokenRef: env[WEBHOOK_INTAKE_TOKEN_REF_ENV]?.trim() || null,
    companyId: env[WEBHOOK_INTAKE_COMPANY_ID_ENV]?.trim() || "",
  };
}

export interface TokenRefDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

/**
 * Resolves `env:<NAME>` / `file:<PATH>` to the secret value. Returns null when
 * the reference is unset (the route answers 503); throws on a malformed
 * reference or an empty value, never including the value itself in the error.
 */
export function resolveWebhookIntakeTokenRef(ref: string | null, deps: TokenRefDeps = {}): string | null {
  if (!ref) return null;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let value: string | undefined;
  if (ref.startsWith("env:")) value = env[ref.slice(4)];
  else if (ref.startsWith("file:")) value = readFile(ref.slice(5));
  else throw new Error("MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF must be env:<NAME> or file:<PATH>");
  const token = value?.trim();
  if (!token) throw new Error("webhook intake secret reference resolved to an empty value");
  return token;
}
