import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBody,
  buildManifest,
  COMPONENTS,
  MANIFEST_NAME,
  componentDigest,
  componentDigests,
  extractChangelogSection,
  previousMinorPatch,
} from "./release-body.mjs";

// RELEASE-PUBLISH (the 02.10 gap): integration tests of the automatic GitHub
// Release flow. The real script (publish-github-release.sh) runs against a
// fake `gh` and `node` in PATH; no test touches GitHub, the registry or a
// real tag. Same harness pattern as deploy/release-gate.test.mjs.
//
// The body builder (release-body.mjs) is covered separately with an
// injected fetch: changelog section extraction, missing-section refusal,
// digest resolution, missing-digest refusal, the full body shape.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "publish-github-release.sh");
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, "utf8");
const BUILDER = path.join(HERE, "release-body.mjs");
const REPO = "itkadr-git/myrmidon";
const COMMIT = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const TAG_OBJECT = "0123456789abcdef0123456789abcdef01234567";

const CHANGELOG = `# Myrmidon changelog

## 1.6.0

- New thing A.
- New thing B.

## 1.5.0

- Old thing.

## 1.4.0

- Older thing.
`;

// The fake gh answers by URL/argument shape. State lives in the sandbox dir:
//   runs.json          workflow runs for the tag commit (API answers)
//   releases.json      existing releases (tag -> {name, body})
//   ref-tag.json       the tag ref (annotated -> tag object)
//   tag-object.json    the annotated tag object (-> commit)
// The fake records every release mutation into mutations.log for assertions.
const FAKE_GH = `#!/usr/bin/env bash
# Fake gh: answers the API GETs from files in $SANDBOX, records release
# mutations into mutations.log. Argument parsing is a plain loop so the
# embedded script survives being a JS template literal.
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    # collect: first non-flag argument is the URL, --jq carries the filter
    url=""; jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;; # --paginate and friends
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done
    body=""
    case "$url" in
      *"/git/ref/tags/"*) body="$(cat "$SANDBOX/ref-tag.json")" ;;
      *"/git/tags/"*)     body="$(cat "$SANDBOX/tag-object.json")" ;;
      *"actions/runs?head_sha="*)
        # RELEASE-PUBLISH-WAIT: scripted progression — when $SANDBOX/runs-after.json
        # exists, the first GH_RUNS_SWITCH_AFTER reads answer "before" (the
        # state runs.json holds), the rest answer "after". Lets a test watch
        # the publish WAIT while the tag's image run is still building, then
        # succeed when it completes. GH_RUNS_SWITCH_AFTER is always exported
        # by the test harness (0 = switch on the first read).
        if [ -f "$SANDBOX/runs-after.json" ]; then
          count_file="$SANDBOX/runs-reads.count"
          reads=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
          echo "$reads" > "$count_file"
          if [ "$reads" -gt "$GH_RUNS_SWITCH_AFTER" ]; then
            body="$(cat "$SANDBOX/runs-after.json")"
          else
            body="$(cat "$SANDBOX/runs.json")"
          fi
        else
          body="$(cat "$SANDBOX/runs.json")"
        fi ;;
      *) body="{}" ;;
    esac
    if [ -n "$jq_filter" ]; then
      jq "$jq_filter" <<<"$body"
    else
      printf '%s\n' "$body"
    fi ;;
  release)
    verb="$1"; shift
    tag=""; title=""; notes=""; jq_filter=""; prerelease=0; latest=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --title) shift; title="$1" ;;
        --notes-file) shift; notes="$1" ;;
        --prerelease) prerelease=1 ;;
        --latest) latest=1 ;;
        --json) shift ;; # promote-latest.sh: --json isPrerelease,isLatest
        --jq) shift; jq_filter="$1" ;;
        myr-v*) tag="$1" ;;
      esac
      shift
    done
    case "$verb" in
      view)
        # The script calls: gh release view <tag> --json name --jq '.name'
        # (--json without --jq prints the object). The filter applies to the
        # release object, not the whole map.
        if jq -e --arg t "$tag" 'has($t)' "$SANDBOX/releases.json" >/dev/null; then
          if [ -n "$jq_filter" ]; then
            # gh --jq prints raw strings (jq -r semantics)
            jq -r --arg t "$tag" '.[$t] | '"$jq_filter" "$SANDBOX/releases.json"
          else
            jq --arg t "$tag" '{name: .[$t].name, body: .[$t].body, isPrerelease: (.[$t].isPrerelease // false), isLatest: (.[$t].isLatest // false)}' "$SANDBOX/releases.json"
          fi
        else
          echo "release not found: $tag" >&2
          exit 1
        fi ;;
      upload)
        printf 'upload tag=%s manifest=%s\n' "$tag" "$(jq -c . release-components.json)" >> "$SANDBOX/mutations.log" ;;
      create)
        printf 'create tag=%s title=%s prerelease=%s latest=%s notes=%s\n' "$tag" "$title" "$prerelease" "$latest" "$(cat "$notes")" >> "$SANDBOX/mutations.log"
        jq --arg t "$tag" --arg n "$title" --arg b "$(cat "$notes")" --argjson pre "$prerelease" \
          '.[$t] = {name: $n, body: $b, isPrerelease: $pre}' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
        mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json" ;;
      edit)
        # Record the mutation with the notes CONTENT (when a file is given),
        # then apply it to the state file so a later view sees the edit.
        notes_content=""
        if [ -n "$notes" ] && [ -f "$notes" ]; then notes_content="$(cat "$notes")"; fi
        printf 'edit target=%s title=%s prerelease=%s latest=%s notes=%s\n' "$tag" "$title" "$prerelease" "$latest" "$notes_content" >> "$SANDBOX/mutations.log"
        if [ -n "$tag" ]; then
          new_title="$title"
          if jq -e --arg t "$tag" 'has($t)' "$SANDBOX/releases.json" >/dev/null 2>&1; then
            if [ "$latest" = "1" ]; then
              jq --arg t "$tag" '.[$t].isLatest = true' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
              mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json"
            fi
            if [ -n "$notes_content" ] || { [ "$new_title" != "null" ] && [ -n "$new_title" ]; }; then
              jq --arg t "$tag" --arg n "$new_title" '.[$t].name = $n' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
              mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json"
            fi
          fi
        fi ;;
    esac ;;
  *) echo "unexpected gh subcommand: $sub" >&2; exit 1 ;;
esac
`;

function writeFakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  return bin;
}

function sandbox({ runs = [], releases = {}, changelog = CHANGELOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-publish-"));
  const bin = writeFakeGh(dir);
  // The checkout the script runs in (cwd): the changelog at its repo path.
  fs.mkdirSync(path.join(dir, "docs/myrmidon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), changelog);
  fs.writeFileSync(path.join(dir, "ref-tag.json"),
    JSON.stringify({ object: { sha: TAG_OBJECT, type: "tag" } }));
  fs.writeFileSync(path.join(dir, "tag-object.json"),
    JSON.stringify({ object: { sha: COMMIT, type: "commit" } }));
  fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify(releases));
  // Offline digest simulation for release-body.mjs (the same state shape the
  // real registry probe answers): every component present by default.
  const registryState = {};
  for (const { repository } of COMPONENTS) registryState[repository] = `sha256:${repository.length}${"d".repeat(63)}`;
  fs.writeFileSync(path.join(dir, "registry-state.json"), JSON.stringify(registryState));
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "mutations.log"), "");
  return { dir, bin };
}

// head_branch mirrors the GitHub API: for a push of tag myr-vX.Y.Z the runs
// started by that push report head_branch = the tag; runs of the same commit
// pushed to main earlier report head_branch = "main".
const run = (sha, pathOfWf, conclusion, status = "completed", headBranch = "myr-v1.6.0") => ({
  head_sha: sha, path: pathOfWf, status, conclusion, head_branch: headBranch,
});

