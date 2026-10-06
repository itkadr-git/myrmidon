// server/src/myrmidon/bot-containers/profile-input.ts
//
// myrmidon(W2a): the input builder for the G2 profile compiler. Pure: everything
// the board has to look up (the card, resolved secrets, skill files, the
// instructions bundle, MCP tokens) arrives in `BotProfileSource`, already
// fetched by the ports in profile-compile.ts / profile-ports.ts, and everything
// instance-wide arrives in `BotProfileSettings` (the MYRMIDON_BOT_* variables).
// So the mapping card -> HermesProfileInput is testable without a database.
//
// Card field -> input mapping follows containers-plan-senior-2026-09-28.md
// §2.1; the compiler (profile-compiler.ts) then turns the input into files.
//
// Errors thrown here are configuration errors (a missing instance setting, a
// missing key value). They name the setting or variable, never a value, so a
// message is safe to show in the reconcile activity log.

import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
// myrmidon(PARALLEL-HELPERS): card + company ceiling -> the values the compiler writes
// into config.yaml's `delegation` section (and the toolset switch).
import { PARALLEL_HELPERS_DEFAULT_MODEL_ENV, readParallelHelpersCard, resolveParallelHelpers, type ParallelHelpersSettings } from "@paperclipai/shared";
// myrmidon(BOT-LSP-DEFAULTS): the language-server mode per role/card.
import { botLspHermesBlock, resolveBotLsp, type BotLspSettings } from "@paperclipai/shared";
import { BOT_BOARD_GATEWAY_SERVER_NAME } from "./board-gateway.js";
import type {
  HermesProfileAdapterConfig,
  HermesProfileEnvEntry,
  HermesProfileHindsightSettings,
  HermesProfileInput,
  HermesProfileInstanceDefaults,
  HermesProfileLspSettings,
  HermesProfileMcpServer,
  HermesProfileSkillFile,
  HermesProfileWorkspaceFile,
} from "./profile-compiler.js";

// ---------------------------------------------------------------------------
// Instance settings
// ---------------------------------------------------------------------------

export const BOT_HINDSIGHT_API_URL_ENV = "MYRMIDON_BOT_HINDSIGHT_API_URL";
export const BOT_HINDSIGHT_BANK_ENV = "MYRMIDON_BOT_HINDSIGHT_BANK";
// myrmidon(MEMORY-ISOLATION): the bank allowlist. A bank outside it fails the
// compile instead of silently materializing a new bank: a typo'd
// adapterConfig.hindsight.bankId must never become a fresh bank that nobody
// reads. Unset/blank = no check (the current behavior).
export const BOT_HINDSIGHT_ALLOWED_BANKS_ENV = "MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS";
export const BOT_LLM_BASE_URL_ENV = "MYRMIDON_BOT_LLM_BASE_URL";
export const BOT_LLM_API_KEY_ENV_ENV = "MYRMIDON_BOT_LLM_API_KEY_ENV";
export const BOT_LLM_API_KEY_SECRET_ENV = "MYRMIDON_BOT_LLM_API_KEY_SECRET";
export const BOT_BOARD_URL_ENV = "MYRMIDON_BOT_BOARD_URL";
/** Existing P4 setting (packages/adapters/hermes/src/server/myrmidon-runtime-mcp.ts):
 *  the internal base a run-scoped MCP gateway URL's origin is rewritten to. Repeated
 *  here, not imported, because the server does not load that adapter module. */
export const BOT_RUNTIME_MCP_URL_BASE_ENV = "MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE";
/** Instance-wide MCP servers every bot gets (ragflow and the like): a JSON array, see `parseBotMcpServers`. */
export const BOT_MCP_SERVERS_ENV = "MYRMIDON_BOT_MCP_SERVERS";
// myrmidon(BOT-RUNTIME-TUNING-B): instance-wide compression token cap —
// absolute number of tokens; Hermes compresses at the lower of the ratio
// threshold and this count. Default 100_000: the ticket's fleet default, set
// by the instance, not the compiler (unset would mean Hermes's own 256K).
// myrmidon(BOT-RUNTIME-TUNING-A): that fleet default is applied in code now
// (BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS below), so a card that sets
// nothing compacts at ~100k instead of half a large model's window; an
// explicit 0 in the variable turns the cap off (Hermes's own default applies).
export const BOT_COMPRESSION_THRESHOLD_TOKENS_ENV = "MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS";

/**
 * myrmidon(BOT-RUNTIME-TUNING-A): the company default for the compression
 * token cap, in tokens — used when MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS
 * is unset (or holds no usable integer). It is a company-level (instance)
 * default, not a compiler default: the compiler still writes only what its
 * input carries, so a caller that passes no instance defaults compiles exactly
 * as before. The agent card's own
 * `adapterConfig.models.compressionThresholdTokens` wins over it.
 */
export const BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS = 100_000;
/** myrmidon(BOT-RUNTIME-TUNING-B): default per-alias map, "alias=tokens,alias=tokens". */
export const BOT_MODEL_CONTEXT_LENGTH_ENV = "MYRMIDON_BOT_MODEL_CONTEXT_LENGTH";
/** myrmidon(BOT-RUNTIME-TUNING-B): instance default for auxiliary.title_generation.model (a gateway model alias). */
export const BOT_AUX_TITLE_MODEL_ENV = "MYRMIDON_BOT_AUX_TITLE_MODEL";
/** myrmidon(BOT-RUNTIME-TUNING-B): instance default for auxiliary.compression.model (a gateway model alias). */
export const BOT_AUX_COMPRESSION_MODEL_ENV = "MYRMIDON_BOT_AUX_COMPRESSION_MODEL";
/**
 * myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): MYRMIDON_BOT_AUX_FALLBACK_MODELS —
 * comma-separated gateway model aliases that form the CHEAP CEILING of every
 * auxiliary call the compiler configures (title generation, compression): they
 * are written as `auxiliary.<task>.fallback_chain`, which Hermes walks BEFORE
 * the main chain. Without it an auxiliary call that fails on its own model
 * climbs the card's `models.fallbacks` / the gateway's own ladder and can be
 * served by a paid model (fact 02.10: session titles did exactly that).
 */
