# GitHub Credentials Cache and Fuse Policy (1.6.6 OPE-9997, 1.6.7 OPE-12446)

The Myrmidon server provides GitHub operation credentials to agents and integration tools via the broker service (`server/src/services/github-operation-credentials.ts`).

Prior to 1.6.6 (OPE-9997), every git command or credentials request generated a new installation access token from GitHub, which added latency (several seconds per git call) and caused high API token issuance load on GitHub App installations. In 1.6.7 (OPE-12446), client-side token caching, server-side single-flight deduplication, and a per-run request fuse were introduced to protect GitHub App hourly quotas from runaway loops.

## Architecture and Caching Layers

### 1. Broker In-Memory Cache (Server-side)

- **Cache TTL**: 50 minutes (`50 * 60 * 1000` ms). Since GitHub App installation access tokens typically expire in 60 minutes, a 50-minute TTL ensures tokens remain valid for the entire cached duration while avoiding edge-of-expiry race conditions.
- **Cache Key**:
  ```text
  companyId:agentId:runId:identityContextId:revision:responsibleUserId:repository
  ```
  The cache key isolates credentials per company, agent, run, identity context, revision, responsible user, and repository. Credentials are never shared across distinct tasks, runs, or repositories.
- **Single-Flight Coalescing**: Concurrent requests arriving for the same cache key join the same active in-flight resolution promise. The broker mints exactly one token from GitHub, and all concurrent callers receive the same resolved credential without burning extra installation API quota.

### 2. Bot Runtime Run-Scoped Disk Cache (Client-side)

To avoid network round-trips to the broker on every local `git` or `gh` invocation, the bot runtime provides a disk cache:

- **Cache Directory**: Enabled by the environment variable `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` (legacy alias: `PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR`). When configured by the launcher, this points to the run-scoped scratch directory (`$PAPERCLIP_RUN_SCRATCH_DIR` / run scratch dir). When unset, the client-side cache is off (allowing test suites to assert exact broker request counts).
- **Storage and Security**: Cache files are stored in `<cacheDir>/.paperclip-broker-cache/<hash>.json` with strict `0600` file permissions (accessible only to the running user). The file name is `sha256(brokerToken|repository)[0..32].json`.
- **Client Cache TTL**: 45 minutes (`45 * 60 * 1000` ms), capped by the token's declared expiry with an additional 1-minute safety margin (`CACHE_EXPIRY_MARGIN_MS = 60 * 1000`).
- **Validation**: On each lookup, the client helper validates the token, finite timestamps, and validity bounds. Any stale, expired, foreign, or corrupted entry is removed immediately (`fs.rmSync(file, { force: true })`) and a fresh token is requested.

## Per-Run Request Fuse (Rate Limiting)

To prevent runaway agent loops or misconfigured tools from exhausting the GitHub App installation quota (5,000 requests/hour), the broker enforces a per-run request fuse before any cache lookup or token generation:

- **Configuration**:
  - `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` (legacy alias: `PAPERCLIP_GITHUB_CREDENTIALS_FUSE_PER_MINUTE`).
  - Default: `60` requests per minute.
  - Setting a non-numeric or non-positive value (`<= 0`) falls back to the default of 60.
- **Sliding-Window Semantics**:
  - The broker tracks request timestamps per `companyId:runId` in a rolling 60-second window (`GITHUB_CREDENTIALS_FUSE_WINDOW_MS = 60 * 1000`).
  - Expired timestamps older than 60 seconds are purged on each check. Stale run windows are automatically pruned when the tracker map exceeds 2,000 entries.
- **HTTP 429 Too Many Requests**:
  If a single run makes more requests than the configured limit within 60 seconds, the broker throws HTTP 429:
  ```text
  Too many GitHub credential requests from this run: over <limit> per minute. Cache the issued token until it expires instead of requesting one per git/gh call.
  ```

## Security and Policy Enforcement

1. **Policy Gate**: Before any cache lookup or token generation, `allowsGitHubCredentialExport` (`server/src/services/github-credential-policy.ts`) verifies that credential export is permitted by instance and company policy.
2. **Active Grant Verification**: On every cache hit, `isCachedCredentialStillActive` verifies that:
   - The connection remains connected (`connection.status === "connected"`).
   - The grant has not been revoked (`grant.revokedAt === null`).
   If the grant was revoked or the connection disconnected, the cached credential is immediately invalidated and purged from memory.
3. **Cache Invalidation**:
   - Explicit invalidation: `clearGitHubOperationCredentialCache()` clears all cached tokens, in-flight promises, and rate-limiting fuse windows when GitHub App credentials or keys are updated.
   - On expired entry access: expired entries are cleaned up lazily during cache operations.

## Operational Recommendations for HTTP 429

When an operator observes `429 Too Many Requests` or errors referencing the credentials fuse:

1. **Identify the Culprit**:
   Check the issue or run logs for the failing agent. A 429 indicates that the agent run made >60 credentials requests within 60 seconds. Common causes include:
   - Git operations invoked in tight loops (e.g. `git status`, `git fetch`, `git diff` inside un-batched bash scripts or custom wrappers) without using a credential helper.
   - `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` not being passed or unwritable in a custom adapter environment.
   - Subprocesses spawning multiple parallel `git`/`gh` processes without sharing environment credentials.
2. **Client Remediation**:
   - Ensure the runner environment provides `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` pointing to a valid run scratch directory so the built-in credential helper caches tokens.
   - Reuse the issued `GH_TOKEN` or `GITHUB_TOKEN` across commands in sub-scripts instead of re-authenticating on every line.
3. **Operator Tuning**:
   If a legitimate workflow (such as an extensive repository migration or multi-submodule fetch) legitimately requires higher burst throughput, increase the server setting:
   ```bash
   MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE=120
   ```
   Setting this variable takes effect immediately or on process restart without modifying company policies.

## Operational Monitoring

Operators can observe credential broker activity and latency through:
- **API Load Metrics**: `GET /api/myrmidon/board-load/api-load` tracks `/runtime-tools/github/credentials` request counts, p50, p95, and max duration.
- **GitHub Rate Limit Log**: Broker rate-limit consumption is logged under `[github-rate-limit]` with the `broker` source tag, allowing operators to verify that hourly broker issuances stay within expected boundaries (`broker` ≤ 300/hour under typical load).
