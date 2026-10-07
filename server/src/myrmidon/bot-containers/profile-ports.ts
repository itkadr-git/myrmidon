// server/src/myrmidon/bot-containers/profile-ports.ts
//
// myrmidon(W2a): the database-bound implementation of BotProfilePorts and
// BotCardSyncPorts. Deliberately thin: every rule (what goes where in the
// profile, which secret is reused) lives in profile-input.ts / profile-compile.ts /
// card-sync.ts, which are tested against fake ports. What is left here is the
// glue to the board's own services, which the unit tests do not load.
//
// Two rules apply to everything in this file:
//  - It runs on every reconcile tick (once a minute per bot), so it never writes
//    unless something is missing or due (an expiring gateway token), and it
//    resolves the secrets it reads without a binding/audit context (no access
//    event per secret per bot per minute): the secrets this file created itself
//    (the bot's gateway key, its board API key and its board tool gateway token)
//    and the MCP tokens. The exception is the card's own env, which a card's
//    author controls: card-env.ts resolves it WITH a binding context (the board
//    checks that the secret is bound to this agent) and keeps the result in
//    memory, re-resolving only when the card's bindings or those secrets'
//    versions change.
//  - A secret it creates is get-or-create by a deterministic name, so a second
//    call returns the same value (compile must give the same hashes tick after
//    tick, or the bot restarts every minute).
//  - myrmidon(PERF-DIET-G): what is company- or instance-scoped and read once
//    per bot is shared inside one sweep instead (profile-pass.ts): compile
//    memoizes the instance settings ports, the skill port memoizes the skill
//    catalogue and the files it reads, and the lifecycle shares the two
//    company-wide reads behind its delivery decision. Nothing is cached between
//    sweeps, so a settings or skill change still lands on the next pass.

import { createHash, randomBytes } from "node:crypto";

import { agentApiKeys, agents as agentsTable, companies, companyMemberships, type Db } from "@paperclipai/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
// myrmidon(PARALLEL-HELPERS): the settings type the parallel-helpers port returns.
import type { BotLspSettings, BotDiskMechanics, ParallelHelpersSettings } from "@paperclipai/shared";
import { getConfiguredSecretProvider } from "../../secrets/configured-provider.js";
import {
  agentInstructionsService,
  agentService,
  companySkillService,
  instanceSettingsService,
  secretService,
} from "../../services/index.js";
// myrmidon(1.6-SKILL-LIFE): the lifecycle decides what reaches this agent.
import { skillLifecycleService } from "../skill-lifecycle/index.js";
import { BOT_AGENT_API_KEY_NAME, ensureBotAgentKey } from "./agent-key.js";
import { createBotBoardGatewayDeps, releaseStrayBotGateways } from "./board-gateway-ports.js";
import {
  BOT_BOARD_GATEWAY_SERVER_NAME,
  botBoardGatewayUrl,
  botGatewaySecretName,
  ensureBotBoardGateway,
} from "./board-gateway.js";
import { createBotCardSync, type BotCardSyncPorts, type BotCardSyncResult } from "./card-sync.js";
import { createCardEnvResolver } from "./card-env.js";
import { loadBotInstructionsBundle } from "./instructions-source.js";
import { readBotProfileSettings } from "./profile-input.js";
import {
  createActivityWarningSink,
  createBotProfileCompile,
  type BotProfileAgentRecord,
  type BotProfileCompileOptions,
  type BotProfilePorts,
} from "./profile-compile.js";
// myrmidon(PERF-DIET-G): the skills half of these ports, kept out of the database
// glue so the catalogue rules are tested against fake readers.
import { createBotProfileSkillLoader } from "./profile-skills.js";
import type { BotContainerActivitySink } from "./reconciler.js";
// myrmidon(PERF-DIET-G): the pass a sweep shares between the bots it reconciles.
import type { BotProfilePass } from "./profile-pass.js";
import type { CompiledProfile } from "./types.js";
// myrmidon(1.6-WIKI): approved wiki regulations reach a bot through its compiled profile.
import { loadRegulationWorkspaceFiles } from "../wiki-cortex/delivery.js";
import { createWikiRegulationService } from "../wiki-cortex/service.js";
import { createDbRegulationStore } from "../wiki-cortex/store.js";
import { readAppliedScopeLayout } from "./scope-wiring.js"; // myrmidon(BOT-DISK-F)
import { readBotDiskLayout, readBotDiskMechanics, readCloneIdleTtlSecForRole, readSharedPackageCachePathForRole } from "./bot-disk-service.js"; // myrmidon(1.6.1-BOT-DISK-B, 1.6.2-BOT-DISK-C, 1.6.5-BOT-DISK-H5c)

