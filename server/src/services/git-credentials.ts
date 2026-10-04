import {
  companySecrets,
  heartbeatRuns,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { isGitHubDotCom } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";
// myrmidon(GITHUB-SHARED-IDENTITY): access rules of the shared (instance-wide) GitHub authorization
import {
  authorizeSharedGitHubIssuance,
  journalSharedGitHubIssuance,
  sharedGitHubConnectionsForOperation,
} from "../myrmidon/github-shared-identity/policy.js";
import { normalizeGitHubRepository } from "../myrmidon/github-shared-identity/settings.js";

/**
 * Server-side git credentials for managed project checkouts and execution-workspace base
 * refreshes. Operators store a GitHub token as a company secret under one of the well-known
 * names below (the same convention the GitHub external-object provider reads); this module
 * resolves it and turns it into a git invocation that authenticates clone/fetch against
 * github.com over HTTPS without ever placing the token in argv, URLs, or on disk.
 *
 * The provider factory is deliberately the single seam for future credential sources (for
 * example a brokered GitHub connection): swap the factory, keep every call site unchanged.
 */

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Env var the credential helper reads the token from; never appears in argv. */
export const GIT_CREDENTIAL_TOKEN_ENV_KEY = "PAPERCLIP_GIT_TOKEN";

// `!`-prefixed helpers run via `sh -c` with the credential action appended as "$1". Only the
// `get` action answers; store/erase drain stdin and exit 0 silently. `x-access-token`
// authenticates classic PATs, fine-grained PATs, and GitHub App installation tokens alike.
//
// The helper re-validates the credential request from its stdin description and answers only
// for `protocol=https` + `host=github.com`/`www.github.com`. The pre-invocation URL check
// runs before git applies configuration like repository-local `url.<base>.insteadOf`
// rewrites, so a rewritten remote could otherwise request the token for an arbitrary host.
// The helper is additionally installed URL-scoped (`credential.https://github.com.helper`)
// so git does not consult it for other hosts in the first place — two independent gates.
const GIT_CREDENTIAL_HELPER =
  `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;

export type GitCredential = {
  token: string;
  source: "managed_connection" | "company_secret" | "server_env";
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
  githubIdentity?: { userId: string; login: string };
  // myrmidon(GITHUB-SHARED-IDENTITY): "shared" — the shared (organization) grant of a shared GitHub connection
  identitySource?: "personal" | "dedicated" | "shared";
  connectionId?: string;
  grantId?: string;
  // myrmidon(GITHUB-SHARED-IDENTITY): the commit author/committer when it is not
  // the authenticating GitHub account (the agent itself under a shared grant)
  commitIdentity?: { name: string; email: string };
  // myrmidon(GITHUB-SHARED-IDENTITY): the repository a shared grant was issued for
  repository?: string;
};

/** A prepared, credential-bearing git invocation: config args plus the env that carries the token. */
export type GitAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source: GitCredential["source"];
  secretName: string | null;
};

/**
 * Resolve auth for one remote URL. Returns null when the URL is out of scope (non-GitHub,
 * ssh, or already credentialed) or when no token is available — callers then run git with
 * ambient behavior, exactly as before this module existed.
 */
export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitAuthInvocation | null>;

/**
 * True only for `https://github.com/...` (or `www.`) URLs without inline userinfo. GHES and
 * other hosts are out of scope for now — sending a github.com token to an arbitrary host
 * would leak it, and an operator's inline URL credential must never be overridden.
 */
export function isGitHubHttpsRemoteUrl(remoteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isGitHubDotCom(parsed.hostname);
}

function isSupportedGitHubRemoteUrl(remoteUrl: string): boolean {
  if (isGitHubHttpsRemoteUrl(remoteUrl)) return true;
  if (/^git@(?:www\.)?github\.com:[^\s]+$/i.test(remoteUrl)) return true;
  try {
    const parsed = new URL(remoteUrl);
    return parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password && isGitHubDotCom(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Mask credential material embedded in URLs so it never reaches warnings, run errors, or
 * persisted payloads: userinfo on any scheme (`https://user:token@host`,
 * `ssh://user:pass@host`) and the entire query string of any URL (`?access_token=…` and
 * every other parameter — masked wholesale rather than by an inevitably incomplete
 * parameter-name list). Scp-style remotes (`git@host:path`) carry no password and are left
 * alone.
 */
export function scrubGitCredentialText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
}

export function buildGitAuthInvocation(credential: GitCredential): GitAuthInvocation {
  // myrmidon(GITHUB-SHARED-IDENTITY): an explicit commit identity (the agent)
  // wins over the authenticating account's noreply identity.
  const author = credential.commitIdentity
    ?? (credential.githubIdentity
      ? {
          name: credential.githubIdentity.login,
          email: `${credential.githubIdentity.userId}+${credential.githubIdentity.login}@users.noreply.github.com`,
        }
      : null);
  const configEntries = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", GIT_CREDENTIAL_HELPER],
    ["credential.https://www.github.com.helper", GIT_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["url.https://github.com/.insteadOf", "git@www.github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@www.github.com/"],
    ...(author ? [
      ["user.name", author.name],
      ["user.email", author.email],
    ] : []),
  ];
  return {
    // The leading empty helper clears ambient helpers (gh, osxkeychain, credential-store) so
    // they neither outrank the resolved token nor receive store/erase callbacks for it. The
    // token helper is installed URL-scoped: git consults it only for credential requests
    // whose context matches github.com over https, so an `insteadOf`-rewritten remote never
    // reaches it (and the helper itself re-checks the request host — see above).
    configArgs: [
      "-c", "credential.helper=",
      "-c", `credential.https://github.com.helper=${GIT_CREDENTIAL_HELPER}`,
      "-c", `credential.https://www.github.com.helper=${GIT_CREDENTIAL_HELPER}`,
    ],
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
      GH_TOKEN: credential.token,
      GITHUB_TOKEN: credential.token,
      GIT_TERMINAL_PROMPT: "0",
      ...(author ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      } : {}),
      GIT_CONFIG_COUNT: String(configEntries.length),
      ...Object.fromEntries(configEntries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ])),
    },
    source: credential.source,
    secretName: credential.secretName,
  };
}

