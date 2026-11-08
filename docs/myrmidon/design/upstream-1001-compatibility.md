# Compatibility assessment: Paperclip v2026.1001.0 directions for Myrmidon 1.6.6

**Reviewed:** 2026-10-11
**Scope:** the five upstream directions selected for the 1.6.6 release plan.
**Method:** inspect the upstream pull requests and their changed boundaries, then
compare them with the current Myrmidon modules, divergence fragments, and
in-flight public pull requests.

This is an implementation boundary document. It does not change runtime
behavior and does not authorize a wholesale upstream merge.

## Decision summary

| Direction | Decision | Delivery boundary |
|---|---|---|
| Task reassignment, upstream [#13686](https://github.com/paperclipai/paperclip/pull/13686) | Adapt | The Myrmidon compare-and-set handoff path is the only supported entry point. |
| Native reviewer admission, upstream [#13581](https://github.com/paperclipai/paperclip/pull/13581) | Design a narrow adapter first | Reviewer ownership, wake admission, and execution locking must join atomically without changing the child assignee. |
| Queued card responses, upstream [#13539](https://github.com/paperclipai/paperclip/pull/13539) | Adopted with Myrmidon adaptations | The server and UI ports are merged. |
| Channel-provider architecture, upstream [#13638](https://github.com/paperclipai/paperclip/pull/13638) | Migrate incrementally | The connector contract and hub are merged; each Telegram concern moves in a separate, observable step. |
| One application plugin registration | Adopt with an order-preserving registry | The route registry remains a separate pending implementation; connector provisioning stays fail-closed independently. |

## 1. Guarded task reassignment

Upstream #13686 adds a reassignment operation that compares the expected owner
and issue version, stops active work before ownership changes, persists an
idempotent receipt, and restores the previous owner if final validation fails.

Myrmidon has additional correctness paths around reassignment:

- replay holds can deliberately preserve the issue state after a settled
  response;
- wake admission uses issue guards and a deferred queue;
- status-version checks prevent an old delivery from starting an extra turn;
- recovery and lock-release paths must distinguish an intended handoff stop
  from an execution failure.

The compatible approach is the Myrmidon `HANDOFF-CAS` implementation. It uses
optional expected assignee and status-version facts on the general issue PATCH
path, re-reads the issue under a row lock, requires the old run to stop, stores
a receipt, and queues a guarded rollback only after a failed post-stop commit.
The baseline PATCH behavior remains unchanged when callers do not provide the
compare-and-set facts.

**Current delivery state:** the implementation is in public PR
[#1060](https://github.com/itkadr-git/myrmidon/pull/1060). It had green checks
when assessed but was behind `main`; it must be refreshed and re-verified before
merge. The existing merged status-version wake guard is complementary: it fences
a stale delivery but does not replace atomic ownership change.

## 2. Atomic native reviewer admission

Upstream #13581 solves a native-run review handoff by atomically claiming the
reviewer run, durable wake request, and issue execution lock. Its important
invariants are exact binding to company, issue, source run, decision revision,
reviewer, and resolver policy; a reviewer receives only review authority; and
the child task retains its original assignee.

A direct port is unsafe because Myrmidon already has independent review-path
logic:

- execution-policy participants and review/approval stages;
- durable wake-queue admission and execution locks;
- review-path attention and recovery wakes;
- card interaction queueing and terminal-interaction publications;
- status-only recovery constraints.

The follow-up must introduce a small Myrmidon-owned admission module, not splice
upstream assumptions through the existing routes. Inside one database
transaction it must:

1. lock and re-read the exact issue, source run, review decision/card, and
   candidate reviewer;
2. reject stale cards, different companies, terminal runs, changed decisions,
   competing execution locks, and mismatched reviewer identities;
3. insert or claim exactly one reviewer wake and its run;
4. assign the issue execution lock to that reviewer run while preserving the
   child `assigneeAgentId`;
5. bind resolution to the exact active reviewer run and decision revision; and
6. make abandoned reviewer recovery reuse the same durable receipt rather than
   issuing a second native wake.

The agent-facing authority must be limited to inspecting the bound child and
resolving the precise review decision. Provider file and shell permissions remain
subject to existing agent, environment, and autonomy policy; this admission path
must not become a broad control-plane grant.

**Current delivery state:** not implemented by this assessment. It needs focused
transactional regression tests for competing lock claims, replay, stale-card
rejection, valid resolution, and recovery before it can be enabled.

## 3. Wait / Steer / Interrupt for resolved cards

Upstream #13539 projects a card response into the message queue while a source
run is active. The operator can wait for normal completion, explicitly steer
where the active turn is compatible, or interrupt for a fresh continuation.

This direction is compatible and landed with Myrmidon-specific safeguards:

- a resolved card is represented as one immutable interaction queue entry;
- interaction receipts never coalesce with comments or with other cards;
- fresh-session answers cannot be steered into the current turn;
- an explicit interrupt is accepted for fresh-session answers;
- anti-reassign checks preserve a review path while a source card or queued
  interaction response is live; and
- the fork's continuation outbox and wake guards retain their own delivery
  semantics.

The server port is merged in public PR
[#721](https://github.com/itkadr-git/myrmidon/pull/721), and the queue UI port
is merged in public PR [#1027](https://github.com/itkadr-git/myrmidon/pull/1027).
The changes are guarded by server wake/queue regressions and UI queue tests.

## 4. Channel connectors and Telegram migration

Upstream #13638 concerns connector onboarding and identity linking. Its broader
separation of provider identity from company membership is directionally useful,
but it is not a Telegram code migration and cannot be copied as one.

Myrmidon instead moves its channel-specific logic behind the connector contract
documented in [chat-channel-connector.en.md](chat-channel-connector.en.md). The
contract deliberately leaves the vendor runtime and data model in place:

- a registry maps a provider to one connector factory;
- a hub owns ordering and passes providers without a registered connector to the
  vendor path;
- existing endpoint, conversation, lease, publication, and delivery tables
  remain the source of truth;
- connection and disconnection remain endpoint lifecycle operations, not server
  restarts; and
- each migration step is tested in observe mode before it decides traffic.

The contract, registry, store, and hub are merged in public PR
[#1009](https://github.com/itkadr-git/myrmidon/pull/1009). The next steps must
move one concern at a time, retain vendor fallback until its scenarios pass, and
validate against a production-database copy before live rollout. The channel
migration must not alter unrelated product branding or database hot-path fixes
in the vendor chat service.

## 5. One application plugin registration and fail-closed connectors

The route-registration direction reduces conflicts in `server/src/app.ts`, but
Myrmidon has ordered routes whose precedence is behavior. The compatible design
is a registry that reproduces every existing API mount in exactly the same order.
The following remain literal, local wiring:

- root pre-auth mounts;
- board-key middleware placement;
- non-route startup/sweep scheduling; and
- non-route dependencies that cannot be expressed as an API mount.

The candidate implementation has an order snapshot, mount-count check, and a
marker guard for vendor-file call sites. It is in public PR
[#679](https://github.com/itkadr-git/myrmidon/pull/679) and is not part of
`main` at this assessment date. It must be updated from `main`, preserve every
mount added while it was pending, and pass its guards again before merging.

The proposed connector decommission behavior is already separately constrained:
self-hosted installation only auto-installs the explicit Kubernetes entry, and
the bundled-plugin provisioner has no uninstall capability. This is fail-closed
and does not depend on the route registry. Any connector removal remains an
explicit operator action.

## Required sequencing

1. Keep the merged Wait / Steer / Interrupt behavior and status-version wake
   guard as the baseline.
2. Refresh, re-test, and merge guarded handoff only after verifying it composes
   with the latest wake, recovery, and replay-hold paths.
3. Implement native reviewer admission as its own atomic path, with no direct
   upstream cherry-pick.
4. Continue the channel move from contract/registry/hub through observe mode and
   isolated topic migrations.
5. Refresh and merge the route registry only after replaying the current mount
   order. Keep connector fail-closed properties as an independent invariant.

## Verification expectations for later implementation PRs

Every implementation PR must include a focused regression that fails without its
new behavior and must cover the affected transaction or queue boundary. In
addition to normal CI, operations should verify on staging:

- reassignment stops the old owner before the new owner can start, including a
  failed-commit rollback;
- one reviewer card produces one bound reviewer run despite simultaneous claims;
- a stale or mismatched reviewer card cannot receive control-plane authority;
- a queued card response never starts an implicit steer of a later active run;
- Telegram delivery remains unchanged during connector observe mode; and
- route precedence and fail-closed connector provisioning remain unchanged after
  the plugin registry is enabled.
