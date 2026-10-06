// scripts/myrmidon/release/release-body.mjs
//
// RELEASE-PUBLISH (the 02.10 gap): assembles the GitHub Release body for a
// myr-vX.Y.Z (or, RC-VERSIONS, a myr-vX.Y.Z-rc.N) tag. Called by
// publish-github-release.sh; also a module for tests. Node built-ins only;
// the registry probe takes an injectable fetch so the tests never touch the
// network.
//
// CLI: node release-body.mjs [--notes-version X.Y.Z] <X.Y.Z[-rc.N]>
//   Reads docs/myrmidon/CHANGELOG.md from the working directory, resolves
//   the component digests of the release tag (an rc probes the registry with
//   its own X.Y.Z-rc.N image tags), prints the body to stdout. The notes
//   come from the `## X.Y.Z` changelog section of the base version — the
//   final myr-vX.Y.Z tag of the same commit publishes the same section (the
//   rc IS its trial run), so an rc needs no `## X.Y.Z-rc.N` section.
//   Exit 1 with a reason on stderr when the CHANGELOG section or a digest
//   is missing (a release without notes or without its images is a defect).

import fs from "node:fs";
import process from "node:process";

export const COMPONENTS = [
  { label: "board", repository: "myrmidon" },
  { label: "dockergate", repository: "myrmidon-dockergate" },
  { label: "fleetd", repository: "myrmidon-fleetd" },
  { label: "bot", repository: "myrmidon-hermes" },
];

// Bot image variants: published by the same bot image workflow, but a release
// may legitimately lack one (a variant that did not change is not rebuilt), so
// they are listed when present and never refuse the publish.
export const OPTIONAL_COMPONENTS = [
  { label: "hermes-dev", repository: "myrmidon-hermes-dev" },
  { label: "hermes-node", repository: "myrmidon-hermes-node" },
];

/** The machine-readable manifest asset of a release (read by deploy/release-manifest.sh). */
export const MANIFEST_NAME = "release-components.json";

/** The manifest key of a table label: the `bot` row is the default bot image. */
const MANIFEST_KEY = { bot: "hermes" };

// RC-VERSIONS: a release version is X.Y.Z or the release candidate X.Y.Z-rc.N.
export const VERSION_RE = /^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/;

/** The base version of a release version: X.Y.Z of X.Y.Z or of X.Y.Z-rc.N. */
export function baseOf(version) {
  const match = VERSION_RE.exec(version);
  return match ? match[1] : null;
}

/** The rc number of a release candidate (X.Y.Z-rc.N -> N), or null. */
export function rcOf(version) {
  const match = VERSION_RE.exec(version);
  return match && match[2] ? Number(match[2]) : null;
}

/** The X.Y.Z a release supersedes: patch>0 -> X.Y.(Z-1), else X.(Y-1).0, else null. */
export function previousMinorPatch(version) {
  const base = baseOf(version);
  if (!base) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  const [, major, minor, patch] = match.map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  return null;
}

/** The `## X.Y.Z` section of the changelog (without the heading), or null. */
export function extractChangelogSection(markdown, version) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  const section = out.join("\n").trim();
  return section.length > 0 ? section : null;
}

const MANIFEST_ACCEPT =
  "application/vnd.oci.image.index.v1+json, " +
  "application/vnd.docker.distribution.manifest.list.v2+json, " +
  "application/vnd.docker.distribution.manifest.v2+json";

/**
 * Resolves one component's index digest for the release version tag with the
 * read-only anonymous v2 API (the same probe as check-release-support.sh,
 * without a docker daemon). Returns null when the tag is not in the registry.
 * `registryState` (a repository -> digest map, from --registry-state) serves
 * the answer without the network — the offline simulation the tests use.
 */
export async function componentDigest(repository, version, { fetchImpl = fetch, registryState = null } = {}) {
  if (registryState) {
    // An offline simulation is authoritative: a repository it does not name is absent.
    return Object.prototype.hasOwnProperty.call(registryState, repository) ? (registryState[repository] ?? null) : null;
  }
  const scope = `repository:itkadr-git/${repository}:pull`;
  const tokenUrl = `https://ghcr.io/token?scope=${encodeURIComponent(scope)}`;
  try {
    const tokenResponse = await fetchImpl(tokenUrl);
    if (!tokenResponse.ok) return null;
    const { token } = await tokenResponse.json();
    const manifestResponse = await fetchImpl(
      `https://ghcr.io/v2/itkadr-git/${repository}/manifests/${version}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT } },
    );
    if (!manifestResponse.ok) return null;
    return manifestResponse.headers.get("docker-content-digest");
  } catch {
    return null;
  }
}

/** Digest table rows for every component; missing components are listed. */
export async function componentDigests(version, { fetchImpl = fetch, registryState = null } = {}) {
  const rows = [];
  const missing = [];
  const digests = {};
  for (const { label, repository } of COMPONENTS) {
    const digest = await componentDigest(repository, version, { fetchImpl, registryState });
    if (digest) {
      rows.push(`| ${label} | \`ghcr.io/itkadr-git/${repository}@${digest}\` |`);
      digests[label] = { repository: `ghcr.io/itkadr-git/${repository}`, digest };
    } else missing.push(label);
  }
  for (const { label, repository } of OPTIONAL_COMPONENTS) {
    const digest = await componentDigest(repository, version, { fetchImpl, registryState });
    if (digest) {
      rows.push(`| ${label} | \`ghcr.io/itkadr-git/${repository}@${digest}\` |`);
      digests[label] = { repository: `ghcr.io/itkadr-git/${repository}`, digest };
    }
  }
  return { rows, missing, digests };
}