function runScript(sb, tag, { extraEnv = {} } = {}) {
  const result = spawnSync("bash", [SCRIPT, "--tag", tag], {
    cwd: sb.dir,
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      SANDBOX: sb.dir,
      GITHUB_REPOSITORY: REPO,
      // offline digest simulation + fast gate polls (the defaults are sized
      // for CI; the tests must not sleep 20 s per poll)
      MYRMIDON_RELEASE_REGISTRY_STATE: path.join(sb.dir, "registry-state.json"),
      MYRMIDON_RELEASE_POLL_SECONDS: "0",
      MYRMIDON_RELEASE_POLL_MAX: "4",
      // RELEASE-PUBLISH-WAIT: the fake gh's runs-state switch (absent fixtures never read
      // it; 0 = the first runs read already answers "after")
      GH_RUNS_SWITCH_AFTER: "0",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  // A spawn that never ran (bash missing, ENOBUFS, a kill) leaves stdout and
  // stderr undefined; without this the assertions saw "undefinedundefined"
  // instead of the real reason. Surface the spawn error itself.
  if (result.error) throw new Error(`publish-github-release.sh did not run: ${result.error.message}`);
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const mutations = (sb) => read(path.join(sb.dir, "mutations.log"));

const GREEN_RUNS = [
  run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-dockergate.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-fleetd.yml", "success"),
];

describe("publish-github-release.sh: the CI gate", () => {
  it("refuses to publish when Myrmidon CI (tag) failed for the tag commit", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "failure"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon CI \(tag\) did not succeed/);
    assert.match(out, /NOT publishing/);
    assert.equal(mutations(sb), "", "no release mutation happened");
  });

  it("refuses to publish when the board image workflow failed", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "failure"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon image \(board\) did not succeed/);
    assert.equal(mutations(sb), "", "no release mutation happened");
  });

  it("refuses to publish when a required run is missing entirely", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /no run of Myrmidon CI \(tag\) found/);
    assert.equal(mutations(sb), "");
  });

  it("publishes when dockergate/fleetd have no run (paths-filtered), but not when they failed", () => {
    // absent: fine
    const sbOk = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const ok = runScript(sbOk, "myr-v1.6.0");
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /no run of Myrmidon dockergate image for .+\(paths-filtered\) — accepted/);
    assert.match(ok.out, /no run of Myrmidon fleetd image for .+\(paths-filtered\) — accepted/);
    assert.match(mutations(sbOk), /create tag=myr-v1\.6\.0/);

    // failed: refuse
    const sbBad = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-fleetd.yml", "failure"),
    ] });
    const bad = runScript(sbBad, "myr-v1.6.0");
    assert.notEqual(bad.code, 0, bad.out);
    assert.match(bad.out, /Myrmidon fleetd image failed/);
    assert.equal(mutations(sbBad), "");
  });

  it("treats a mixed conclusion (a failed attempt among re-runs) as failure", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "failure"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon CI \(tag\) did not succeed.*mixed/);
    assert.equal(mutations(sb), "");
  });

  // ---- RELEASE-PUBLISH-WAIT: the gate must wait for the TAG's runs, not the commit's ----

  it("waits for the board image run of the tag while it is still building, then publishes (the 1.6.1 incident)", () => {
    // The exact shape of 2026-10-04 04:40: the release commit was on main
    // (its CI + image runs completed green by 04:31, but those are
    // head_branch=main runs that build the `main`/`sha-` tags), the tag push
    // at 04:40 started the tag's own image run (head_branch=myr-v1.6.1),
    // which was still in progress. The old gate matched by head_sha only,
    // saw the green main run, skipped the wait and the digest probe failed.
    const before = [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", null, "in_progress"),
    ];
    const after = [
      before[0],
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ];
    const sb = sandbox({ runs: before });
    fs.writeFileSync(path.join(sb.dir, "runs-after.json"),
      JSON.stringify({ total_count: after.length, workflow_runs: after }));
    const { code, out } = runScript(sb, "myr-v1.6.0", { extraEnv: { GH_RUNS_SWITCH_AFTER: "2" } });
    assert.equal(code, 0, out);
    // the wait actually happened: the gate polled before the switch
    assert.match(out, /gate: Myrmidon image \(board\) success/);
    assert.match(mutations(sb), /create tag=myr-v1\.6\.0/);
  });

  it("refuses with the tag's failure when the main-branch run of the same commit is green", () => {
    // Same layout, but the TAG's image run completed with a failure: the
    // refusal must name the tag run, not be masked by the green main run.
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success", "completed", "main"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "failure"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon image \(board\) did not succeed for commit/);
    assert.match(out, /NOT publishing/);
    assert.equal(mutations(sb), "");
  });

  // ---- TAG-CI (the 1.6.4 incident): the tag's own run is the ONLY source of green ----

  it("CI gate no longer accepts the same-commit main run: the publish green comes from the tag's own run only", () => {
    // 1.6.4 shape: the release commit's main-branch runs are green, but the
    // tag has no CI run of its own yet (myrmidon-ci-tag.yml still starting).
    // The old gate passed CI on the main run; the new gate waits for the
    // TAG run and refuses when it never completes.
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success", "completed", "main"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /no run of Myrmidon CI \(tag\) found|timed out waiting for Myrmidon CI \(tag\)/);
    assert.equal(mutations(sb), "");
  });

  it("publishes when the tag's own CI run is green even with no main-branch run at all", () => {
    // The inverse of the old main-fallback test: a green tag run is
    // sufficient by itself — the gate never looks at main.
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    assert.match(out, /gate: Myrmidon CI \(tag\) success/);
    assert.match(mutations(sb), /create tag=myr-v1\.6\.0/);
  });

  it("refuses to publish when the tag CI run was cancelled (the 1.6.4 shape)", () => {
    // The exact incident: main's concurrency-cancel cancelled the CI run of
    // the tag's commit; the publish must refuse LOUDLY (naming the cancelled
    // run and the workflow_dispatch recovery), not time out waiting.
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "cancelled"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon CI \(tag\) has a CANCELLED run/);
    assert.match(out, /NOT publishing/);
    assert.match(out, /workflow_dispatch/);
    assert.equal(mutations(sb), "");
  });

  it("accepts an -rc.N tag through the same tag-scoped gate", () => {
    // RC releases (myr-v1.6.5-rc.1) take the same tag-scoped gate: the CI
    // runs are matched by head_branch == the RC tag. (The body builder is
    // X.Y.Z-scoped today; the RC publish path belongs to the RC task — this
    // test pins the GATE side only.)
    const rcTag = "myr-v1.6.0-rc.1";
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success", "completed", rcTag),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success", "completed", rcTag),
    ] });
    const { code, out } = runScript(sb, rcTag);
    assert.match(out, /gate: Myrmidon CI \(tag\) success/);
    assert.match(out, /gate: Myrmidon image \(board\) success/);
  });

  it("still refuses a tag that does not look like myr-vX.Y.Z[-rc.N]", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "main");
    assert.notEqual(code, 0, out);
    assert.match(out, /tag must look like myr-vX\.Y\.Z/);
    assert.equal(mutations(sb), "");
  });
});

describe("publish-github-release.sh: the release body and mutations", () => {
  it("fails loudly when the CHANGELOG section is missing", () => {
    const sb = sandbox({ runs: GREEN_RUNS, changelog: "# Myrmidon changelog\n\n## 1.5.0\n\n- Old thing.\n" });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /no "## 1\.6\.0" section/i);
    assert.equal(mutations(sb), "");
  });

  it("creates the release with the CHANGELOG section and marks the previous superseded", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: { "myr-v1.5.0": { name: "Myrmidon 1.5.0", body: "old body" } },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /create tag=myr-v1\.6\.0 title=Myrmidon 1\.6\.0 prerelease=0 latest=0 notes=.*New thing A\./s);
    assert.match(mut, /edit target=myr-v1\.5\.0 title=Myrmidon 1\.5\.0 \(superseded\)/);
    assert.match(mut, /check-release-support\.sh --from-tag 1\.6\.0/);
  });

  // RC-VERSIONS: a publish NEVER moves the `latest` marker — not for a final
  // tag, not for an rc. The marker moves only via promote-latest.sh.
  it("never publishes with --latest (the marker is the promote step's, not the publish's)", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /create tag=myr-v1\.6\.0 .* latest=0/);
    assert.doesNotMatch(mut, /latest=1/);
    assert.match(out, /never --latest/);
  });

  it("is idempotent: an existing release is edited, not duplicated; an already-superseded previous is not renamed again", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: {
        "myr-v1.6.0": { name: "Myrmidon 1.6.0", body: "stale body" },
        "myr-v1.5.0": { name: "Myrmidon 1.5.0 (superseded)", body: "old" },
      },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /edit target=myr-v1\.6\.0 title=Myrmidon 1\.6\.0 prerelease=0 latest=0 notes=Myrmidon 1\.6\.0 replaces/s);
    assert.doesNotMatch(mut, /create tag=/);
    // previous already carries the marker: the edit for 1.5.0 must NOT appear
    assert.doesNotMatch(mut, /edit target=myr-v1\.5\.0/);
  });
});

