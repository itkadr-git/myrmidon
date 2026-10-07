/**
 * Myrmidon (P6): broker candidate walk for the managed GitHub launcher.
 *
 * The server hands a run one GitHub credential broker URL: its public origin.
 * That origin is not always reachable from the run (for example behind a
 * client-certificate proxy), and then `gh`/`git` silently run without managed
 * credentials. The launcher therefore tries several candidate base URLs in
 * order until one answers:
 *
 *   PAPERCLIP_GITHUB_BROKER_URL -> PAPERCLIP_API_URL -> PAPERCLIP_RUNTIME_API_URL
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
  push(env.PAPERCLIP_GITHUB_BROKER_URL);
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
  const deadline = Date.now() + totalTimeoutMs;
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
          headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
            'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
          body,
        });
        outcome = String(response.status);
        if (response.status !== 409) break;
        await response.arrayBuffer().catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(retryDelayMs, deadline - Date.now()))));
      }
    } catch (error) {
      // A dead or unreachable candidate must not stop the walk.
      response = null;
      outcome = error && error.name === 'TimeoutError' ? 'timeout' : 'no_response';
    }
    if (response && response.ok) return { response, tried };
    if (response) {
      lastResponse = response;
      await response.arrayBuffer().catch(() => undefined);
    }
    tried.push(url + ' -> ' + outcome);
    if (Date.now() >= deadline) break;
  }
  return { response: lastResponse, tried };
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

// The 'origin' remote of the working directory; the real git binary, never the
// launcher itself (originalPath excludes the launcher's own directory).
function paperclipRepositoryFromOrigin(cwd, env, originalPath) {
  try {
    const cp = require('node:child_process');
    const result = cp.spawnSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd, env: Object.assign({}, env, { PATH: originalPath.join(require('node:path').delimiter) }),
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
