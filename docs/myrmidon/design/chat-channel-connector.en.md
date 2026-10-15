# Channel via connector: Telegram moves out of the core

> Russian version: [chat-channel-connector.md](chat-channel-connector.md)

**Revision:** 07.10.2026 · **Track 4** · release **1.6.6**, step 1 (design).

This document describes the channel connector contract, the step-by-step move
of Telegram out of the core with no bot downtime, and compatibility with the
current settings and data. **No code is written against this document until
the design is approved.**

It continues the vendor plans:
`doc/plans/chat-adapters/2026-09-03-chat-adapters-architecture.md`
(ownership boundary, app and connection model, persistence model, shared
contracts, event flows, identity and permissions, delivery phases) and
`doc/plans/2026-09-09-chat-provider-foundation.md` (the provider and the data
foundation). Our rules for editing vendor code are in
[CONVENTIONS.md](../CONVENTIONS.md), section 8.

## 0. Summary

- **The core knows only the contract.** Everything that knows about Telegram
  moves into the connector
  `server/src/myrmidon/channel-connectors/telegram/` and into the shared
  layer. The vendor `server/src/services/chat-channels.ts` keeps **one** of
  our inserts — the hub connection point.
- **There are 81 inserts today**, not 77 as the task statement said:
  `chat-channels.ts` has grown to 38,696 lines; of the 81 `// myrmidon(…)`
  inserts, **66** belong to the Telegram bridge (addressing, holds, DM status,
  topics, voice, notifications, media limits) and **15** are general —
  product renaming (B1, B1b) and database hot-path speedups (D1, D2). The
  target state is one insert; the general 15 stay — they are not about the
  channel.
- **The connector is an object on top of the vendor runtime.** The vendor
  `ChatSdkEndpointRuntime` already brings the transport up on an endpoint;
  our connector owns five areas: lifecycle, links and routing, inbound,
  outbound, media — plus settings. Not a single new branch is added to the
  vendor `switch (provider)`.
- **Connect, configure and disconnect — in the UI** on the existing Chat
  endpoints screens (`/chat-endpoints*`); connecting and disconnecting a
  channel does not restart the server: the channel runtime is created per
  endpoint, and the state lives in the database and in the leases
  (`chat_endpoint_leases`).
- **Data and settings stay compatible.** Steps 1–3 change neither the schema
  nor the data; the settings keys and their values stay the same, migrations
  are additive only and only where unavoidable. Rolling the image back onto
  the new schema must work.
- **The move is 6 steps, each in its own PR**, and each is accepted on a copy
  of the production database: contract and registry (behavior unchanged) →
  connection point in observe mode → bridge topics one at a time → channel
  on/off switch in the UI → shared writer-access layer.
- **Our goal is NOT to cut Telegram out of the vendor files.** The 247
  `provider === "…"` comparisons, the 92 `"telegram"` literals and the
  `@chat-adapter/*` factory are vendor code; the weekly vendor port matters
  more. We remove **our own** inserts from the vendor files, not the vendor
  logic.

## 1. Problem and boundaries

What we are solving:

1. Every vendor update conflicts in `chat-channels.ts`, because our bridge is
   spliced into its branches: inbound handling, wake-up, reply publication,
   command menu, leases, media.
2. Our features are scattered across topics and have no single home:
   `@bot` addressing, holds (CHAT-HOLD), DM status, forum topics, voice,
   agent identity, notifications.
3. Channel settings live in two places (company settings and our
   `channelSettings` block), and connecting/disconnecting a channel is not
   expressed explicitly in the UI.

What we are NOT solving in this stage:

