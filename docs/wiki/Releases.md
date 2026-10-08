# Releases

> Русская версия: [Releases.ru](Releases.ru)

Myrmidon ships as tagged releases. The version comes from the git tag
`myr-v<major>.<minor>.<patch>`; CI stamps it into the image and
`/api/health`, so what you run is what was tagged — there is no version file
to edit.

## Where to look

- [Releases on GitHub](https://github.com/itkadr-git/myrmidon/releases) —
  final releases and RC pre-releases, published by CI from main or a
  `myr-v*` tag.
- [Changelog](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md)
  ([Russian](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.ru.md))
  — what landed in which version, newest first.
- The base Paperclip version a release was built from is in the image label
  `io.github.itkadr-git.myrmidon.base.paperclip-version`.

A release on GitHub never changes after publication: an install or an update
always fetches exactly the files that passed the release checks.

## Release candidates and finals

Work lands on `main` all the time; a release cut freezes it into a version.
RC pre-releases (`myr-vX.Y.Z-rcN`) are published for testing before the
final tag. Updating to either is the same operation — re-running the
installer — covered in [Upgrading and rollback](Upgrading-and-rollback).

## How changes reach a release

Every pull request records its user-facing change as a fragment file in
`docs/myrmidon/changes/` instead of editing the shared changelog directly.
At the release cut a script folds all fragments into the changelog under the
new version heading and deletes the fragments — so two pull requests with
changelog entries never conflict with each other, and the changelog in a
release is complete by construction.

The release procedure itself, including the CI pipeline and the deploy flow,
is documented for operators in
[ci.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/ci.md)
and
[deploy.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md).