export const BOT_AUX_FALLBACK_MODELS_ENV = "MYRMIDON_BOT_AUX_FALLBACK_MODELS";
/**
 * myrmidon(MEMORY-CENTRAL-A): instance-wide switch that turns every bot's Hermes
 * LOCAL memory off (config.yaml `memory.enabled: false`), so durable memory
 * lives only in the shared hindsight service. Truthy like the other bot
 * switches (`1`/`true`/`yes`/`on`, case-insensitive); anything else, including
 * a typo, keeps local memory on — off is the default, an opt-in feature must
 * not flip on by accident.
 */
export const BOT_LOCAL_MEMORY_OFF_ENV = "MYRMIDON_BOT_LOCAL_MEMORY_OFF";

/**
 * One instance-wide MCP server. The token is never in the setting: `tokenSecret`
 * names a company secret, resolved by profile-compile.ts on every compile.
 */
export interface BotStaticMcpServer {
  name: string;
  url: string;
  /** Company secret that holds the server's token; null for a server declared `noAuth`. */
  tokenSecret: string | null;
  /** HTTP header that carries the token. */
  header: string;
  /** Prefix of the header value ("Bearer"); "" sends the raw token. */
  scheme: string;
}

export interface BotProfileSettings {
  /** hindsight service address as seen from a bot container. Required. */
  hindsightApiUrl: string | null;
  /** Default hindsight bank, used when the card names none. */
  hindsightBank: string | null;
  /**
   * Banks a card's `adapterConfig.hindsight.bankId` (and the fallback
   * `MYRMIDON_BOT_HINDSIGHT_BANK`) may name, from
   * `MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS` (comma-separated). Null when unset
   * or blank: no allowlist check, the pre-MEMORY-ISOLATION behavior. Empty
   * after trimming the commas is also null — an allowlist of nothing is a
   * misconfigured value, not "no bank is allowed".
   */
  hindsightAllowedBanks: string[] | null;
  /**
   * OpenAI-compatible LLM gateway base URL; null = each provider's own default endpoint.
   * Only a card that goes through the gateway ({@link cardUsesLlmGateway}) gets it; a card
   * with a native provider is not given the address, and the setting is optional for it
   * (see {@link assertBotLlmSettingsForCard}).
   */
  llmBaseUrl: string | null;
  /**
   * Name of the .env variable that carries the LLM gateway key (never the key).
   * Only a card that goes through the gateway ({@link cardUsesLlmGateway}) gets the key;
   * the setting is optional for a card with a native provider
   * (see {@link assertBotLlmSettingsForCard}).
   */
  llmApiKeyEnv: string | null;
  /** Company secret that holds the LLM gateway key; defaults to `llmApiKeyEnv`. */
  llmApiKeySecret: string | null;
  /** The board's address as seen from a bot container (no trailing /api). Required. */
  boardUrl: string | null;
  /** Internal base for MCP gateway URLs; null = URLs are used as the board built them. */
  runtimeMcpUrlBase: string | null;
  /** Instance-wide MCP servers (MYRMIDON_BOT_MCP_SERVERS); empty when unset or invalid. */
  mcpServers: BotStaticMcpServer[];
  /** Why MYRMIDON_BOT_MCP_SERVERS could not be used; null when it is unset or valid.
   *  `assertBotProfileSettings` throws it: a broken declaration must not silently mean "no MCP". */
  mcpServersError: string | null;
  /**
   * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS,
   * an absolute token cap written to `compression.threshold_tokens`.
   * myrmidon(BOT-RUNTIME-TUNING-A): the variable now carries an OVERRIDE of
   * the company default (100_000, BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS):
   * unset or unusable falls back to it, an explicit `0` means "no cap" (null
   * here, so the compiler writes nothing and Hermes's own default applies).
   * Invalid values are reported per entry, not thrown: a bad threshold must
   * not stop a bot's profile from compiling. Optional in the type so
   * preexisting hand-built settings objects (older callers, part C's
   * card-env tests) keep compiling; `readBotProfileSettings` always fills it.
   */
  compressionThresholdTokens?: number | null;
  /** Why MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS could not be used; null when unset or valid. */
  compressionThresholdTokensError?: string | null;
  /**
   * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_MODEL_CONTEXT_LENGTH,
   * "alias=tokens,alias=tokens"; written to `model.context_length` for a card
   * whose model matches an alias (the card's own `models.contextLength` wins).
   */
  modelContextLengths?: Record<string, number> | null;
  /** Why MYRMIDON_BOT_MODEL_CONTEXT_LENGTH could not be used; null when unset or fully valid. */
  modelContextLengthsError?: string | null;
  /**
   * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_AUX_TITLE_MODEL — the gateway
   * model alias written to `auxiliary.title_generation.model` when a card sets
   * none. No default: the operator names a model the gateway actually knows
   * (a hard-coded "free" model would silently break bots).
   */
  auxiliaryTitleModel?: string | null;
  /**
   * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_AUX_COMPRESSION_MODEL — same
   * for `auxiliary.compression.model`.
   */
  auxiliaryCompressionModel?: string | null;
  /**
   * myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): MYRMIDON_BOT_AUX_FALLBACK_MODELS
   * — the auxiliary fallback ceiling: gateway aliases the compiler writes to
   * `auxiliary.title_generation.fallback_chain` and
   * `auxiliary.compression.fallback_chain`. Null/empty = no chain is written
   * and Hermes keeps its own policy (an auxiliary task on `provider: auto`
   * follows the main chain). The ceiling is an instance-wide policy, not a card
   * field: it caps a class of models for every bot, and an operator names
   * aliases the gateway actually serves.
   */
  auxiliaryFallbackModels?: string[] | null;
  /**
   * myrmidon(MEMORY-CENTRAL-A): MYRMIDON_BOT_LOCAL_MEMORY_OFF — when truthy,
   * every bot's Hermes LOCAL memory is turned off in config.yaml
   * (`memory.memory_enabled`/`user_profile_enabled: false`); durable memory
   * then lives only in hindsight. Optional in the type so preexisting
   * hand-built settings objects keep compiling; `readBotProfileSettings`
   * always fills it.
   */
  localMemoryOff?: boolean;
}

