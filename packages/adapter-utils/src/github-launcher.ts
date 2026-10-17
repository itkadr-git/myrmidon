// myrmidon(P6): broker candidate walk embedded into the launcher
// myrmidon(GITHUB-SHARED-IDENTITY): plus the target-repository resolution a
// non-container run needs to name the repository to the broker.
import { githubBrokerCandidatesLauncherSource, githubBrokerRepositoryLauncherSource } from "./myrmidon-github-broker.js";
import { GITHUB_CREDENTIAL_HELPER_PROGRAM, githubCredentialHelperSource } from "./github-credential-helper.js";

/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
${githubBrokerCandidatesLauncherSource()}
${githubBrokerRepositoryLauncherSource()}
async function main() {
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    // myrmidon(GITHUB-SHARED-IDENTITY): the same Git config the bot image
    // installs at /etc/gitconfig — the leading empty helper clears ambient
    // helpers, and the URL-scoped one, with useHttpPath, makes git hand the
    // staged helper the repository path of the operation so the broker can
    // mint a GitHub App token for exactly that repository.
    const credentialHelper = path.join(directory, '${GITHUB_CREDENTIAL_HELPER_PROGRAM}');
    const gitConfig = [
      ['credential.helper', ''],
      ['credential.https://github.com.helper', credentialHelper],
      ['credential.https://www.github.com.helper', credentialHelper],
      ['credential.https://github.com.useHttpPath', 'true'],
      ['credential.https://www.github.com.useHttpPath', 'true'],
      ['url.https://github.com/.insteadOf', 'git@github.com:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
      ['core.askPass', ''],
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      ['user.useConfigOnly', 'true'],
    ];
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: String(gitConfig.length),
    });
    gitConfig.forEach(([key, value], index) => {
      env['GIT_CONFIG_KEY_' + index] = key;
      env['GIT_CONFIG_VALUE_' + index] = value;
    });
    // myrmidon(P6): walk up to six broker candidates instead of one URL.
    // myrmidon(GITHUB-SHARED-IDENTITY): and name the repository this command
    // targets, so an App identity serves it.
    const brokerBaseUrls = paperclipBrokerCandidateUrls(env);
    try {
    let response;
    if (brokerBaseUrls.length > 0 && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const repository = paperclipTargetRepository(program, process.argv.slice(2), env, originalPath);
      const brokerAttempt = await paperclipRequestBrokerCredentials(env, brokerBaseUrls, undefined, repository);
      response = brokerAttempt.response;
      if (!response || !response.ok) {
        if (brokerAttempt.tried.length > 0) process.stderr.write('Paperclip: GitHub broker candidates tried: ' + brokerAttempt.tried.join(', ') + '.\n');
        if (!response) diagnostic('broker_transport_unavailable');
        else diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      const result = await response.json();
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        // The Git configuration above is the launcher's own: only the token,
        // the terminal-prompt switch and the commit identity are taken from the
        // broker, so a broker-supplied credential helper can never replace the
        // staged one that names the repository.
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL))$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

// myrmidon(GITHUB-SHARED-IDENTITY): the launcher file set a consumer without an
// execution target materializes itself (NONCONTAINER-GITHUB-LAUNCHER).
//
// `prepareGitHubOperationLaunchers` stages these programs on a local/SSH
// execution target, which a hermes gateway run does not have: the gateway may
// run on another host (or in a container whose image the board cannot write
// into), so the adapter ships the bodies with the run request and the gateway
// writes them next to that run's terminals. The same programs the image
// installs are staged, from the same source here — no second copy to drift.
//
// Bodies are token-free constants, so a replayed request carries byte-identical
// content and its Idempotency-Key fingerprint stays stable.
export const GITHUB_LAUNCHER_PAYLOAD_VERSION = 1;
/** Login-shell profiles that re-prepend the staged directory after /etc/profile reorders PATH. */
export const GITHUB_LAUNCHER_PROFILE_FILE_NAMES = [
  ".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile",
] as const;
/** Program files staged by both delivery paths, in staging order. */
export const GITHUB_LAUNCHER_PROGRAM_FILE_NAMES = ["package.json", "git", "gh", GITHUB_CREDENTIAL_HELPER_PROGRAM] as const;

function launcherProgramBody(name: string): string {
  switch (name) {
    case "package.json":
      return '{"type":"commonjs"}\n';
    case GITHUB_CREDENTIAL_HELPER_PROGRAM:
      return githubCredentialHelperSource();
    default:
      return githubLauncherSource();
  }
}

/**
 * The program bodies, keyed by staged file name.
 *
 * `package.json` pins the staged directory's own module scope so an enclosing
 * project's `"type": "module"` cannot reinterpret `require()`.
 */
export function githubLauncherProgramFiles(): Record<string, string> {
  // Built from the shared name list: the payload a gateway stages and the files
  // a local/SSH target stages must be the same set, and this keeps them so.
  return Object.fromEntries(GITHUB_LAUNCHER_PROGRAM_FILE_NAMES.map((name) => [name, launcherProgramBody(name)] as const));
}

/**
 * The launcher as request content for a hermes gateway run's `github_launcher`
 * body field: `{version, files}`. The gateway validates it, writes the files
 * under a per-run directory of its own, and puts that directory first on the
 * PATH of that run's terminals — the delivery path
 * `prepareGitHubOperationLaunchers` provides for an execution target.
 *
 * The login-shell profiles are built by the gateway, not shipped: their PATH
 * must name the directory the gateway itself chose.
 */
export function githubLauncherPayload(): { version: number; files: Record<string, string> } {
  return { version: GITHUB_LAUNCHER_PAYLOAD_VERSION, files: githubLauncherProgramFiles() };
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