export { BOT_AGENT_API_KEY_NAME };

export function apiServerKeySecretName(agentId: string): string {
  return `myrmidon-bot-${agentId}-api-server-key`;
}

export function agentApiKeySecretName(agentId: string): string {
  return `myrmidon-bot-${agentId}-paperclip-api-key`;
}

const SYSTEM_ACTOR = { userId: null, agentId: null } as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Skills: read the card's skills into compiler input
// ---------------------------------------------------------------------------

// myrmidon(PERF-DIET-G): the rules and the filesystem read moved to
// profile-skills.ts, where they run against fake readers with call counts;
// this file binds them to the company skills service below.

// ---------------------------------------------------------------------------
// Secrets: get-or-create by name
// ---------------------------------------------------------------------------

type SecretsService = ReturnType<typeof secretService>;

async function getOrCreateSecret(
  secrets: SecretsService,
  companyId: string,
  name: string,
  description: string,
  generate: () => string,
): Promise<{ secretId: string; value: string }> {
  const existingId = (await secrets.getByName(companyId, name))?.id;
  if (existingId) {
    return { secretId: existingId, value: await secrets.resolveSecretValue(companyId, existingId, "latest") };
  }
  let secretId: string;
  try {
    const created = await secrets.create(
      companyId,
      { name, provider: getConfiguredSecretProvider(), value: generate(), description },
      SYSTEM_ACTOR,
    );
    secretId = created.id;
  } catch (err) {
    // A parallel create (another process, or the card sync racing this tick) won: use its secret.
    const raced = (await secrets.getByName(companyId, name))?.id;
    if (!raced) throw err;
    secretId = raced;
  }
  return { secretId, value: await secrets.resolveSecretValue(companyId, secretId, "latest") };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function toAgentRecord(row: {
  id: string;
  companyId: string;
  name: string;
  role?: string;
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
}): BotProfileAgentRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    adapterType: row.adapterType,
    adapterConfig: asRecord(row.adapterConfig),
    runtimeConfig: asRecord(row.runtimeConfig),
    // myrmidon(1.6-WIKI): the role picks which approved regulations reach this agent.
    ...(row.role ? { role: row.role } : {}),
  };
}

/**
 * The board's data behind `createBotProfileCompile`. `listMcpServers` gives the
 * bot its OWN board tool gateway (board-gateway.ts): a gateway owned by this
 * agent, and a token that opens only that gateway, kept as the company secret
 * `myrmidon-bot-<agentId>-board-gateway-token`. The run-scoped tokens hermes_local
 * uses live one hour and cannot sit in a container's long-lived profile; this one
 * expires in 30 days and is rotated here. The instance-wide servers (ragflow and
 * the like) do NOT come through this port: they are declared in
 * MYRMIDON_BOT_MCP_SERVERS, and compile resolves their tokens through
 * `readCompanySecret`.
 */
