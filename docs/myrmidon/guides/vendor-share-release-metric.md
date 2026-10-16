# Vendor-derived share in the release notes (VENDOR-SHARE-METRIC, 1.6.5)

Every release published from `myr-v*` tags shows how much of the tree is still
inherited from vendor code, and how that changed since the previous release.

## The line

```
Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)
```

It lands in the release body under its own heading:

```
## Vendor-derived files
```

The share itself is measured by `scripts/myrmidon/vendor-share.mjs` (merged in
#563) against the vendor base commit recorded in
`scripts/myrmidon/vendor-base.txt`. The delta compares against the **previous
release's own line**, so the wording of the metric is its own history: the
previous body is read with `gh release view <previous tag> --json body` and the
older counts are parsed out of it. The percentage is rebuilt from the two counts
rather than from the rounded `89.78 %` in the text, so a delta compares like
with like.

A previous release published before this metric (or a manually written body)
has no line: the section then reads

```
нет данных (no vendor-share line in that release)
```

## Where it runs

`scripts/myrmidon/release/publish-github-release.sh`, step **3b** — right after
the release body is built (step 3, `release-body.mjs`) and before publishing
(step 4, `gh release create --notes-file release-body.md`). The line is appended
to the body file, so the released notes are exactly the file that was published.

`scripts/myrmidon/release/vendor-share-notes.mjs` does the work: it prints one
line, exits `0` on success and exits `3` with the reason on stderr when the
share cannot be computed (an empty or unreadable state file, a checkout without
the vendor base).

## Failure is never fatal

The metric is advisory. A non-zero exit from `vendor-share-notes.mjs` makes the
publisher write

```
## Vendor-derived files

не посчитано (vendor-share metric failed; the release continues)
```

with a warning in the log, and the release still goes out. Nothing else in the
publish gate (component digests, the tag's own CI run, the manifest asset)
depends on the metric.

## Offline seams

The release job talks to GitHub; the tests do not. Two variables stand in for
the outside world, next to the existing `MYRMIDON_RELEASE_REGISTRY_STATE`:

- `MYRMIDON_RELEASE_VENDOR_SHARE_STATE` — a JSON file with the current share
  summary (`{"summary":{"inherited":6123,"totalFiles":6812,"share":0.899...}}`),
  used instead of running `vendor-share.mjs`.
- `MYRMIDON_RELEASE_PREVIOUS_BODY` — a file holding the previous release's
  notes, used instead of `gh release view`.

Both are read by `vendor-share-notes.mjs` only; the server never sees them. See
`docs/myrmidon/SETTINGS.md`, section `Track 5 — operations`.

## The CI step

`vendor-share.mjs` also runs on `main` in CI, publishes its JSON as a build
artifact and logs the same line, so the number is visible on every merge and not
only at release time. Workflow files (`.github/workflows/*`) are applied by the
board operator: the change ships as a `format-patch` attachment on the issue,
not as a commit in the PR that carries this document.

The release job needs enough history for the vendor base commit to be present in
the checkout; when it is not, the metric degrades to `не посчитано` and the
release is unaffected.

## Tests

```
node --test scripts/myrmidon/release/vendor-share-notes.myrmidon.test.mjs
node --test scripts/myrmidon/release/release-publish.test.mjs
```

The first is the unit contract of the line (format, delta sign, `нет данных`,
`не посчитано`, exit 3, round-trip); the second drives the real publisher
end-to-end with a fake `gh` and asserts the section in the published notes —
including that the release is still created when the metric fails.