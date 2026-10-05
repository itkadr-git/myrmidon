#!/usr/bin/env node
// CHANGE-FRAGMENTS: the CI gate of the change-fragments workflow
// (docs/myrmidon/changes/README.md). Verifies one thing: the shared registry
// documents — docs/myrmidon/CHANGELOG(.ru).md, DIVERGENCE.md, SETTINGS(.ru).md
// — are never edited by hand in a pull request. Their content arrives as
// per-PR fragment files (no merge conflicts) and is folded into the shared
// documents by scripts/myrmidon/release/collect-fragments.mjs at release cut.
//
//   node scripts/myrmidon/ci/change-fragments-gate.mjs --event-file <github-event.json>
//       [--base <sha> --head <sha>] [--root <dir>]
//
// Modes:
//   pull_request (event file present): the diff is base.sha..head.sha of the
//     event. Shared documents must be untouched unless the same diff deletes
//     at least one fragment (that is the release-cut PR). Fragments are never
//     mandatory: a PR without registry changes needs none.
//   push / local: with explicit --base/--head the same check runs against
//     that range (used by tests). Without them and without an event file the
//     check is a no-op (a push to main carries merged, already-reviewed
//     content — including the release cut).
//
// Output on violation: the hint naming the fragment format and the release
// procedure. Exit 0 clean / no-op, 1 violations, 2 usage. Node built-ins only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FRAGMENTS_PREFIX = "docs/myrmidon/changes/";
const SHARED_DOCS = [
  "docs/myrmidon/CHANGELOG.md",
  "docs/myrmidon/CHANGELOG.ru.md",
  "docs/myrmidon/DIVERGENCE.md",
  "docs/myrmidon/SETTINGS.md",
  "docs/myrmidon/SETTINGS.ru.md",
];

const HINT = [
  "",
  "CHANGE-FRAGMENTS: the shared registry documents are no longer edited by",
  "hand — every PR ships its entry as its own file, and the release cut folds",
  "the files into the shared documents (no more append conflicts).",
  "",
  "What to do instead of the edit above:",
  "  1. git restore the shared document(s) listed above",
  "  2. add docs/myrmidon/changes/<branch-slug>.md with your entry —",
  "     format and a copy-paste template: docs/myrmidon/changes/README.md",
  "  3. at release cut the maintainer runs",
  "     node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z",
  "     which folds every fragment into CHANGELOG/DIVERGENCE/SETTINGS and",
  "     deletes the fragment files.",
  "",
  "The release-cut PR itself is recognized by the fragment deletions it",
  "carries and passes this check.",
  "",
].join("\n");

/** git diff --name-status for the range; [{ status, file }], renames resolved to the new path. */
export function diffNameStatus(root, base, head) {
  const out = execFileSync("git", ["diff", "--name-status", `${base}..${head}`], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0], file: parts[parts.length - 1] };
    });
}

/** The verdict for one change set: { ok, violations[], deletedFragments[] }. */
export function judge(changes) {
  const deletedFragments = changes.filter(
    (c) => c.status === "D" && c.file.startsWith(FRAGMENTS_PREFIX),
  );
  const releaseCut = deletedFragments.length > 0;
  const violations = changes.filter(
    (c) => SHARED_DOCS.includes(c.file) && !(releaseCut && c.status !== "A"),
  );
  return { ok: violations.length === 0, violations, deletedFragments, releaseCut };
}

export function check({ root = process.cwd(), eventFile = null, base = null, head = null } = {}) {
  let range = base && head ? { base, head } : null;
  let eventName = null;
  if (!range && eventFile) {
    const event = JSON.parse(fs.readFileSync(eventFile, "utf8"));
    if (event.pull_request?.base?.sha && event.pull_request?.head?.sha) {
      range = { base: event.pull_request.base.sha, head: event.pull_request.head.sha };
      eventName = "pull_request";
    }
  }
  if (!range) {
    return { skipped: true, reason: "not a pull request and no --base/--head given" };
  }
  const changes = diffNameStatus(root, range.base, range.head);
  const verdict = judge(changes);
  return { skipped: false, eventName, range, changes, ...verdict };
}

function main(argv) {
  const args = { root: process.cwd(), eventFile: null, base: null, head: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--event-file":
        args.eventFile = argv[++i];
        break;
      case "--base":
        args.base = argv[++i];
        break;
      case "--head":
        args.head = argv[++i];
        break;
      case "--root":
        args.root = argv[++i];
        break;
      default:
        console.error(`unknown argument: ${argv[i]}`);
        return 2;
    }
  }
  try {
    const result = check(args);
    if (result.skipped) {
      console.log(`change-fragments check skipped: ${result.reason}`);
      return 0;
    }
    if (result.ok) {
      const note = result.releaseCut
        ? ` (release cut: ${result.deletedFragments.length} fragment(s) folded)`
        : "";
      console.log(`change-fragments check ok${note}`);
      return 0;
    }
    console.error("change-fragments check FAILED: shared registry documents edited by hand:");
    for (const v of result.violations) console.error(`  ${v.status}\t${v.file}`);
    console.error(HINT);
    return 1;
  } catch (err) {
    console.error(`change-fragments-gate: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
