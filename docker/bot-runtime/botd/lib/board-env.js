// myrmidon(REBRAND-ENV, OPE-12052): the board address and the bot's board key
// as botd reads them from its environment.
//
// MYRMIDON_<NAME> is the name; PAPERCLIP_<NAME> is only the legacy alias the
// board still writes next to it (profile-compiler buildEnvFile), kept so a bot
// image older than the board keeps working. A non-empty MYRMIDON_* value wins;
// an empty one falls back to the alias (an empty address or key is useless to
// botd, unlike the board-side readProductEnv, where an empty canonical value
// stays an explicit empty).
//
// Plain Node (no dependencies): botd cannot import @myrmidon/shared.

/**
 * @param {Record<string, string | undefined>} env  process.env-like
 * @param {"API_URL" | "API_KEY"} name
 * @returns {string | undefined}
 */
export function boardEnv(env, name) {
  for (const prefix of ["MYRMIDON_", "PAPERCLIP_"]) {
    const value = env[`${prefix}${name}`];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Every non-empty value the board key has in `env`, under either name (for redaction). */
export function boardKeyValues(env) {
  return ["MYRMIDON_API_KEY", "PAPERCLIP_API_KEY"].map((name) => env[name]).filter((v) => typeof v === "string" && v !== "");
}