// RC-VERSIONS (owner requirement, 05.10): the release-candidate publish.
describe("publish-github-release.sh: release candidates (RC-VERSIONS)", () => {
  it("publishes an rc as a PRE-RELEASE with the rc title, the base version's notes and the rc's digests — and supersedes nothing", () => {
    const rcRuns = [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success", "completed", "myr-v1.6.0-rc.1"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success", "completed", "myr-v1.6.0-rc.1"),
    ];
    const sb = sandbox({
      runs: rcRuns,
      releases: { "myr-v1.5.0": { name: "Myrmidon 1.5.0", body: "old body" } },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0-rc.1");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    // pre-release, never latest, the (RC 1) title
    assert.match(mut, /create tag=myr-v1\.6\.0-rc\.1 title=Myrmidon 1\.6\.0-rc\.1 \(RC 1\) prerelease=1 latest=0/s);
    // the notes are the BASE version's changelog section
    assert.match(mut, /notes=.*New thing A\./s);
    // the digest table and manifest probe the RC's image tags
    assert.match(mut, /check-release-support\.sh --from-tag 1\.6\.0-rc\.1/);
    const upload = /upload tag=myr-v1\.6\.0-rc\.1 manifest=(.*)/.exec(mut);
    assert.ok(upload, "the manifest asset was uploaded");
    const manifest = JSON.parse(upload[1]);
    assert.equal(manifest.version, "1.6.0-rc.1");
    assert.equal(manifest.tag, "myr-v1.6.0-rc.1");
    // an rc supersedes nothing
    assert.doesNotMatch(mut, /superseded/);
    assert.match(out, /no supersede/);
  });

  it("the rc body carries the trial-run header pointing at the final tag and promote-latest.sh", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci-tag.yml", "success", "completed", "myr-v1.6.0-rc.1"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success", "completed", "myr-v1.6.0-rc.1"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0-rc.1");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /Release candidate 1 of 1\.6\.0/);
    assert.match(mut, /promote-latest\.sh/);
  });

  it("a final publish does not supersede the rc of its own version line", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: {
        "myr-v1.5.0": { name: "Myrmidon 1.5.0 (superseded)", body: "old" },
        "myr-v1.5.0-rc.1": { name: "Myrmidon 1.5.0-rc.1 (RC 1)", body: "rc body" },
      },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    // 1.5.0 is already superseded; the rc title must stay untouched
    assert.doesNotMatch(mut, /edit target=myr-v1\.5\.0/);
    assert.doesNotMatch(mut, /edit target=myr-v1\.5\.0-rc\.1/);
  });

  it("a final publish supersedes the previous final, not its rc", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: {
        "myr-v1.5.0": { name: "Myrmidon 1.5.0", body: "old" },
        "myr-v1.5.0-rc.2": { name: "Myrmidon 1.5.0-rc.2 (RC 2)", body: "rc body" },
      },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /edit target=myr-v1\.5\.0 title=Myrmidon 1\.5\.0 \(superseded\)/);
    assert.doesNotMatch(mut, /edit target=myr-v1\.5\.0-rc\.2/);
  });

  it("refuses a tag that is neither a final nor an rc tag", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "myr-v1.6.0-rc1");
    assert.notEqual(code, 0, out);
    assert.match(out, /tag must look like myr-vX\.Y\.Z or myr-vX\.Y\.Z-rc\.N/);
    assert.equal(mutations(sb), "");
  });
});