const GIT_AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled|repository not found|not accessible|permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i;

/**
 * Turn a failed git network operation into an actionable suffix for the error message.
 * Returns null when the failure does not look auth-related — a credential that was merely
 * present during an unrelated failure (network outage, target-path collision) must not be
 * blamed for it.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null } | null;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  if (input.used) {
    const label = input.used.secretName
      ? `the ${input.used.secretName} company-secret GitHub credential`
      : input.used.source === "managed_connection"
        ? "the resolved GitHub connection"
      : "the server-environment GitHub credential";
    return `The operation authenticated with ${label}, which was rejected or lacks access to this repository.`;
  }
  return "No GitHub credential is configured — add a GITHUB_TOKEN or GH_TOKEN company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.";
}

type SecretServiceLike = ReturnType<typeof secretService>;

type GitCredentialSecretsDeps = {
  getByName: (
    companyId: string,
    name: string,
  ) => Promise<{ id: string } | null | undefined> | ReturnType<SecretServiceLike["getByName"]>;
  resolveSecretValue: SecretServiceLike["resolveSecretValue"];
  resolveUserSecretValue?: SecretServiceLike["resolveUserSecretValue"];
};

/**
 * Build the credential provider for one run. Resolution order: the managed GitHub identity
 * resolver, then a company secret by well-known name, then the server process environment
 * (`GITHUB_TOKEN`/`GH_TOKEN`) for self-hosted operators. A configured managed identity fails
 * closed instead of falling through to legacy credentials. The lookup is memoized per
 * provider instance so one run performs at most one secret resolution (and writes at most
 * one audit event) no matter how many git operations it authenticates.
 */
