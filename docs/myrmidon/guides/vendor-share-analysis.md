# Vendor share of the repository

The release rule requires the share of files inherited from the vendor code to be
measured on every release. Until now the number came from a hand audit
(~6.1k of ~6.8k files). `scripts/myrmidon/vendor-share.mjs` produces it in one
command, from the repository itself.

## What counts as inherited

A tracked file counts as inherited when **both** hold:

1. its path existed in the vendor base commit. A rename is followed through
   git's own rename detection, so a file moved with `git mv` is still matched
   against its old path;
2. the share of matching lines against the base version is at or above the
   threshold (default 50%). The share is the multiset intersection of non-empty
   lines over the longer side, so an unchanged file scores 100% and a full
   rewrite 0%.

Everything else is reported as `new` (path absent from the base), `modified`
(rewritten below the threshold), `binary` or `excluded`. The exclusion list is a
constant in the script: lock files (`package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`, `*.lock`, `Cargo.lock`, …), build output (`dist`, `build`, `out`,
`coverage`, `.next`, `__snapshots__`), generated artifacts (`*.min.js`,
`*.map`, `*.snap`, `*.generated.*`), the vendor-base file and the divergence
registry.

## Usage

```bash
# short Markdown table (default output)
node scripts/myrmidon/vendor-share.mjs

# machine-readable JSON report
node scripts/myrmidon/vendor-share.mjs --json

# stricter threshold, or another base commit / checkout
node scripts/myrmidon/vendor-share.mjs --threshold 0.7
node scripts/myrmidon/vendor-share.mjs --base <sha>
node scripts/myrmidon/vendor-share.mjs --repo /path/to/checkout
```

| Option | Meaning |
| --- | --- |
| `--threshold`, `-t` | similarity threshold, 0..1 (default 0.5) |
| `--base` | vendor base commit or ref (default: `scripts/myrmidon/vendor-base.txt`) |
| `--repo` | repository to analyse (default: the current directory) |
| `--json` | print JSON instead of the Markdown table |
| `--help`, `-h` | usage |

## Threshold and the source of its value

The threshold is resolved in this order: the `--threshold` flag, then the
`MYRMIDON_VENDOR_SHARE_THRESHOLD` environment variable (a forced override),
then the built-in `0.5`. The report always names the source it used
(`flag`, `env` or `default`), so a surprising number can be traced back to the
value that produced it. The variable is documented in
[SETTINGS.md](../SETTINGS.md).

## Output

JSON: `summary` (`totalFiles`, `inherited`, `modified`, `newFiles`, `binary`,
`excluded`, `share`, `threshold`, `thresholdSource`, `baseCommit`,
`baseSource`), `byDirectory` and `byPackage` breakdowns with a share each, and
the per-file list (the `basePath` a rename was matched against). Markdown: a
summary table plus one table by top-level directory and one by package.

## Vendor base commit

The base commit is recorded in `scripts/myrmidon/vendor-base.txt` together with
the command that finds it: the newest vendor release tag reachable from `main`
(`git tag --merged main 'v20*' --sort=-v:refname | head -1` → `v2026.916.1` →
`d554c4789ed3…`). Our own releases use `myr-v*`, so every commit below that tag
is vendor code.

## Performance

On the current `main` the script measures ~9k tracked files in a few seconds —
well inside the two-minute budget. The base versions are read through a bounded
`git cat-file --batch` call instead of one process per file, and files whose
blob hash is unchanged are classified without reading their content at all.

## Verification

`scripts/myrmidon/vendor-share.myrmidon.test.mjs` builds a small artificial
repository in a temporary directory — a base commit, then an untouched file, a
fully rewritten file, a `git mv` rename, a new file and an excluded lock file —
and checks every classification, the summary arithmetic and the CLI contract
(JSON shape, Markdown output, threshold source). CI runs all
`scripts/myrmidon/**/*.test.mjs` with `node --test`.

Manual check:

```bash
node scripts/myrmidon/vendor-share.mjs
node --test scripts/myrmidon/vendor-share.myrmidon.test.mjs
```