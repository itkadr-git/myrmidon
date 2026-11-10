/**
 * Myrmidon (P6): broker candidate walk for the managed GitHub launcher.
 *
 * The server hands a run one GitHub credential broker URL: its public origin.
 * That origin is not always reachable from the run (for example behind a
 * client-certificate proxy), and then `gh`/`git` silently run without managed
 * credentials. The launcher therefore tries several candidate base URLs in
 * order until one answers:
 *
 *   MYRMIDON_BOT_BOARD_URL -> PAPERCLIP_GITHUB_BROKER_URL -> PAPERCLIP_API_URL -> PAPERCLIP_RUNTIME_API_URL
 *   -> items of PAPERCLIP_RUNTIME_API_CANDIDATES_JSON
 *
 * at most GITHUB_BROKER_MAX_CANDIDATES, without duplicates. Each request is
 * bounded by GITHUB_BROKER_REQUEST_TIMEOUT_MS and the whole walk by
 * GITHUB_BROKER_TOTAL_TIMEOUT_MS. A 409 is retried on the same candidate, as
 * before. A failing candidate never stops the walk. Diagnostics name the tried
 * URLs and statuses, never tokens.
 *
 * The code below is plain JavaScript embedded into the launcher script, which
 * runs standalone on local, SSH and sandbox runtimes.
 */

export const GITHUB_BROKER_MAX_CANDIDATES = 6;
export const GITHUB_BROKER_REQUEST_TIMEOUT_MS = 10_000;
export const GITHUB_BROKER_TOTAL_TIMEOUT_MS = 60_000;
export const GITHUB_BROKER_CONFLICT_RETRY_DELAY_MS = 1_000;
export const GITHUB_BROKER_CONFLICT_MAX_ATTEMPTS = 30;

/**
 * Defines `paperclipBrokerCandidateUrls(env)` and
 * `paperclipRequestBrokerCredentials(env, candidateUrls, limits?, repository?)`
 * for the launcher script. The latter resolves to `{ response, tried }`:
 * `response` is the first ok response, else the last HTTP response, else null
 * when no candidate answered at all.
 *
 * myrmidon(GITHUB-SHARED-IDENTITY): `repository` (`owner/repo`, optional) is
 * sent as the request body. The broker mints a GitHub App installation token
 * for exactly that repository, so an operation that never names one stays
 * `absent` for a run whose only identity is an App.
 */
