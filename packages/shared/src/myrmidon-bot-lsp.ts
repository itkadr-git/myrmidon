// myrmidon(BOT-LSP-DEFAULTS): which language-server mode a bot runs with.
//
// Hermes starts a language server for every git worktree a bot edits in
// (`lsp` in hermes_cli/config_defaults.py). On a TypeScript monorepo each one
// is a tsserver of about 1 GB, kept for `idle_timeout` (600 s by default)
// after the last use, and typescript-language-server starts a second
// ("syntax") tsserver next to it. A fleet where every bot edits worktrees
// therefore carries dozens of tsserver processes even though most bots never
// write code, and the bots that do get their typecheck from the build server
// anyway.
//
// The policy: a bot whose role (caste key, `agents.role`) writes code runs
// language servers in a LIMITED mode; every other bot runs none. One place
// decides it — the profile compiler reads it (server/src/myrmidon/bot-containers/
// profile-input.ts), the settings page and the agent card write it
// (ui/src/components/myrmidon/BotLspSettingsPanel.tsx,
// AgentCardLspFields.tsx) — so the rules live here.
//
// Three modes:
//   off     — `lsp.enabled: false`: no language server, no event loop, no cost.
//   limited — one tsserver per worktree (`tsserver.useSyntaxServer: "never"`),
//             no automatic typings acquisition, a heap cap and a short idle
//             timeout. Diagnostics after edits still work.
//   full    — Hermes' own defaults, nothing written.
//
// The instance setting picks the mode for "coding" and "non-coding" roles and
// lists which roles code; an agent card may pin its own mode.

import { z } from "zod";

/** adapterConfig key holding the card's language-server block. */
export const BOT_LSP_CARD_KEY = "lsp";

/** Instance setting (`instance_settings.general.botLsp`). */
export const BOT_LSP_SETTINGS_KEY = "botLsp";

export const BOT_LSP_MODES = ["off", "limited", "full"] as const;
export type BotLspMode = (typeof BOT_LSP_MODES)[number];

/**
 * Roles (caste keys) that write code when the settings name none. Built-in
 * castes `engineer`, `qa` and `devops`, plus the custom-caste keys a company
 * commonly creates for code review and releases. A key no company uses is
 * harmless: the list is matched against `agents.role`, nothing else.
 */
export const DEFAULT_BOT_LSP_CODING_ROLES: readonly string[] = ["engineer", "qa", "devops", "reviewer", "release"];

/** Mode of a coding role when the settings say nothing. */
export const DEFAULT_BOT_LSP_CODING_MODE: BotLspMode = "limited";
/** Mode of every other role when the settings say nothing. */
export const DEFAULT_BOT_LSP_NON_CODING_MODE: BotLspMode = "off";

/** `lsp.idle_timeout` of the limited mode, seconds (Hermes' own default is 600). */
export const DEFAULT_BOT_LSP_IDLE_TIMEOUT_SECONDS = 120;
/** Hermes raises any idle timeout below this to it (agent/lsp/manager.py MIN_IDLE_TIMEOUT). */
export const BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS = 30;
export const BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS = 86_400;

/** tsserver heap cap of the limited mode, MB (`maxTsServerMemory`). */
export const DEFAULT_BOT_LSP_TSSERVER_MEMORY_MB = 1024;
export const BOT_LSP_TSSERVER_MEMORY_MIN_MB = 256;
export const BOT_LSP_TSSERVER_MEMORY_MAX_MB = 16_384;

/** Hermes' registry id of the JavaScript/TypeScript server (typescript-language-server). */
export const BOT_LSP_TYPESCRIPT_SERVER_ID = "typescript";

const ROLE_KEY = /^[a-zA-Z0-9-]+$/;

/** The instance setting, as stored. Every field optional: absent = the module default. */
export interface BotLspSettings {
  /** Caste keys whose bots write code. */
  codingRoles?: string[];
  /** Mode of a bot whose role is in `codingRoles`. */
  codingMode?: BotLspMode;
  /** Mode of every other bot. */
  nonCodingMode?: BotLspMode;
  /** `lsp.idle_timeout` of the limited mode, seconds. */
  idleTimeoutSeconds?: number;
  /** tsserver heap cap of the limited mode, MB. */
  tsserverMemoryMb?: number;
  /** `lsp.exclude_roots` for every bot whose language servers run (limited or full). */
  excludeRoots?: string[];
}

