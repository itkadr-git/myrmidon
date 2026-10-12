// server/src/myrmidon/monitoring/dashboard/token.ts
// myrmidon(1.6.6 MONITORING C): resolution of token references of the form
// `env:<NAME>` / `file:<PATH>` — the maintenance/zabbix pattern. The resolved
// value is handed to the source client and is never logged, never returned.

import { readFileSync } from "node:fs";

export interface TokenRefDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

/**
 * Resolves `env:<NAME>` (an environment variable) or `file:<PATH>` (a file,
 * a Docker secret for example). Returns null when the reference is null so
 * callers can run a source without auth. Throws on a malformed reference or
 * an empty value; the value itself never appears in the error text.
 */
export function resolveMonitoringTokenRef(ref: string | null, deps: TokenRefDeps = {}): string | null {
  if (!ref) return null;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let value: string | undefined;
  if (ref.startsWith("env:")) value = env[ref.slice(4)];
  else if (ref.startsWith("file:")) value = readFile(ref.slice(5));
  else throw new Error("monitoring token reference must be env:<NAME> or file:<PATH>");
  const token = value?.trim();
  if (!token) throw new Error("monitoring token reference resolved to an empty value");
  return token;
}
