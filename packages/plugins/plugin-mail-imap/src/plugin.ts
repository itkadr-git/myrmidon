import {
  definePlugin,
  type PluginConfigChangeContext,
  type PluginContext,
  type PluginJobContext,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { resolveConfig, type MailPluginConfig } from "./config.js";
import { ImapFlowClient } from "./imap-client.js";
import { runSyncPass, type ImapClientLike, type SyncRunResult } from "./sync-engine.js";
import {
  MAIL_SYNC_JOB_KEY,
  SYNC_NOW_ACTION_KEY,
  TEST_CONNECTION_ACTION_KEY,
  MAILBOX_STATE_NAMESPACE,
  LAST_UID_STATE_KEY,
  COMPANIES_STATE_NAMESPACE,
  ENABLED_COMPANIES_STATE_KEY,
} from "./manifest.js";

/** IMAP client factory — injectable for tests. */
export type ImapClientFactory = (config: MailPluginConfig, password: string) => ImapClientLike;

const defaultClientFactory: ImapClientFactory = (config, password) =>
  new ImapFlowClient({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapTls,
    user: config.username,
    pass: password,
  });

let clientFactory: ImapClientFactory = defaultClientFactory;

/** Test hook: replace the IMAP client factory. Not part of the plugin API. */
export function setImapClientFactory(factory: ImapClientFactory): void {
  clientFactory = factory;
}

/** Test hook: restore the default factory. */
export function resetImapClientFactory(): void {
  clientFactory = defaultClientFactory;
}

// Lifecycle hooks (onConfigChanged) receive no PluginContext, so setup stores
// the live context here for them. One worker process hosts one plugin instance.
let liveCtx: PluginContext | null = null;

function table(ctx: PluginContext, name: string): string {
  return `${ctx.db.namespace}.${name}`;
}

async function loadConfig(ctx: PluginContext, companyId: string): Promise<MailPluginConfig> {
  const raw = await ctx.config.get(companyId);
  const resolved = resolveConfig(raw ?? {});
  if (!resolved.ok) {
    throw new Error(`mail plugin misconfigured: ${resolved.errors.join("; ")}`);
  }
  return resolved.config;
}

async function resolvePassword(ctx: PluginContext, config: MailPluginConfig, companyId: string): Promise<string> {
  return ctx.secrets.resolve(config.passwordSecretRef, {
    companyId,
    configPath: "passwordSecretRef",
  });
}

async function readLastUid(ctx: PluginContext, companyId: string): Promise<number> {
  const value = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: MAILBOX_STATE_NAMESPACE,
    stateKey: LAST_UID_STATE_KEY,
  });
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function writeLastUid(ctx: PluginContext, companyId: string, uid: number): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      namespace: MAILBOX_STATE_NAMESPACE,
      stateKey: LAST_UID_STATE_KEY,
    },
    uid,
  );
}

async function readEnabledCompanies(ctx: PluginContext): Promise<string[]> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    namespace: COMPANIES_STATE_NAMESPACE,
    stateKey: ENABLED_COMPANIES_STATE_KEY,
  });
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function markCompanyEnabled(ctx: PluginContext, companyId: string): Promise<void> {
  const companies = await readEnabledCompanies(ctx);
  if (companies.includes(companyId)) return;
  await ctx.state.set(
    { scopeKind: "instance", namespace: COMPANIES_STATE_NAMESPACE, stateKey: ENABLED_COMPANIES_STATE_KEY },
    [...companies, companyId],
  );
}

async function persistRun(
  ctx: PluginContext,
  companyId: string,
  runId: string,
  trigger: string,
  cursorBefore: number,
  sourceFolder: string,
  result: SyncRunResult,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sync_runs")} (id, company_id, run_id, trigger, fetched, moved, skipped, errors, cursor_before, cursor_after, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      randomUUID(),
      companyId,
      runId,
      trigger,
      result.fetched,
      result.moved,
      result.skipped,
      result.errors,
      cursorBefore,
      result.highestUidSeen,
    ],
  );
  for (const detail of result.details) {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "mail_log")} (id, company_id, run_id, uid, message_id, from_header, subject, source_folder, target_folder, rule_name, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomUUID(),
        companyId,
        runId,
        detail.uid,
        detail.messageId ?? null,
        detail.from,
        detail.subject,
        sourceFolder,
        detail.targetFolder,
        detail.ruleName,
        detail.status,
        detail.error ?? null,
      ],
    );
  }
}

