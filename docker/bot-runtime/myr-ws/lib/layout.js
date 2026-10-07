"use strict";
// myrmidon(1.6.5 BOT-DISK-H2a): directory layout of `myr-ws` (contract C1,
// packages/shared/src/myrmidon-bot-workspace.ts). Constants are mirrored here
// because the image ships plain CommonJS without the workspace packages; the
// contract test in scripts/myrmidon/bot-runtime/myr-ws-base.test.mjs compares
// every value with the shared constants.

const path = require("node:path");

const MYRMIDON_HOME_DIR = "/data/hermes/.myrmidon";
const WS_GIT_BASE_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const WS_GIT_BASE_LIMIT = 8;
const WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC = 900;

const ENV = {
  home: "MYRMIDON_WS_HOME",
  gitReal: "MYRMIDON_GIT_REAL",
  refreshSec: "MYRMIDON_WS_REFRESH_SEC",
  // Test-only: replaces https://github.com as the origin URL root.
  remoteBase: "MYRMIDON_WS_REMOTE_BASE",
};

const DEFAULT_GIT_REAL = "/opt/paperclip/libexec/git";
const DEFAULT_REMOTE_BASE = "https://github.com";

// GitHub: owner 1-39 of [A-Za-z0-9-], not starting with "-"; repo name of
// [A-Za-z0-9_.-], never "." or "..", at most 100. Slightly stricter than the
// contract regex on purpose: no path injection, no hidden/dot-only segments.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

function homeDir(env = process.env) {
  return env[ENV.home] || MYRMIDON_HOME_DIR;
}

function gitBaseRoot(env = process.env) {
  return path.join(homeDir(env), "git-base");
}

/** Parses `owner/repo` (an optional `.git` suffix is dropped); null when invalid. */
function parseRepo(input) {
  if (typeof input !== "string") return null;
  const parts = input.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER_RE.test(owner)) return null;
  if (!REPO_RE.test(repo) || repo === "." || repo === ".." || repo.startsWith(".")) return null;
  return { owner, repo, slug: `${owner}/${repo}` };
}

function basePath(parsed, env = process.env) {
  return path.join(gitBaseRoot(env), parsed.owner, `${parsed.repo}.git`);
}

module.exports = {
  ENV,
  MYRMIDON_HOME_DIR,
  WS_GIT_BASE_REFSPEC,
  WS_GIT_BASE_LIMIT,
  WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC,
  DEFAULT_GIT_REAL,
  DEFAULT_REMOTE_BASE,
  homeDir,
  gitBaseRoot,
  parseRepo,
  basePath,
};