export function createGitRemoteAuthProvider(
  db: Db,
  companyId: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
  },
  deps?: {
    secrets?: GitCredentialSecretsDeps;
    env?: NodeJS.ProcessEnv;
    secretNames?: readonly string[];
  },
): GitRemoteAuthProvider {
  const secrets: GitCredentialSecretsDeps = deps?.secrets ?? secretService(db);
  const env = deps?.env ?? process.env;
  const secretNames = deps?.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  let credentialPromise: Promise<GitCredential | null> | null = null;

  const resolveCredential = async (): Promise<GitCredential | null> => {
    // Unit callers historically pass a null DB through the typed test seam. Production
    // always supplies a real DB and therefore always checks managed identities before
    // considering legacy secrets or process environment credentials.
    const managed = db
      ? await resolveManagedGitHubCredential(db, secrets, companyId, context ?? {})
      : { configured: false as const };
    if (managed.configured) {
      if (!managed.credential) throw new Error(managed.error ?? "Managed GitHub connection is unavailable");
      return managed.credential;
    }
    for (const secretName of secretNames) {
      const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
      if (!secret) continue;
      // A resolution failure (inactive secret, provider outage) records its own failure audit
      // event; fall through to the next source instead of failing the whole git operation here.
      const token = await secrets
        .resolveSecretValue(companyId, secret.id, "latest", {
          accessContext: {
            consumerType: "system",
            consumerId: "workspace-git-credential",
            actorType: "system",
            issueId: context?.issueId ?? null,
            heartbeatRunId: context?.heartbeatRunId ?? null,
            responsibleUserId: context?.responsibleUserId ?? null,
          },
        })
        .then((value) => value.trim())
        .catch(() => "");
      if (token) return { token, source: "company_secret", secretName };
    }
    const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
    if (envToken) return { token: envToken, source: "server_env", secretName: null };
    return null;
  };

  return async (remoteUrl: string) => {
    if (!isSupportedGitHubRemoteUrl(remoteUrl)) return null;
    if (db && context?.heartbeatRunId && context.agentId) {
      const [run] = await db.select({ contextId: heartbeatRuns.activeIdentityContextId }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, context.agentId),
      ));
      if (run?.contextId) {
        const { resolveGitHubOperationCredentials } = await import("./github-operation-credentials.js");
        const result = await resolveGitHubOperationCredentials(db, {
          companyId, runId: context.heartbeatRunId, agentId: context.agentId,
          // myrmidon(GITHUB-SHARED-IDENTITY): the shared grant is issued per repository
          repository: normalizeGitHubRepository(remoteUrl),
        });
        if (result.status === "absent") {
          const credential = await resolveCredential();
          return credential ? buildGitAuthInvocation(credential) : null;
        }
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        return { ...anonymous, env: {
          ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "",
          ...result.env,
        } };
      }
    }
    credentialPromise ??= resolveCredential();
    const credential = await credentialPromise;
    if (!credential) return null;
    return buildGitAuthInvocation(credential);
  };
}

/**
 * myrmidon(GITHUB-SHARED-IDENTITY): the shared GitHub authorization — a managed
 * (OAuth, `github.code` connector) GitHub connection with the `shared`
 * credential policy. Other shared-policy GitHub connections (a pasted MCP key)
 * keep their vendor behavior.
 */
function isManagedSharedGitHubConnection(connection: typeof toolConnections.$inferSelect): boolean {
  if (connection.credentialPolicy !== "shared") return false;
  const config = connection.config && typeof connection.config === "object" ? connection.config as Record<string, unknown> : {};
  const oauth = config.oauth && typeof config.oauth === "object" ? config.oauth as Record<string, unknown> : {};
  return oauth.connectorProfile === "github.code";
}

