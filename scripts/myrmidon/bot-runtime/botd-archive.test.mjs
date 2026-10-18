import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { archive, readManifest, repoFromUrl, retain, verifyEntry } from "../../../docker/bot-runtime/botd/lib/archive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLOSE_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/myrmidon/bot-disk-contract/myr-ws-close.json"), "utf8"));
const KEY = "ABC-101";

let tmp;
let origin;
let copy;
let archiveRoot;

function git(cwd, ...args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-archive-"));
  origin = path.join(tmp, "origin.git");
  copy = path.join(tmp, "copy");
  archiveRoot = path.join(tmp, "archive");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, copy);
  fs.writeFileSync(path.join(copy, "a.txt"), "one\n");
  fs.writeFileSync(path.join(copy, ".gitignore"), "ignored/\n");
  git(copy, "add", ".");
  git(copy, "commit", "-qm", "base");
  git(copy, "branch", "-M", "main");
  git(copy, "push", "-q", "origin", "main");
  git(copy, "checkout", "-qb", `bot/${KEY}`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** unpushed commit + stash + tracked edit + untracked + ignored */
function dirtyCopy() {
  fs.writeFileSync(path.join(copy, "b.txt"), "unpushed\n");
  git(copy, "add", "b.txt");
  git(copy, "commit", "-qm", "unpushed work");
  fs.writeFileSync(path.join(copy, "a.txt"), "stashed\n");
  git(copy, "stash", "push", "-q");
  fs.writeFileSync(path.join(copy, "a.txt"), "edited\n");
  fs.writeFileSync(path.join(copy, "new.txt"), "untracked\n");
  fs.mkdirSync(path.join(copy, "ignored"));
  fs.writeFileSync(path.join(copy, "ignored", "junk.bin"), "x".repeat(5000));
}

const at = (iso) => new Date(iso);

describe("archive()", () => {
  it("unpushed commit + stash + untracked: bundle/patch/tar, verified, manifest entry", () => {
    dirtyCopy();
    const r = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z") });
    assert.equal(r.ok, true, r.reason);
    const e = r.entry;
    assert.equal(path.basename(e.bundle), `${KEY}-20261006T140100Z.bundle`);
    assert.equal(path.basename(e.patch), `${KEY}-20261006T140100Z.patch`);
    assert.equal(path.basename(e.untrackedTar), `${KEY}-20261006T140100Z.untracked.tar`);
    assert.equal(e.truncatedUntracked, false);
    assert.equal(e.createdAt, "2026-10-06T14:01:00.000Z");
    assert.equal(e.sizeBytes, [e.bundle, e.patch, e.untrackedTar].reduce((s, f) => s + fs.statSync(f).size, 0));
    git(copy, "bundle", "verify", e.bundle);
    const heads = git(copy, "bundle", "list-heads", e.bundle);
    assert.match(heads, new RegExp(`refs/heads/bot/${KEY}`));
    assert.match(heads, /refs\/stash/);
    // patch holds the tracked edit
    assert.match(fs.readFileSync(e.patch, "utf8"), /\+edited/);
    // tar: untracked yes, ignored no
    const listing = spawnSync("tar", ["-tf", e.untrackedTar], { encoding: "utf8" }).stdout;
    assert.match(listing, /new\.txt/);
    assert.doesNotMatch(listing, /junk\.bin/);
    // manifest
    const m = readManifest(archiveRoot);
    assert.equal(m.version, 1);
    assert.deepEqual(m.archives, [e]);
  });

  it("the bundle restores the unpushed commit in a fresh clone", () => {
    dirtyCopy();
    const r = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z") });
    const fresh = path.join(tmp, "fresh");
    git(tmp, "clone", "-q", origin, fresh);
    git(fresh, "bundle", "unbundle", r.entry.bundle);
    const want = git(copy, "rev-parse", `bot/${KEY}`);
    assert.equal(git(fresh, "cat-file", "-t", want), "commit");
    git(fresh, "branch", `bot/${KEY}`, want);
    assert.equal(git(fresh, "show", `bot/${KEY}:b.txt`), "unpushed");
  });

  it("untracked over the cap: only bundle+patch, flag in the manifest", () => {
    dirtyCopy();
    fs.writeFileSync(path.join(copy, "big.bin"), "y".repeat(4096));
    const r = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z"), untrackedCapBytes: 1000 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.entry.truncatedUntracked, true);
    assert.equal(r.entry.untrackedTar, undefined);
    assert.ok(fs.existsSync(r.entry.bundle) && fs.existsSync(r.entry.patch));
    assert.deepEqual(fs.readdirSync(archiveRoot).filter((f) => f.endsWith(".tar")), []);
    assert.equal(readManifest(archiveRoot).archives[0].truncatedUntracked, true);
  });

  it("nothing untracked: no tar and no truncation flag", () => {
    fs.writeFileSync(path.join(copy, "b.txt"), "x\n");
    git(copy, "add", "b.txt");
    git(copy, "commit", "-qm", "w");
    const r = archive(copy, KEY, { archiveRoot });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.entry.untrackedTar, undefined);
    assert.equal(r.entry.truncatedUntracked, false);
  });

  it("derives repo from origin without credentials", () => {
    assert.equal(repoFromUrl("https://x-access-token:SECRET@github.com/acme/widgets.git"), "acme/widgets");
    assert.equal(repoFromUrl("git@github.com:acme/widgets.git"), "acme/widgets");
    assert.equal(repoFromUrl("/srv/local/origin.git"), undefined);
    dirtyCopy();
    assert.equal(archive(copy, KEY, { archiveRoot, repo: "acme/widgets" }).entry.repo, "acme/widgets");
  });

  it("verify failure => ok:false, files removed, manifest untouched (copy must not be deleted)", () => {
    dirtyCopy();
    const fake = path.join(tmp, "git-broken-verify");
    fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do if [ "$a" = verify ]; then echo "bundle is corrupt" >&2; exit 1; fi; done\nexec git "$@"\n', { mode: 0o755 });
    const r = archive(copy, KEY, { archiveRoot, gitBin: fake });
    assert.equal(r.ok, false);
    assert.match(r.reason, /corrupt/);
    assert.deepEqual(fs.readdirSync(archiveRoot), []);
  });

  it("not a git copy / bad key => ok:false", () => {
    assert.equal(archive(path.join(tmp, "nope"), KEY, { archiveRoot }).ok, false);
    assert.equal(archive(copy, "bad key", { archiveRoot }).ok, false);
  });

  it("verifyEntry catches a damaged bundle and a missing file", () => {
    dirtyCopy();
    const { entry } = archive(copy, KEY, { archiveRoot });
    assert.equal(verifyEntry(entry, { repoPath: copy }).ok, true);
    fs.truncateSync(entry.bundle, 20);
    assert.equal(verifyEntry(entry, { repoPath: copy }).ok, false);
    fs.rmSync(entry.patch);
    assert.match(verifyEntry(entry, { repoPath: copy }).reason, /missing/);
  });

  it("all archive files are born 0600/0640 (dirs 0750), even under a permissive umask", () => {
    dirtyCopy();
    const previous = process.umask(0o022); // production finding: botd ran with 0022 -> 0644 archives
    try {
      const r = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z") });
      assert.equal(r.ok, true, r.reason);
      // child-tool outputs (git bundle create, tar -cf) land 0640 inside the umask window;
      // direct writes (patch, manifest.json) are explicit 0600; the archive dir 0750.
      for (const f of [r.entry.bundle, r.entry.untrackedTar]) {
        assert.equal(fs.statSync(f).mode & 0o777, 0o640, `${path.basename(f)} must be 0640`);
      }
      for (const f of [r.entry.patch, path.join(archiveRoot, "manifest.json")]) {
        assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${path.basename(f)} must be 0600`);
      }
      assert.equal(fs.statSync(archiveRoot).mode & 0o777, 0o750, "archiveRoot must be 0750");
    } finally {
      process.umask(previous);
    }
  });

  it("two archives of one key in the same second get distinct names", () => {
    dirtyCopy();
    const a = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z") });
    const b = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T14:01:00Z") });
    assert.notEqual(a.entry.bundle, b.entry.bundle);
    assert.equal(readManifest(archiveRoot).archives.length, 2);
  });

  it("a broken manifest is moved aside, not overwritten", () => {
    dirtyCopy();
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, "manifest.json"), "{not json");
    const r = archive(copy, KEY, { archiveRoot });
    assert.equal(r.ok, true, r.reason);
    assert.ok(fs.readdirSync(archiveRoot).some((f) => f.startsWith("manifest.json.corrupt-")));
    assert.equal(readManifest(archiveRoot).archives.length, 1);
  });

  it("paths follow the contract close fixture shape", () => {
    dirtyCopy();
    const { entry } = archive(copy, KEY, { archiveRoot, now: at("2026-10-06T15:00:00Z") });
    const fixtureName = path.basename(CLOSE_FIXTURE.archivePath);
    assert.equal(path.basename(entry.bundle).replace(/-\d{8}T\d{6}Z/, "-TS"), fixtureName.replace(/-\d{8}T\d{6}Z/, "-TS"));
    assert.match(path.basename(entry.bundle), /^[A-Z][A-Z0-9]*-\d+-\d{8}T\d{6}Z\.bundle$/);
  });
});

describe("retain()", () => {
  function seed(items) {
    fs.mkdirSync(archiveRoot, { recursive: true });
    const archives = items.map(({ createdAt, size, key = KEY }) => {
      const bundle = path.join(archiveRoot, `${key}-${createdAt.replace(/[-:]/g, "").replace(/\.\d+/, "")}.bundle`);
      fs.writeFileSync(bundle, Buffer.alloc(size));
      return { key, bundle, patch: undefined, createdAt, sizeBytes: size, truncatedUntracked: false };
    });
    fs.writeFileSync(path.join(archiveRoot, "manifest.json"), JSON.stringify({ version: 1, archives }));
    return archives;
  }
  const NOW = at("2026-10-07T00:00:00Z");

  it("removes entries older than 30 days, keeps fresh ones", () => {
    const [old, fresh] = seed([
      { createdAt: "2026-09-01T00:00:00Z", size: 10 },
      { createdAt: "2026-09-20T00:00:00Z", size: 10 },
    ]);
    const r = retain(archiveRoot, { now: NOW });
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed.map((x) => [x.createdAt, x.reason]), [["2026-09-01T00:00:00Z", "age"]]);
    assert.equal(fs.existsSync(old.bundle), false);
    assert.equal(fs.existsSync(fresh.bundle), true);
    assert.equal(readManifest(archiveRoot).archives.length, 1);
  });

  it("over the cap deletes the oldest first until it fits", () => {
    const [a, b, c] = seed([
      { createdAt: "2026-10-03T00:00:00Z", size: 400 },
      { createdAt: "2026-10-01T00:00:00Z", size: 400 },
      { createdAt: "2026-10-05T00:00:00Z", size: 400 },
    ]);
    const r = retain(archiveRoot, { now: NOW, capBytes: 800 });
    assert.deepEqual(r.removed.map((x) => [x.createdAt, x.reason]), [["2026-10-01T00:00:00Z", "cap"]]);
    assert.equal(fs.existsSync(b.bundle), false);
    assert.equal(fs.existsSync(a.bundle) && fs.existsSync(c.bundle), true);
    assert.equal(r.remainingBytes, 800);
    assert.equal(r.remaining, 2);
  });

  it("never evicts the entry just created, even if it alone exceeds the cap", () => {
    const [old, newest] = seed([
      { createdAt: "2026-10-01T00:00:00Z", size: 100 },
      { createdAt: "2026-10-06T00:00:00Z", size: 900 },
    ]);
    const r = retain(archiveRoot, { now: NOW, capBytes: 500, keepCreatedAt: ["2026-10-06T00:00:00Z"] });
    assert.equal(fs.existsSync(old.bundle), false);
    assert.equal(fs.existsSync(newest.bundle), true);
    assert.equal(r.remaining, 1);
  });

  it("pressure: a shorter maxAgeDays (7) is honoured; entries with no files left are dropped", () => {
    const [, gone] = seed([
      { createdAt: "2026-09-25T00:00:00Z", size: 10 },
      { createdAt: "2026-10-05T00:00:00Z", size: 10 },
    ]);
    fs.rmSync(gone.bundle);
    const r = retain(archiveRoot, { now: NOW, maxAgeDays: 7 });
    assert.equal(r.removed.length, 1);
    assert.equal(r.remaining, 0);
  });

  it("empty/missing archive dir is fine", () => {
    assert.deepEqual(retain(path.join(tmp, "none"), { now: NOW }), { ok: true, removed: [], remainingBytes: 0, remaining: 0 });
  });
});
