# GitHub Credentials Cache Policy (1.6.6 OPE-9997)

The Myrmidon server provides GitHub operation credentials to agents and integration tools via the broker service (`server/src/services/github-operation-credentials.ts`).

Prior to 1.6.6 (OPE-9997), every git command or credentials request generated a new installation access token from GitHub, which added latency (several seconds per git call) and caused high API token issuance load on GitHub App installations.

Starting in 1.6.6, GitHub operation credentials are cached in memory at the broker level with strict security constraints.

## Caching Behavior

- **Cache TTL**: 50 minutes (`50 * 60 * 1000` ms). Since GitHub App installation access tokens typically expire in 60 minutes, a 50-minute TTL ensures tokens remain valid for the entire cached duration while avoiding edge-of-expiry race conditions.
- **Cache Key**:
  ```text
  companyId:agentId:runId:identityContextId:revision:responsibleUserId:repository
  ```
  The cache key isolates credentials per company, agent, run, identity context, revision, responsible user, and repository. Credentials are never shared across distinct tasks, runs, or repositories.

## Security and Policy Enforcement

1. **Policy Gate**: Before any cache lookup or token generation, `allowsGitHubCredentialExport` (`server/src/services/github-credential-policy.ts`) verifies that credential export is permitted by instance and company policy.
2. **Active Grant Verification**: On every cache hit, `isCachedCredentialStillActive` verifies that:
   - The connection remains connected (`connection.status === "connected"`).
   - The grant has not been revoked (`grant.revokedAt === null`).
   If the grant was revoked or the connection disconnected, the cached credential is immediately invalidated and purged from memory.
3. **Cache Invalidation**:
   - Explicit invalidation: `resetGitHubOperationCredentialCache()` clears all cached tokens when GitHub App credentials or keys are updated.
   - On expired entry access: expired entries are cleaned up lazily during cache operations.

## Operational Monitoring

Operators can observe credential broker activity and latency through the API load metrics (`GET /api/myrmidon/board-load/api-load`), where `/runtime-tools/github/credentials` is monitored with request count, p50, p95, and max duration.