export async function resolveManagedGitHubIdentitySelection(
  db: Db,
  companyId: string,
  context: {
    responsibleUserId?: string | null;
    agentId?: string | null;
    allowStandingDelegation?: boolean;
    excludeGrantId?: string;
    // myrmidon(GITHUB-SHARED-IDENTITY): consider shared grants (only the
    // run-scoped broker does), chosen by the operation's target repository
    allowShared?: boolean;
    repository?: string | null;
  },
): Promise<{
  configured: boolean;
  identitySource?: "personal" | "dedicated" | "shared";
  grant?: typeof connectionGrants.$inferSelect;
  error?: string;
}> {
  const connections = await db.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId),
  ));
  const githubConnections = connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object" ? connection.config as Record<string, unknown> : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return { configured: false };

  const connectionIds = githubConnections.map((connection) => connection.id);
  const installs = await db.select().from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId),
    inArray(toolConnectionInstalls.connectionId, connectionIds),
  ));
  // myrmidon(GITHUB-SHARED-IDENTITY): a shared GitHub connection exists for an
  // operation only when the broker asks and the connection's rule allows this
  // agent AND matches the target repository; otherwise it neither resolves nor
  // counts as "configured". Identities of different products never mix.
  const sharedConnectionIds = context.allowShared === true
    ? await sharedGitHubConnectionsForOperation(db, companyId, context.agentId, context.repository)
    : new Set<string>();
  const eligibleConnectionIds = new Set(githubConnections.filter((connection) => installs.some((install) =>
    install.connectionId === connection.id && (
      (install.targetType === "company" && install.targetId === companyId)
      || (install.targetType === "agent" && install.targetId === context.agentId)
    )
  ) && (!isManagedSharedGitHubConnection(connection) || sharedConnectionIds.has(connection.id))).map((connection) => connection.id));
  // A GitHub connection installed only for another agent is not configured for
  // this run. Treating the company-wide connection as configured here would
  // make unrelated agents fail before their adapter starts and would also
  // suppress their otherwise-eligible legacy credential fallback.
  if (eligibleConnectionIds.size === 0) return { configured: false };
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId),
    inArray(connectionGrants.connectionId, [...eligibleConnectionIds]),
    // myrmidon(GITHUB-SHARED-IDENTITY): the organization grant of a shared connection too
    or(eq(connectionGrants.kind, "agent"), eq(connectionGrants.kind, "user"), eq(connectionGrants.kind, "organization")),
  ));
  const dedicated = context.agentId
    ? grants.filter((grant) => grant.kind === "agent" && grant.subjectAgentId === context.agentId)
    : [];
  // Connections are already restricted above to the owner-selected install
  // targets. Within that consent boundary the server-resolved responsible user
  // is authoritative; standing delegation is only an ownerless-run fallback.
  const personal = context.responsibleUserId
    ? grants.filter((grant) => grant.kind === "user" && grant.subjectUserId === context.responsibleUserId)
    : [];
  const delegated = context.allowStandingDelegation !== false && !context.responsibleUserId && context.agentId
    ? await db.select({ grantId: connectionGrantDelegations.grantId }).from(connectionGrantDelegations).where(and(
        eq(connectionGrantDelegations.companyId, companyId),
        eq(connectionGrantDelegations.agentId, context.agentId),
        inArray(connectionGrantDelegations.grantId, grants.map((grant) => grant.id)),
      )).then((rows) => {
        const delegatedIds = new Set(rows.map((row) => row.grantId));
        return grants.filter((grant) => grant.kind === "user" && delegatedIds.has(grant.id));
      })
    : [];
  // myrmidon(GITHUB-SHARED-IDENTITY): the shared grant is the last resort —
  // a dedicated grant (and the run's personal or delegated grant) wins.
  const shared = grants.filter((grant) => grant.kind === "organization" && sharedConnectionIds.has(grant.connectionId)
    && githubConnections.some((connection) => connection.id === grant.connectionId && isManagedSharedGitHubConnection(connection)));
  const candidates = dedicated.length > 0 ? dedicated
    : personal.length > 0 ? personal
    : delegated.length > 0 ? delegated
    : shared;
  const identitySource = dedicated.length > 0 ? "dedicated" as const
    : personal.length > 0 || delegated.length > 0 || shared.length === 0 ? "personal" as const
    : "shared" as const;
  // Reconnecting can create another connection/grant for the same GitHub
  // account. Ambiguity is about provider identities, not the number of rows.
  // Only trust GitHub's stable account ID; equal logins or missing metadata
  // cannot establish that two grants belong to the same person.
  const githubUserIds = candidates.map((candidate) => candidate.providerTenant?.github?.userId?.trim());
  if (candidates.length === 0 || (candidates.length > 1 && (
    githubUserIds.some((id) => !id) || new Set(githubUserIds).size !== 1
  ))) {
    return {
      configured: true, identitySource,
      error: candidates.length === 0
        ? "No managed GitHub identity is available for this run"
        // myrmidon(GITHUB-SHARED-IDENTITY): overlapping shared rules name the repository
        : identitySource === "shared"
          ? `More than one shared GitHub identity matches repository ${normalizeGitHubRepository(context.repository) ?? "(none)"}; narrow the allowed repositories`
          : "More than one managed GitHub identity matches this run",
    };
  }
  const credentialIds = candidates.flatMap((grant) => grant.credentialSecretRefs
    .filter((ref) => ref.configPath === "oauth.access_token").map((ref) => ref.secretId));
  const credentialRecords = candidates.length > 1 && credentialIds.length > 0
    ? await db.select({
        id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt,
        scope: companySecrets.scope, ownerUserId: companySecrets.ownerUserId,
        definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt,
      }).from(companySecrets).leftJoin(userSecretDefinitions, and(
        eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId),
        eq(userSecretDefinitions.companyId, companyId),
      )).where(and(
        eq(companySecrets.companyId, companyId), inArray(companySecrets.id, credentialIds),
      ))
    : [];
  const hasCredentialRecord = (grant: typeof connectionGrants.$inferSelect) => {
    if (candidates.length === 1) return true;
    const github = grant.providerTenant?.github;
    const ref = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
    return Boolean(github && github.installationCount > 0 && github.repositoryCount > 0 && ref
      && credentialRecords.some((secret) => secret.id === ref.secretId
        && secret.status === "active" && !secret.deletedAt
        && (grant.kind === "user"
          ? secret.scope === "user" && secret.ownerUserId === grant.subjectUserId
            && secret.definitionStatus === "active" && !secret.definitionDeletedAt
          : secret.scope === "company")));
  };
  const isAvailable = (grant: typeof connectionGrants.$inferSelect) =>
    grant.status === "active" && hasCredentialRecord(grant) && githubConnections.some((connection) =>
      connection.id === grant.connectionId && connection.enabled && connection.status === "active",
    );
  // Prefer an available, healthy authorization for this account, then the newest
  // connection grant. Do not rank by updatedAt: refreshes/webhooks change it.
  // Select one grant, preserving its credential and connection policy intact.
  const healthRank = (candidate: typeof connectionGrants.$inferSelect) => {
    const health = githubConnections.find((connection) => connection.id === candidate.connectionId)?.healthStatus;
    return health === "ok" || health === "healthy" ? 2 : health === "unknown" ? 1 : 0;
  };
  const grant = candidates.filter((candidate) => candidate.id !== context.excludeGrantId).sort((a, b) =>
    Number(isAvailable(b)) - Number(isAvailable(a))
    || healthRank(b) - healthRank(a)
    || b.createdAt.getTime() - a.createdAt.getTime()
    || a.id.localeCompare(b.id),
  )[0]!;
  if (!grant) return { configured: true, identitySource, error: "No alternative managed GitHub authorization is available" };
  const connection = githubConnections.find((candidate) => candidate.id === grant.connectionId);
  if (!connection?.enabled || connection.status !== "active") {
    return { configured: true, identitySource, error: "The managed GitHub connection is unavailable" };
  }
  if (grant.status !== "active") return { configured: true, identitySource, error: "The managed GitHub identity must be reconnected" };
  return { configured: true, identitySource, grant };
}

