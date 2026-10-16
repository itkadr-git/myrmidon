/**
 * myrmidon(REBRAND-C): read product environment variables as MYRMIDON_*.
 *
 * Vendor `PAPERCLIP_*` variables work as aliases for one more release: when a
 * variable is set under the old name only, the value is used and a one-time
 * warning per variable name is written to the log, so an operator with an
 * existing installation sees the rename before the alias is removed.
 *
 * Precedence: MYRMIDON_<NAME> wins when both names are set; PAPERCLIP_<NAME>
 * is consulted only when MYRMIDON_<NAME> is unset (undefined or empty
 * string, matching the dotenv convention where an empty value is "not set").
 *
 * Every variable name the product recognizes is listed in
 * docs/myrmidon/SETTINGS.md (the mapping table section).
 */

const MYRMIDON_PREFIX = "MYRMIDON_";
const PAPERCLIP_PREFIX = "PAPERCLIP_";

export const ENV_ALIAS_DEPRECATION_MESSAGE =
  "The PAPERCLIP_* variable names are deprecated aliases for MYRMIDON_*; they will stop working in a future release. Rename them in your environment.";

/** Warnings already emitted, keyed by the old variable name. */
const warnedAliases = new Set<string>();

export interface ReadProductEnvOptions {
  /**
   * Environment to read from; defaults to `process.env`. Tests pass an
   * isolated object so they do not depend on the real environment.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Sink for the one-time deprecation warning; defaults to `console.warn`.
   * Tests capture the warning through this option.
   */
  warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  console.warn(message);
}

/**
 * Reads one product variable with the legacy alias fallback.
 * Returns `undefined` when neither name is set.
 */
export function readProductEnv(name: string, options: ReadProductEnvOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const canonicalName = `${MYRMIDON_PREFIX}${name}`;
  const value = env[canonicalName];
  if (value !== undefined && value !== "") return value;

  const legacyName = `${PAPERCLIP_PREFIX}${name}`;
  const legacyValue = env[legacyName];
  if (legacyValue !== undefined && legacyValue !== "") {
    if (!warnedAliases.has(legacyName)) {
      warnedAliases.add(legacyName);
      const warn = options.warn ?? defaultWarn;
      warn(
        `myrmidon: environment variable ${legacyName} is a deprecated alias of ${canonicalName}; ${ENV_ALIAS_DEPRECATION_MESSAGE}`,
      );
    }
    return legacyValue;
  }
  return undefined;
}

/**
 * Reads one product variable with the alias fallback against a caller-provided
 * environment (the common non-process case, e.g. a child env object). No
 * warning: this path is used for environments the product itself builds, not
 * the operator's shell.
 */
export function readProductEnvFrom(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const canonical = env[`${MYRMIDON_PREFIX}${name}`];
  if (canonical !== undefined && canonical !== "") return canonical;
  const legacy = env[`${PAPERCLIP_PREFIX}${name}`];
  if (legacy !== undefined && legacy !== "") return legacy;
  return undefined;
}

/**
 * Copies the product variables of one environment into a new object under
 * their canonical MYRMIDON_* names, so child processes see the new names only
 * and the alias does not leak further than one process boundary.
 */
export function materializeProductEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = readProductEnvFrom(env, name);
    if (value !== undefined) out[`${MYRMIDON_PREFIX}${name}`] = value;
  }
  return out;
}

/**
 * Writes a product variable under both names into the given environment, so
 * both the new name and the one-release alias resolve for code (including
 * child processes) that still expects the old spelling.
 */
export function writeProductEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[`${MYRMIDON_PREFIX}${name}`] = value;
  env[`${PAPERCLIP_PREFIX}${name}`] = value;
}

/**
 * Deletes a product variable under both names from the given environment.
 */
export function deleteProductEnv(env: NodeJS.ProcessEnv, name: string): void {
  delete env[`${MYRMIDON_PREFIX}${name}`];
  delete env[`${PAPERCLIP_PREFIX}${name}`];
}

/**
 * Reports whether an environment key belongs to the product's variable
 * namespace (either spelling). Used by sanitizers that must strip product
 * variables regardless of the prefix they carry.
 */
export function isProductEnvKey(key: string): boolean {
  return key.startsWith(MYRMIDON_PREFIX) || key.startsWith(PAPERCLIP_PREFIX);
}

/** Resets the one-time warning memory; for tests only. */
export function resetEnvAliasWarningsForTest(): void {
  warnedAliases.clear();
}
