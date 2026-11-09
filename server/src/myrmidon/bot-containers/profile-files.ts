// server/src/myrmidon/bot-containers/profile-files.ts
//
// myrmidon(fleet-site audit): the profile files the compiler writes with a secret in them, named
// once. profile-compiler.ts writes them under these names, and the replica store
// (fleet-replica-filter.ts) leaves them out of a stored snapshot: the apply that follows a restore
// writes them again from the card and the company secrets, so a copy of them on the board's disk
// adds nothing but a place for the secrets to leak from.
//
// Paths are relative to the bot's datadir, forward slashes, the same as in CompiledProfileFile.path.

/** The gateway's environment file: always secret (0o600) — API_SERVER_KEY, PAPERCLIP_API_KEY, the LLM key. */
export const HERMES_ENV_FILE = "hermes/.env";

/** The gateway's config: marked secret (0o600) whenever an MCP server carries headers, which may hold a credential. */
export const HERMES_CONFIG_FILE = "hermes/config.yaml";

/**
 * Every path the compiler can write as a secret file. config.yaml is listed although it is plain
 * without MCP headers: the compiler writes it again on every apply either way, so leaving it out of
 * a snapshot loses nothing. profile-files.myrmidon.test.ts keeps this list in step with the compiler.
 */
export const PROFILE_SECRET_FILE_PATHS: readonly string[] = [HERMES_ENV_FILE, HERMES_CONFIG_FILE];