// RC-VERSIONS: promote-latest.sh — the ONLY step that moves the `latest`
// marker, and only with proof the board runs exactly this version.
describe("promote-latest.sh: latest only after the board runs it (RC-VERSIONS)", () => {
  const PROMOTE = path.join(HERE, "promote-latest.sh");

  // The fake gh here needs the API endpoints promote-latest.sh reads; the
  // publish fake answers only /git/ref|/git/tags + release — good enough:
  // promote-latest.sh also reads /compare, so extend the fake inline.
  const FAKE_GH_PROMOTE = `#!/usr/bin/env bash
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    url=""; jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;;
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done
    case "$url" in
      *"/git/ref/tags/"*)
        if [ -f "$SANDBOX/ref-tag.json" ]; then body="$(cat "$SANDBOX/ref-tag.json")"; else echo "not found" >&2; exit 1; fi ;;
      *"/git/tags/"*) body="$(cat "$SANDBOX/tag-object.json")" ;;
      *"/compare/"*) body="$(cat "$SANDBOX/compare.json")" ;;
      *) body="{}" ;;
    esac
    if [ -n "$jq_filter" ]; then jq -r "$jq_filter" <<<"$body"; else printf '%s\\n' "$body"; fi ;;
  release)
    verb="$1"; shift
    tag=""; jq_filter=""; latest=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --latest) latest=1 ;;
        --json) shift ;;
        --jq) shift; jq_filter="$1" ;;
        --repo) shift ;;
        myr-v*) tag="$1" ;;
      esac
      shift
    done
    case "$verb" in
      view)
        if jq -e --arg t "$tag" 'has($t)' "$SANDBOX/releases.json" >/dev/null; then
          if [ -n "$jq_filter" ]; then
            jq -r --arg t "$tag" '.[$t] | '"$jq_filter" "$SANDBOX/releases.json"
          else
            jq --arg t "$tag" '{name: .[$t].name, isPrerelease: (.[$t].isPrerelease // false), isLatest: (.[$t].isLatest // false)}' "$SANDBOX/releases.json"
          fi
        else
          echo "release not found: $tag" >&2; exit 1
        fi ;;
      edit)
        printf 'edit target=%s latest=%s\\n' "$tag" "$latest" >> "$SANDBOX/mutations.log"
        if [ "$latest" = "1" ]; then
          jq --arg t "$tag" '.[$t].isLatest = true' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
          mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json"
        fi ;;
    esac ;;
  *) echo "unexpected gh subcommand: $sub" >&2; exit 1 ;;
esac`;

  const FAKE_CURL = `#!/usr/bin/env bash
# fake curl: answers the board health URL from $SANDBOX/health.json
echo "curl $*" >> "$SANDBOX/calls.log"
cat "$SANDBOX/health.json"`;

  function promoteSandbox({ releases = {}, compare = { status: "identical", ahead_by: 0 }, health = { status: "ok", version: "1.6.0", commit: COMMIT } } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-promote-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "gh"), FAKE_GH_PROMOTE, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify(releases));
    fs.writeFileSync(path.join(dir, "compare.json"), JSON.stringify(compare));
    fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health));
    fs.writeFileSync(path.join(dir, "ref-tag.json"), JSON.stringify({ object: { sha: TAG_OBJECT, type: "tag" } }));
    fs.writeFileSync(path.join(dir, "tag-object.json"), JSON.stringify({ object: { sha: COMMIT, type: "commit" } }));
    fs.writeFileSync(path.join(dir, "calls.log"), "");
    fs.writeFileSync(path.join(dir, "mutations.log"), "");
    return { dir, bin };
  }

  function runPromote(sb, args) {
    const result = spawnSync("bash", [PROMOTE, ...args], {
      cwd: sb.dir,
      env: {
        ...process.env,
        PATH: `${sb.bin}:${process.env.PATH}`,
        SANDBOX: sb.dir,
        GITHUB_REPOSITORY: REPO,
      },
      encoding: "utf8",
    });
    if (result.error) throw new Error(`promote-latest.sh did not run: ${result.error.message}`);
    return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  const FINAL_RELEASE = { "myr-v1.6.0": { name: "Myrmidon 1.6.0", isPrerelease: false, isLatest: false } };

  it("marks the release Latest when the board runs exactly this version", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.equal(code, 0, out);
    assert.match(mutations(sb), /edit target=myr-v1\.6\.0 latest=1/);
    assert.match(out, /now the Latest release/);
  });

  it("refuses when the production board runs another version", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE, health: { status: "ok", version: "1.5.0", commit: COMMIT } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /board runs version 1\.5\.0, not 1\.6\.0/);
    assert.equal(mutations(sb), "", "the marker must not move");
  });

  it("refuses a release candidate tag (an rc is the trial run, never Latest)", () => {
    const sb = promoteSandbox({ releases: { "myr-v1.6.0-rc.1": { name: "Myrmidon 1.6.0-rc.1 (RC 1)", isPrerelease: true } } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0-rc.1", "--health-url", "http://board/api/health"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /only a final release tag/);
    assert.equal(mutations(sb), "");
  });

  it("refuses a pre-release release object", () => {
    const sb = promoteSandbox({ releases: { "myr-v1.6.0": { name: "Myrmidon 1.6.0", isPrerelease: true } } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /is a pre-release/);
    assert.equal(mutations(sb), "");
  });

  it("refuses when the release commit is not on main", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE, compare: { status: "ahead", ahead_by: 2 } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /not on main/);
    assert.equal(mutations(sb), "");
  });

  it("is idempotent: a release that is already Latest is left alone", () => {
    const sb = promoteSandbox({ releases: { "myr-v1.6.0": { name: "Myrmidon 1.6.0", isPrerelease: false, isLatest: true } } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.equal(code, 0, out);
    assert.match(out, /already Latest/);
    assert.equal(mutations(sb), "");
  });

  it("refuses without a board health URL (no proof, no promotion)", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE });
    const env = { ...process.env };
    delete env.MYRMIDON_PROD_HEALTH_URL; delete env.HEALTH_URL; delete env.MYRMIDON_PROD_HEALTH_TOKEN_FILE; delete env.HEALTH_TOKEN_FILE;
    const result = spawnSync("bash", [PROMOTE, "--tag", "myr-v1.6.0"], {
      cwd: sb.dir,
      env: { ...env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir, GITHUB_REPOSITORY: REPO },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no production board health URL/);
    assert.equal(mutations(sb), "");
  });

  it("sends the board API key as ONE Authorization: Bearer header (token trimmed), and none without a token file", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE });
    const tokenFile = path.join(sb.dir, "token");
    fs.writeFileSync(tokenFile, "  abc123\n");
    const withToken = runPromote(sb, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health", "--health-token-file", tokenFile]);
    assert.equal(withToken.code, 0, withToken.out);
    assert.match(read(path.join(sb.dir, "calls.log")), /^curl -fsS --max-time 30 -H Authorization: Bearer abc123 http:\/\/board\/api\/health$/m);

    const sb2 = promoteSandbox({ releases: FINAL_RELEASE });
    const noToken = runPromote(sb2, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health"]);
    assert.equal(noToken.code, 0, noToken.out);
    assert.doesNotMatch(read(path.join(sb2.dir, "calls.log")), /Authorization/);

    const sb3 = promoteSandbox({ releases: FINAL_RELEASE });
    const empty = path.join(sb3.dir, "empty");
    fs.writeFileSync(empty, "\n");
    const bad = runPromote(sb3, ["--tag", "myr-v1.6.0", "--health-url", "http://board/api/health", "--health-token-file", empty]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /token file is empty/);
    assert.equal(mutations(sb3), "");
  });

  it("--skip-health-check moves the marker with a loud warning (rehearsed promotions only)", () => {
    const sb = promoteSandbox({ releases: FINAL_RELEASE, health: { status: "ok", version: "9.9.9", commit: COMMIT } });
    const { code, out } = runPromote(sb, ["--tag", "myr-v1.6.0", "--skip-health-check"]);
    assert.equal(code, 0, out);
    assert.match(out, /WARNING: --skip-health-check/);
    assert.match(mutations(sb), /edit target=myr-v1\.6\.0 latest=1/);
  });
});

