// myrmidon(1.6.5 BOT-DISK-H1a): argv of `git clone` → what the git wrapper
// needs to route a clone of a GitHub repository into the board's shared base
// (`myr-ws open`) instead of a full copy of the history.
//
// Pure: no filesystem, no environment, no child process, no logging. The
// wrapper (docker/bot-runtime/git-reference/git) loads it from the directory it
// itself lives in and calls parseCloneArgs(process.argv.slice(2)); every other
// caller is a test.
//
//   parseCloneArgs(["clone", "https://github.com/itkadr-git/myrmidon.git", "d"])
//     → { owner: "itkadr-git", repo: "myrmidon", dir: "d",
//         ignoredFlags: [], hadUserinfo: false, kind: "github" }
//
// Result fields (exactly these six):
//   owner, repo  the GitHub repository, lower case, without the ".git" suffix;
//                both null when kind is "foreign".
//   dir          the clone's target directory: the second positional argument
//                when the command names one, else what `git clone` derives
//                itself from the URL (its last path segment, original
//                spelling), or null when nothing can be derived. --mirror and
//                --bare do not change it — they are ignored (see below), so
//                this is the plain-clone directory.
//   ignoredFlags the flags of this argv the wrapper drops, because the objects
//                are already in the shared base: --filter, --depth, --mirror,
//                --bare. Spelling as it appeared: "--depth=1", or the bare
//                "--depth"/"--filter" whose value was the next argument (that
//                value is consumed, never mistaken for the repository or the
//                directory). The wrapper prints them on stderr; nothing else
//                reads them.
//   hadUserinfo  true when the URL carries a credential in its userinfo
//                (`user:password@host` of an http/https URL) — the PAT-in-URL
//                form the design's Ф0 forbids in .git/config and in logs. An
//                ssh URL `ssh://git@host/…` or an scp-style `git@host:…` is NOT
//                userinfo: `git` is the plain ssh login, and stripping it would
//                break every ssh clone, so those report false.
//   kind         "github" for a repository URL on github.com (https, ssh://,
//                scp-style, with or without ".git"); "foreign" for everything
//                else — the wrapper then runs the real git with argv, streams
//                and exit status untouched.
//
// Returns null when argv is not a `git clone` command (any other subcommand, a
// bare `git --version`, a token that is no subcommand) or when the command
// names no repository. The wrapper then runs the real git unchanged.
//
// SECURITY (design, Ф0): the URL is never copied into the result — owner, repo
// and dir are derived from it and the credential-bearing userinfo is dropped.
// A token in `https://user:TOKEN@github.com/o/r.git` is therefore absent from
// every field, which the test asserts by substring over JSON.stringify(result).
//
// CJS on purpose, like the wrapper: in the image it sits next to `git` in
// /opt/paperclip/bin, where no package.json makes Node load it as CommonJS.

"use strict";

/** git global options that take their value as the NEXT argument. */
const GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
  "--exec-path",
]);

/** `git clone` options that take their value as the NEXT argument. */
const CLONE_WITH_VALUE = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "-u",
  "--upload-pack",
  "--reference",
  "--reference-if-able",
  "--separate-git-dir",
  "--depth",
  "--shallow-since",
  "--shallow-exclude",
  "--filter",
  "-j",
  "--jobs",
  "--template",
  "-c",
  "--config",
  "--server-option",
  "--bundle-uri",
  "--ref-format",
  "--revision",
]);

/**
 * Clone options the wrapper drops with a message: the objects are already in
 * the shared base, so --filter would hide them there too and --depth/--mirror/
 * --bare would only decide the storage of a copy the wrapper does not make.
 */
const IGNORED_CLONE_FLAGS = new Set(["--filter", "--depth", "--mirror", "--bare"]);

/** Same shapes the wrapper validates its mirror paths with. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SCP_RE = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/;
/** Schemes whose userinfo is a credential (`user:token@host`) rather than a login. */
const CREDENTIAL_SCHEMES = new Set(["http:", "https:"]);

/**
 * Index of the `clone` subcommand in a full git argv, skipping the global
 * options that stand before it, or -1 when this is no `git clone` command.
 */
function cloneIndex(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") return -1;
    if (token === "clone") return i;
    if (token === "--") return -1;
    if (token.startsWith("-")) {
      if (!token.includes("=") && GLOBAL_WITH_VALUE.has(token)) i += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

/** Positional repository/directory of the clone plus the flags the wrapper drops. */
function readCloneArgs(argv, at) {
  const positionals = [];
  const ignoredFlags = [];
  let literal = false;
  for (let i = at + 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.length > 1 && token.startsWith("-")) {
      const name = token.split("=")[0];
      // An option of either set may take its value as the next argument; that
      // value is consumed here so it never reads as the repository or the
      // directory. --depth 1 therefore reports the bare "--depth".
      const takesValue = !token.includes("=") && CLONE_WITH_VALUE.has(name);
      if (IGNORED_CLONE_FLAGS.has(name)) ignoredFlags.push(token);
      if (takesValue) i += 1;
      continue;
    }
    positionals.push(token);
  }
  return {
    url: positionals.length > 0 ? positionals[0] : null,
    dir: positionals.length > 1 ? positionals[1] : null,
    ignoredFlags,
  };
}

/** Host, path and credential-userinfo of a repository URL, or null. */
function describeUrl(url) {
  if (typeof url !== "string" || url === "-" || url === "--") return null;
  if (SCHEME_RE.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    return {
      host: parsed.hostname || null,
      path: parsed.pathname || "",
      userinfo: CREDENTIAL_SCHEMES.has(parsed.protocol) && Boolean(parsed.username || parsed.password),
    };
  }
  const scp = SCP_RE.exec(url);
  if (scp) return { host: scp[2], path: scp[3], userinfo: false };
  return { host: null, path: url, userinfo: false };
}

/** owner/repo (lower case) when the URL names a GitHub repository, else null. */
function githubParts(described) {
  if (!described || !described.host) return null;
  if (!GITHUB_HOSTS.has(String(described.host).toLowerCase())) return null;
  const path = String(described.path || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const segments = path.split("/");
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/** The directory `git clone` itself would create for this URL, or null. */
function derivedDir(described) {
  const path = String((described && described.path) || "").replace(/[/\\]+$/, "");
  const last = path.split(/[/\\]/).pop() || "";
  const name = last.replace(/\.git$/i, "");
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * Parse the argv of a `git clone` command (without the leading `git`).
 * Returns null when this is not a clone of a named repository.
 */
function parseCloneArgs(argv) {
  const at = cloneIndex(argv);
  if (at === -1) return null;
  const { url, dir, ignoredFlags } = readCloneArgs(argv, at);
  if (url === null) return null;
  const described = describeUrl(url);
  if (!described) return null;
  const github = githubParts(described);
  return {
    owner: github ? github.owner : null,
    repo: github ? github.repo : null,
    dir: dir !== null ? dir : derivedDir(described),
    ignoredFlags,
    hadUserinfo: described.userinfo,
    kind: github ? "github" : "foreign",
  };
}

module.exports = { parseCloneArgs };