export function createDbBotProfilePorts(db: Db): BotProfilePorts {
  const agents = agentService(db);
  const secrets = secretService(db);
  const skills = companySkillService(db);
  // myrmidon(1.6-SKILL-LIFE): the profile compiler filters and pins company
  // skills by their lifecycle state through this service.
  const skillLifecycle = skillLifecycleService(db);
  const instructions = agentInstructionsService();
  const instanceSettings = instanceSettingsService(db);
  // myrmidon(1.6-WIKI): the wiki regulations of the company, delivered through the profile.
  const wikiRegulations = createWikiRegulationService(createDbRegulationStore(db));
  const resolveCardEnv = createCardEnvResolver(
    {
      resolveEnvBindings: (companyId, bindings, context) => secrets.resolveEnvBindings(companyId, bindings, context),
      async readSecretStamp(companyId, secretId) {
        const secret = await secrets.getById(secretId);
        if (!secret || secret.companyId !== companyId) return null;
        return `${secret.latestVersion}:${secret.status}`;
      },
    },
    // myrmidon(FLEETD-VMEXEC): the allowlist is re-read per resolve (per tick),
    // like the other per-tick bot settings; the env source is process.env.
    { env: process.env },
  );
  // myrmidon(PERF-DIET-G): the skills port, bound to the company services. The
  // pass it receives (a sweep's, profile-pass.ts) shares the catalogue reads and
  // the skill files between the bots of that pass.
  const loadAgentSkills = createBotProfileSkillLoader({
    readExperimental: () => instanceSettings.getExperimental(),
    resolveLifecycle: (companyId, agentId, cache) => skillLifecycle.resolveDelivery(companyId, agentId, cache),
    listRuntimeSkillEntries: (companyId, options) => skills.listRuntimeSkillEntries(companyId, options),
  });

  return {
    async loadAgent(agentId) {
      // myrmidon(PERF-DIET-G): one row by id. The board's own getById hydrates
      // the whole company and the agent's month spend beside the row — three
      // queries to normalize an org chain and a cost view a container profile
      // never reads. The fields the profile uses (BotProfileAgentRecord) are the
      // columns themselves, so the row is read directly.
      const rows = await db
        .select({
          id: agentsTable.id,
          companyId: agentsTable.companyId,
          name: agentsTable.name,
          role: agentsTable.role,
          adapterType: agentsTable.adapterType,
          adapterConfig: agentsTable.adapterConfig,
          runtimeConfig: agentsTable.runtimeConfig,
        })
        .from(agentsTable)
        .where(eq(agentsTable.id, agentId))
        .limit(1);
      const row = rows[0];
      return row ? toAgentRecord(row) : null;
    },

    resolveCardEnv,

    async readCompanySecret(companyId, name) {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) return null;
      return secrets.resolveSecretValue(companyId, secret.id, "latest");
    },

    async ensureApiServerKey(agent) {
      const { secretId, value } = await getOrCreateSecret(
        secrets,
        agent.companyId,
        apiServerKeySecretName(agent.id),
        `Hermes API server key of the bot container for agent ${agent.name}`,
        generateToken,
      );
      return { secretId, value };
    },

    async ensureAgentApiKey(agent) {
      const secretName = agentApiKeySecretName(agent.id);
      return ensureBotAgentKey(
        {
          async readSecret() {
            const secret = await secrets.getByName(agent.companyId, secretName);
            if (!secret) return null;
            return { secretId: secret.id, value: await secrets.resolveSecretValue(agent.companyId, secret.id, "latest") };
          },
          async findActiveKeyByToken(agentId, token) {
            // The token's own hash against the key table: "a key with the bot's name is active"
            // says nothing about whether THIS token still opens the board.
            const rows = await db
              .select({ id: agentApiKeys.id, responsibleUserId: agentApiKeys.responsibleUserId })
              .from(agentApiKeys)
              .where(
                and(
                  eq(agentApiKeys.agentId, agentId),
                  eq(agentApiKeys.keyHash, createHash("sha256").update(token).digest("hex")),
                  isNull(agentApiKeys.revokedAt),
                ),
              )
              .limit(1);
            return rows[0] ? { id: rows[0].id, responsibleUserId: rows[0].responsibleUserId?.trim() || null } : null;
          },
          async listActiveBotKeyIds(agentId) {
            const keys = await agents.listKeys(agentId);
            return keys.filter((key) => key.name === BOT_AGENT_API_KEY_NAME && !key.revokedAt).map((key) => key.id);
          },
          async readCompanyDefaultResponsibleUserId() {
            // The same rule as the board's own work without an actor (routines): the company's
            // explicit default first, then its oldest active owner.
            const rows = await db
              .select({ userId: companies.defaultResponsibleUserId })
              .from(companies)
              .where(eq(companies.id, agent.companyId))
              .limit(1);
            return rows[0]?.userId?.trim() || null;
          },
          async findCompanyOwnerUserId() {
            const rows = await db
              .select({ userId: companyMemberships.principalId })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.companyId, agent.companyId),
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.status, "active"),
                  eq(companyMemberships.membershipRole, "owner"),
                ),
              )
              .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
              .limit(1);
            return rows[0]?.userId?.trim() || null;
          },
          async createKey(agentId, responsibleUserId) {
            const created = await agents.createApiKey(agentId, BOT_AGENT_API_KEY_NAME, { kind: "standard" }, { responsibleUserId });
            return { id: created.id, token: created.token };
          },
          async fillKeyResponsibleUser(agentId, keyId, responsibleUserId) {
            // One conditional UPDATE: only this driver's own, still active key, and only while its
            // field is empty (NULL or blank, which the board treats the same). Never overwrites.
            const updated = await db
              .update(agentApiKeys)
              .set({ responsibleUserId })
              .where(
                and(
                  eq(agentApiKeys.id, keyId),
                  eq(agentApiKeys.agentId, agentId),
                  eq(agentApiKeys.name, BOT_AGENT_API_KEY_NAME),
                  isNull(agentApiKeys.revokedAt),
                  sql`coalesce(btrim(${agentApiKeys.responsibleUserId}), '') = ''`,
                ),
              )
              .returning({ id: agentApiKeys.id });
            return updated.length > 0;
          },
          async revokeKey(agentId, keyId) {
            await agents.revokeKey(agentId, keyId);
          },
          async storeSecret(existing, token) {
            if (existing) {
              await secrets.rotate(existing.secretId, { value: token }, SYSTEM_ACTOR);
              return;
            }
            await secrets.create(
              agent.companyId,
              {
                name: secretName,
                provider: getConfiguredSecretProvider(),
                value: token,
                description: `Board API key of the bot container for agent ${agent.name}`,
              },
              SYSTEM_ACTOR,
            );
          },
        },
        agent.id,
      );
    },

    async listMcpServers(agent, context) {
      const secretName = botGatewaySecretName(agent.id);
      const deps = createBotBoardGatewayDeps(db, agent, {
        async readSecret() {
          const secret = await secrets.getByName(agent.companyId, secretName);
          if (!secret) return null;
          return { secretId: secret.id, value: await secrets.resolveSecretValue(agent.companyId, secret.id, "latest") };
        },
        async storeSecret(existing, token) {
          if (existing) {
            await secrets.rotate(existing.secretId, { value: token }, SYSTEM_ACTOR);
            return;
          }
          await secrets.create(
            agent.companyId,
            {
              name: secretName,
              provider: getConfiguredSecretProvider(),
              value: token,
              description: `Board tool gateway token of the bot container for agent ${agent.name}`,
            },
            SYSTEM_ACTOR,
          );
        },
      });
      // Switched off: the same path as "nothing assigned", which releases what was made and delivers nothing.
      const ensured = await ensureBotBoardGateway(
        context.enabled ? deps : { ...deps, resolveAssignment: async () => ({ assignment: null, warnings: [] }) },
      );
      if (!ensured.gateway) return { servers: [], warnings: ensured.warnings };
      return {
        servers: [
          {
            name: BOT_BOARD_GATEWAY_SERVER_NAME,
            url: botBoardGatewayUrl(context.boardUrl, ensured.gateway.publicId),
            token: ensured.gateway.token,
          },
        ],
        warnings: ensured.warnings,
      };
    },

    // myrmidon(PERF-DIET-G): the rules live in profile-skills.ts (tested with
    // fake readers); this only binds them to the company services. The pass is the
    // sweep's: it shares the lifecycle delivery, the runtime catalogue and the skill
    // files of a whole sweep between its bots.
    async loadSkills(agent, pass) {
      return loadAgentSkills(agent, pass);
    },

    async loadInstructions(agent) {
      // Only the bundle's files beside its entry file are read here: the instructions
      // themselves travel in the run request (see instructions-source.ts).
      const bundle = await instructions.getBundle(agent);
      return loadBotInstructionsBundle({
        async listBundle() {
          if (!bundle.rootPath) return null;
          return {
            entryFile: bundle.entryFile,
            files: bundle.files.map((file) => ({ path: file.path, size: file.size, virtual: file.virtual })),
          };
        },
        async readFile(relativePath) {
          return (await instructions.readFile(agent, relativePath)).content;
        },
      });
    },

    // myrmidon(BOT-RUNTIME-TUNING-B): instance defaults for the profile compiler,
    // from the MYRMIDON_BOT_* settings via the existing reader (readBotProfileSettings
    // pattern; re-read on every call, so a corrected variable needs no rebuild).
    // The per-tick compile call in profile-compile.ts merges these with the settings
    // it read itself; this port supplies the same map for callers that go through
    // buildHermesProfileInput without their own instanceDefaults source.
    async instanceDefaults() {
      const settings = readBotProfileSettings(process.env);
      return {
        compression: {
          ...(settings.compressionThresholdTokens !== null ? { thresholdTokens: settings.compressionThresholdTokens } : {}),
        },
        ...(settings.modelContextLengths ? { modelContextLengths: settings.modelContextLengths } : {}),
        auxiliary: {
          ...(settings.auxiliaryTitleModel ? { titleGenerationModel: settings.auxiliaryTitleModel } : {}),
          ...(settings.auxiliaryCompressionModel ? { compressionModel: settings.auxiliaryCompressionModel } : {}),
          // myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING): the auxiliary fallback
          // ceiling; the compiler resolves the route of each entry from the
          // card's provider and the input's gateway settings.
          ...(settings.auxiliaryFallbackModels && settings.auxiliaryFallbackModels.length > 0
            ? { fallbackModels: settings.auxiliaryFallbackModels }
            : {}),
        },
      };
    },

    // myrmidon(PARALLEL-HELPERS): the company ceiling/default for helpers. Read
    // from the instance settings row on every tick (see the port's contract):
    // a settings change applies on the next reconcile, without a restart.
    async parallelHelpers(): Promise<ParallelHelpersSettings | undefined> {
      const general = await instanceSettings.getGeneral();
      return general.parallelHelpers;
    },

    // myrmidon(1.6.1-BOT-DISK-B): the shared package cache path, read per tick
    // from the same row the local driver reads for its binds.
    async sharedPackageCachePath(role?: string): Promise<string | undefined> {
      return readSharedPackageCachePathForRole(db, role);
    },

    // myrmidon(1.6.2-BOT-DISK-C): the clone lifecycle policy for the in-container reaper.
    async cloneIdleTtlSec(role?: string): Promise<number | undefined> {
      return readCloneIdleTtlSecForRole(db, role);
    },

    // myrmidon(BOT-DISK-D): the pnpm store directory and import method, read per tick from the same row.
    async pnpmSettings(): Promise<{ storeDir: string; importMethod: string }> {
      const layout = await readBotDiskLayout(db);
      return { storeDir: layout.pnpmStoreDir, importMethod: layout.pnpmImportMethod };
    },

    // myrmidon(1.6.5-BOT-DISK-H5c): the BOT-DISK-H mechanics (C7), read per tick
    // from the same `general.botDisk` row, so a settings change reaches the bots
    // on the next reconcile without a restart.
    async botDiskMechanics(): Promise<BotDiskMechanics> {
      return readBotDiskMechanics(db);
    },

    // myrmidon(BOT-DISK-F): the layout the board keeps this bot on, so a member of a shared
    // scope instance gets the instance's pnpm store path.
    async scopeLayout(agentId: string) {
      return readAppliedScopeLayout(db, agentId);
    },

    // myrmidon(BOT-LSP-DEFAULTS): the instance language-server policy. Read
    // from the settings row on every tick: a change applies on the next
    // reconcile (a config.yaml change, so under the per-bot pause), no restart
    // of the server.
    async botLsp(): Promise<BotLspSettings | undefined> {
      const general = await instanceSettings.getGeneral();
      return general.botLsp;
    },

    // myrmidon(1.6-WIKI): the approved regulations of the agent's role, as workspace files
    // for the container profile. An empty wiki produces no file at all.
    async loadRegulations(agent, context) {
      return loadRegulationWorkspaceFiles(wikiRegulations, { companyId: agent.companyId, role: agent.role }, context);
    },
  };
}

