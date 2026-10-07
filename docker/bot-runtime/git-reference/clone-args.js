"use strict";
// docker/bot-runtime/git-reference/clone-args.js
//
// myrmidon(1.6.5 BOT-DISK-H1a): pure parser of `git clone ...` arguments for the
// git wrapper (BOT-DISK-H1c). No dependencies, no I/O, no environment: the same
// argv always gives the same answer. The wrapper uses it to decide whether a
// clone names a GitHub repository (then it is turned into `myr-ws open`) or
// something else (kind "foreign": the real git runs unchanged).
//
//   parseCloneArgs(argv) -> {
//     kind: "github" | "foreign" | "invalid",
//     owner: string | null,        // github only
//     repo: string | null,         // github only, without ".git"
//     dir: string | null,          // target directory as given, else the repo name (github only)
//     ignoredFlags: string[],      // option NAMES (never values) that decide history/storage
//                                  // and are dropped, plus unknown options
//     hadUserinfo: boolean,        // the URL carried credentials (token, user:password)
//   }
//
// "invalid" = no repository argument at all. argv may start with "clone" (the
// subcommand is skipped) or hold only the arguments after it.
//
// Secrets: the repository URL is only ever read, never copied. Neither the
// userinfo, nor the URL, nor any option VALUE is placed in the result, so a
// token cannot reach a log through it.

// Options that take a value in a separate argument (`--opt value`); the
// `--opt=value` form needs no table.
const VALUE_OPTS = new Set([
  "-b", "--branch", "-o", "--origin", "--depth", "--filter", "--reference",
  "--reference-if-able", "--separate-git-dir", "--template", "-c", "--config",
  "-j", "--jobs", "--shallow-since", "--shallow-exclude", "-u", "--upload-pack",
  "--server-option", "--bundle-uri", "--revision", "--ref-format", "--also-filter-submodules",
]);

// Options that decide history or storage of the copy: dropped with a message
// (the objects already live in the base, so none of them buys anything).
const IGNORED_OPTS = new Set([
  "--filter", "--depth", "--mirror", "--bare", "--single-branch", "--no-single-branch",
  "--shallow-since", "--shallow-exclude", "--shallow-submodules", "--no-shallow-submodules",
  "--sparse", "--dissociate", "--shared", "-s", "--local", "-l", "--no-local",
  "--no-hardlinks", "--reference", "--reference-if-able", "--separate-git-dir",
  "--revision", "--bundle-uri", "--also-filter-submodules",
]);

// Known options that are neither stored nor dropped meaningfully.
const BENIGN_OPTS = new Set([
  "-b", "--branch", "-o", "--origin", "-q", "--quiet", "-v", "--verbose", "--progress",
  "--no-progress", "-n", "--no-checkout", "--checkout", "--no-tags", "--tags", "--template",
  "-c", "--config", "-j", "--jobs", "--recurse-submodules", "--no-recurse-submodules",
  "--remote-submodules", "--no-remote-submodules", "--reject-shallow", "--no-reject-shallow",
  "--ipv4", "-4", "--ipv6", "-6", "-u", "--upload-pack", "--server-option", "--ref-format",
  "--no-sparse", "--no-dissociate", "--no-bundle-uri",
]);

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

function optName(arg) {
  const eq = arg.indexOf("=");
  return arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
}

function splitPath(p) {
  const parts = String(p).replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

// Returns {github: bool, owner, repo, hadUserinfo}; never the URL itself.
function parseRepoArg(arg) {
  const out = { github: false, owner: null, repo: null, hadUserinfo: false };
  if (typeof arg !== "string" || arg === "") return out;

  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?/.exec(arg);
  if (m) {
    const scheme = m[1].toLowerCase();
    const authority = m[2];
    const at = authority.lastIndexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : "";
    const hostport = at >= 0 ? authority.slice(at + 1) : authority;
    const host = hostport.replace(/:\d*$/, "").toLowerCase();
    if (!["https", "http", "ssh", "git"].includes(scheme) || !GITHUB_HOSTS.has(host)) return out;
    // the plain ssh login ("git@") is not a credential; a token or user:password is
    out.hadUserinfo = userinfo !== "" && (userinfo.includes(":") || userinfo.toLowerCase() !== "git");
    const rp = splitPath(m[3] || "");
    if (!rp) return out;
    return { ...out, github: true, owner: rp.owner, repo: rp.repo };
  }

  // scp-like: [user@]host:owner/repo (no "://", host before the first colon)
  if (!arg.startsWith("/") && !arg.startsWith(".")) {
    const s = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(arg);
    if (s && GITHUB_HOSTS.has(s[2].toLowerCase())) {
      const user = s[1] || "";
      out.hadUserinfo = user !== "" && user.toLowerCase() !== "git";
      const rp = splitPath(s[3]);
      if (!rp) return out;
      return { ...out, github: true, owner: rp.owner, repo: rp.repo };
    }
  }
  return out;
}

function parseCloneArgs(argv) {
  const result = { kind: "invalid", owner: null, repo: null, dir: null, ignoredFlags: [], hadUserinfo: false };
  if (!Array.isArray(argv)) return result;
  let args = argv.filter((a) => typeof a === "string");
  // the subcommand itself may lead the list; the wrapper passes what follows it otherwise
  if (args[0] === "clone") args = args.slice(1);

  const ignored = [];
  const positionals = [];
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDashes || a === "-" || !a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      afterDashes = true;
      continue;
    }
    const name = optName(a);
    const hasInlineValue = a.startsWith("--") && a.includes("=");
    if (!hasInlineValue && VALUE_OPTS.has(name)) i++; // swallow the value, never read it
    if (IGNORED_OPTS.has(name) || (!BENIGN_OPTS.has(name) && !VALUE_OPTS.has(name))) {
      if (!ignored.includes(name)) ignored.push(name);
    }
  }

  result.ignoredFlags = ignored;
  if (positionals.length === 0) return result;

  const repoInfo = parseRepoArg(positionals[0]);
  const explicitDir = positionals.length > 1 ? positionals[1] : null;
  if (!repoInfo.github) {
    result.kind = "foreign";
    result.dir = explicitDir;
    return result;
  }
  result.kind = "github";
  result.owner = repoInfo.owner;
  result.repo = repoInfo.repo;
  result.hadUserinfo = repoInfo.hadUserinfo;
  result.dir = explicitDir !== null ? explicitDir : repoInfo.repo;
  return result;
}

module.exports = { parseCloneArgs };