/**
 * The release manifest: one JSON object naming every component image of the
 * release by digest. deploy.sh reads it (release-manifest.sh) so one deploy
 * updates the board, dockergate, fleetd and the bot images from the same
 * source of truth. Keys: board, dockergate, fleetd, hermes (the default bot
 * image) and, when the release has them, hermes-dev and hermes-node.
 */
export function buildManifest({ version, digests }) {
  const components = {};
  for (const [label, value] of Object.entries(digests)) {
    components[MANIFEST_KEY[label] ?? label] = value;
  }
  return { schema: 1, version, tag: `myr-v${version}`, components };
}

/** The complete release body: deploy line, notes, digest table, cross-check. */
export function buildBody({ version, notesVersion = null, previous, section, digestRows }) {
  const anchor = previous
    ? `, "Upgrading from ${previous} to ${version}"`
    : "";
  const replaces = previous ?? "<previous>";
  // RC-VERSIONS: an rc body opens with the trial-run line and a pointer at
  // the promote step; the final tag of the same commit re-publishes the
  // same notes section without it.
  const rc = rcOf(version);
  const notes = notesVersion ?? baseOf(version);
  const rcLine = rc
    ? [
        "**Release candidate " + rc + " of " + notes + ".** Trial run: deploy it to our production, verify (health, attention list, the fleet taking tasks, bot images), then cut the final `myr-v" + notes + "` on the same commit (no rebuild — the images are the ones below) and mark it Latest with `scripts/myrmidon/release/promote-latest.sh`.",
        "",
      ]
    : [];
  return [
    ...rcLine,
    `Myrmidon ${version} replaces ${replaces}. Deploy the board, the release component images (dockergate, fleetd) and the bot images from this tag together (one deploy: \`deploy.sh --release <tag>\`); see [docs/myrmidon/deploy.md](docs/myrmidon/deploy.md)${anchor}.`,
    "",
    section,
    "",
    "## Component images (digests)",
    "",
    "| Component | Image (digest) |",
    "|---|---|",
    ...digestRows,
    "",
    `Cross-check: \`scripts/myrmidon/dockergate/check-release-support.sh --from-tag ${version}\` prints the same dockergate and fleetd digests (run against the live registry). A release whose components are missing is refused by \`deploy.sh\` itself before anything changes.`,
    "",
  ].join("\n");
}

/** Reads the changelog from the repo checkout (working directory). */
export function readChangelog(root = process.cwd()) {
  return fs.readFileSync(`${root}/docs/myrmidon/CHANGELOG.md`, "utf8");
}

function parseArgs(argv) {
  const args = { version: null, notesVersion: null, registryStatePath: null, manifestOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--previous") {
      const version = argv[i + 1];
      if (!version || !VERSION_RE.test(version)) process.exit(2);
      const previous = previousMinorPatch(version);
      if (previous) process.stdout.write(previous);
      process.exit(0);
    }
    if (a === "--registry-state") {
      args.registryStatePath = argv[i + 1];
      i += 1;
    } else if (a === "--manifest-out") {
      args.manifestOut = argv[i + 1];
      i += 1;
    } else if (a === "--notes-version") {
      args.notesVersion = argv[i + 1];
      i += 1;
    } else if (!args.version) {
      args.version = a;
    }
  }
  return args;
}

async function main() {
  const { version, notesVersion, registryStatePath, manifestOut } = parseArgs(process.argv.slice(2));
  if (!version || !VERSION_RE.test(version)) {
    console.error("usage: release-body.mjs [--notes-version X.Y.Z] [--registry-state <file>] <X.Y.Z[-rc.N]>");
    process.exit(2);
  }
  const notes = notesVersion ?? baseOf(version);
  const previous = previousMinorPatch(version);
  const section = extractChangelogSection(readChangelog(), notes);
  if (!section) {
    console.error(
      `docs/myrmidon/CHANGELOG.md has no "## ${notes}" section — a release without notes is a defect`,
    );
    process.exit(1);
  }
  const registryState = registryStatePath
    ? JSON.parse(fs.readFileSync(registryStatePath, "utf8"))
    : null;
  const { rows, missing, digests } = await componentDigests(version, { registryState });
  if (missing.length > 0) {
    console.error(
      `component image digests missing from the registry for release ${version}: ${missing.join(", ")} — NOT publishing (RELEASE-GATE: the board and the components deploy from the same tag)`,
    );
    process.exit(1);
  }
  if (manifestOut) {
    fs.writeFileSync(manifestOut, `${JSON.stringify(buildManifest({ version, digests }), null, 2)}\n`);
  }
  process.stdout.write(buildBody({ version, notesVersion: notes, previous, section, digestRows: rows }));
}

if (process.argv[1] && process.argv[1].endsWith("release-body.mjs")) {
  await main();
}
