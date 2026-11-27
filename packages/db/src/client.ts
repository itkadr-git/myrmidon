import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import * as schema from "./schema/index.js";
import { withTransientWriteRetry } from "./transient-write-retry.js";
import { withQueryObservation } from "./query-observer.js";

const require = createRequire(import.meta.url);

// Resolve the ESM entries explicitly: the packages' require conditions use
// separate CommonJS builds whose classes have different identities.
function loadPostgres() {
  return (require(fileURLToPath(import.meta.resolve("postgres"))) as { default: typeof postgres }).default;
}

function loadDrizzle() {
  return (require(fileURLToPath(import.meta.resolve("drizzle-orm/postgres-js"))) as typeof import("drizzle-orm/postgres-js")).drizzle;
}

type RegisteredPostgresClient = ReturnType<typeof postgres>;

/**
 * Derives a registry key from a connection URL's host and port only. We must
 * not retain or log the full URL, because it carries credentials.
 */
function hostPortKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}`;
}

/**
 * Same as `hostPortKey`, but returns `null` instead of throwing when the URL
 * does not parse. `postgres(url)` tolerates a value `new URL()` rejects (an
 * empty string falls back to the `PG*` environment variables), so `createDb`
 * must tolerate it too: skip the registry entry and let the driver decide
 * the outcome, instead of throwing an error the driver itself would not.
 */
function hostPortKeyOrNull(url: string): string | null {
  try {
    return hostPortKey(url);
  } catch (error) {
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code === "ERR_INVALID_URL") return null;
    throw error;
  }
}

// Tracks every client `createDb` hands out, keyed by host and port, so a test
// fixture can end them before it stops the Postgres cluster they point at. A
// `WeakRef` plus `FinalizationRegistry` means a long-lived process (a real
// server) retains nothing extra: an unreferenced client is pruned on its own.
const clientsByHostPort = new Map<string, Set<WeakRef<RegisteredPostgresClient>>>();
const clientFinalizer = new FinalizationRegistry<{ hostPortKey: string; ref: WeakRef<RegisteredPostgresClient> }>(
  ({ hostPortKey, ref }) => {
    const refs = clientsByHostPort.get(hostPortKey);
    if (!refs) return;
    refs.delete(ref);
    if (refs.size === 0) clientsByHostPort.delete(hostPortKey);
  },
);

function registerClient(key: string, client: RegisteredPostgresClient): void {
  const ref = new WeakRef(client);
  let refs = clientsByHostPort.get(key);
  if (!refs) {
    refs = new Set();
    clientsByHostPort.set(key, refs);
  }
  refs.add(ref);
  clientFinalizer.register(client, { hostPortKey: key, ref }, ref);
}

/**
 * Ends every live client `createDb` handed out for the given URL's host and
 * port, then forgets them. Call this before stopping a Postgres cluster: a
 * client that outlives the cluster it points at can crash the process (a
 * reserved connection's deferred write firing after the socket is gone).
 * Swallows individual `end()` errors so one bad client cannot block the rest.
 */
export async function closeRegisteredClients(url: string): Promise<void> {
  const key = hostPortKey(url);
  const refs = clientsByHostPort.get(key);
  if (!refs) return;

  clientsByHostPort.delete(key);
  const clients: RegisteredPostgresClient[] = [];
  for (const ref of refs) {
    clientFinalizer.unregister(ref);
    const client = ref.deref();
    if (client) clients.push(client);
  }

  await Promise.all(clients.map((client) => client.end({ timeout: 1 }).catch(() => {})));
}

export interface DatabaseClientOptions {
  /**
   * postgres.js `prepare`. Set false when connecting through a
   * transaction-mode pooler (pgbouncer / Neon `-pooler` endpoints /
   * Supabase Supavisor transaction ports) so the client does not rely on
   * session-scoped prepared statements. Defaults to the driver default
   * (enabled), preserving existing behavior on direct connections.
   */
  prepare?: boolean;
  /** postgres.js `max` — connection pool size (driver default: 10). */
  maxConnections?: number;
  /** postgres.js `idle_timeout` in seconds (driver default: disabled). */
  idleTimeoutSeconds?: number;
  /** postgres.js `connect_timeout` in seconds (driver default: 30). */
  connectTimeoutSeconds?: number;
  /**
   * postgres.js `max_lifetime` in seconds. Bounds how long one pooled
   * connection is reused before the client replaces it (driver default: a
   * random value between 30 and 60 minutes).
   */
  maxLifetimeSeconds?: number;
  /**
   * postgres.js `connection.application_name`, shown in
   * `pg_stat_activity.application_name`. Lets an operator tell Paperclip's
   * pool apart from other clients of the same database (driver default:
   * `postgres.js`).
   */
  applicationName?: string;
  /**
   * Called once per statement this client issues, before the statement reaches
   * the driver, in the caller's async context.
   *
   * myrmidon(1.6.6 PROCS-0.3A) uses it to attribute DB work to a load lane:
   * the callback reads the lane in force from an AsyncLocalStorage of the
   * caller, so no query-building code has to know a lane exists. Statements
   * inside `db.transaction(...)` are not observed, and a throwing callback is
   * swallowed — observation never fails a query.
   */
  onQuery?: (query: string) => void;
}

/**
 * Idle pooled connections close after this many seconds unless
 * `DATABASE_IDLE_TIMEOUT_SECONDS` says otherwise. The driver default keeps an
 * idle connection open forever, so a process that stops issuing queries still
 * holds every backend it ever opened. Set `DATABASE_IDLE_TIMEOUT_SECONDS=0`
 * to restore the driver default.
 */
export const DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS = 60;
/** `application_name` reported to PostgreSQL unless `DATABASE_APPLICATION_NAME` overrides it. */
export const DEFAULT_DATABASE_APPLICATION_NAME = "paperclip";

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be "true" or "false", got: ${env[name]}`);
}

function envPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got: ${env[name]}`);
  }
  return Number.parseInt(value, 10);
}

function envNonNegativeInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer, got: ${env[name]}`);
  }
  return Number.parseInt(value, 10);
}

function envNonEmptyString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  return value;
}

/**
 * Database client tuning from the environment, so hosted deployments can
 * adapt to their connection topology (pooled endpoints, network latency)
 * without editing source. Every variable is optional. This function returns
 * only the values the environment sets; `resolveDatabaseClientOptions` adds
 * Paperclip's own defaults on top, and the driver defaults apply to the rest
 * — self-hosted setups need none of these.
 */
export function databaseClientOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseClientOptions {
  const options: DatabaseClientOptions = {};
  const prepare = envBoolean(env, "DATABASE_PREPARED_STATEMENTS");
  if (prepare !== undefined) options.prepare = prepare;
  const maxConnections = envPositiveInteger(env, "DATABASE_POOL_MAX");
  if (maxConnections !== undefined) options.maxConnections = maxConnections;
  // `0` is allowed here: it disables idle reaping (the driver default).
  const idleTimeoutSeconds = envNonNegativeInteger(env, "DATABASE_IDLE_TIMEOUT_SECONDS");
  if (idleTimeoutSeconds !== undefined) options.idleTimeoutSeconds = idleTimeoutSeconds;
  const connectTimeoutSeconds = envPositiveInteger(env, "DATABASE_CONNECT_TIMEOUT_SECONDS");
  if (connectTimeoutSeconds !== undefined) options.connectTimeoutSeconds = connectTimeoutSeconds;
  const maxLifetimeSeconds = envPositiveInteger(env, "DATABASE_MAX_LIFETIME_SECONDS");
  if (maxLifetimeSeconds !== undefined) options.maxLifetimeSeconds = maxLifetimeSeconds;
  const applicationName = envNonEmptyString(env, "DATABASE_APPLICATION_NAME");
  if (applicationName !== undefined) options.applicationName = applicationName;
  return options;
}

/**
 * Fills in Paperclip's defaults for the options the caller left unset: idle
 * connections are reaped after `DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS`, and the
 * pool identifies itself as `DEFAULT_DATABASE_APPLICATION_NAME`. Everything
 * else stays at the driver default. An explicit value (including
 * `idleTimeoutSeconds: 0`) always wins over the default.
 */
export function resolveDatabaseClientOptions(options: DatabaseClientOptions): DatabaseClientOptions {
  return {
    ...options,
    idleTimeoutSeconds: options.idleTimeoutSeconds ?? DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
    applicationName: options.applicationName ?? DEFAULT_DATABASE_APPLICATION_NAME,
  };
}

export function postgresJsOptions(options: DatabaseClientOptions): Record<string, unknown> {
  const driverOptions: Record<string, unknown> = {};
  if (options.prepare !== undefined) driverOptions.prepare = options.prepare;
  if (options.maxConnections !== undefined) driverOptions.max = options.maxConnections;
  if (options.idleTimeoutSeconds !== undefined) driverOptions.idle_timeout = options.idleTimeoutSeconds;
  if (options.connectTimeoutSeconds !== undefined) driverOptions.connect_timeout = options.connectTimeoutSeconds;
  if (options.maxLifetimeSeconds !== undefined) driverOptions.max_lifetime = options.maxLifetimeSeconds;
  if (options.applicationName !== undefined) {
    driverOptions.connection = { application_name: options.applicationName };
  }
  return driverOptions;
}