// RELEASE-PUBLISH-WAIT: the workflow must prefer the typed tag input over ref_name. A
// workflow_dispatch from a branch sets github.ref_name to that branch
// (e.g. "main"); with "ref_name || inputs.tag" the typed tag was overridden
// and the publish died with "tag must look like myr-vX.Y.Z (got: main)".
describe("myrmidon-release.yml: the tag input wins over ref_name", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const WORKFLOW = path.join(HERE, "..", "..", "..", ".github", "workflows", "myrmidon-release.yml");
  const workflow = fs.readFileSync(WORKFLOW, "utf8");

  it("every tag reference resolves the workflow_dispatch input first", () => {
    const tagRefs = [...workflow.matchAll(/\$\{\{ ([^}]+) \}\}/g)]
      .map((m) => m[1])
      .filter((expr) => expr.includes("inputs.tag") || expr.includes("github.ref_name"));
    assert.ok(tagRefs.length >= 3, "checkout ref, TAG env and the concurrency group all use the tag");
    for (const expr of tagRefs) {
      assert.equal(
        expr, "inputs.tag || github.ref_name",
        `the tag expression must be "inputs.tag || github.ref_name" (got: "${expr}") — a workflow_dispatch from a branch must not override the typed tag`,
      );
    }
    assert.doesNotMatch(workflow, /github\.ref_name \|\| inputs\.tag/);
  });

  it("declares the tag input as required", () => {
    assert.match(workflow, /tag:\s*\n\s+description:[^\n]+\n\s+required: true/);
  });
});

