import { readProductEnv } from "@myrmidon/shared/env-alias"; // myrmidon(REBRAND-C)

function readSetting(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return readProductEnv(name, { env: environment });
}

/** Server-owned rollout policy. Never read from agent tool arguments. */
export function runnerApiToolsEnabled(
  companyId: string,
  bindingOverride?: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = readSetting(environment, "RUNNER_API_TOOLS_ENABLED");
  // A binding can only narrow operator permission, never opt into this surface.
  if (enabled !== "true" || bindingOverride === false) return false;
  const companies = readSetting(environment, "RUNNER_API_TOOLS_COMPANY_IDS");
  if (companies === undefined) return true;
  return companies.split(",").map(value => value.trim()).filter(Boolean).includes(companyId);
}
