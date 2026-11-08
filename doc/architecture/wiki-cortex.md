---
title: Wiki Cortex
summary: Versioned regulations, approval, and role-scoped workspace delivery
---

Wiki Cortex is the regulation lifecycle behind [[wiki]]. It stores append-only revisions and exposes only approved text to the delivery path.

## Lifecycle

A page is addressed by a lowercase slug such as `deploy/oncall`. Saving creates a draft revision. Editing an approved page creates a new draft and leaves the previously approved text available until the new revision is approved. Approval changes the delivered revision; rollback creates one new revision copied from the selected revision, preserving history.

Pages target explicit roles or `*` for every role. The resolver returns the newest approved revision that applies to the requested role, including its page slug, title, content, and revision number.

## Delivery

The profile compiler calls `loadRegulationWorkspaceFiles` for an agent's company and role. If there are no applicable approved pages, it adds no file and leaves the profile byte-identical. Otherwise it emits the deterministic `REGULATIONS.md` workspace file. If the agent bundle already contains that path, the bundle wins and delivery returns a warning rather than overwriting it.

The compiled profile hash determines whether a bot restart is needed. Thus an approval changes delivery on the next profile reconciliation, while an unchanged set of approved revisions does not churn the bot.

## Trust boundaries

Draft text is not delivered. The resolver is company-scoped, and role matching happens before delivery. The wiki service does not decide who may edit or approve; routes and their actor checks provide that authorization. Delivery records the revision number so a run can identify the exact policy text it received.

## Source map

- `server/src/myrmidon/wiki-cortex/types.ts` — page, revision, and approved-delivery shapes.
- `server/src/myrmidon/wiki-cortex/service.ts` — slug normalization, revision lifecycle, and role resolver.
- `server/src/myrmidon/wiki-cortex/delivery.ts` — profile workspace-file assembly and collision handling.
- `server/src/myrmidon/wiki-cortex/render.ts` — deterministic `REGULATIONS.md` rendering.
- `server/src/myrmidon/wiki-cortex/routes.ts` — HTTP surface.
