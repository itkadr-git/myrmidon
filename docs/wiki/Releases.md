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

### 1.6.9 candidate status

The next RC is pending PREDEPLOY and green main; Alex has already approved the number rc.23. The historical
`myr-v1.6.9-rc.22` was published at
`2d5174055299f6e1959ac95740333788798712b2`. The later main review gate fix
#4604 is not in that tag. The final candidate SHA, image digests, CI, rollout,
database audit and two-hour evidence remain pending; this is not a stable
release announcement. For 1.6.9, verify the standard managed launcher. Privileged activation and live OIDC belong to 1.7. Alex decides on the stable tag after the exact commit is verified. See the
[candidate operator notes](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/releases/1.6.9.md)
for the evidence boundaries.

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

## Release-stop notification recovery

The notifier retains the `release-stop-lock-<event id>` repository label as
a durable reservation, including after a failed create: GitHub may have saved
the issue even if the response was lost. A stale listing can cause retries to
fail closed. Check the stopped Actions run ID and tag, then search all open and
closed issues for the exact title `release-stop: <tag> (<event id>)` and verify
the issue body and run link. If found, keep the reservation; retries will
deduplicate once the issue is visible. An empty listing alone is not proof of
absence. Only after confirming no issue was created and no notifier for the
event is still running may an operator delete the orphan label and retry.
When uncertain, retain it and escalate. See the [operator runbook](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/release-stop-notification.md).

The release procedure itself, including the CI pipeline and the deploy flow,
is documented for operators in
[ci.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/ci.md)
and
[deploy.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md).