function readSetting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * myrmidon(MEMORY-CENTRAL-A): the shared truthiness of the bot instance
 * switches (`1`/`true`/`yes`/`on`, case-insensitive) — the same set
 * `isBotContainersEnabled` accepts in agent-config.ts.
 */
function isTruthyBotSwitch(value: string | null): boolean {
  if (!value) return false;
  const raw = value.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * myrmidon(PARALLEL-HELPERS): `readSetting` over the card's resolved env (a
 * plain record of `HermesProfileEnvEntry`), for the instance-level default
 * helper model. Instance-level values always win over the card here only when
 * the card's own block names no model — the normal precedence for defaults.
 */
function readSettingFromRecord(env: Record<string, HermesProfileEnvEntry>, name: string): string | null {
  const value = env[name]?.value?.trim();
  return value ? value : null;
}

/** MCP server names become YAML keys and env-variable suffixes, so they are folded to a safe alphabet. */
export function sanitizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** An HTTP header name: letters, digits, hyphens and underscores. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
/** An auth scheme word ("Bearer", "Token"); empty means the raw token. */
const AUTH_SCHEME_PATTERN = /^[A-Za-z0-9-]*$/;
const DEFAULT_MCP_HEADER = "Authorization";
const DEFAULT_MCP_SCHEME = "Bearer";

function parseHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * MYRMIDON_BOT_MCP_SERVERS: `[{"name":"ragflow","url":"http://...","tokenSecret":"<company secret name>"}]`.
 * Optional per entry: `header` (default Authorization), `scheme` (default Bearer,
 * "" sends the raw token), `noAuth: true` in place of `tokenSecret` for a server
 * that takes no token. An entry with neither `tokenSecret` nor `noAuth` is an
 * error, so a forgotten secret never becomes an unauthenticated server.
 * The name of the bot's own board tool gateway server is reserved: that server is
 * issued per bot by the board, so a declaration under its name (which would carry
 * one instance-wide token into every bot) is an error, not a silent override.
 * Errors name the entry and the field, never a value.
 */
