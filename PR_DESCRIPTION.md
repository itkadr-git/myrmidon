# Self-registration safety and user-admin smoke coverage (OPE-8649)

> Paperclip is the open source app people use to manage AI agents for work
> - Myrmidon adds authentication policy and the administrator-facing Users screen
> - The signup policy must not permit public account creation by default
> - The Users screen needs server lifecycle operations for create, block, and password reset
> - This pull request adds the server support and HTTP integration coverage for these behaviors
> - The benefit is a default-closed signup path with a tested administrator-managed lifecycle

## Linked Issues or Issue Description

Refs #1688

This work completes the closed self-registration and Users administration acceptance criteria for OPE-8649.

## What Changed

- Added an explicit default-off self-registration setting and source reporting.
- Kept administrator-managed user creation, blocking, and password reset endpoints with one-time password links.
- Added HTTP integration tests for signup rejection and user lifecycle operations.
- Added an EN/RU change fragment and operator guides; no shared registry document is edited directly.

## Architecture Decisions

None. This extends the existing Better Auth and Myrmidon server routes; no architecture decision record applies to this focused authentication and user-management change.

## Verification

- CI runs the server integration tests, database migration/snapshot checks, and the change-fragments gate.
- Manual verification: from a clean browser session, attempt signup without an invitation and confirm rejection unless `MYRMIDON_AUTH_SELF_SIGN_UP=true` is explicitly configured.
- Local test execution was not performed under the repository's CI-only work policy.

## Risks

- Migration 0401 adds the one-time password-set token table. Existing user rows are unchanged.
- Self-registration remains off unless explicitly enabled. Operators who require public signup must set the environment variable or runtime setting deliberately.

## Model Used

Model: OpenAI GPT-6 Luna via Hermes Agent; exact provider model ID, context window, and capabilities are not exposed to this agent runtime.
