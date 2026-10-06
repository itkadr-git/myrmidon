// myrmidon(GITHUB-SHARED-IDENTITY): the git credential helper a NON-CONTAINER
// run gets. The bot image installs the same helper at
// /opt/paperclip/bin/git-credential-paperclip and wires it in /etc/gitconfig
// with `useHttpPath = true`; a run outside a bot container (a local or SSH
// execution target — the dev agents on the build machine, a bot container on a
// fleetd host's run) has no image of its own, so
// `prepareGitHubOperationLaunchers` stages this script next to the managed
// `git`/`gh` launchers and the launcher points git at it (URL-scoped, with
// `useHttpPath`). git then hands the helper the repository path of the
// operation, and the helper names that `owner/repo` to the board's broker with
// the run's capability, so the broker can mint a GitHub App installation token
// for exactly that repository.
//
// Standalone source, staged unchanged on local and SSH runtimes, exactly like
// githubLauncherSource(). It carries no secret: the capability reaches it
// through the environment of the run that git belongs to, and the helper prints
// the resolved token only as git's `password=` answer on stdout. Diagnostics
// name the repository, statuses and reason — never the token.

import { githubBrokerCandidatesLauncherSource } from "./myrmidon-github-broker.js";

/**
 * File name of the staged helper inside the run's GitHub launcher directory.
 * The launcher's Git config names it; the container path installs the same
 * program under /opt/paperclip/bin.
 */
export const GITHUB_CREDENTIAL_HELPER_PROGRAM = "git-credential-paperclip";

/** The helper's total budget for one credential request, in milliseconds. */
export const GITHUB_CREDENTIAL_HELPER_TOTAL_TIMEOUT_MS = 60_000;

export function githubCredentialHelperSource(): string {
  return String.raw`#!/usr/bin/env node
// myrmidon(GITHUB-SHARED-IDENTITY): the non-container counterpart of the bot
// image's /opt/paperclip/bin/git-credential-paperclip. Answers git's 'get' for
// github.com over https by asking the board's broker for a credential scoped to
// the repository git named, and drains 'store'/'erase' silently: nothing is
// ever persisted, and a refusal answers nothing at all, so git continues
// exactly as it would without the helper.
const TOTAL_TIMEOUT_MS = ${GITHUB_CREDENTIAL_HELPER_TOTAL_TIMEOUT_MS};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function parseDescription(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return out;
}

// useHttpPath in the launcher's Git config makes git send 'path'; only the first
// two segments are kept, with a trailing .git dropped. Anything else (a relative
// path, a single segment, a traversal) is not forwarded to the broker.
function repositoryFromPath(value) {
  if (typeof value !== 'string') return null;
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return owner + '/' + repo;
}
${githubBrokerCandidatesLauncherSource()}
async function main() {
  const action = process.argv[2] || '';
  const description = parseDescription(await readStdin());
  if (action !== 'get') return;
  if (description.protocol !== 'https') return;
  if (description.host !== 'github.com' && description.host !== 'www.github.com') return;
  const capability = (process.env.PAPERCLIP_GITHUB_BROKER_TOKEN || '').trim();
  if (!capability) {
    process.stderr.write('Paperclip: no GitHub broker capability in this environment; continuing without managed credentials.\n');
    return;
  }
  const repository = repositoryFromPath(description.path);
  let response = null;
  try {
    const attempt = await paperclipRequestBrokerCredentials(
      process.env, paperclipBrokerCandidateUrls(process.env),
      { totalTimeoutMs: TOTAL_TIMEOUT_MS }, repository);
    response = attempt.response;
  } catch { response = null; }
  if (!response) {
    process.stderr.write('Paperclip: GitHub broker unreachable; continuing without managed credentials.\n');
    return;
  }
  if (!response.ok) {
    process.stderr.write('Paperclip: GitHub broker answered HTTP ' + response.status + '; continuing without managed credentials.\n');
    return;
  }
  let result = null;
  try { result = await response.json(); } catch { result = null; }
  if (!result || result.status !== 'available' || !result.env || !result.env.GH_TOKEN) {
    const reason = result && typeof result.reason === 'string'
      ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
      : 'check the GitHub connection in Paperclip';
    process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '; continuing without managed credentials.\n');
    return;
  }
  process.stdout.write('username=x-access-token\npassword=' + result.env.GH_TOKEN + '\n');
}
main().catch(() => { process.exitCode = 1; });
`;
}