export function githubBrokerCandidatesLauncherSource(): string {
  return String.raw`
function paperclipBrokerCandidateUrls(env) {
  const urls = [];
  const seen = new Set();
  const push = (value) => {
    const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '').replace(/\/api$/, '') : '';
    if (!trimmed || seen.has(trimmed) || urls.length >= ${GITHUB_BROKER_MAX_CANDIDATES}) return;
    seen.add(trimmed);
    urls.push(trimmed);
  };
  push(env.MYRMIDON_BOT_BOARD_URL);
  push(env.PAPERCLIP_GITHUB_BROKER_URL);
  push(env.MYRMIDON_API_URL);
  push(env.PAPERCLIP_API_URL);
  push(env.PAPERCLIP_RUNTIME_API_URL);
  let extra = [];
  try {
    const parsed = JSON.parse(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON || '[]');
    if (Array.isArray(parsed)) extra = parsed;
  } catch {}
  for (const item of extra) push(item);
  return urls;
}
async function paperclipRequestBrokerCredentials(env, candidateUrls, limits, repository) {
  const requestTimeoutMs = (limits && limits.requestTimeoutMs) || ${GITHUB_BROKER_REQUEST_TIMEOUT_MS};
  const totalTimeoutMs = (limits && limits.totalTimeoutMs) || ${GITHUB_BROKER_TOTAL_TIMEOUT_MS};
  const retryDelayMs = (limits && limits.retryDelayMs) || ${GITHUB_BROKER_CONFLICT_RETRY_DELAY_MS};
  const body = typeof repository === 'string' && repository ? JSON.stringify({ repository }) : '{}';
  // myrmidon(OPE-12446): a fresh, in-window cached credential answers this
  // invocation without contacting the broker at all.
  const now = Date.now();
  const cached = paperclipLoadCachedBrokerCredential(env, repository || '', now);
  if (cached && paperclipCachedBrokerCredentialIsFresh(cached, now)) {
    return { response: paperclipCachedResponse(cached), tried: [] };
  }
  const deadline = now + totalTimeoutMs;
  const tried = [];
  let lastResponse = null;
  for (const base of candidateUrls) {
    const url = base + '/runtime-tools/github/credentials';
    let response = null;
    let outcome = 'no_response';
    try {
      for (let attempt = 0; attempt < ${GITHUB_BROKER_CONFLICT_MAX_ATTEMPTS}; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { outcome = 'budget_exhausted'; break; }
        response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
          headers: {
            authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.MYRMIDON_API_KEY || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
            'x-myrmidon-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN,
            'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN,
            ...((env.MYRMIDON_RUN_ID || env.PAPERCLIP_RUN_ID) ? {
              'x-paperclip-run-id': env.MYRMIDON_RUN_ID || env.PAPERCLIP_RUN_ID,
              'x-myrmidon-run-id': env.MYRMIDON_RUN_ID || env.PAPERCLIP_RUN_ID,
            } : {}),
            'content-type': 'application/json',
          },
          body,
        });
        outcome = String(response.status);
        if (response.status !== 409 && ![400, 495, 496].includes(response.status)) break;
        await response.arrayBuffer().catch(() => undefined);
        if ([400, 495, 496].includes(response.status)) break;
      }
    } catch (error) {
      // A dead or unreachable candidate must not stop the walk.
      response = null;
      outcome = error && error.name === 'TimeoutError' ? 'timeout' : 'no_response';
    }
    if (response && response.ok) {
      // myrmidon(OPE-12446): the broker issued (or reused) a credential for
      // this run+repository — remember it for the following invocations.
      try {
        const clone = response.clone();
        const result = await clone.json();
        paperclipStoreBrokerCredential(env, repository || '', result, now);
      } catch {}
      return { response, tried };
    }
    if (response) {
      lastResponse = response;
      await response.arrayBuffer().catch(() => undefined);
    }
    tried.push(url + ' -> ' + outcome);
    if (Date.now() >= deadline) break;
  }
  return { response: lastResponse, tried };
}

// myrmidon(OPE-12446): a run-scoped on-disk cache of the issued credential.
// Every git/gh invocation is a NEW launcher/helper process, so an in-process
// memo cannot hold a token across calls. The cache file lives in the directory
// named by MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR (canonical) or
// PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR (legacy alias) — a per-run directory
// the gateway sets alongside the capability — keyed by a hash of the
// capability and the target repository. While the entry is inside its validity
// window the broker is not contacted at all; the runaway that drained the
// GitHub App budget (852 requests in 10 minutes) was one request per git/gh
// call.
//
// Token hygiene: the capability is hashed (sha256) into the file name, the
// file carries mode 0600 inside a 0700 directory, and the entry is removed as
// soon as it is no longer usable — the token never outlives its validity on
// disk. A missing, stale or unwritable cache degrades to the ordinary broker
// walk and never breaks the operation.
const PAPERCLIP_BROKER_CACHE_DEFAULT_TTL_MS = 45 * 60 * 1000;
const PAPERCLIP_BROKER_CACHE_EXPIRY_MARGIN_MS = 60 * 1000;
function paperclipBrokerCacheRoot(env) {
  for (const name of ['MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR', 'PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR']) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (!value) continue;
    try {
      const nodeFs = require('node:fs');
      const nodePath = require('node:path');
      const root = nodePath.join(value, '.paperclip-broker-cache');
      nodeFs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    } catch { return null; }
  }
  // No per-run directory named: the cache stays OFF and every call walks the
  // broker exactly as before (the gateway sets the directory alongside the
  // capability, so real runs always have it). The require call is reached only
  // when a cache directory is actually configured, so a sandboxed VM harness
  // without require keeps the cache OFF and the walk intact.
  return null;
}
function paperclipBrokerCachePath(env, repository) {
  const root = paperclipBrokerCacheRoot(env);
  if (!root) return null;
  const nodePath = require('node:path');
  const key = require('node:crypto').createHash('sha256')
    .update(String(env.PAPERCLIP_GITHUB_BROKER_TOKEN || '') + '|' + String(repository || ''))
    .digest('hex')
    .slice(0, 32);
  return nodePath.join(root, key + '.json');
}
function paperclipLoadCachedBrokerCredential(env, repository, now) {
  const file = paperclipBrokerCachePath(env, repository);
  if (!file) return null;
  try {
    const nodeFs = require('node:fs');
    const parsed = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    const issuedAt = Number(parsed.issuedAt);
    const expiresAt = Number(parsed.expiresAt);
    const token = parsed.env && typeof parsed.env.GH_TOKEN === 'string' ? parsed.env.GH_TOKEN : '';
    if (!token || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
        || expiresAt - PAPERCLIP_BROKER_CACHE_EXPIRY_MARGIN_MS <= now
        || now - issuedAt > PAPERCLIP_BROKER_CACHE_DEFAULT_TTL_MS) {
      try { nodeFs.rmSync(file, { force: true }); } catch {}
      return null;
    }
    return parsed;
  } catch { return null; }
}
function paperclipStoreBrokerCredential(env, repository, result, now) {
  const file = paperclipBrokerCachePath(env, repository);
  if (!file) return;
  try {
    if (!result || result.status !== 'available' || !result.env || typeof result.env.GH_TOKEN !== 'string') return;
    // The same allow-list the launcher applies to the broker's env, so a
    // cached call carries the same identity (commit author/committer included)
    // as the broker call it replaces.
    const cachedEnv = {};
    for (const [key, value] of Object.entries(result.env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL))$/.test(key) && typeof value === 'string') cachedEnv[key] = value;
    }
    if (!cachedEnv.GH_TOKEN) return;
    let expiresAt = now + PAPERCLIP_BROKER_CACHE_DEFAULT_TTL_MS;
    const declared = Date.parse(String(result.expiresAt || ''));
    if (Number.isFinite(declared)) expiresAt = Math.min(declared, expiresAt);
    require('node:fs').writeFileSync(file, JSON.stringify({
      issuedAt: now, expiresAt, status: result.status,
      env: cachedEnv,
    }), { mode: 0o600 });
  } catch { /* an unwritable cache must not break the operation */ }
}
function paperclipCachedBrokerCredentialIsFresh(entry, now) {
  return Boolean(entry) && Number(entry.expiresAt) - PAPERCLIP_BROKER_CACHE_EXPIRY_MARGIN_MS > now;
}
// A cached entry answers the same shape the walk returns: an object with the
// fields ok, status and json.
// Callers only read status/ok and call json() once.
function paperclipCachedResponse(entry) {
  return {
    ok: true,
    status: 200,
    json: async () => entry,
  };
}

`;
}