// TAG-CI (the 1.6.4 incident): the tag has its own un-cancellable CI run
// and the publish gate takes its green from it alone.
describe("myrmidon-ci-tag.yml: the tag CI is a separate un-cancellable run", () => {
  const TAG_WORKFLOW = path.join(HERE, "..", "..", "..", ".github", "workflows", "myrmidon-ci-tag.yml");
  const workflow = fs.readFileSync(TAG_WORKFLOW, "utf8");

  it("triggers on release tags (including -rc.N) and workflow_dispatch", () => {
    assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- "myr-v\*\.\*\.\*"/);
    assert.match(workflow, /workflow_dispatch:/);
  });

  it("has its own concurrency group keyed by the tag with cancel-in-progress: false", () => {
    assert.match(workflow, /group: myrmidon-ci-tag-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
    assert.match(workflow, /cancel-in-progress: false/);
    // A main push must never share the group: the group expression carries
    // no pull_request number / branch ref from the main CI.
    assert.doesNotMatch(workflow, /group: myrmidon-ci-\$\{\{ github\.event/);
  });

  it("keeps the full-tier lanes of myrmidon-ci.yml (typecheck, build, tests, checks, dockergate, fleetd)", () => {
    for (const lane of ["typecheck:", "build:", "tests:", "tests-other:", "tests-runner:", "checks:", "fleetd:", "dockergate:", "ci-result:"]) {
      assert.match(workflow, new RegExp(`^  ${lane}`, "m"), `lane ${lane} missing`);
    }
    // every lane is mandatory for the result: nothing may skip
    assert.match(workflow, /all\(to_entries\[\]; \.value\.result == "success"\)/);
  });

  it("workflow_dispatch checks out the typed tag (the 1.6.4 manual re-run path)", () => {
    const checkouts = [...workflow.matchAll(/ref: \$\{\{ ([^}]+) \}\}/g)].map((m) => m[1]);
    assert.ok(checkouts.length >= 3, "every lane's checkout resolves the tag");
    for (const expr of new Set(checkouts)) {
      assert.equal(expr, "inputs.tag || ''");
    }
  });
});

describe("publish-github-release.sh: the gate takes its green from the tag CI workflow", () => {
  it("waits on myrmidon-ci-tag.yml, not myrmidon-ci.yml", () => {
    assert.match(SCRIPT_TEXT, /wait_for "\.github\/workflows\/myrmidon-ci-tag\.yml" must "Myrmidon CI \(tag\)"/);
    assert.doesNotMatch(SCRIPT_TEXT, /wait_for "\.github\/workflows\/myrmidon-ci\.yml"/);
  });

  it("refuses a cancelled tag CI run before waiting", () => {
    assert.match(SCRIPT_TEXT, /refuse_if_cancelled "\.github\/workflows\/myrmidon-ci-tag\.yml"/);
    assert.match(SCRIPT_TEXT, /CANCELLED run/);
  });

  it("never matches main-branch runs (no main fallback in the run selectors)", () => {
    assert.doesNotMatch(SCRIPT_TEXT, /branch_match_expr "\$tag" main/);
  });

  it("accepts -rc.N tags", () => {
    assert.match(SCRIPT_TEXT, /\^myr-v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\(-rc\\\.\(\[0-9\]\+\)\)\?\$/);
  });
});

describe("release-body.mjs: body construction", () => {

  it("extracts the X.Y.Z section and stops at the next heading", () => {
    const section = extractChangelogSection(CHANGELOG, "1.5.0");
    assert.equal(section, "- Old thing.");
    const section6 = extractChangelogSection(CHANGELOG, "1.6.0");
    assert.match(section6, /New thing A\./);
    assert.doesNotMatch(section6, /Old thing/);
  });

  it("returns null for a missing section and for an empty one", () => {
    assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
    assert.equal(extractChangelogSection("## 1.6.0\n\n## 1.5.0\n", "1.6.0"), null);
  });

  it("derives the superseded version (patch, minor, floor)", () => {
    assert.equal(previousMinorPatch("1.5.2"), "1.5.1");
    assert.equal(previousMinorPatch("1.5.0"), "1.4.0");
    assert.equal(previousMinorPatch("1.6.0"), "1.5.0");
    assert.equal(previousMinorPatch("2.0.0"), null);
  });

  it("builds the body: deploy line with the upgrade anchor, notes, digest table", () => {
    const a64 = "a".repeat(64);
    const b64 = "b".repeat(64);
    const body = buildBody({
      version: "1.6.0",
      previous: "1.5.0",
      section: "- New thing A.",
      digestRows: [
        `| board | \`ghcr.io/itkadr-git/myrmidon@sha256:${a64}\` |`,
        `| bot | \`ghcr.io/itkadr-git/myrmidon-hermes@sha256:${b64}\` |`,
      ],
    });
    assert.match(body, /Myrmidon 1\.6\.0 replaces 1\.5\.0\./);
    assert.match(body, /Deploy the board, the release component images \(dockergate, fleetd\) and the bot images from this tag together/);
    assert.match(body, /"Upgrading from 1\.5\.0 to 1\.6\.0"/);
    assert.match(body, /docs\/myrmidon\/deploy\.md/);
    assert.match(body, /- New thing A\./);
    assert.match(body, /## Component images \(digests\)/);
    assert.match(body, /board \| `ghcr\.io\/itkadr-git\/myrmidon@sha256:a{64}`/);
    assert.match(body, /check-release-support\.sh --from-tag 1\.6\.0/);
    // no private addresses, no token-shaped strings
    assert.doesNotMatch(body, /(?<!\d)(?:10|192|172)\.\d+\.\d+\.\d+(?!\d)/);
  });
});

describe("release-body.mjs: digest resolution (injected fetch)", () => {

  const registryFetch = (digests) => async (url, init) => {
    if (url.startsWith("https://ghcr.io/token")) {
      return { ok: true, json: async () => ({ token: "anonymous" }) };
    }
    const repo = /\/v2\/itkadr-git\/([^/]+)\//.exec(url)[1];
    const digest = digests[repo];
    if (!digest) return { ok: false };
    return {
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "docker-content-digest" ? digest : null) },
    };
  };

  it("resolves every component digest, one anonymous token per repository", () => {
    const tokenUrls = [];
    const fetchImpl = async (url, init) => {
      if (url.startsWith("https://ghcr.io/token")) {
        tokenUrls.push(url);
        return { ok: true, json: async () => ({ token: "anonymous" }) };
      }
      const repo = /\/v2\/itkadr-git\/([^/]+)\//.exec(url)[1];
      return {
        ok: true,
        headers: { get: () => `sha256:${repo.length}${"c".repeat(63)}` },
      };
    };
    return componentDigests("1.6.0", { fetchImpl }).then(({ rows, missing }) => {
      assert.deepEqual(missing, []);
      // 4 required components plus the 2 optional bot variants (hermes-dev, hermes-node)
      assert.equal(rows.length, 6);
      assert.match(rows[0], /board/);
      assert.match(rows.join("\n"), /hermes-dev/);
      // one token request per repository (6 scopes)
      assert.equal(tokenUrls.length, 6);
    });
  });

  it("reports the missing components instead of publishing partial digests", () => {
    const fetchImpl = registryFetch({ myrmidon: "sha256:x", "myrmidon-hermes": "sha256:y" });
    return componentDigests("1.6.0", { fetchImpl }).then(({ rows, missing }) => {
      assert.deepEqual(missing, ["dockergate", "fleetd"]);
      assert.equal(rows.length, 2);
    });
  });

  it("a registry error resolves to null (fail-closed), not a crash", () => {
    const fetchImpl = async () => { throw new Error("network down"); };
    return componentDigest("myrmidon", "1.6.0", { fetchImpl }).then((d) => {
      assert.equal(d, null);
    });
  });
});