/**
 * A raw postgres.js client through the shared driver of this package — for the
 * call sites that need LISTEN/NOTIFY (the PROCS-1.3 process bus) rather than a
 * drizzle face. Not registered in the client registry: the caller owns the
 * lifecycle and ends it with its own teardown (the bus `stop` does).
 */
export function createPostgresJsClient(url: string, options?: DatabaseClientOptions) {
  const postgres = loadPostgres();
  const resolved = resolveDatabaseClientOptions(options ?? databaseClientOptionsFromEnv());
  return postgres(url, postgresJsOptions(resolved));
}

export function createDb(url: string, options?: DatabaseClientOptions) {
  return createDbWithDrivers(loadPostgres(), loadDrizzle(), url, options);
}

// Startup is already async. Use the ESM loader here so tsx does not compile
// a second copy of Drizzle through its CommonJS require hook.
export async function createStartupDb(url: string, options?: DatabaseClientOptions): Promise<Db> {
  const [{ default: postgres }, { drizzle }] = await Promise.all([
    import("postgres"),
    import("drizzle-orm/postgres-js"),
  ]);
  return createDbWithDrivers(postgres, drizzle, url, options);
}

function createDbWithDrivers(
  postgres: ReturnType<typeof loadPostgres>,
  drizzle: typeof import("drizzle-orm/postgres-js").drizzle,
  url: string,
  options?: DatabaseClientOptions,
) {
  const resolved = resolveDatabaseClientOptions(options ?? databaseClientOptionsFromEnv());
  const sql = postgres(url, postgresJsOptions(resolved));
  const key = hostPortKeyOrNull(url);
  if (key) registerClient(key, sql);
  // The registry keeps the real client (teardown must end the actual pool);
  // drizzle gets the retrying face so a pooler-recycled socket replays the
  // query instead of failing the request that happened to draw it, wrapped in
  // the query observer when someone measures (myrmidon 1.6.6 PROCS-0.3A:
  // observation sits outside the retry, so a replayed statement counts once).
  const client = withTransientWriteRetry(sql);
  return drizzle(
    resolved.onQuery ? withQueryObservation(client, resolved.onQuery) : client,
    { schema },
  );
}

export type { MigrationState } from "./migration-inspection.js";
export type { MigrationHistoryReconcileResult, MigrationBootstrapResult } from "./migration-init.js";

export const getPostgresDataDirectory: typeof import("./postgres-maintenance.js").getPostgresDataDirectory = async (...args) =>
  (await import("./postgres-maintenance.js")).getPostgresDataDirectory(...args);

export const reconcilePendingMigrationHistory: typeof import("./migration-init.js").reconcilePendingMigrationHistory = async (...args) =>
  (await import("./migration-init.js")).reconcilePendingMigrationHistory(...args);

export type { MigrationChainEntry, MigrationTargetSchema } from "./migration-metadata.js";

export const listMigrationChain: typeof import("./migration-metadata.js").listMigrationChain = async (...args) =>
  (await import("./migration-metadata.js")).listMigrationChain(...args);

export const loadMigrationTargetSchema: typeof import("./migration-metadata.js").loadMigrationTargetSchema = async (...args) =>
  (await import("./migration-metadata.js")).loadMigrationTargetSchema(...args);

export const inspectMigrations: typeof import("./migration-inspection.js").inspectMigrations = async (...args) =>
  (await import("./migration-inspection.js")).inspectMigrations(...args);

export const applyPendingMigrations: typeof import("./migration-init.js").applyPendingMigrations = async (...args) =>
  (await import("./migration-init.js")).applyPendingMigrations(...args);

export const migratePostgresIfEmpty: typeof import("./migration-init.js").migratePostgresIfEmpty = async (...args) =>
  (await import("./migration-init.js")).migratePostgresIfEmpty(...args);

export const ensurePostgresDatabase: typeof import("./postgres-maintenance.js").ensurePostgresDatabase = async (...args) =>
  (await import("./postgres-maintenance.js")).ensurePostgresDatabase(...args);

export const resetPostgresDatabase: typeof import("./postgres-maintenance.js").resetPostgresDatabase = async (...args) =>
  (await import("./postgres-maintenance.js")).resetPostgresDatabase(...args);

export type Db = ReturnType<typeof createDb>;
