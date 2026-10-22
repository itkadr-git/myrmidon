#!/usr/bin/env node
/**
 * VENDOR-SHARE-METRIC (1.6.5): the vendor-derived line of the release notes.
 *
 * publish-github-release.sh runs this right after building the release body
 * and appends the printed line as the `## Vendor-derived files` section:
 *
 *   Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)
 *
 * The line is advisory: when the current share cannot be computed the script
 * exits 3 with the reason on stderr, and the publisher writes «не посчитано»
 * instead of failing the release (OPE-4152 acceptance: a metric failure must
 * never break the publish).
 *
 * Usage:
 *   node vendor-share-notes.mjs [--previous-tag myr-vX.Y.Z]
 *                               [--previous-body <file>] [--repo <dir>]
 *
 * The current share comes from analyzeVendorShare (../vendor-share.mjs) for
 * the working checkout. MYRMIDON_RELEASE_VENDOR_SHARE_STATE (a JSON file with
 * a share summary) replaces the computation — the same offline seam
 * release-body.mjs uses for component digests (MYRMIDON_RELEASE_REGISTRY_STATE).
 * The previous release's numbers are parsed from its release notes body (the
 * previous release was published by this same script and carries the same
 * line), so no git history of the previous tag is needed: the release
 * workflow checks out a single ref.
 */
import fs from "node:fs";
import { analyzeVendorShare, resolveThreshold } from "../vendor-share.mjs";

export const STATE_ENV = "MYRMIDON_RELEASE_VENDOR_SHARE_STATE";
export const NOT_COMPUTED = "не посчитано";

const LINE_RE =
  /Vendor-derived files:\s+(\d+)\s+of\s+(\d+)\s+\((\d+(?:\.\d+)?)\s*%\)/;

export function pctOf(summary) {
  return (summary.share * 100).toFixed(2);
}

/**
 * Parse the vendor-derived line out of a previous release body.
 * Returns { inherited, totalFiles, share } or null when the body carries no
 * line (a release published before this metric, or «не посчитано»).
 * The share is rebuilt from the two counts (the printed percentage is rounded
 * to two decimals) so a delta compares like with like.
 */
export function parseShareLine(text) {
  if (!text) return null;
  const match = LINE_RE.exec(text);
  if (!match) return null;
  const inherited = Number(match[1]);
  const totalFiles = Number(match[2]);
  if (!Number.isFinite(inherited) || !Number.isFinite(totalFiles) || totalFiles <= 0) {
    return null;
  }
  return { inherited, totalFiles, share: inherited / totalFiles };
}

const signed = (n, digits = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

/**
 * Build the one-line share statement. `current` is a share summary (the
 * analyzeVendorShare summary or its STATE_ENV equivalent); `previous` is the
 * parseShareLine result for the previous release tag, or null.
 */
export function formatShareLine(current, previous, previousTag = null) {
  const base = `Vendor-derived files: ${current.inherited} of ${current.totalFiles} (${pctOf(current)}%)`;
  if (!previousTag) {
    return `${base}, Δ to the previous release: нет данных (no previous release found)`;
  }
  if (!previous) {
    return `${base}, Δ to ${previousTag}: нет данных (no vendor-share line in that release)`;
  }
  const pp = (current.share - previous.share) * 100;
  const files = current.inherited - previous.inherited;
  return `${base}, Δ to ${previousTag}: ${signed(pp)} pp (${signed(files, 0)} files)`;
}

function readStateSummary(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${STATE_ENV} ${file} is not readable JSON: ${error.message}`);
  }
  const summary = parsed?.summary ?? parsed;
  const { totalFiles, inherited, share } = summary ?? {};
  if (
    !Number.isFinite(Number(totalFiles)) || !Number.isFinite(Number(inherited)) ||
    !Number.isFinite(Number(share)) || Number(totalFiles) <= 0
  ) {
    throw new Error(
      `${STATE_ENV} ${file} must hold a share summary with totalFiles, inherited and share`
    );
  }
  return summary;
}

/**
 * CLI. Returns the exit code: 0 when the line was printed, 3 when the current
 * share could not be computed (the publisher then writes «не посчитано»).
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const opts = { previousTag: null, previousBody: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--previous-tag") opts.previousTag = argv[(i += 1)];
    else if (argv[i] === "--previous-body") opts.previousBody = argv[(i += 1)];
    else if (argv[i] === "--repo") opts.repo = argv[(i += 1)];
    else {
      err(`vendor-share-notes: unknown argument ${argv[i]}\n`);
      return 2;
    }
  }

  let current;
  try {
    const state = process.env[STATE_ENV];
    if (state) {
      current = readStateSummary(state);
    } else {
      const threshold = resolveThreshold();
      current = analyzeVendorShare({
        repoDir: opts.repo ?? process.cwd(),
        threshold: threshold.value,
        thresholdSource: threshold.source,
      }).summary;
    }
  } catch (error) {
    err(`vendor-share-notes: current share not computed — ${error.message}\n`);
    return 3;
  }

  const previous = opts.previousBody
    ? parseShareLine(fs.existsSync(opts.previousBody) ? fs.readFileSync(opts.previousBody, "utf8") : "")
    : null;
  out(`${formatShareLine(current, previous, opts.previousTag)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