/** The card write behind `createBotCardSync`: the agent update path, so the secret_ref
 *  it stores is bound to the agent (a run may then resolve it) and the change is recorded
 *  as a config revision under a system source. */
export function createDbBotCardSyncPorts(db: Db, profilePorts: BotProfilePorts = createDbBotProfilePorts(db)): BotCardSyncPorts {
  const agents = agentService(db);
  return {
    loadAgent: profilePorts.loadAgent,
    ensureApiServerKey: profilePorts.ensureApiServerKey,
    async saveAdapterConfig(agent, adapterConfig) {
      await agents.update(agent.id, { adapterConfig }, { recordRevision: { source: "myrmidon_bot_containers" } });
    },
  };
}

/**
 * The fields of `BotContainerRuntimeDeps` W2a fills, bound to the database:
 *
 *   startBotContainerReconciliation(listAgents, { driver, maintenance, network, activity, ...botProfileWiring(db, { activity }) })
 *
 * (the call is startup.ts, `startBotContainers`, with `listAgents` from agents-query.ts).
 *
 * Profile warnings (a skipped skill, a bundle file over the limit, an assigned
 * connection left out of the board gateway) go to `opts.onWarnings`, or, when only `opts.activity` is given, to that
 * activity log: the same place the reconciler writes its own events.
 */