const modeSchema = z.enum(BOT_LSP_MODES);
const roleKeySchema = z.string().min(1).max(60).regex(ROLE_KEY, "a caste key: latin letters, digits, hyphens");
const idleSchema = z.number().int().min(BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS).max(BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS);
const memorySchema = z.number().int().min(BOT_LSP_TSSERVER_MEMORY_MIN_MB).max(BOT_LSP_TSSERVER_MEMORY_MAX_MB);
const excludeRootSchema = z.string().trim().min(1).max(500);

export const botLspSettingsSchema = z
  .object({
    codingRoles: z.array(roleKeySchema).max(200).optional(),
    codingMode: modeSchema.optional(),
    nonCodingMode: modeSchema.optional(),
    idleTimeoutSeconds: idleSchema.optional(),
    tsserverMemoryMb: memorySchema.optional(),
    excludeRoots: z.array(excludeRootSchema).max(50).optional(),
  })
  .strict();

/**
 * Body of `PATCH /api/myrmidon/bot-lsp`: a field left out keeps its stored
 * value, `null` removes it (back to the module default).
 */
export const patchBotLspSettingsSchema = z
  .object({
    codingRoles: z.array(roleKeySchema).max(200).nullable().optional(),
    codingMode: modeSchema.nullable().optional(),
    nonCodingMode: modeSchema.nullable().optional(),
    idleTimeoutSeconds: idleSchema.nullable().optional(),
    tsserverMemoryMb: memorySchema.nullable().optional(),
    excludeRoots: z.array(excludeRootSchema).max(50).nullable().optional(),
  })
  .strict();

export type BotLspSettingsPatch = z.infer<typeof patchBotLspSettingsSchema>;

/** The card block, as stored in adapterConfig. Absent `mode` = follow the role. */
export interface BotLspCard {
  mode?: BotLspMode;
}

/** Every setting with its default filled in. */
export interface EffectiveBotLspSettings {
  codingRoles: string[];
  codingMode: BotLspMode;
  nonCodingMode: BotLspMode;
  idleTimeoutSeconds: number;
  tsserverMemoryMb: number;
  excludeRoots: string[];
}