export function parseBotMcpServers(raw: string | null): { servers: BotStaticMcpServer[]; error: string | null } {
  if (raw === null) return { servers: [], error: null };
  const fail = (message: string) => ({ servers: [] as BotStaticMcpServer[], error: `${BOT_MCP_SERVERS_ENV}: ${message}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("is not valid JSON");
  }
  if (!Array.isArray(parsed)) return fail("must be a JSON array of servers");

  const servers: BotStaticMcpServer[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const record = asRecord(entry);
    const label = `entry ${index}`;
    const rawName = typeof record.name === "string" ? record.name : "";
    const name = sanitizeMcpServerName(rawName);
    if (!name) return fail(`${label} has no usable "name"`);
    if (name === sanitizeMcpServerName(BOT_BOARD_GATEWAY_SERVER_NAME)) {
      return fail(`${label} ("${name}") uses a reserved server name: the board tool gateway of each bot is issued by the board and cannot be declared here`);
    }
    if (seen.has(name)) return fail(`${label} ("${name}") repeats a server name`);
    seen.add(name);
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || !parseHttpUrl(url)) return fail(`${label} ("${name}") needs an http(s) "url"`);
    const tokenSecret = typeof record.tokenSecret === "string" ? record.tokenSecret.trim() : "";
    const noAuth = record.noAuth === true;
    if (tokenSecret && noAuth) return fail(`${label} ("${name}") sets both "tokenSecret" and "noAuth"`);
    if (!tokenSecret && !noAuth) {
      return fail(`${label} ("${name}") needs "tokenSecret" (a company secret name), or "noAuth": true for a server without a token`);
    }
    const header = record.header === undefined ? DEFAULT_MCP_HEADER : typeof record.header === "string" ? record.header.trim() : "";
    if (!HEADER_NAME_PATTERN.test(header)) return fail(`${label} ("${name}") has an invalid "header" name`);
    const scheme = record.scheme === undefined ? DEFAULT_MCP_SCHEME : typeof record.scheme === "string" ? record.scheme.trim() : null;
    if (scheme === null || !AUTH_SCHEME_PATTERN.test(scheme)) return fail(`${label} ("${name}") has an invalid "scheme"`);
    servers.push({ name, url, tokenSecret: noAuth ? null : tokenSecret, header, scheme });
  }
  return { servers, error: null };
}

/**
 * MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS: comma-separated bank ids. Blank,
 * unset or commas-only → null (no check). Duplicates and empty items are
 * folded away; order is kept as written (it never reaches a compiled file).
 */
export function parseBotHindsightAllowedBanks(raw: string | null): string[] | null {
  if (raw === null) return null;
  const seen = new Set<string>();
  const banks: string[] = [];
  for (const item of raw.split(",")) {
    const bank = item.trim();
    if (!bank || seen.has(bank)) continue;
    seen.add(bank);
    banks.push(bank);
  }
  return banks.length > 0 ? banks : null;
}

/**
 * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS —
 * an integer token count. Not a hard fail: a value that is not an integer
 * (or an empty string) is reported in `error` and dropped, because a bad
 * threshold must not stop a bot's profile from compiling — the warning
 * surface (the reconcile activity log) is where an operator sees it.
 *
 * myrmidon(BOT-RUNTIME-TUNING-A): this parser only reads the variable; the
 * company default (100_000) and the meaning of `0` ("no cap") are applied by
 * {@link readBotProfileSettings}, so an unusable value never silently removes
 * the fleet's cap.
 */
export function parseBotCompressionThresholdTokens(raw: string | null): { value: number | null; error: string | null } {
  if (raw === null) return { value: null, error: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return { value: null, error: `${BOT_COMPRESSION_THRESHOLD_TOKENS_ENV}: "${raw}" is not an integer` };
  }
  return { value: parsed, error: null };
}

/**
 * myrmidon(BOT-RUNTIME-TUNING-B): MYRMIDON_BOT_MODEL_CONTEXT_LENGTH —
 * "alias=tokens,alias=tokens". Duplicates: the last one wins. Entries without
 * "=" or with a non-integer token count are reported in `error` and skipped;
 * a valid prefix still applies (the map is best-effort, an alias the compiler
 * validates again by range before writing it).
 */
export function parseBotModelContextLengths(raw: string | null): { map: Record<string, number> | null; error: string | null } {
  if (raw === null) return { map: null, error: null };
  const errors: string[] = [];
  const map: Record<string, number> = {};
  for (const item of raw.split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      errors.push(`"${entry}" has no "="`);
      continue;
    }
    const alias = entry.slice(0, eq).trim();
    const tokens = Number(entry.slice(eq + 1).trim());
    if (!alias || !Number.isInteger(tokens)) {
      errors.push(`"${entry}" is not "alias=tokens"`);
      continue;
    }
    map[alias] = tokens;
  }
  if (Object.keys(map).length === 0) {
    return { map: null, error: errors.length > 0 ? `${BOT_MODEL_CONTEXT_LENGTH_ENV}: ${errors.join("; ")}` : null };
  }
  return { map, error: errors.length > 0 ? `${BOT_MODEL_CONTEXT_LENGTH_ENV}: ${errors.join("; ")} (skipped)` : null };
}

/**
 * myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): MYRMIDON_BOT_AUX_FALLBACK_MODELS —
 * comma-separated gateway model aliases. Comma-separated like
 * MODEL_CONTEXT_LENGTH, but a bare alias list (no "="): each item is the model
 * name of one `auxiliary.<task>.fallback_chain` entry. Duplicates are folded
 * away, order is kept as written (the chain is walked in that order), blanks
 * are skipped. Unset/blank/commas-only → null: no ceiling, Hermes keeps its own
 * auxiliary fallback policy. There is no per-entry error path — any non-empty
 * item is a usable alias, and whether the gateway serves it is the operator's
 * problem (a dropped entry would look like "no ceiling", the bug this closes).
 */
export function parseBotAuxFallbackModels(raw: string | null): string[] | null {
  if (raw === null) return null;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of raw.split(",")) {
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models.length > 0 ? models : null;
}

export function readBotProfileSettings(env: NodeJS.ProcessEnv = process.env): BotProfileSettings {
  const llmApiKeyEnv = readSetting(env, BOT_LLM_API_KEY_ENV_ENV);
  const mcp = parseBotMcpServers(readSetting(env, BOT_MCP_SERVERS_ENV));
  // myrmidon(BOT-RUNTIME-TUNING-B): the instance defaults the profile compiler
  // writes into config.yaml — read here so a corrected variable takes effect
  // on the next compile tick, like the rest of this settings object.
  const compressionTokens = parseBotCompressionThresholdTokens(readSetting(env, BOT_COMPRESSION_THRESHOLD_TOKENS_ENV));
  // myrmidon(BOT-RUNTIME-TUNING-A): the variable is an override of the company
  // default, not an all-or-nothing switch. Unset or unusable (an invalid value
  // already carries its own warning above) falls back to the company default
  // 100_000, so a card that says nothing still compacts at ~100k instead of
  // half a large model's window; an explicit 0 means "no cap" and stays null,
  // which writes no threshold_tokens at all (Hermes's own default applies).
  const compressionThresholdTokens =
    compressionTokens.value === null
      ? BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS
      : compressionTokens.value === 0
        ? null
        : compressionTokens.value;
  const contextLengths = parseBotModelContextLengths(readSetting(env, BOT_MODEL_CONTEXT_LENGTH_ENV));
  // myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): the cheap ceiling of the
  // auxiliary fallback chains.
  const auxiliaryFallbackModels = parseBotAuxFallbackModels(readSetting(env, BOT_AUX_FALLBACK_MODELS_ENV));
  return {
    hindsightApiUrl: readSetting(env, BOT_HINDSIGHT_API_URL_ENV),
    hindsightBank: readSetting(env, BOT_HINDSIGHT_BANK_ENV),
    hindsightAllowedBanks: parseBotHindsightAllowedBanks(readSetting(env, BOT_HINDSIGHT_ALLOWED_BANKS_ENV)),
    llmBaseUrl: readSetting(env, BOT_LLM_BASE_URL_ENV),
    llmApiKeyEnv,
    llmApiKeySecret: readSetting(env, BOT_LLM_API_KEY_SECRET_ENV) ?? llmApiKeyEnv,
    boardUrl: readSetting(env, BOT_BOARD_URL_ENV),
    runtimeMcpUrlBase: readSetting(env, BOT_RUNTIME_MCP_URL_BASE_ENV)?.replace(/\/+$/, "") ?? null,
    mcpServers: mcp.servers,
    mcpServersError: mcp.error,
    compressionThresholdTokens,
    compressionThresholdTokensError: compressionTokens.error,
    modelContextLengths: contextLengths.map,
    modelContextLengthsError: contextLengths.error,
    auxiliaryTitleModel: readSetting(env, BOT_AUX_TITLE_MODEL_ENV),
    auxiliaryCompressionModel: readSetting(env, BOT_AUX_COMPRESSION_MODEL_ENV),
    auxiliaryFallbackModels,
    // myrmidon(MEMORY-CENTRAL-A): MYRMIDON_BOT_LOCAL_MEMORY_OFF, truthy like
    // the other bot switches; anything else (including a typo) keeps local
    // memory on — the feature is opt-in and off by default.
    localMemoryOff: isTruthyBotSwitch(readSetting(env, BOT_LOCAL_MEMORY_OFF_ENV)),
  };
}

export class BotProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotProfileInputError";
  }
}

function assertHttpUrl(setting: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BotProfileInputError(`${setting} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BotProfileInputError(`${setting} must be an http(s) URL`);
  }
}

/** Env variable names the compiler or the image owns; the LLM key variable may not be one of them. */
const OWNED_ENV_NAMES = new Set(["HOME", "PATH", "HERMES_HOME", "API_SERVER_KEY", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY"]);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The settings without which no profile can be built at all. Checked before any
 * secret is created for the bot, so an unconfigured instance fails fast and
 * leaves nothing behind.
 */
export function assertBotProfileSettings(settings: BotProfileSettings): void {
  if (settings.mcpServersError) throw new BotProfileInputError(settings.mcpServersError);
  if (!settings.hindsightApiUrl) {
    throw new BotProfileInputError(`${BOT_HINDSIGHT_API_URL_ENV} is not set (the shared hindsight service address)`);
  }
  assertHttpUrl(BOT_HINDSIGHT_API_URL_ENV, settings.hindsightApiUrl);
  if (!settings.boardUrl) {
    throw new BotProfileInputError(`${BOT_BOARD_URL_ENV} is not set (the board address as seen from a bot container)`);
  }
  assertHttpUrl(BOT_BOARD_URL_ENV, settings.boardUrl);
  if (settings.llmBaseUrl) assertHttpUrl(BOT_LLM_BASE_URL_ENV, settings.llmBaseUrl);
  if (settings.llmApiKeyEnv) {
    if (!ENV_NAME_PATTERN.test(settings.llmApiKeyEnv) || OWNED_ENV_NAMES.has(settings.llmApiKeyEnv)) {
      throw new BotProfileInputError(
        `${BOT_LLM_API_KEY_ENV_ENV} must be a valid variable name that is not HOME, PATH, HERMES_HOME, API_SERVER_KEY, PAPERCLIP_API_URL or PAPERCLIP_API_KEY`,
      );
    }
  }
}

/**
 * Does the card's provider go through the instance's LLM gateway rather than a
 * native provider of its own? True for an empty or "auto" provider and for
 * "custom" / "custom:<name>": the vendor gateway resolves those against an
 * explicit endpoint, and without one it falls back to its OpenRouter default;
 * without a key it sends the placeholder "no-key-required". A native provider
 * ("anthropic", "gemini", ...) has its own endpoint and key and needs neither.
 */
export function cardUsesLlmGateway(card: Record<string, unknown>): boolean {
  const provider = asTrimmedString(card.provider)?.toLowerCase();
  return !provider || provider === "auto" || provider === "custom" || provider.startsWith("custom:");
}

/**
 * myrmidon(MEMORY-ISOLATION): the card's hindsight bank must be on
 * MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS when that setting is set. Checked before
 * any secret is created for the bot (the same fail-fast slot as
 * {@link assertBotLlmSettingsForCard}), so a typo'd bank id in a card fails the
 * compile leaving nothing behind, instead of silently materializing a new bank
 * nobody reads. Unset/blank allowlist = no check (the previous behavior). A
 * missing bank anywhere is NOT this function's error (readHindsight owns it) —
 * here a card without a bank simply passes.
 */
export function assertBotHindsightBankForCard(settings: BotProfileSettings, card: Record<string, unknown>): void {
  if (!settings.hindsightAllowedBanks) return;
  const bankId = asTrimmedString(asRecord(card.hindsight).bankId) ?? settings.hindsightBank;
  if (!bankId) return;
  if (!settings.hindsightAllowedBanks.includes(bankId)) {
    throw new BotProfileInputError(
      `hindsight bank "${bankId}" is not in ${BOT_HINDSIGHT_ALLOWED_BANKS_ENV} (${settings.hindsightAllowedBanks.join(", ")})`,
    );
  }
}

/**
 * The gateway settings a card needs, checked against the card: a card whose
 * provider goes through the gateway ({@link cardUsesLlmGateway}) fails here,
 * naming the missing setting, instead of compiling to a profile that talks to
 * the wrong endpoint or sends a placeholder key. Throws BotProfileInputError.
 * Called before any secret is created for the bot.
 */
export function assertBotLlmSettingsForCard(settings: BotProfileSettings, card: Record<string, unknown>): void {
  if (!cardUsesLlmGateway(card)) return;
  const provider = asTrimmedString(card.provider) ?? "";
  const which = provider ? `the card's provider is "${provider}"` : "the card sets no provider";
  if (!settings.llmBaseUrl) {
    throw new BotProfileInputError(
      `${BOT_LLM_BASE_URL_ENV} is not set, but ${which} and so needs the LLM gateway endpoint: without it the bot would go to the gateway's OpenRouter default`,
    );
  }
  if (!settings.llmApiKeyEnv) {
    throw new BotProfileInputError(
      `${BOT_LLM_API_KEY_ENV_ENV} is not set, but ${which} and so needs the LLM gateway key: without it the bot would send a placeholder key`,
    );
  }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** One MCP server: a URL and a token, from the board's gateway or from MYRMIDON_BOT_MCP_SERVERS. */
export interface BotMcpSource {
  name: string;
  url: string;
  token: string;
  /** Header that carries the token; default Authorization. */
  header?: string;
  /** Prefix of the header value; default "Bearer", "" = the raw token. */
  scheme?: string;
  /** A server that takes no token: no header and no .env variable are produced. */
  noAuth?: boolean;
  /** Whether the runtime MCP URL base rewrite applies (default true). Servers declared in MYRMIDON_BOT_MCP_SERVERS
   *  and the bot's own board gateway (its URL comes from MYRMIDON_BOT_BOARD_URL, already reachable from the
   *  container) are used at the address given, so the compiler sets this to false for them. */
  rewriteUrl?: boolean;
}

export interface BotProfileSource {
  botKey: string;
  /** The card, as stored (env bindings unresolved, `apiKey` a secret_ref). */
  adapterConfig: Record<string, unknown>;
  /** agent.runtimeConfig — read for heartbeat.maxConcurrentRuns. */
  runtimeConfig: Record<string, unknown>;
  /** The card's env with every secret_ref already resolved. */
  env: Record<string, HermesProfileEnvEntry>;
  /** Company skills chosen by the card's desiredSkills: runtime name -> files. */
  skills: Record<string, readonly HermesProfileSkillFile[]>;
  /** The text of workspace/AGENTS.md; blank writes none. The container wiring passes blank: instructions travel in the run request, not in a scanned context file (see instructions-source.ts). */
  instructions: string;
  /** The instructions bundle's other files, placed under workspace/ (names the gateway loads as project context are dropped). */
  workspaceFiles?: readonly HermesProfileWorkspaceFile[];
  /** The LLM gateway key held as an instance/company secret; used when the card goes
   *  through the gateway (`cardUsesLlmGateway`) and its own env carries no value under
   *  `settings.llmApiKeyEnv`. Ignored for a card with a native provider. */
  llmApiKey: string | null;
  /** Generated once per bot and stored as a company secret. */
  apiServerKey: string;
  /** This bot's board API key (agent_api_keys), stored as a company secret. */
  paperclipApiKey: string;
  mcpServers: readonly BotMcpSource[];
  instanceDefaults?: HermesProfileInstanceDefaults;
  /**
   * myrmidon(PARALLEL-HELPERS): the company ceiling/default for helpers, from
   * instance settings (`general.parallelHelpers`), as the ports read it.
   * Optional: absent = module defaults. The RESOLUTION against the card happens
   * here (not in the compiler) so that the pure compiler keeps no settings
   * knowledge; `resolveParallelHelpers` also normalizes the model fallback.
   */
  parallelHelpersSettings?: ParallelHelpersSettings;
  /**
   * myrmidon(BOT-LSP-DEFAULTS): the agent's role (caste key, `agents.role`).
   * Decides, with the card's own pin and the instance policy, which
   * language-server mode the bot runs with. Absent = a non-coding bot.
   */
  role?: string;
  /**
   * myrmidon(BOT-LSP-DEFAULTS): the instance language-server policy
   * (`general.botLsp`), as the ports read it. Absent = module defaults.
   */
  botLspSettings?: BotLspSettings;
}

export interface BuiltBotProfileInput {
  input: HermesProfileInput;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small readers (a card is user-edited JSON: never trust a field's type)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.flatMap((item) => {
    const text = asTrimmedString(item);
    return text ? [text] : [];
  });
  return list.length > 0 ? list : undefined;
}

// ---------------------------------------------------------------------------
// Card sections
// ---------------------------------------------------------------------------

function readAdapterConfig(card: Record<string, unknown>): HermesProfileAdapterConfig {
  const models = asRecord(card.models);
  const toolsets = Array.isArray(card.toolsets) ? asStringList(card.toolsets)?.join(",") : asTrimmedString(card.toolsets);
  return {
    model: asTrimmedString(card.model),
    provider: asTrimmedString(card.provider),
    effort: asTrimmedString(card.effort),
    models: {
      vision: asTrimmedString(models.vision),
      video: asTrimmedString(models.video),
      stt: asTrimmedString(models.stt),
      tts: asTrimmedString(models.tts),
      fallbacks: asStringList(models.fallbacks),
      // myrmidon(BOT-RUNTIME-TUNING-B): context window and auxiliary models from
      // the card's "Additional models" block; validated by the compiler.
      contextLength: asTrimmedPositiveInt(models.contextLength),
      // myrmidon(BOT-RUNTIME-TUNING-A): the card's own compression token cap;
      // the compiler validates the range and it wins over the instance default.
      compressionThresholdTokens: asTrimmedPositiveInt(models.compressionThresholdTokens),
      titleGeneration: asTrimmedString(models.titleGeneration),
      compressionSummary: asTrimmedString(models.compressionSummary),
    },
    // myrmidon(PARALLEL-HELPERS): the raw card block; resolved against the company
    // ceiling in buildHermesProfileInput (the ceiling is instance settings).
    parallelHelpers: readParallelHelpersCard(card),
    toolsets,
  };
}

/** A positive integer read from user-edited card JSON; anything else is undefined (a card is never trusted). */
function asTrimmedPositiveInt(value: unknown): number | undefined {
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (typeof trimmed !== "number" || !Number.isInteger(trimmed)) return undefined;
  return trimmed > 0 ? trimmed : undefined;
}

const RECALL_BUDGETS = ["low", "mid", "high"] as const;
const MEMORY_MODES = ["hybrid", "context", "tools"] as const;

/**
 * One observation scope: a hindsight tag conjunction, e.g. `["channel:board"]`
 * or `["channel:board", "team:core"]`. Serialized into
 * `hermes/hindsight/config.json` as `observation_scopes` (an array of arrays),
 * the same shape the live hermes_local profiles carry.
 */
export function parseObservationScopes(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes: string[][] = [];
  const seen = new Set<string>();
  for (const scope of value) {
    // A single tag ("channel:board") is the same as a one-element list.
    const tags = (typeof scope === "string" ? [scope] : Array.isArray(scope) ? scope : [])
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter((tag) => tag.length > 0);
    if (tags.length === 0) continue;
    const key = JSON.stringify(tags);
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push(tags);
  }
  return scopes.length > 0 ? scopes : undefined;
}

/**
 * hindsight settings. The fleet only runs `local_external` (one shared service),
 * so `mode` is fixed here and a card cannot switch a bot to a cloud endpoint.
 * The card's optional `adapterConfig.hindsight` block may name the bank and tune
 * tags/mission/recall; the bank falls back to MYRMIDON_BOT_HINDSIGHT_BANK.
 */
function readHindsight(card: Record<string, unknown>, settings: BotProfileSettings): HermesProfileHindsightSettings {
  const block = asRecord(card.hindsight);
  const bankId = asTrimmedString(block.bankId) ?? settings.hindsightBank;
  if (!bankId) {
    throw new BotProfileInputError(
      `no hindsight bank: the card sets no adapterConfig.hindsight.bankId and ${BOT_HINDSIGHT_BANK_ENV} is not set`,
    );
  }
  // myrmidon(MEMORY-ISOLATION): the bank must be on the allowlist when one is
  // set — a typo'd bank id must fail the compile, not silently create a bank.
  // The bank id itself is safe to name in the error: it is an id, not a value
  // the way a secret or an address is.
  if (settings.hindsightAllowedBanks && !settings.hindsightAllowedBanks.includes(bankId)) {
    throw new BotProfileInputError(
      `hindsight bank "${bankId}" is not in ${BOT_HINDSIGHT_ALLOWED_BANKS_ENV} (${settings.hindsightAllowedBanks.join(", ")})`,
    );
  }
  const recallBudget = RECALL_BUDGETS.find((candidate) => candidate === block.recallBudget);
  const memoryMode = MEMORY_MODES.find((candidate) => candidate === block.memoryMode);
  return {
    bankId,
    mode: "local_external",
    apiUrl: settings.hindsightApiUrl ?? undefined,
    tags: asStringList(block.tags),
    mission: asTrimmedString(block.mission),
    recallBudget,
    memoryMode,
    autoRetain: typeof block.autoRetain === "boolean" ? block.autoRetain : undefined,
    observationScopes: parseObservationScopes(block.observationScopes),
  };
}

const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

/**
 * agent.runtimeConfig.heartbeat.maxConcurrentRuns, normalized exactly like the
 * board does for its own scheduling (services/heartbeat.ts normalizeMaxConcurrentRuns:
 * default AGENT_DEFAULT_MAX_CONCURRENT_RUNS, floored, clamped to 1..50), so the
 * gateway's own limit never disagrees with the board's.
 */
export function readMaxConcurrentRuns(runtimeConfig: Record<string, unknown>): number {
  const raw = asRecord(runtimeConfig.heartbeat).maxConcurrentRuns;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  const parsed = Math.floor(Number.isFinite(numeric) ? numeric : AGENT_DEFAULT_MAX_CONCURRENT_RUNS);
  if (!Number.isFinite(parsed)) return AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** Env prefix of the variables that carry MCP bearer tokens inside a bot's .env. */
export const BOT_MCP_TOKEN_ENV_PREFIX = "MYRMIDON_MCP_TOKEN_";

/** Same rewrite as the P4 adapter's rewriteRuntimeMcpServerUrl: origin replaced, path and query kept. */
export function rewriteMcpServerUrl(url: string, internalBase: string): string {
  try {
    const parsed = new URL(url);
    const base = new URL(internalBase);
    if (parsed.origin === base.origin) return url;
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * The internal base MCP gateway URLs are rewritten to. Same precedence as the P4
 * adapter (myrmidon-runtime-mcp.ts resolveRuntimeMcpUrlBase): the card's
 * `runtimeMcpUrlRewrite: false` turns it off, the card's `runtimeMcpUrlBase`
 * overrides the instance setting, and the instance setting
 * MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE is the default; unset = no rewrite.
 */
function effectiveMcpUrlBase(card: Record<string, unknown>, settings: BotProfileSettings): string | null {
  if (card.runtimeMcpUrlRewrite === false) return null;
  const agentBase = asTrimmedString(card.runtimeMcpUrlBase);
  if (agentBase) return agentBase.replace(/\/+$/, "");
  return settings.runtimeMcpUrlBase;
}

/**
 * MCP servers for the profile. A token never lands in config.yaml as a value:
 * config.yaml carries `Authorization: Bearer ${MYRMIDON_MCP_TOKEN_<NAME>}` (the
 * header and scheme are configurable per server) and the token itself goes to
 * the (0600) .env, where Hermes expands the reference at load. A `noAuth` server
 * gets neither a header nor a variable.
 */
function buildMcpServers(
  sources: readonly BotMcpSource[],
  urlBase: string | null,
  warnings: string[],
): { servers: HermesProfileMcpServer[]; env: Record<string, HermesProfileEnvEntry> } {
  const servers: HermesProfileMcpServer[] = [];
  const env: Record<string, HermesProfileEnvEntry> = {};
  const seenNames = new Set<string>();
  for (const source of sources) {
    const name = sanitizeMcpServerName(source.name);
    if (!name) {
      warnings.push("mcp: a server with an empty name was skipped");
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`mcp.${name}: duplicate server name, the first one is kept`);
      continue;
    }
    const url = urlBase && source.rewriteUrl !== false ? rewriteMcpServerUrl(source.url, urlBase) : source.url;
    if (source.noAuth) {
      seenNames.add(name);
      servers.push({ name, url });
      continue;
    }
    if (!source.token.trim()) {
      warnings.push(`mcp.${name}: no token, the server was skipped`);
      continue;
    }
    const header = source.header ?? DEFAULT_MCP_HEADER;
    const scheme = source.scheme ?? DEFAULT_MCP_SCHEME;
    if (!HEADER_NAME_PATTERN.test(header) || !AUTH_SCHEME_PATTERN.test(scheme)) {
      warnings.push(`mcp.${name}: an invalid header name or scheme, the server was skipped`);
      continue;
    }
    const variable = `${BOT_MCP_TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    if (variable in env) {
      warnings.push(`mcp.${name}: its token variable ${variable} collides with another server's, skipped`);
      continue;
    }
    seenNames.add(name);
    env[variable] = { value: source.token, secret: true };
    servers.push({
      name,
      url,
      headers: { [header]: scheme ? `${scheme} \${${variable}}` : `\${${variable}}` },
    });
  }
  return { servers, env };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * myrmidon(BOT-LSP-DEFAULTS): the role policy and the card's pin -> the
 * compiler's per-agent `lsp` settings. Undefined = write no `lsp` block (full
 * mode with no exclusions, i.e. Hermes' own defaults).
 */
function buildBotLsp(
  role: string | undefined,
  card: Record<string, unknown>,
  settings: BotLspSettings | undefined,
): HermesProfileLspSettings | undefined {
  const resolved = resolveBotLsp(role, card, settings);
  const block = botLspHermesBlock(resolved.mode, settings);
  if (!block) return undefined;
  return {
    enabled: block.enabled,
    ...(block.idleTimeout !== undefined ? { idleTimeout: block.idleTimeout } : {}),
    ...(block.excludeRoots ? { excludeRoots: block.excludeRoots } : {}),
    ...(block.servers ? { servers: block.servers } : {}),
  };
}

/**
 * Card + resolved data + instance settings -> the input of `compileHermesProfile`.
 * Deterministic: the same source and settings give the same input, which is what
 * keeps the compiled hashes stable between reconcile ticks (the reconciler calls
 * compile on every tick, and a hash that flips restarts the bot).
 */
export function buildHermesProfileInput(source: BotProfileSource, settings: BotProfileSettings): BuiltBotProfileInput {
  assertBotProfileSettings(settings);
  const warnings: string[] = [];
  const card = source.adapterConfig;
  assertBotLlmSettingsForCard(settings, card);

  // A card with a native provider (gemini, zai, kimi-coding, anthropic, ...) talks to its own
  // endpoint with its own key from the card's env. The gateway address and key must not reach
  // its profile: the gateway would receive the provider's key in a protocol it does not speak,
  // because Hermes reads `model.base_url` for the provider it names.
  const usesGateway = cardUsesLlmGateway(card);

  const env: Record<string, HermesProfileEnvEntry> = { ...source.env };
  if (usesGateway && settings.llmApiKeyEnv) {
    const cardValue = env[settings.llmApiKeyEnv]?.value;
    if (!cardValue || !cardValue.trim()) {
      if (!source.llmApiKey || !source.llmApiKey.trim()) {
        throw new BotProfileInputError(
          `no value for the LLM gateway key: the card's env has no ${settings.llmApiKeyEnv} and the company secret "${settings.llmApiKeySecret ?? settings.llmApiKeyEnv}" is missing or empty`,
        );
      }
      env[settings.llmApiKeyEnv] = { value: source.llmApiKey, secret: true };
    }
  }

  const mcp = buildMcpServers(source.mcpServers, effectiveMcpUrlBase(card, settings), warnings);
  Object.assign(env, mcp.env);

  // myrmidon(BOT-RUNTIME-TUNING-B): the instance defaults for compression,
  // per-model context windows and auxiliary models. A source that already
  // carries instanceDefaults (a caller with its own map) wins per-field where
  // it sets something; the settings-derived values fill the rest, so a card's
  // explicit values keep winning over both.
  // myrmidon(BOT-RUNTIME-TUNING-A): `settings.compressionThresholdTokens` is
  // the company default (never null now) and is spread FIRST for exactly that
  // reason — a caller-provided compression block overrides it, and the card's
  // own `models.compressionThresholdTokens` overrides both (in the compiler).
  const settingsInstanceDefaults: HermesProfileInstanceDefaults = {
    compression: {
      ...(settings.compressionThresholdTokens !== null
        ? { thresholdTokens: settings.compressionThresholdTokens }
        : {}),
      ...(source.instanceDefaults?.compression ?? {}),
    },
    sessionsRetentionDays: source.instanceDefaults?.sessionsRetentionDays,
    // myrmidon(MEMORY-CENTRAL-A): MYRMIDON_BOT_LOCAL_MEMORY_OFF is an instance
    // switch read into settings; a hand-built settings object without the
    // field falls back to the caller's own instanceDefaults.
    disableLocalMemory: settings.localMemoryOff ?? source.instanceDefaults?.disableLocalMemory,
    modelContextLengths: settings.modelContextLengths ?? source.instanceDefaults?.modelContextLengths,
    auxiliary: {
      ...(source.instanceDefaults?.auxiliary ?? {}),
      ...(settings.auxiliaryTitleModel ? { titleGenerationModel: settings.auxiliaryTitleModel } : {}),
      ...(settings.auxiliaryCompressionModel ? { compressionModel: settings.auxiliaryCompressionModel } : {}),
      // myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): the instance-wide cheap
      // ceiling for auxiliary fallback chains; null (unset) leaves Hermes's own
      // policy in place.
      ...(settings.auxiliaryFallbackModels && settings.auxiliaryFallbackModels.length > 0
        ? { fallbackModels: settings.auxiliaryFallbackModels }
        : {}),
    },
  };
  const instanceDefaultsWarnings: string[] = [];
  if (settings.compressionThresholdTokensError) instanceDefaultsWarnings.push(settings.compressionThresholdTokensError);
  if (settings.modelContextLengthsError) instanceDefaultsWarnings.push(settings.modelContextLengthsError);
  warnings.push(...instanceDefaultsWarnings);

  const input: HermesProfileInput = {
    botKey: source.botKey,
    adapterConfig: readAdapterConfig(card),
    env,
    skills: source.skills,
    instructions: source.instructions,
    workspaceFiles: source.workspaceFiles,
    hindsight: readHindsight(card, settings),
    llm: usesGateway
      ? {
          baseUrl: settings.llmBaseUrl ?? undefined,
          apiKeyEnv: settings.llmApiKeyEnv ?? undefined,
        }
      : {},
    mcpServers: mcp.servers,
    maxConcurrentRuns: readMaxConcurrentRuns(source.runtimeConfig),
    // myrmidon(PARALLEL-HELPERS): card block + company ceiling -> delegation
    // config (see resolveParallelHelpers). The default helper model comes from
    // MYRMIDON_BOT_HELPER_MODEL on the card's env — an instance value, not a
    // literal in code, so no model name is baked into the product. The card's
    // env is a plain record here, so index it directly rather than casting.
    parallelHelpers: resolveParallelHelpers(
      card,
      source.parallelHelpersSettings,
      readSettingFromRecord(env, PARALLEL_HELPERS_DEFAULT_MODEL_ENV) ?? "",
    ),
    instanceDefaults: settingsInstanceDefaults,
    // myrmidon(BOT-LSP-DEFAULTS): role policy + card pin -> the bot's `lsp` block.
    // Resolved here (not in the compiler) for the same reason as the helpers:
    // the pure compiler keeps no settings knowledge.
    lsp: buildBotLsp(source.role, card, source.botLspSettings),
    apiServerKey: source.apiServerKey,
    // settings.boardUrl is non-null here: assertBotProfileSettings threw otherwise.
    paperclipApiUrl: settings.boardUrl as string,
    paperclipApiKey: source.paperclipApiKey,
  };
  return { input, warnings };
}