async function executeSync(
  ctx: PluginContext,
  companyId: string,
  runId: string,
  trigger: string,
): Promise<SyncRunResult> {
  const config = await loadConfig(ctx, companyId);
  const password = await resolvePassword(ctx, config, companyId);
  const lastUid = await readLastUid(ctx, companyId);

  const client = clientFactory(config, password);
  const result = await runSyncPass({
    client,
    rules: config.sortRules,
    defaultTargetFolder: config.defaultTargetFolder,
    sourceFolder: config.sourceFolder,
    lastUid,
    maxMessages: config.maxMessagesPerRun,
  });

  if (result.highestUidSeen !== null) {
    await writeLastUid(ctx, companyId, result.highestUidSeen);
  }
  await persistRun(ctx, companyId, runId, trigger, lastUid, config.sourceFolder, result);

  await ctx.activity.log({
    companyId,
    message: `mail sync ${trigger}: fetched=${result.fetched} moved=${result.moved} skipped=${result.skipped} errors=${result.errors}`,
    entityType: "plugin_job",
    entityId: MAIL_SYNC_JOB_KEY,
    metadata: {
      runId,
      trigger,
      fetched: result.fetched,
      moved: result.moved,
      skipped: result.skipped,
      errors: result.errors,
      cursorBefore: lastUid,
      cursorAfter: result.highestUidSeen,
    },
  });
  await ctx.metrics.write("mail_sync.fetched", result.fetched, { trigger });
  await ctx.metrics.write("mail_sync.moved", result.moved, { trigger });
  await ctx.metrics.write("mail_sync.errors", result.errors, { trigger });

  return result;
}

async function testConnection(ctx: PluginContext, companyId: string): Promise<Record<string, unknown>> {
  try {
    const config = await loadConfig(ctx, companyId);
    const password = await resolvePassword(ctx, config, companyId);
    const client = clientFactory(config, password);
    await client.connect();
    await client.selectMailbox(config.sourceFolder);
    const highestUid = await client.getHighestUid();
    await client.close();
    return { ok: true, host: config.imapHost, sourceFolder: config.sourceFolder, highestUid };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    liveCtx = ctx;
    ctx.logger.info("mail-imap plugin starting");

    ctx.jobs.register(MAIL_SYNC_JOB_KEY, async (job: PluginJobContext) => {
      ctx.logger.info("mail-sync job started", { runId: job.runId, trigger: job.trigger });
      const companies = await readEnabledCompanies(ctx);
      if (companies.length === 0) {
        ctx.logger.info("mail-sync: no configured companies, skipping", { runId: job.runId });
        return;
      }
      for (const companyId of companies) {
        try {
          await executeSync(ctx, companyId, job.runId, job.trigger);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.error("mail-sync failed for company", { runId: job.runId, companyId, error: message });
          await ctx.activity.log({
            companyId,
            message: `mail sync ${job.trigger} failed: ${message}`,
            entityType: "plugin_job",
            entityId: MAIL_SYNC_JOB_KEY,
            metadata: { runId: job.runId, trigger: job.trigger, error: message },
          });
          await ctx.metrics.write("mail_sync.errors", 1, { trigger: job.trigger });
        }
      }
    });

    ctx.actions.register(SYNC_NOW_ACTION_KEY, async (_params: Record<string, unknown>, actionCtx: PluginPerformActionContext) => {
      const companyId = actionCtx.companyId;
      if (!companyId) {
        return { ok: false, status: 400, error: "company scope required" };
      }
      const runId = randomUUID();
      const result = await executeSync(ctx, companyId, runId, "manual");
      return {
        ok: true,
        runId,
        fetched: result.fetched,
        moved: result.moved,
        skipped: result.skipped,
        errors: result.errors,
      };
    });

    ctx.actions.register(TEST_CONNECTION_ACTION_KEY, async (_params: Record<string, unknown>, actionCtx: PluginPerformActionContext) => {
      const companyId = actionCtx.companyId;
      if (!companyId) {
        return { ok: false, status: 400, error: "company scope required" };
      }
      return testConnection(ctx, companyId);
    });
  },

  async onConfigChanged(newConfig: Record<string, unknown>, context?: PluginConfigChangeContext) {
    const companyId = context?.companyId;
    if (!companyId || !liveCtx) return;
    const resolved = resolveConfig(newConfig);
    if (resolved.ok) {
      await markCompanyEnabled(liveCtx, companyId);
    }
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const resolved = resolveConfig(config);
    if (resolved.ok) {
      return { ok: true };
    }
    return { ok: false, errors: resolved.errors };
  },

  async onHealth() {
    return { status: "ok" as const, message: "mail-imap plugin ready" };
  },
});

export default plugin;