export function botProfileWiring(
  db: Db,
  opts: BotProfileCompileOptions & { activity?: BotContainerActivitySink } = {},
): {
  compile: (agentId: string, botKey: string, pass?: BotProfilePass) => Promise<CompiledProfile>;
  /** myrmidon(PERF-DIET-G): the cache one sweep shares between the bots it
   *  reconciles; the sweep begins one pass per tick and ends it when the last
   *  bot is done, so nothing survives into the next tick. */
  beginProfilePass: () => BotProfilePass;
  endProfilePass: (pass: BotProfilePass) => void;
  syncCard: (agentId: string, botKey: string) => Promise<BotCardSyncResult>;
  releaseStrayGateways: (keepAgentIds: ReadonlySet<string>) => Promise<{ released: number; warnings: string[] }>;
} {
  const ports = createDbBotProfilePorts(db);
  const { activity, ...compileOptions } = opts;
  const onWarnings = compileOptions.onWarnings ?? (activity ? createActivityWarningSink(activity) : undefined);
  const compile = createBotProfileCompile(ports, { ...compileOptions, ...(onWarnings ? { onWarnings } : {}) });
  return {
    compile,
    beginProfilePass: compile.beginPass,
    endProfilePass: compile.endPass,
    syncCard: createBotCardSync(createDbBotCardSyncPorts(db, ports)),
    releaseStrayGateways: (keepAgentIds) => releaseStrayBotGateways(db, keepAgentIds),
  };
}