export async function filterResolvedGitHubConnectionsForRun<T extends {
  id: string;
  config?: unknown;
  transportConfig?: unknown;
}>(input: {
  db: Db;
  companyId: string;
  agentId: string;
  responsibleUserId?: string | null;
  connections: T[];
}): Promise<T[]> {
  const githubConnections = input.connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object"
      ? connection.config as Record<string, unknown>
      : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return input.connections;
  const selection = await resolveManagedGitHubIdentitySelection(input.db, input.companyId, {
    agentId: input.agentId,
    responsibleUserId: input.responsibleUserId ?? null,
  });
  const selectedConnectionId = selection.grant?.connectionId ?? null;
  const githubIds = new Set(githubConnections.map((connection) => connection.id));
  return input.connections.filter((connection) =>
    !githubIds.has(connection.id) || connection.id === selectedConnectionId,
  );
}

export async function resolveManagedGitHubCredential(
  db: Db,
  secrets: GitCredentialSecretsDeps,
  companyId: string,
  context: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
    allowStandingDelegation?: boolean;
    // myrmidon(GITHUB-SHARED-IDENTITY): see resolveManagedGitHubIdentitySelection; the
    // repository (owner/repo or a github.com remote) the shared grant would serve
    allowShared?: boolean;
    repository?: string | null;
  },
): Promise<{ configured: boolean; identitySource?: "personal" | "dedicated" | "shared"; credential?: GitCredential; error?: string; repository?: string }> {
  const selection = await resolveManagedGitHubIdentitySelection(db, companyId, context);
  if (!selection.configured) return { configured: false };
  if (!selection.grant) return { configured: true, identitySource: selection.identitySource, error: selection.error };
  // myrmidon(GITHUB-SHARED-IDENTITY): a policy denial is final; no alternate grant is tried
  let sharedDenied = false;
  // myrmidon(GITHUB-SHARED-IDENTITY): explicit result type — the shared branches return spread objects
  type Acquired = {
    configured: boolean; identitySource?: "personal" | "dedicated" | "shared";
    credential?: GitCredential; error?: string; repository?: string;
  };
  const acquire = async (selection: Awaited<ReturnType<typeof resolveManagedGitHubIdentitySelection>>): Promise<Acquired> => {
    let grant = selection.grant!;
    // myrmidon(GITHUB-SHARED-IDENTITY): gate the shared grant per agent and
    // repository BEFORE the token is refreshed or read.
    const sharedIssuance = grant.kind === "organization"
      ? await authorizeSharedGitHubIssuance(db, {
          companyId, agentId: context.agentId, runId: context.heartbeatRunId, repository: context.repository, grant,
        })
      : null;
    if (sharedIssuance && !sharedIssuance.ok) {
      sharedDenied = true;
      return {
        configured: true, identitySource: selection.identitySource, error: sharedIssuance.error,
        ...(sharedIssuance.repository ? { repository: sharedIssuance.repository } : {}),
      };
    }
    if (grant.kind === "user" && grant.subjectUserId) {
      const [membership] = await db.select({ id: companyMemberships.id, role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, grant.subjectUserId),
        eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership || membership.role === "viewer") return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity owner is not an authorized company member" };
    }
    const expiresAt = grant.providerTenant?.oauth?.accessTokenExpiresAt;
    const refreshedAt = grant.providerTenant?.oauth?.refreshedAt;
    const expiryMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    const refreshedMs = typeof refreshedAt === "string" ? Date.parse(refreshedAt) : Number.NaN;
    if (Number.isFinite(expiryMs) && (
      expiryMs <= Date.now() + 60 * 60_000
      || !Number.isFinite(refreshedMs)
      || refreshedMs <= Date.now() - 30 * 24 * 60 * 60_000
    )) {
      grant = await toolAccessService(db).refreshOAuthGrantCredentials({
        companyId,
        connectionId: grant.connectionId,
        grantId: grant.id,
        actor: { actorType: "system", actorId: "workspace-git-credential" },
        issueId: context.issueId,
        heartbeatRunId: context.heartbeatRunId,
      });
    }
    const accessRef = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
    const github = grant.providerTenant?.github;
    if (!accessRef || !github) return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity is incomplete" };
    if (github.installationCount < 1 || github.repositoryCount < 1) {
      return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity no longer has repository access" };
    }
    const accessContext = {
      consumerType: "system" as const,
      consumerId: "workspace-git-credential",
      // myrmidon(GITHUB-SHARED-IDENTITY): the secret access event of a shared issuance names the repository
      ...(sharedIssuance?.ok ? { configPath: `github_shared:${sharedIssuance.repository}` } : {}),
      actorType: "system" as const,
      actorId: context.agentId ?? undefined,
      issueId: context.issueId ?? null,
      heartbeatRunId: context.heartbeatRunId ?? null,
      responsibleUserId: context.responsibleUserId ?? null,
    };
    let token: string;
    if (grant.kind === "user") {
      if (!grant.subjectUserId || !secrets.resolveUserSecretValue) {
        return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential cannot be resolved" };
      }
      const [secret] = await db.select({
        userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      }).from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.id, accessRef.secretId),
        eq(companySecrets.ownerUserId, grant.subjectUserId),
      )).limit(1);
      if (!secret?.userSecretDefinitionId) return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential is invalid" };
      const resolved = await secrets.resolveUserSecretValue(companyId, {
        definitionId: secret.userSecretDefinitionId,
        responsibleUserId: grant.subjectUserId,
        version: accessRef.versionSelector ?? "latest",
        required: true,
      }, accessContext);
      if (!resolved) return { configured: true, identitySource: selection.identitySource, error: "The personal GitHub credential is missing" };
      token = resolved.value;
    } else {
      token = await secrets.resolveSecretValue(companyId, accessRef.secretId, accessRef.versionSelector ?? "latest", { accessContext });
    }
    // myrmidon(GITHUB-SHARED-IDENTITY): journal every shared issuance (agent, run, repository)
    if (sharedIssuance?.ok && context.agentId) {
      await journalSharedGitHubIssuance(db, {
        companyId, agentId: context.agentId, runId: context.heartbeatRunId, repository: sharedIssuance.repository, grant,
      });
    }
    return {
      configured: true, identitySource: selection.identitySource,
      ...(sharedIssuance?.ok ? { repository: sharedIssuance.repository } : {}),
      credential: {
        token,
        source: "managed_connection" as const,
        secretName: null,
        githubIdentity: { userId: github.userId, login: github.login },
        // myrmidon(GITHUB-SHARED-IDENTITY): organization grant -> "shared", the agent stays the author
        identitySource: grant.kind === "agent" ? "dedicated" as const
          : grant.kind === "organization" ? "shared" as const
          : "personal" as const,
        connectionId: grant.connectionId,
        grantId: grant.id,
        ...(sharedIssuance?.ok
          ? { commitIdentity: sharedIssuance.commitIdentity, repository: sharedIssuance.repository }
          : {}),
      },
    };
  };
  let failure: { configured: boolean; identitySource?: "personal" | "dedicated" | "shared"; error?: string; repository?: string };
  try {
    const result = await acquire(selection);
    if (result.credential) return result;
    failure = result;
    if (sharedDenied) return failure; // myrmidon(GITHUB-SHARED-IDENTITY)
  } catch {
    failure = { configured: true, identitySource: selection.identitySource, error: "GitHub credentials are temporarily unavailable" };
  }
  // Retry credential acquisition, never the GitHub operation. An alternate
  // authorization must still belong to this exact principal and account.
  const alternate = await resolveManagedGitHubIdentitySelection(db, companyId, {
    ...context, excludeGrantId: selection.grant.id,
  });
  const accountId = selection.grant.providerTenant?.github?.userId;
  if (!accountId || !alternate.grant || alternate.identitySource !== selection.identitySource
    || alternate.grant.providerTenant?.github?.userId !== accountId
    || alternate.grant.subjectUserId !== selection.grant.subjectUserId
    || alternate.grant.subjectAgentId !== selection.grant.subjectAgentId) return failure;
  try { return await acquire(alternate); } catch { return failure; }
}