| Out of this stage | Why |
|---|---|
| Rewriting the vendor `chat-telegram-*` and `switch (provider)` | vendor code, weekly port; see CONVENTIONS §8 |
| New channels (an own transport without the vendor adapter) | the registry allows it; the implementation is a separate task |
| Changing the data model (own tables instead of the vendor's) | raises port and migration risk for no benefit |
| Changing the bridge's user-facing texts | texts and language — [telegram-bridge-locale.md](../guides/telegram-bridge-locale.md) |
| Writer permissions and access as such | the shared layer is a separate task of the release (section 9) |

## 2. How it works today

### 2.1 The vendor part

| What | Where | Fact |
|---|---|---|
| Chat channels service | `server/src/services/chat-channels.ts` | 38,696 lines, 247 `provider === "…"` comparisons (150 of them on `endpoint.provider`), 92 `"telegram"` literals |
| Channel runtime | `server/src/services/chat-sdk-runtime.ts` | 3,305 lines; `CHAT_SDK_VERSION = "4.39.0"`; the `ChatSdkProvider` union (`slack \| github \| discord \| microsoft-teams \| telegram \| imessage-photon`); the adapter factory `switch (config.provider)` on top of `@chat-adapter/*`; the endpoint runtime class `ChatSdkEndpointRuntime` |
| Three ready pieces of the contract | `chat-provider-lifecycle.ts` (512 lines), `chat-provider-links.ts` (193), `chat-provider-inventory.ts` (331) | lifecycle effects, conversation link, endpoint resource inventory (Slack channels, GitHub repositories, etc.) |
| Data | `packages/db/src/schema/chat_channels.ts` | 12 tables: endpoints, resources, principals, identity links, conversations, deliveries, publications, message links, actions, agent routes, leases, sdk state; next to them `chat_telegram_draft_ids`, `chat_discord_command_owners`, `chat_teams_file_transfers` |
| API | `server/src/routes/chat-channels.ts` (509 lines) | CRUD `/chat-endpoints`, `setup-secret`, `test`, `resources`, `principals`, `conversations`, `activity`, `identity-links`, task binding (`/issues/:issueId/chat-binding`) and inbound webhooks `/api/chat-webhooks/:publicId/:provider` |
| UI | `ui/src/pages/apps/chat/*`, `ui/src/components/chat/AgentChannelsPanel.tsx`, `ui/src/api/chatEndpoints.ts` | connection screens and endpoint cards, the agent channels panel, the `ChatConnectorsExperimentalGate` gate |
| Telegram at the vendor | 17 `chat-telegram-*` files | 7 modules (draft-stop, ephemeral, media-intake, photo, rich-intake, stop-subscription, video-note), 8 vendor tests and 1 of ours |

### 2.2 Our bridge

| Module (`server/src/myrmidon/…`) | Lines (largest files) | What it does | Where it moves |
|---|---|---|---|
| `agent-chat-bridge` | bridge 733, cross-channel 583, commands/ 458+368+313, addressing 332 | the "bot DM ↔ agent chat" bridge, commands (`/new`, `/model`, `/stop`), `@<alias>` addressing | connector: addressing, commands |
| `telegram-notify` | jobs 535, proactivity-policy 417, card-bundler 221, topic-inbound 84, store 108, settings 100, sweep 70 | owner notifications, cards, proactivity, inbound forum topics | connector: notifications and topics; shared layer: cards |
| `telegram-dm-progress` | runtime-steps 273, labels 237, service 139, throttle 83, settings 83 | run progress in the DM, one editable line | connector: DM status |
| `telegram-dm-status-progress.ts`, `telegram-dm-status-settings.ts` | 2 files | the status-line key and layout | connector |
| `telegram-voice-stt-intake` | index 304, wiring 118, transcript 95, settings 62 | voice intake and transcription into the turn | connector: voice; shared layer: `stt/` |
| `chat-holds` | wait-notice 225, clear-on-message 121, chat-backed 85 | "turn accepted, waiting" instead of a silent queue | connector: holds |
| `channel-settings` | settings 343, service 130, routes 38 | channel settings: env → `instance_settings.general.channelSettings` → default, edit log | shared layer |
| `chat-reconciliation` | reconcile-interval 141, inbound-comment-candidates 47, owner-join 34 | reconciling conversations and tasks, the owner joining a task | shared layer |
| `cto-chat` | plan-generator 301, telegram-entry 158, routes 132, plan-approval 121 | planning from chat on top of the shared layer | a scenario, not the connector |

### 2.3 Inserts in `chat-channels.ts`

`grep -c "myrmidon(" = 81`. By topic:

| Topic (marker) | Inserts | Move target |
|---|---|---|
| `X8b` (bot DM ↔ agent chat bridge) | 10 | connector: identity, conversation routing |
| `X9b` (`@<alias>` addressing) | 9 | connector: addressing |
| `U1` (DM status line, splitting long text) | 8 | connector: DM status |
| `1.6.1 VOICE-STT B` / `1.6.5 VOICE-STT A` | 8 / 2 | connector: voice |
| `TG-NOTIFY-D` (forum topics) | 7 | connector: topics |
| `P7` (lost attachments) | 7 | connector: media |
| `CHAT-HOLD` | 6 | connector: holds |
| `U2` (confirmation cards from another ticket) | 5 | shared layer: cards |
| `X8e`, `1.7-TG-LOCALE` | 2 / 2 | connector: command menu, locale |
| `B1b`, `D1`, `D2`, `B1` | 7 / 4 / 3 / 1 | stay: product renaming and DB hot path |

Total: 66 inserts belong to the channel and move; the 15 general ones stay as
they are.

## 3. The channel connector contract

### 3.1 Five areas

The connector is an object per provider (`telegram`), created by a factory.
All methods are synchronous in call shape and receive a context (database,
company, log, time) — no global state anywhere.

```ts
// server/src/myrmidon/channel-connectors/contract.ts  (design, no code yet)
export interface ChannelConnector {
  readonly provider: ChatProviderName;          // "telegram"

  lifecycle: {
    start(endpoint): Promise<ChannelRuntime>;   // bring the channel runtime up
    stop(endpoint, reason): Promise<void>;      // disconnect in the UI
    status(endpoint): Promise<ChannelStatus>;   // disabled | connecting | ready | degraded
  };

  links: {
    conversationKey(event): string;             // stable conversation key
    conversationUrl(conversation): string | null;
    route(event): Promise<ChannelRoute | null>; // the task and the agent the turn is addressed to
    bind(conversation, route): Promise<void>;   // bind the conversation to the task and the agent
  };

  inbound: {
    normalize(raw): Promise<ChannelTurn | null>;      // transport event → our shape
    admit(turn, ctx): Promise<ChannelAdmission>;      // let it in or not: holds, topic, writer right
    intakeMedia(turn): Promise<MediaIntakeResult>;    // the turn's attachments, limits, refusal reason
  };

  outbound: {
    plan(publication, ctx): Promise<TransportPlan>;   // text, parts, file, status line
    send(plan, transport): Promise<SendResult>;       // sending and outbox accounting
  };

  media: {
    fileLimitBytes: number; captionLimit: number; accepts: readonly MediaKind[];
  };

  settings: {
    keys: readonly ChannelSettingDescriptor[];        // what the channel is tuned with
    resolve(ctx): Promise<ResolvedChannelSettings>;   // env → database → default
  };
}
```

The lifecycle builds on what the vendor already has: the
`chat-provider-lifecycle.ts` effects (webhook subscription, command menu,
greeting) and the endpoint lease in `chat_endpoint_leases`. `start`/`stop` do
not spawn a new process: the Telegram transport is a webhook on the endpoint,
so switching a channel on and off is a state and lease record, not a server
restart.

### 3.2 Registry and hub

```ts
// server/src/myrmidon/channel-connectors/registry.ts
registerChannelConnector("telegram", telegramConnectorFactory);

// server/src/myrmidon/channel-connectors/hub.ts
hub(db, deps);              // the only object the core sees
hub.inbound({ endpoint, raw });
hub.outbound({ publication });
hub.lifecycle.start(endpoint) / .stop(endpoint);
hub.settings(endpoint);
```

- The registry is the only place that says which channels we have. The core
  asks the hub by the endpoint's provider and knows no channel name.
- The hub owns ordering: one inbound event — one turn; a publication never
  leaves twice (the vendor outbox idempotency key is preserved).
- A provider missing from the registry passes straight through the hub: the
  vendor path stays untouched. This lets us move topics one at a time without
  breaking the other channels.

### 3.3 Contract boundaries

- The connector does not know `ChatSdkEndpointRuntime` directly; it receives
  a normalized event and a send adapter from the hub — the vendor runtime
  stays the vendor's.
- The connector does not write ad-hoc SQL against the vendor tables: data
  access goes through one `channel-connectors/store.ts` layer on top of the
  existing tables.
- The contract holds neither UI nor texts: texts (notifications, holds, the
  status line) live in the connector's resources and in the shared cards
  layer.
- Send accounting stays the vendor's: `chat_publications` and
  `chat_deliveries` are the source of truth; the connector only picks the
  send plan.

## 4. One connection point in `chat-channels.ts`

The target insert is exactly one:

```ts
// myrmidon(HUB): the only connection between the vendor chat service and our
// channel connectors. Everything channel-specific lives in
// server/src/myrmidon/channel-connectors/.
const channelHub = myrmidonChannelConnectorHub(db, { logger });
```

Four flows go through it: the inbound transport event, wake-up and routing,
reply publication and the endpoint lifecycle. Everything else (`X8b`, `X9b`,
`U1`, `U2`, `CHAT-HOLD`, `TG-NOTIFY-D`, `VOICE-STT`, `P7`, `X8e`,
`TG-LOCALE` — 66 inserts) moves into the connector and the shared layer: the
vendor file keeps the hub call, not our logic between vendor branches.

The general 15 inserts (`B1`, `B1b`, `D1`, `D2`) are not touched by the move:
product renaming and typed UUID comparisons on the hot path are not about the
channel; their place is in the core.

The insert-removal order across the steps (section 6) is chosen so that each
PR stays reviewable: one topic — one PR, and a topic's inserts are removed by
the same PR that moves its code.

## 5. Settings and data compatibility

### 5.1 Settings

| Layer | Keys | What changes |
|---|---|---|
| Environment variables | `MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, `MYRMIDON_TELEGRAM_DM_STATUS`, `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS`, `MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES`, `MYRMIDON_TELEGRAM_VOICE_STT`, `MYRMIDON_TELEGRAM_DM_LANGUAGE`, `MYRMIDON_TELEGRAM_NOTIFY_TICK_SEC`, `MYRMIDON_TELEGRAM_DM_PROGRESS`, `TELEGRAM_API_BASE_URL` | nothing: names and priority (env → database → default) are preserved; reading stays in `channel-settings/settings.ts` |
| Company UI | `CHANNEL_SETTING_KEYS` in `instance_settings.general.channelSettings`: DM conversations, DM status, split max parts, file limit | nothing in steps 1–3; step 4 adds a "channel enabled" key with the default "enabled" = current behavior |
| Endpoint | the vendor endpoint fields and `setup-secret` | nothing: connect and disconnect go through the existing `/chat-endpoints*` routes |

### 5.2 Data

- The schema does not change in steps 1–3: not a single migration. The
  connector reads and writes the same tables.
- Where a new field is unavoidable (step 4, the channel switch), the field is
  additive and its number is the next free one after the vendor migrations;
  the old state "no field" reads as "enabled", so rolling the image back onto
  the new schema works.
- Data is not relocated: `chat_endpoints`, `chat_conversations`,
  `chat_publications`, `chat_endpoint_leases` stay the source of truth, so a
  copy of the production database fits acceptance without conversion.

### 5.3 What the user sees

Nothing new in steps 1–3: the same DMs, the same groups and topics, the same
commands, the same hold text. Step 4 adds an "enabled/disabled" state to the
channel card and an explanation of why the channel is silent — that does not
exist today.

## 6. The move in steps

| Step | What | Files | Watchdog test | Downtime | Acceptance |
|---|---|---|---|---|---|
| S1 | Contract, types, registry, hub — new files only | `server/src/myrmidon/channel-connectors/*` | contract and registry tests | none | package types and tests |
| S2 | Connection point: one `HUB` insert, hub in observe mode | `chat-channels.ts` (+1 insert), the hub | "observe does not change behavior" test | none | DB copy: the hub log matches the actual turns |
| S3 | Bridge topics one at a time: topics → notifications and DM status → holds → addressing and commands → voice → media → identity | Telegram connector + the vendor file (removing the topic's inserts) | the topic's existing `*.myrmidon.test.ts` + a connector test | none | the topic's scenarios on the DB copy |
| S4 | Channel on/off switch in the UI: state, explanation, disconnect and reconnect | `channel-settings/*`, an additive field, `ui/src/pages/apps/chat/*` | "a disabled channel neither accepts nor sends" test | none | DB copy: disable and re-enable with no restart |
| S5 | The shared writer-access layer plugs into the connector and the core | shared layer + the hub call | layer tests | none | permission scenarios on the DB copy |
| S6 | Reconciliation: one insert left, the general 15 in place, the divergence registry updated by a fragment | `chat-channels.ts`, `docs/myrmidon/changes/*` | insert-counter test | none | review of the vendor file diff |

**S1 — contract and registry.** Not a single line in the vendor files. Check:
the new files' types and tests. Zero risk, behavior unchanged.

**S2 — connection point in observe mode.** The hub is created once, receives
the four flows and writes a log, but decides nothing: decisions stay on the
vendor path. The point of the step is to confirm on a production-DB copy that
the hub sees every turn and every publication before it starts deciding
anything. Watchdog test: with observe mode on, behavior and the publication
count do not differ from `main`.

**S3 — topics one at a time.** The order is from "least visible" to "most
visible"; inside a topic, the code moves first, then the inserts are removed:

1. forum topics (`TG-NOTIFY-D`, 7 inserts) — topic intake and gate;
2. notifications and DM status (`U1`, 8, and the `telegram-notify` module) —
   progress and notifications;
3. holds (`CHAT-HOLD`, 6) — the "turn accepted, waiting" reply;
4. addressing and commands (`X9b` 9, `X8b` 10, `X8e` 2) — `@<alias>`, `/new`,
   `/model`, `/stop`;
5. voice (`VOICE-STT` 10) — voice intake and transcription;
6. media (`P7` 7, limits, long-text splitting) — attachments and captions;
7. identity and routes (the rest of `X8b`/`U2`) — binding the conversation to
   the task and the agent.

Each topic is its own PR with one registry fragment; the topic's criterion:
texts, buttons and routes unchanged, and its scenarios on the DB copy pass as
before.

**S4 — the channel switch.** The connector declares the state itself; the
channel card shows "enabled/disabled", the downtime reason and the button.
Disconnecting is a state record and a lease release, reconnecting is the way
back; no restart.

**S5 — writer access and permissions.** The shared layer (section 9) plugs in
the same way into both the connector and the core: a channel has no notion of
permissions of its own.

**S6 — reconciliation.** We verify that `chat-channels.ts` has one of our
inserts left, the general 15 are in place, and the divergence-registry rows
were added as fragments. After this step channels live behind the contract,
and the vendor port touches only vendor code.

## 7. No bot downtime

- **The channel runtime lives on the endpoint.** The vendor runtime is
  created per endpoint and lives in the server process; the connector's
  `start`/`stop` are a state and a lease, not a restart. Hence: connecting,
  configuring and disconnecting a channel needs no server restart.
- **Message ordering is held by the vendor outbox.** `chat_publications` and
  `chat_deliveries` with their idempotency keys are the send source of truth;
  moving the publication logic does not change the keys, so a re-entry after
  a failure does not duplicate a message.
- **Steps 1–3 change neither routes nor texts.** The vendor branches stay
  functional: until a topic is moved, the vendor path works; after the move —
  the connector path. The shared path is one and the same (the hub), so no
  "two truths" appear.
- **Observe before deciding.** S2 is switched on before the hub decides
  anything; connector errors in the S3 steps are logged and fall through to
  the vendor path (fail-open) instead of leaving the bot mute.
- **Rollout — only by an image from CI.** The rollout and rollback procedure
  is the existing one; this release needs no separate maintenance.

## 8. Verification on a production-DB copy

1. **The copy.** Take a production database dump and stand up a staging
   environment on that copy — acceptance runs only on it, not on a synthetic
   database.
2. **Inventory.** Compare before/after: the endpoint list and their
   providers; conversation-to-task-and-agent bindings; active leases;
   publication and delivery counts.
3. **Turn scenarios.** A DM to the bot, a group with `@<alias>`, a forum
   topic, a voice message, an attachment over the limit, a long text reply,
   `/new`, `/stop`, a hold on pause — each scenario passes as before, and the
   report carries the log tails.
4. **Settings scenarios.** Changing company settings (DM conversations, DM
   status, file limit, split max parts) and the env-over-database priority —
   values and their source are visible as before.
5. **Lifecycle (from S4).** Disabling and re-enabling the channel with no
   restart: inbound is not accepted, publications do not leave, work resumes
   after re-enabling; the lease is released.
6. **Observe (S2).** The hub log is reconciled against the actual turns: no
   missed, no extra.

## 9. The shared writer-access layer

Writer permissions and access are a property of a channel as such, not of
Telegram: "who may write into this conversation and which task that message
lands in" is decided once and the same way for all channels. So the layer
lives next to the connector, not inside it, and plugs into the hub and the
core with one call. The connector only reports the inputs (author,
conversation, addressing flag); the shared layer makes the decision. This
lets permissions roll in gradually without rewriting the connectors.

Until this layer is implemented, the connector calls the vendor answer to
"let it in or not" and behaves as today — the S3 topic moves do not depend on
it.

## 10. Risks

| Risk | How we close it |
|---|---|
| The hub decides before being validated by observation | step S2 in its own PR with a "behavior unchanged" test |
| A topic is moved and a scenario is lost | each topic — its own PR, its own fragment and its own DB-copy scenarios |
| A vendor port conflicts during the move | each topic removes only its own inserts; the general 15 stay untouched |
| A connector error leaves the bot mute | fail-open onto the vendor path in steps S2–S3, log and error counter |
| The channels file is hot (needs `review-approved`) | one PR per step, small diff, review after green CI |
| Settings diverge between env and the UI | the env → database → default priority is preserved; step S4 adds only the switch key |

## 11. Open questions and decisions made without the owner

**Questions to the owner (already answered; the answers are what this design
implements):**

1. Channel switch (S4): is "enabled/disabled" for the whole channel enough,
   or do individual features (topics, voice, notifications) need separate
   switches? — **Decided: one switch for the whole channel.**
2. The shared writer-access layer: do we bring it in right after S4 or as a
   separate release, once Telegram is behind the contract? — **Decided: right
   after S4, in this release.**
3. The S3 topic order — do we keep "from lower risk to higher risk", or does
   the owner want `@bot` addressing and holds first? — **Decided: keep
   "from lower risk to higher risk".**

**Decisions made without the owner (in this document):**

- The connector is a layer on top of the vendor runtime, not a new transport:
  a minimal footprint in vendor code matters more than contract completeness.
- A provider missing from the registry passes straight through: the move does
  not have to cover all channels at once.
- The general inserts (`B1`, `B1b`, `D1`, `D2`) stay in the core: they are
  not about the channel.
- The topic order inside S3 and the step composition are refined during
  decomposition, unless the owner objects.