describe("release manifest (release-components.json)", () => {
  it("buildManifest names every component by repository and digest, the bot image as hermes", () => {
    const digests = {
      board: { repository: "ghcr.io/itkadr-git/myrmidon", digest: `sha256:${"1".repeat(64)}` },
      bot: { repository: "ghcr.io/itkadr-git/myrmidon-hermes", digest: `sha256:${"2".repeat(64)}` },
      "hermes-dev": { repository: "ghcr.io/itkadr-git/myrmidon-hermes-dev", digest: `sha256:${"3".repeat(64)}` },
    };
    const manifest = buildManifest({ version: "1.6.2", digests });
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.tag, "myr-v1.6.2");
    assert.deepEqual(Object.keys(manifest.components).sort(), ["board", "hermes", "hermes-dev"]);
    assert.equal(manifest.components.hermes.digest, `sha256:${"2".repeat(64)}`);
    assert.equal(MANIFEST_NAME, "release-components.json");
  });

  it("an optional bot variant missing from the registry does not refuse the release", () => {
    const state = {
      myrmidon: "sha256:a", "myrmidon-dockergate": "sha256:b", "myrmidon-fleetd": "sha256:c", "myrmidon-hermes": "sha256:d",
    };
    return componentDigests("1.6.2", { registryState: state }).then(({ missing, digests }) => {
      assert.deepEqual(missing, []);
      assert.deepEqual(Object.keys(digests).sort(), ["board", "bot", "dockergate", "fleetd"]);
    });
  });

  it("publish uploads the manifest asset next to the release body", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const log = mutations(sb);
    assert.match(log, /create tag=myr-v1\.6\.0/);
    const upload = /upload tag=myr-v1\.6\.0 manifest=(.*)/.exec(log);
    assert.ok(upload, "the manifest asset was uploaded");
    const manifest = JSON.parse(upload[1]);
    assert.equal(manifest.version, "1.6.0");
    assert.deepEqual(Object.keys(manifest.components).sort(), ["board", "dockergate", "fleetd", "hermes"]);
    assert.match(manifest.components.dockergate.digest, /^sha256:/);
  });
});

// VENDOR-SHARE-METRIC (1.6.5): the publisher appends the vendor-derived share
// and its delta to the previous release to the notes. The current share comes
// from MYRMIDON_RELEASE_VENDOR_SHARE_STATE (the offline seam next to
// MYRMIDON_RELEASE_REGISTRY_STATE) and the previous numbers from
// MYRMIDON_RELEASE_PREVIOUS_BODY (the previous release's own notes). A metric
// failure must never break a publish: the section then reads «не посчитано»
// and the release still goes out (OPE-4152 acceptance).
describe("publish-github-release.sh: the vendor-derived share in the notes", () => {
  const writeShareState = (sb, { inherited, totalFiles }) => {
    const file = path.join(sb.dir, "vendor-share-state.json");
    fs.writeFileSync(file, JSON.stringify({
      summary: { inherited, totalFiles, share: inherited / totalFiles },
    }));
    return file;
  };

  it("appends the share and the delta to the previous release", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const previousBody = path.join(sb.dir, "previous-body.md");
    fs.writeFileSync(previousBody, "Vendor-derived files: 6116 of 6812 (89.78%)\n");
    const { code, out } = runScript(sb, "myr-v1.6.0", { extraEnv: {
      MYRMIDON_RELEASE_VENDOR_SHARE_STATE: writeShareState(sb, { inherited: 6123, totalFiles: 6812 }),
      MYRMIDON_RELEASE_PREVIOUS_BODY: previousBody,
    } });
    assert.equal(code, 0, out);
    assert.match(out, /vendor-share section: Vendor-derived files: 6123 of 6812 \(89\.89%\)/);
    const log = mutations(sb);
    assert.match(log, /create tag=myr-v1\.6\.0/);
    assert.match(log, /## Vendor-derived files/);
    assert.match(log, /Vendor-derived files: 6123 of 6812 \(89\.89%\), Δ to myr-v1\.5\.0: \+0\.10 pp \(\+7 files\)/);
    // the metric is additive: the CHANGELOG section is still in the body
    assert.match(log, /New thing A\./);
  });

  it("says 'нет данных' when the previous release carries no share line", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const previousBody = path.join(sb.dir, "previous-body.md");
    fs.writeFileSync(previousBody, "## What's changed\n\n- nothing about vendor files\n");
    const { code, out } = runScript(sb, "myr-v1.6.0", { extraEnv: {
      MYRMIDON_RELEASE_VENDOR_SHARE_STATE: writeShareState(sb, { inherited: 6123, totalFiles: 6812 }),
      MYRMIDON_RELEASE_PREVIOUS_BODY: previousBody,
    } });
    assert.equal(code, 0, out);
    assert.match(mutations(sb), /Δ to myr-v1\.5\.0: нет данных \(no vendor-share line in that release\)/);
  });

  it("publishes «не посчитано» instead of failing when the share cannot be computed", () => {
    const sb = sandbox({ runs: GREEN_RUNS });
    const { code, out } = runScript(sb, "myr-v1.6.0", { extraEnv: {
      MYRMIDON_RELEASE_VENDOR_SHARE_STATE: path.join(sb.dir, "absent.json"),
    } });
    assert.equal(code, 0, "a metric failure never breaks the publish");
    assert.match(out, /vendor-share metric not computed/);
    const log = mutations(sb);
    assert.match(log, /create tag=myr-v1\.6\.0/);
    assert.match(log, /## Vendor-derived files\s*\n\s*не посчитано/);
  });
});