/**
 * Defines the target-repository resolution for the launcher script:
 * `paperclipNormalizeRepository(value)`, `paperclipRepositoryFromArgs(args)`,
 * `paperclipRepositoryFromGitArgs(args)` and
 * `paperclipTargetRepository(program, args, env, originalPath)`.
 *
 * myrmidon(GITHUB-SHARED-IDENTITY): a NON-CONTAINER run has to name the
 * repository itself, unlike a bot container where `useHttpPath` hands the
 * helper git's own path. The rules are the container `gh` wrapper's plus one
 * for git: `-R`/`--repo`, `GH_REPO`, an explicit github.com URL among the git
 * arguments, and finally the `origin` remote of the working directory. Only
 * github.com references are accepted, and an unusable explicit value never
 * falls through to the remote: the operator's own `-R` wins or nothing does.
 */
export function githubBrokerRepositoryLauncherSource(): string {
  return String.raw`
// [HOST/]OWNER/REPO, an https/ssh URL or a scp-like remote; github.com only.
function paperclipNormalizeRepository(value) {
  if (typeof value !== 'string') return null;
  let rest = value.trim();
  if (!rest) return null;
  const scp = /^git@(?:www\.)?github\.com:(.+)$/i.exec(rest);
  if (scp) {
    rest = scp[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    let parsed;
    try { parsed = new URL(rest); } catch { return null; }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    rest = parsed.pathname;
  } else {
    const parts = rest.split('/').filter((part) => part.length > 0);
    if (parts.length === 3) {
      const host = parts[0].toLowerCase();
      if (host !== 'github.com' && host !== 'www.github.com') return null;
      rest = parts.slice(1).join('/');
    }
  }
  const segments = rest.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return owner + '/' + repo;
}

// -R/--repo/--repo=/<dir>/…, exactly as gh accepts them; '--' ends the search.
function paperclipRepositoryFromArgs(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '-R' || arg === '--repo') return args[index + 1] ?? null;
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length);
    if (arg.startsWith('-R') && arg.length > 2) return arg.slice(2);
  }
  return null;
}

// A git command names its remote as a URL, a scp-like remote or nothing at all
// ('origin', a branch, a path). Only the URL-shaped values name a repository:
// 'origin/main' must keep meaning the configured 'origin' remote, not a
// repository called 'origin/main'.
function paperclipRepositoryFromGitValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^git@(?:www\.)?github\.com:/i.test(trimmed)
      && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      && !/^(?:www\.)?github\.com\//i.test(trimmed)) return null;
  return paperclipNormalizeRepository(trimmed);
}

function paperclipRepositoryFromGitArgs(args) {
  let cwd = process.cwd();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '-C') { if (args[index + 1]) cwd = args[index + 1]; continue; }
    if (arg.startsWith('-')) continue;
    const repository = paperclipRepositoryFromGitValue(arg);
    if (repository) return { repository, cwd };
  }
  return { repository: null, cwd };
}

// The 'origin' remote of the working directory; never invoke a known wrapper.
// MYRMIDON_GIT_REAL is operator-configurable, so validate it here too rather
// than trusting the launcher to have performed the check for this code path.
// The same wrapper paths the launcher rejects: the staged launcher directory
// (its own git binary is the launcher), the image wrapper and its
// /usr/local/bin shadow. The launcher resolves the real git once — with the
// re-entry probe for unknown PATH entries — and stashes the answer in
// 'resolvedRealGit'; this lookup reuses exactly that binary. The variable
// 'directory' below is the launcher script's staged directory, set by the
// surrounding launcher script.
function paperclipRealGitExecutable(env) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (typeof resolvedRealGit !== 'undefined' && resolvedRealGit && resolvedRealGit.value) return resolvedRealGit.value;
  const configured = env && typeof env.MYRMIDON_GIT_REAL === 'string' ? env.MYRMIDON_GIT_REAL.trim() : '';
  const wrapperPaths = new Set(['/opt/paperclip/bin/git', '/usr/local/bin/git'].map(p => {
    try { return fs.realpathSync(p); } catch { return p; }
  }));
  if (typeof directory === 'string' && directory) {
    const staged = path.join(directory, 'git');
    try { wrapperPaths.add(fs.realpathSync(staged)); } catch { wrapperPaths.add(staged); }
  }
  if (configured) {
    try {
      const candidate = fs.realpathSync(path.resolve(configured));
      if (!wrapperPaths.has(candidate)) return configured;
    } catch {}
  }
  return '/opt/paperclip/libexec/git';
}

function paperclipRepositoryFromOrigin(cwd, env, originalPath) {
  try {
    const cp = require('node:child_process');
    const childEnv = Object.assign({}, env, {
      PATH: originalPath.join(require('node:path').delimiter),
      PAPERCLIP_GITHUB_OPERATION_ACTIVE: '1',
    });
    const result = cp.spawnSync(paperclipRealGitExecutable(env), ['config', '--get', 'remote.origin.url'], {
      cwd, env: childEnv,
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 ? paperclipNormalizeRepository(result.stdout) : null;
  } catch {
    return null;
  }
}

function paperclipTargetRepository(program, args, env, originalPath) {
  if (program === 'gh') {
    const explicit = paperclipRepositoryFromArgs(args) ?? (env.GH_REPO || null);
    if (explicit) return paperclipNormalizeRepository(explicit);
    return paperclipRepositoryFromOrigin(process.cwd(), env, originalPath);
  }
  const fromArgs = paperclipRepositoryFromGitArgs(args);
  if (fromArgs.repository) return fromArgs.repository;
  return paperclipRepositoryFromOrigin(fromArgs.cwd, env, originalPath);
}
`;
}