export interface ResolvedBotLsp {
  mode: BotLspMode;
  /** Where the mode came from: the card's own pin, or the role policy. */
  source: "card" | "role";
  /** Whether the role is a coding role (independent of a card pin). */
  coding: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isBotLspMode(value: unknown): value is BotLspMode {
  return typeof value === "string" && (BOT_LSP_MODES as readonly string[]).includes(value);
}

function inRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function cleanList(value: unknown, keep: (item: string) => boolean): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && keep(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Settings row -> every value in force. A malformed field (a hand-edited row)
 * falls back to its default instead of failing the compile.
 */
export function effectiveBotLspSettings(settings: BotLspSettings | undefined | null): EffectiveBotLspSettings {
  const raw = asRecord(settings);
  return {
    codingRoles: cleanList(raw.codingRoles, (key) => ROLE_KEY.test(key)) ?? [...DEFAULT_BOT_LSP_CODING_ROLES],
    codingMode: isBotLspMode(raw.codingMode) ? raw.codingMode : DEFAULT_BOT_LSP_CODING_MODE,
    nonCodingMode: isBotLspMode(raw.nonCodingMode) ? raw.nonCodingMode : DEFAULT_BOT_LSP_NON_CODING_MODE,
    idleTimeoutSeconds:
      inRange(raw.idleTimeoutSeconds, BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS, BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS) ??
      DEFAULT_BOT_LSP_IDLE_TIMEOUT_SECONDS,
    tsserverMemoryMb:
      inRange(raw.tsserverMemoryMb, BOT_LSP_TSSERVER_MEMORY_MIN_MB, BOT_LSP_TSSERVER_MEMORY_MAX_MB) ??
      DEFAULT_BOT_LSP_TSSERVER_MEMORY_MB,
    excludeRoots: cleanList(raw.excludeRoots, () => true) ?? [],
  };
}

/** The card's block as stored; an unknown mode reads as "follow the role". */
export function readBotLspCard(card: Record<string, unknown>): BotLspCard {
  const block = asRecord(card[BOT_LSP_CARD_KEY]);
  return isBotLspMode(block.mode) ? { mode: block.mode } : {};
}

/** Whether a role (caste key) is a coding role under these settings. Case-insensitive. */
export function isBotLspCodingRole(role: string | null | undefined, settings: BotLspSettings | undefined | null): boolean {
  const key = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!key) return false;
  return effectiveBotLspSettings(settings).codingRoles.some((item) => item.toLowerCase() === key);
}

/**
 * Role + card + settings -> the mode this bot runs with. The card's pin wins;
 * otherwise the role decides. A bot with no role is a non-coding bot.
 */
export function resolveBotLsp(
  role: string | null | undefined,
  card: Record<string, unknown>,
  settings: BotLspSettings | undefined | null,
): ResolvedBotLsp {
  const effective = effectiveBotLspSettings(settings);
  const coding = isBotLspCodingRole(role, settings);
  const pinned = readBotLspCard(card).mode;
  if (pinned) return { mode: pinned, source: "card", coding };
  return { mode: coding ? effective.codingMode : effective.nonCodingMode, source: "role", coding };
}

/**
 * The Hermes `lsp` block for a mode, or null for "write nothing" (full mode
 * without exclusions = Hermes' own defaults). Field names follow the profile
 * compiler's `HermesProfileLspSettings`, which writes them as `enabled`,
 * `idle_timeout`, `exclude_roots` and `servers`.
 *
 * The limited mode's tsserver preferences ride
 * `lsp.servers.typescript.initialization_options`, which Hermes passes
 * unchanged as the LSP initializationOptions of typescript-language-server
 * (agent/lsp/manager.py init_overrides -> servers.py _make_spec). That server
 * reads `tsserver.useSyntaxServer` ("never" = no second, syntax-only
 * tsserver), `maxTsServerMemory` (passed to tsserver as
 * --max-old-space-size) and `disableAutomaticTypingAcquisition`.
 */
// Type aliases, not interfaces: the compiler's YAML node type is an index
// signature, which only object-literal types satisfy implicitly.
export type BotLspTypescriptInitOptions = {
  disableAutomaticTypingAcquisition: boolean;
  maxTsServerMemory: number;
  tsserver: { useSyntaxServer: "never" };
};

export type BotLspHermesBlock = {
  enabled: boolean;
  idleTimeout?: number;
  excludeRoots?: string[];
  servers?: { [serverId: string]: { initialization_options: BotLspTypescriptInitOptions } };
};

export function botLspHermesBlock(
  mode: BotLspMode,
  settings: BotLspSettings | undefined | null,
): BotLspHermesBlock | null {
  const effective = effectiveBotLspSettings(settings);
  if (mode === "off") return { enabled: false };
  const excludeRoots = effective.excludeRoots.length > 0 ? { excludeRoots: effective.excludeRoots } : {};
  if (mode === "full") {
    return effective.excludeRoots.length > 0 ? { enabled: true, ...excludeRoots } : null;
  }
  return {
    enabled: true,
    idleTimeout: effective.idleTimeoutSeconds,
    ...excludeRoots,
    servers: {
      [BOT_LSP_TYPESCRIPT_SERVER_ID]: {
        initialization_options: {
          disableAutomaticTypingAcquisition: true,
          maxTsServerMemory: effective.tsserverMemoryMb,
          tsserver: { useSyntaxServer: "never" },
        },
      },
    },
  };
}

/** One agent's line in the settings view's summary. */
export interface BotLspAgentMode {
  id: string;
  name: string;
  role: string | null;
  mode: BotLspMode;
  source: "card" | "role";
}

export interface BotLspModeCounts {
  off: number;
  limited: number;
  full: number;
}

export function countBotLspModes(agents: readonly { mode: BotLspMode }[]): BotLspModeCounts {
  const counts: BotLspModeCounts = { off: 0, limited: 0, full: 0 };
  for (const agent of agents) counts[agent.mode] += 1;
  return counts;
}
